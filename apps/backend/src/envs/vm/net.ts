// Guest egress for one VM: Gondolin HTTP hooks backed by the shared policy engine, plus our own upstream
// fetch so every hop (redirects included) is logged once with status and bytes while responses still
// stream. Connections only ever go to public addresses (connect-time lookup), which also covers DNS
// rebinding between the policy check and the connect.

import type { NetworkMode } from "@terrarium/shared";
import type { HttpHooks, HttpIpAllowInfo } from "@earendil-works/gondolin";
import { Agent, fetch as undiciFetch, Response as UndiciResponse } from "undici";
import { type LookupAll, addressCategory, isPublicIp, publicOnlyLookup, resolveAndCheck } from "../../policy/index.ts";
import type { NetAttempt } from "../types.ts";

interface Pending {
  ts: number;
  method: string;
  url: string;
  host: string;
  ip?: string;
  reason: string;
}

/** Synthetic DNS answers every A query with this address (set explicitly in the VM options). */
export const SYNTHETIC_DNS_IPV4 = "192.0.2.1";
const NULL_BODY_STATUS = new Set([101, 103, 204, 205, 304]);
const ORPHAN_MS = 60_000;
const RAW_LOG_PER_SEC = 50;

export class VmNetwork {
  mode: NetworkMode;
  private readonly listeners = new Set<(a: NetAttempt) => void>();
  private readonly pending = new Map<string, Pending[]>();
  private readonly lookup: LookupAll | undefined;
  private readonly agent: Agent;
  private readonly sweep: NodeJS.Timeout;
  private readonly tlsLiteral = new Map<string, NodeJS.Timeout[]>();
  private readonly syntheticTls: number[] = [];
  private rawWindow = 0;
  private rawCount = 0;
  private rawSuppressed = 0;

  constructor(mode: NetworkMode, lookup?: LookupAll) {
    this.mode = mode;
    this.lookup = lookup;
    this.agent = new Agent({ connect: { lookup: publicOnlyLookup(lookup) as never }, keepAliveTimeout: 10_000 });
    this.sweep = setInterval(() => this.sweepOrphans(), 15_000);
    this.sweep.unref();
  }

  onAttempt(listener: (a: NetAttempt) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  close(): void {
    clearInterval(this.sweep);
    for (const list of this.tlsLiteral.values()) for (const t of list) clearTimeout(t);
    this.tlsLiteral.clear();
    this.sweepOrphans(true);
    void this.agent.close().catch(() => {});
  }

  readonly httpHooks: HttpHooks = {
    isRequestAllowed: (request) => this.decide(request.method, request.url),
    isIpAllowed: (info) => this.checkIp(info),
  };

  /** Upstream fetch handed to Gondolin (`VMOptions.fetch`); called once per hop after the hooks allowed it. */
  readonly fetch = (input: unknown, init?: Record<string, unknown>): Promise<UndiciResponse> => this.upstream(input, init ?? {});

  /**
   * Gondolin debug lines (component "net"): the only signal for flows that never reach the HTTP hooks,
   * i.e. dropped non-HTTP traffic and TLS to a bare IP whose handshake fails for lack of a hostname.
   */
  onDebug(message: string): void {
    let m = /^tls mitm start (\S+):(\d+)$/.exec(message);
    if (m) {
      const [, ip, port] = m;
      if (ip === SYNTHETIC_DNS_IPV4) {
        // Hostname connections all target the synthetic DNS answer and send SNI.
        this.syntheticTls.push(Date.now());
        return;
      }
      const timer = setTimeout(() => {
        this.dropTlsTimer(ip!, timer);
        this.emit({ method: "TLS", url: `https://${ip}:${port}/`, host: ip!, ip, decision: "deny", reason: `TLS to bare IP ${ip} (no SNI hostname): handshake not completed, nothing sent upstream` });
      }, 2_000);
      timer.unref();
      const list = this.tlsLiteral.get(ip!) ?? [];
      list.push(timer);
      this.tlsLiteral.set(ip!, list);
      return;
    }
    if (message.startsWith("tls sni ")) {
      // The line doesn't name the connection: attribute it to a recent hostname connection first, else to
      // the newest bare-IP one (client set SNI itself, e.g. curl --connect-to), whose request gets logged.
      const cutoff = Date.now() - 5_000;
      while (this.syntheticTls.length > 0 && this.syntheticTls[0]! < cutoff) this.syntheticTls.shift();
      if (this.syntheticTls.shift() !== undefined) return;
      const last = [...this.tlsLiteral.entries()].at(-1);
      if (last) this.dropTlsTimer(last[0], last[1].at(-1)!, true);
      return;
    }
    m = /^tcp blocked \S+ -> (\S+):(\d+) \((\w+)\)/.exec(message);
    if (m) {
      const [, ip, port, proto] = m;
      this.emitRaw({ method: proto!.toUpperCase(), url: `tcp://${ip}:${port}`, host: ip!, ip, reason: `${proto} connection dropped: only HTTP and HTTPS are proxied` });
      return;
    }
    m = /^udp blocked \S+ -> (\S+):(\d+)/.exec(message);
    if (m) {
      const [, ip, port] = m;
      this.emitRaw({ method: "UDP", url: `udp://${ip}:${port}`, host: ip!, ip, reason: "UDP dropped: only DNS (synthetic) is answered" });
      return;
    }
    m = /^dns blocked \(non-dns payload\) \S+ -> (\S+):(\d+)/.exec(message);
    if (m) {
      const [, ip, port] = m;
      this.emitRaw({ method: "UDP", url: `udp://${ip}:${port}`, host: ip!, ip, reason: "non-DNS payload on port 53 dropped" });
    }
  }

  /**
   * Non-HTTP TCP that Gondolin rejects while sniffing (unknown protocol, CONNECT, sniff limit) only raises a
   * "tcp-deny" event on its internal network stack, with no debug line. Subscribe through the VM internals
   * (pinned 0.14.0: vm.server.network.stack, which is recreated on every guest socket attach). Call between
   * VM.create() and start(). Returns false if the internals moved, in which case those drops go unlogged.
   */
  watchStack(vm: unknown): boolean {
    type Stack = { on?: (event: string, fn: (e: { key?: string; reason?: string }) => void) => void };
    type Backend = { stack?: Stack; resetStack?: () => void };
    const network = (vm as { server?: { network?: Backend | null } }).server?.network;
    if (!network || typeof network.resetStack !== "function") return false;
    const listen = (stack: Stack | undefined) => stack?.on?.("tcp-deny", (e) => this.onTcpDeny(e.key ?? "", e.reason ?? ""));
    const reset = network.resetStack;
    network.resetStack = function (this: Backend) {
      reset.call(this);
      listen(this.stack);
    };
    listen(network.stack);
    return true;
  }

  private onTcpDeny(key: string, reason: string): void {
    if (reason === "policy-deny") return; // already logged from the "tcp blocked" debug line
    const m = /^TCP:[^:]+:\d+:(.+):(\d+)$/.exec(key);
    const ip = m?.[1];
    const port = m?.[2];
    const url = ip ? `tcp://${ip}:${port}` : "";
    if (reason === "connect-not-allowed") {
      this.emitRaw({ method: "CONNECT", url, host: ip ?? "", ip, reason: "HTTP CONNECT (proxy tunnel) not allowed" });
    } else if (reason === "unknown-protocol") {
      this.emitRaw({ method: "TCP", url, host: ip ?? "", ip, reason: "non-HTTP TCP dropped: only HTTP and HTTPS are proxied" });
    } else {
      this.emitRaw({ method: "TCP", url, host: ip ?? "", ip, reason: `TCP flow dropped (${reason})` });
    }
  }

  private emit(a: Omit<NetAttempt, "ts"> & { ts?: number }): void {
    const attempt = { ts: Date.now(), ...a } as NetAttempt;
    for (const l of this.listeners) {
      try {
        l(attempt);
      } catch {
        // listener errors must not break guest networking
      }
    }
  }

  /** Rate-limited deny log for raw (non-HTTP) flows, so a port scan can't flood the trace. */
  private emitRaw(a: { method: string; url: string; host: string; ip?: string; reason: string }): void {
    const sec = Math.floor(Date.now() / 1000);
    if (sec !== this.rawWindow) {
      if (this.rawSuppressed > 0) {
        this.emit({ method: "RAW", url: "", host: "", decision: "deny", reason: `${this.rawSuppressed} more dropped non-HTTP flows not logged (rate limit)` });
      }
      this.rawWindow = sec;
      this.rawCount = 0;
      this.rawSuppressed = 0;
    }
    if (++this.rawCount > RAW_LOG_PER_SEC) {
      this.rawSuppressed++;
      return;
    }
    this.emit({ ...a, decision: "deny" });
  }

  private dropTlsTimer(ip: string, timer: NodeJS.Timeout, cancel = false): void {
    if (cancel) clearTimeout(timer);
    const list = this.tlsLiteral.get(ip);
    if (!list) return;
    const i = list.indexOf(timer);
    if (i !== -1) list.splice(i, 1);
    if (list.length === 0) this.tlsLiteral.delete(ip);
  }

  private async decide(method: string, url: string): Promise<boolean> {
    const mode = this.mode;
    const d = await resolveAndCheck(mode, { method, url }, this.lookup);
    const pendingTls = this.tlsLiteral.get(d.host)?.[0];
    if (pendingTls) this.dropTlsTimer(d.host, pendingTls, true); // bare-IP TLS completed; this entry covers it
    const ip = d.ips.find((x) => !isPublicIp(x)) ?? d.ips[0];
    if (!d.allow) {
      this.emit({ method, url, host: d.host, ip, decision: "deny", reason: d.reason });
      return false;
    }
    const key = pendingKey(method, url);
    const list = this.pending.get(key) ?? [];
    list.push({ ts: Date.now(), method, url, host: d.host, ip, reason: d.reason });
    this.pending.set(key, list);
    return true;
  }

  private checkIp(info: HttpIpAllowInfo): boolean {
    if (this.mode === "off") return false;
    if (isPublicIp(info.ip)) return true;
    // Only reachable if DNS changed between our check and Gondolin's (rebinding): log and drop the pending record.
    const host = info.hostname.toLowerCase();
    let rec: Pending | undefined;
    for (const [key, list] of this.pending) {
      const i = list.findIndex((p) => p.host === host);
      if (i !== -1) {
        rec = list.splice(i, 1)[0];
        if (list.length === 0) this.pending.delete(key);
        break;
      }
    }
    const category = addressCategory(info.ip) ?? "metadata";
    this.emit({
      method: rec?.method ?? "CONNECT",
      url: rec?.url ?? `${info.protocol}://${info.hostname}:${info.port}/`,
      host,
      ip: info.ip,
      decision: "deny",
      reason: `${host} resolves to ${category} address ${info.ip} at connect time`,
    });
    return false;
  }

  private take(method: string, url: string): Pending | undefined {
    const key = pendingKey(method, url);
    const list = this.pending.get(key);
    const rec = list?.shift();
    if (list && list.length === 0) this.pending.delete(key);
    return rec;
  }

  private async upstream(input: unknown, init: Record<string, unknown>): Promise<UndiciResponse> {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : String((input as { url?: string }).url);
    const method = String(init.method ?? "GET").toUpperCase();
    const rec = this.take(method, url) ?? { ts: Date.now(), method, url, host: new URL(url).hostname, reason: `allowed: ${this.mode}` };
    if (this.mode === "off") {
      this.emit({ ...rec, decision: "deny", reason: "mode off" });
      throw new Error("blocked by policy: mode off");
    }
    const bytesOut = bodySize(init.body);
    let res: UndiciResponse;
    try {
      res = await undiciFetch(url, { ...(init as object), dispatcher: this.agent } as never);
    } catch (err) {
      const e = err as { cause?: { code?: string; message?: string }; message?: string };
      if (e.cause?.code === "EPOLICY") {
        // Connect-time lookup returned an internal address (DNS rebinding): nothing was sent.
        const why = (e.cause.message ?? "").replace(/^blocked by policy: /, "");
        const ip = /(\S+)$/.exec(why)?.[1];
        this.emit({ ...rec, ip, decision: "deny", reason: `${why} at connect time`, bytesOut: 0 });
        throw err;
      }
      const detail = e.cause?.code ?? e.cause?.message ?? e.message ?? "error";
      this.emit({ ...rec, decision: "allow", reason: `${rec.reason}; upstream failed: ${detail}`, bytesOut });
      throw err;
    }
    const status = res.status;
    if (!res.body || NULL_BODY_STATUS.has(status) || method === "HEAD") {
      if (res.body) await res.body.cancel().catch(() => {});
      this.emit({ ...rec, decision: "allow", status, bytesIn: 0, bytesOut });
      return new UndiciResponse(null, { status, statusText: res.statusText, headers: res.headers });
    }
    const reader = res.body.getReader();
    let bytesIn = 0;
    let done = false;
    const finish = (note?: string) => {
      if (done) return;
      done = true;
      this.emit({ ...rec, decision: "allow", reason: note ? `${rec.reason}; ${note}` : rec.reason, status, bytesIn, bytesOut });
    };
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const r = await reader.read();
          if (r.done) {
            finish();
            controller.close();
            return;
          }
          bytesIn += r.value.byteLength;
          controller.enqueue(r.value);
        } catch (err) {
          finish("response body failed");
          controller.error(err);
        }
      },
      cancel(reason) {
        finish("response body cancelled");
        return reader.cancel(reason);
      },
    });
    return new UndiciResponse(body as never, { status, statusText: res.statusText, headers: res.headers });
  }

  private sweepOrphans(all = false): void {
    const cutoff = Date.now() - ORPHAN_MS;
    for (const [key, list] of this.pending) {
      while (list.length > 0 && (all || list[0]!.ts < cutoff)) {
        const p = list.shift()!;
        this.emit({ ...p, decision: "allow", reason: `${p.reason}; never sent upstream (guest closed or DNS failed)` });
      }
      if (list.length === 0) this.pending.delete(key);
    }
  }
}

/** The hook sees the request's raw URL, the upstream fetch its `new URL()` form: key both the same way. */
function pendingKey(method: string, url: string): string {
  try {
    return `${method.toUpperCase()} ${new URL(url).href}`;
  } catch {
    return `${method.toUpperCase()} ${url}`;
  }
}

function bodySize(body: unknown): number | undefined {
  if (body == null) return 0;
  if (body instanceof Uint8Array) return body.byteLength;
  if (typeof body === "string") return Buffer.byteLength(body);
  return undefined; // streamed body: size unknown up front
}
