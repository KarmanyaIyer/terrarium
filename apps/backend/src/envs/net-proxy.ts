// Host-side HTTP client for sim envs. Every hop: resolve DNS, ask the policy engine (with resolved IPs),
// connect to the checked IP only (no second lookup, so no DNS rebinding), log the attempt either way.

import { lookup } from "node:dns/promises";
import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import type { NetworkMode } from "@terrarium/shared";
import type { NetAttempt } from "./types.ts";
import type { PolicyModule } from "./policy.ts";

export interface ProxyRequest {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: Uint8Array;
  followRedirects?: boolean;
  timeoutMs?: number;
  maxRedirects?: number;
}

export interface ProxyResponse {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: Uint8Array;
  url: string;
  redirectChain?: { status: number; statusText: string; headers: Record<string, string> }[];
}

export class NetDenied extends Error {
  url: string;
  reason: string;
  constructor(url: string, reason: string) {
    super(`network access denied: ${reason}`);
    this.url = url;
    this.reason = reason;
  }
}

const MAX_BODY = 16 * 1024 * 1024;
const HOP_HEADERS = new Set(["host", "connection", "keep-alive", "proxy-connection", "transfer-encoding", "upgrade", "te", "trailer", "proxy-authorization"]);

function flatHeaders(h: IncomingHttpHeaders): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) if (v !== undefined) out[k] = Array.isArray(v) ? v.join(", ") : v;
  return out;
}

export async function proxyFetch(
  mode: () => NetworkMode,
  policy: PolicyModule,
  req: ProxyRequest,
  onAttempt: (a: NetAttempt) => void,
): Promise<ProxyResponse> {
  let url = req.url;
  let method = (req.method ?? "GET").toUpperCase();
  let body = req.body;
  const chain: ProxyResponse["redirectChain"] = [];
  const maxRedirects = Math.min(req.maxRedirects ?? 5, 10);
  for (let hop = 0; ; hop++) {
    const res = await oneHop(mode(), policy, { ...req, url, method, body }, onAttempt);
    const location = res.headers.location;
    if (req.followRedirects !== false && res.status >= 300 && res.status < 400 && location && hop < maxRedirects) {
      chain.push({ status: res.status, statusText: res.statusText, headers: res.headers });
      url = new URL(location, url).href;
      if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === "POST")) {
        method = "GET";
        body = undefined;
      }
      continue;
    }
    return chain.length ? { ...res, redirectChain: chain } : res;
  }
}

async function oneHop(mode: NetworkMode, policy: PolicyModule, req: ProxyRequest & { method: string }, onAttempt: (a: NetAttempt) => void): Promise<ProxyResponse> {
  const ts = Date.now();
  const base = { ts, method: req.method, url: req.url };
  let parsed: URL;
  try {
    parsed = new URL(req.url);
  } catch {
    onAttempt({ ...base, host: "", decision: "deny", reason: "invalid URL" });
    throw new NetDenied(req.url, "invalid URL");
  }
  const host = parsed.hostname.replace(/^\[|\]$/g, "");
  const attempt = { ...base, host };
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    onAttempt({ ...attempt, decision: "deny", reason: `scheme ${parsed.protocol} not allowed` });
    throw new NetDenied(req.url, `scheme ${parsed.protocol} not allowed`);
  }
  // Mode "off" never needs DNS: deny before resolving so no lookup leaves the machine.
  let ips: string[] = [];
  if (mode !== "off") {
    if (isIP(host)) ips = [host];
    else {
      try {
        ips = (await lookup(host, { all: true, verbatim: true })).map((a) => a.address);
      } catch (err) {
        const reason = `DNS lookup failed (${(err as NodeJS.ErrnoException).code ?? "error"})`;
        onAttempt({ ...attempt, decision: "deny", reason });
        throw new NetDenied(req.url, reason);
      }
    }
  }
  const verdict = policy.checkRequest(mode, { method: req.method, url: req.url, resolvedIps: ips });
  const nonPublic = ips.find((ip) => !policy.isPublicIp(ip));
  if (!verdict.allow || nonPublic) {
    const reason = verdict.allow ? `non-public address ${nonPublic}` : verdict.reason;
    onAttempt({ ...attempt, ip: nonPublic ?? ips[0], decision: "deny", reason });
    throw new NetDenied(req.url, reason);
  }
  const ip = ips[0];
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers ?? {})) if (!HOP_HEADERS.has(k.toLowerCase())) headers[k] = v;
  const bytesOut = req.body?.length ?? 0;
  try {
    const res = await new Promise<ProxyResponse>((resolve, reject) => {
      const doRequest = parsed.protocol === "https:" ? httpsRequest : httpRequest;
      const r = doRequest(
        {
          protocol: parsed.protocol,
          hostname: host,
          port: parsed.port || undefined,
          path: parsed.pathname + parsed.search,
          method: req.method,
          headers: { ...headers, ...(bytesOut ? { "content-length": String(bytesOut) } : {}) },
          servername: isIP(host) ? undefined : host,
          lookup: (_h: string, opts: any, cb: any) => {
            const family = isIP(ip);
            if (opts?.all) cb(null, [{ address: ip, family }]);
            else cb(null, ip, family);
          },
          timeout: Math.min(req.timeoutMs ?? 30_000, 60_000),
        },
        (res) => {
          const parts: Buffer[] = [];
          let size = 0;
          res.on("data", (c: Buffer) => {
            size += c.length;
            if (size > MAX_BODY) {
              r.destroy(new Error(`response larger than ${MAX_BODY} bytes`));
              return;
            }
            parts.push(c);
          });
          res.on("end", () => resolve({ status: res.statusCode ?? 0, statusText: res.statusMessage ?? "", headers: flatHeaders(res.headers), body: Buffer.concat(parts), url: req.url }));
          res.on("error", reject);
        },
      );
      r.on("timeout", () => r.destroy(new Error("request timed out")));
      r.on("error", reject);
      if (req.body?.length) r.write(req.body);
      r.end();
    });
    onAttempt({ ...attempt, ip, decision: "allow", reason: verdict.reason, status: res.status, bytesIn: res.body.length, bytesOut });
    return res;
  } catch (err) {
    onAttempt({ ...attempt, ip, decision: "allow", reason: `${verdict.reason}; failed: ${(err as Error).message}`, bytesOut });
    throw err;
  }
}
