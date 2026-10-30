// Host side of a sim env: owns the sandboxed just-bash child, its persisted filesystem (dir/state.json), the
// network RPC (policy-checked, performed here), and hang recovery (kill + restart from the last checkpoint).

import { type ChildProcess, spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import type { EnvFacts, NetworkMode, SimConfig } from "@terrarium/shared";
import { SRC_EXT, VERSIONS } from "../../config.ts";
import { logger } from "../../util/log.ts";
import { processStats } from "../../util/sysmem.ts";
import { NetDenied, proxyFetch } from "../net-proxy.ts";
import { policy } from "../policy.ts";
import type { EnvRuntime, ExecOptions, ExecOutcome, Manifest, NetAttempt, ReadResult } from "../types.ts";
import { DUMP_CHUNK_BYTES, FILE_PIECE_BYTES, type FsEntryWire, type HostRequest, MAX_LINE, type WorkerExecResult, type WorkerMessage } from "./protocol.ts";
import { buildProfile, nodeExecutable, SANDBOX_EXEC } from "./sandbox.ts";

const log = logger("sim");
const WORKER = new URL(`./worker${SRC_EXT}`, import.meta.url).pathname;
const HANG_GRACE_MS = 10_000;
const DEFAULT_TIMEOUT = 120_000;
const READ_BATCH_BYTES = 64 * 1024 * 1024;

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
type Pending = { resolve: (v: any) => void; reject: (e: Error) => void; chunks?: FsEntryWire[]; timer?: NodeJS.Timeout };

export interface StateFile {
  version: 1;
  entries: FsEntryWire[];
}

/** State files written before pieces existed (and seeds) can hold one entry per whole file: split it. */
function splitEntry(e: FsEntryWire): FsEntryWire[] {
  const step = (FILE_PIECE_BYTES / 3) * 4; // base64 chars per piece, a multiple of 4
  if (e.t !== "f" || !e.d || e.d.length <= step) return [e];
  const out: FsEntryWire[] = [];
  for (let i = 0; i < e.d.length; i += step) out.push({ ...e, d: e.d.slice(i, i + step), ...(i || e.a ? { a: 1 as const } : {}) });
  return out;
}

export function seedState(seedFiles: { path: string; content: string }[] = []): StateFile {
  const now = Date.now();
  const entries: FsEntryWire[] = [{ p: "/workspace", t: "d", m: 0o755, mt: now }];
  for (const f of seedFiles) {
    const p = normalizePath(f.path);
    entries.push({ p, t: "f", m: 0o644, mt: now, d: Buffer.from(f.content, "utf8").toString("base64") });
  }
  return { version: 1, entries };
}

export function normalizePath(p: string, cwd = "/workspace"): string {
  const abs = posix.isAbsolute(p) ? p : posix.join(cwd, p);
  return posix.normalize(abs).replace(/\/+$/, "") || "/";
}

function writeAtomic(path: string, data: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, data, { mode: 0o600 });
  renameSync(tmp, path);
}

export class SimRuntime implements EnvRuntime {
  readonly id: string;
  readonly type = "sim" as const;
  readonly dir: string;
  private config: SimConfig;
  private network: NetworkMode;
  private child: ChildProcess | null = null;
  private ready = false;
  private starting: Promise<void> | null = null;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private listeners = new Set<(a: NetAttempt) => void>();
  private stderrTail: string[] = [];
  private sandboxed = true;

  constructor(id: string, dir: string, config: SimConfig, network: NetworkMode) {
    this.id = id;
    this.dir = dir;
    this.config = config;
    this.network = network;
  }

  get statePath(): string {
    return join(this.dir, "state.json");
  }

  get pid(): number | undefined {
    return this.child?.pid;
  }

  isRunning(): boolean {
    return this.ready && this.child !== null;
  }

  start(): Promise<void> {
    if (this.isRunning()) return Promise.resolve();
    if (!this.starting) this.starting = this.spawnChild().finally(() => (this.starting = null));
    return this.starting;
  }

  private async spawnChild(): Promise<void> {
    if (!existsSync(SANDBOX_EXEC)) throw new Error(`${SANDBOX_EXEC} not found: refusing to run just-bash without the OS sandbox`);
    const node = nodeExecutable();
    const args = ["-p", buildProfile(), node, "--max-old-space-size=768", "--disable-warning=ExperimentalWarning", WORKER];
    const child = spawn(SANDBOX_EXEC, args, {
      cwd: "/",
      stdio: ["pipe", "pipe", "pipe"],
      // Homebrew Node otherwise opens a formula-owned OpenSSL config outside its install prefix. The worker
      // needs no host TLS configuration, and /dev/null is already the only writable/readable device it uses.
      env: { PATH: "/usr/bin:/bin", LANG: "en_US.UTF-8", TZ: "UTC", OPENSSL_CONF: "/dev/null" },
    });
    this.child = child;
    this.ready = false;
    const readyP = new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`sim worker did not start: ${this.stderrTail.slice(-3).join(" | ")}`)), 20_000);
      this.pending.set(0, { resolve: (v) => (clearTimeout(t), resolve(v)), reject: (e) => (clearTimeout(t), reject(e)) });
    });
    let buf = "";
    child.stdout!.setEncoding("utf8");
    child.stdout!.on("data", (text: string) => {
      buf += text;
      if (buf.length > MAX_LINE && !buf.includes("\n")) {
        log.error(`sim ${this.id}: worker line exceeds ${MAX_LINE} bytes; killing`);
        child.kill("SIGKILL");
        return;
      }
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line) this.onMessage(line);
      }
    });
    child.stderr!.setEncoding("utf8");
    child.stderr!.on("data", (text: string) => {
      for (const l of text.split("\n")) if (l.trim()) this.stderrTail.push(l.slice(0, 400));
      if (this.stderrTail.length > 30) this.stderrTail.splice(0, this.stderrTail.length - 30);
    });
    child.on("exit", (code, signal) => {
      if (this.child === child) {
        this.child = null;
        this.ready = false;
      }
      const err = new Error(`sim worker exited (code ${code ?? signal}): ${this.stderrTail.slice(-3).join(" | ")}`);
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(err);
      }
      this.pending.clear();
      if (code !== 0 && signal !== "SIGTERM" && signal !== "SIGKILL") log.warn(err.message);
    });
    child.stdin!.on("error", () => {});
    await readyP;
    await this.request({ op: "init", config: { python: this.config.python, javascript: this.config.javascript, maxTotalBytes: this.config.maxTotalBytes } });
    if (existsSync(this.statePath)) await this.loadState(JSON.parse(readFileSync(this.statePath, "utf8")) as StateFile);
    this.ready = true;
  }

  private onMessage(line: string): void {
    let msg: WorkerMessage;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg.type === "ready") {
      this.pending.get(0)?.resolve(undefined);
      this.pending.delete(0);
    } else if (msg.type === "chunk") {
      this.pending.get(msg.id)?.chunks?.push(...msg.entries);
    } else if (msg.type === "reply") {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.ok) p.resolve(p.chunks ? { result: msg.result, entries: p.chunks } : msg.result);
      else p.reject(new Error(msg.error));
    } else if (msg.type === "fetch") {
      void this.handleFetch(msg);
    }
  }

  private send(req: HostRequest): void {
    const line = JSON.stringify(req);
    if (Buffer.byteLength(line) > MAX_LINE) throw new Error(`request exceeds ${MAX_LINE} bytes`);
    this.child!.stdin!.write(line + "\n");
  }

  private request<T = any>(req: DistributiveOmit<HostRequest, "id">, opts: { timeoutMs?: number; collect?: boolean } = {}): Promise<T> {
    if (!this.child) return Promise.reject(new Error("sim env is not running"));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const p: Pending = { resolve, reject, chunks: opts.collect ? [] : undefined };
      if (opts.timeoutMs) p.timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`sim worker did not answer ${req.op} within ${opts.timeoutMs} ms`));
      }, opts.timeoutMs);
      this.pending.set(id, p);
      try {
        this.send({ ...req, id } as HostRequest);
      } catch (err) {
        this.pending.delete(id);
        clearTimeout(p.timer);
        reject(err as Error);
      }
    });
  }

  private async handleFetch(msg: Extract<WorkerMessage, { type: "fetch" }>): Promise<void> {
    const reply = (r: DistributiveOmit<Extract<HostRequest, { op: "fetchResult" }>, "id" | "op">) => {
      if (this.child) this.send({ id: this.nextId++, op: "fetchResult", ...r } as HostRequest);
    };
    try {
      const res = await proxyFetch(
        () => this.network,
        policy,
        { url: msg.url, method: msg.method, headers: msg.headers, body: msg.body ? Buffer.from(msg.body, "base64") : undefined, followRedirects: msg.followRedirects, timeoutMs: msg.timeoutMs, maxRedirects: msg.maxRedirects },
        (a) => this.emitNet(a),
      );
      reply({ reqId: msg.reqId, ok: true, result: { ...res, body: Buffer.from(res.body).toString("base64") } });
    } catch (err) {
      reply({ reqId: msg.reqId, ok: false, error: err instanceof NetDenied ? err.reason : (err as Error).message, denied: err instanceof NetDenied });
    }
  }

  private emitNet(a: NetAttempt): void {
    for (const l of this.listeners) l(a);
  }

  private async loadState(state: StateFile): Promise<void> {
    let batch: FsEntryWire[] = [];
    let bytes = 0;
    let first = true;
    const flush = async () => {
      await this.request({ op: "load", entries: batch, reset: first }, { timeoutMs: 60_000 });
      first = false;
      batch = [];
      bytes = 0;
    };
    for (const e of state.entries.flatMap(splitEntry)) {
      const size = (e.d?.length ?? 0) + e.p.length + 64;
      if (bytes + size > DUMP_CHUNK_BYTES && batch.length) await flush();
      batch.push(e);
      bytes += size;
    }
    if (batch.length || first) await flush();
  }

  private async dumpState(): Promise<StateFile> {
    const { entries } = await this.request<{ entries: FsEntryWire[] }>({ op: "dump" }, { collect: true, timeoutMs: 60_000 });
    return { version: 1, entries };
  }

  /** Persist the in-memory filesystem to dir/state.json. */
  async checkpoint(): Promise<void> {
    if (!this.isRunning()) return;
    writeAtomic(this.statePath, JSON.stringify(await this.dumpState()));
  }

  async stop(): Promise<void> {
    const child = this.child;
    if (!child) return;
    try {
      if (this.ready) await this.checkpoint();
    } catch (err) {
      log.warn(`sim ${this.id}: checkpoint on stop failed`, err);
    }
    this.ready = false;
    const exited = new Promise<void>((r) => child.once("exit", () => r()));
    child.stdin!.end();
    const t = setTimeout(() => child.kill("SIGKILL"), 3000);
    await exited;
    clearTimeout(t);
    this.child = null;
  }

  private async restartAfterHang(): Promise<void> {
    const child = this.child;
    this.ready = false;
    if (child) {
      const exited = new Promise<void>((r) => child.once("exit", () => r()));
      child.kill("SIGKILL");
      await exited;
    }
    this.child = null;
    await this.start();
  }

  async exec(command: string, opts: ExecOptions = {}): Promise<ExecOutcome> {
    await this.start();
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT;
    const started = Date.now();
    const id = this.nextId; // the exec request id (assigned in request())
    const onAbort = () => {
      if (this.child) this.send({ id: this.nextId++, op: "abort", execId: id });
    };
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const r = await this.request<WorkerExecResult>(
        { op: "exec", command, cwd: opts.cwd, stdin: opts.stdin, timeoutMs, maxOutputBytes: opts.maxOutputBytes ?? 1024 * 1024 },
        { timeoutMs: timeoutMs + HANG_GRACE_MS },
      );
      // A failed save is part of the command's result: the agent and the trace both see it.
      const saveError = await this.checkpoint().then(
        () => "",
        (err: Error) => {
          log.warn(`sim ${this.id}: checkpoint failed`, err);
          return `${r.stderr && !r.stderr.endsWith("\n") ? "\n" : ""}[terrarium: saving the simulated filesystem failed (${err.message}); changes since the last save are lost if the env restarts]\n`;
        },
      );
      if (saveError) r.stderr += saveError;
      if (r.stdout) opts.onStdout?.(r.stdout);
      if (r.stderr) opts.onStderr?.(r.stderr);
      return r;
    } catch (err) {
      const msg = (err as Error).message;
      log.warn(`sim ${this.id}: exec failed, restarting worker from last checkpoint: ${msg}`);
      await this.restartAfterHang().catch((e) => log.error(`sim ${this.id}: restart failed`, e));
      const stderr = `[terrarium: the simulated shell stopped responding (${msg}); it was restarted from the last checkpoint and changes from this command were lost]`;
      opts.onStderr?.(stderr);
      return { exitCode: opts.signal?.aborted ? 130 : 124, stdout: "", stderr, durationMs: Date.now() - started, truncated: false, timedOut: !opts.signal?.aborted };
    } finally {
      opts.signal?.removeEventListener("abort", onAbort);
    }
  }

  async readFile(path: string, opts: { maxBytes?: number } = {}): Promise<ReadResult> {
    await this.start();
    const maxBytes = opts.maxBytes ?? 8 * 1024 * 1024;
    const parts: Buffer[] = [];
    let got = 0;
    for (;;) {
      const r = await this.request<{ data: string; size: number; truncated: boolean }>({ op: "readFile", path: normalizePath(path), maxBytes: maxBytes - got, offset: got }, { timeoutMs: 30_000 });
      const piece = Buffer.from(r.data, "base64");
      parts.push(piece);
      got += piece.length;
      if (!piece.length || got >= maxBytes || got >= r.size) return { data: new Uint8Array(Buffer.concat(parts)), size: r.size, truncated: r.size > got };
    }
  }

  async readFiles(paths: string[], opts: { maxBytes?: number; totalBytes?: number } = {}): Promise<(ReadResult | Error)[]> {
    const out: (ReadResult | Error)[] = [];
    let left = Math.max(0, opts.totalBytes ?? READ_BATCH_BYTES);
    const perFile = opts.maxBytes ?? 8 * 1024 * 1024;
    for (const p of paths) {
      if (left <= 0) {
        out.push(new Error(`read ${p}: batch read limit reached`));
        continue;
      }
      const r = await this.readFile(p, { maxBytes: Math.min(perFile, left) }).catch((err: unknown) => (err instanceof Error ? err : new Error(String(err))));
      out.push(r);
      if (!(r instanceof Error)) left -= r.data.byteLength;
    }
    return out;
  }

  /** just-bash runs nothing in the background once an exec returns. */
  async killAgentProcesses(): Promise<void> {}

  async writeFile(path: string, data: string | Uint8Array, opts: { as?: "agent" | "root"; mode?: number } = {}): Promise<void> {
    await this.start();
    const bytes = typeof data === "string" ? Buffer.from(data, "utf8") : Buffer.from(data);
    for (let off = 0; off === 0 || off < bytes.length; off += FILE_PIECE_BYTES) {
      const piece = bytes.subarray(off, off + FILE_PIECE_BYTES).toString("base64");
      await this.request({ op: "writeFile", path: normalizePath(path), data: piece, mode: opts.mode, append: off > 0 }, { timeoutMs: 30_000 });
    }
    await this.checkpoint();
  }

  async manifest(root = "/workspace"): Promise<Manifest> {
    await this.start();
    return this.request<Manifest>({ op: "manifest", root: normalizePath(root), maxEntries: 20_000 }, { timeoutMs: 60_000 });
  }

  async snapshot(destDir: string): Promise<{ bytes: number }> {
    mkdirSync(destDir, { recursive: true });
    const dest = join(destDir, "state.json");
    if (this.isRunning()) writeAtomic(dest, JSON.stringify(await this.dumpState()));
    else if (existsSync(this.statePath)) copyFileSync(this.statePath, dest);
    else writeAtomic(dest, JSON.stringify(seedState()));
    return { bytes: statSync(dest).size };
  }

  async restore(snapshotDir: string): Promise<void> {
    const src = join(snapshotDir, "state.json");
    if (!existsSync(src)) throw new Error(`snapshot has no state.json: ${snapshotDir}`);
    mkdirSync(this.dir, { recursive: true });
    copyFileSync(src, this.statePath);
    if (this.isRunning()) await this.loadState(JSON.parse(readFileSync(src, "utf8")) as StateFile);
  }

  async destroy(): Promise<void> {
    const child = this.child;
    this.ready = false;
    if (child) {
      const exited = new Promise<void>((r) => child.once("exit", () => r()));
      child.kill("SIGKILL");
      await exited;
    }
    this.child = null;
    rmSync(this.dir, { recursive: true, force: true });
  }

  async setNetwork(mode: NetworkMode): Promise<void> {
    this.network = mode;
  }

  onNet(listener: (attempt: NetAttempt) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async facts(): Promise<EnvFacts> {
    await this.start();
    const f = await this.request<{ commands: string[]; totalBytes: number; node: string }>({ op: "facts" }, { timeoutMs: 30_000 });
    return {
      kind: "sim",
      isolation: `Simulated shell (just-bash ${VERSIONS.justBash}, child process under sandbox-exec)`,
      os: "none: simulated, not a real OS",
      arch: "n/a (interpreted)",
      diskMiB: Math.round(this.config.maxTotalBytes / 1048576),
      diskUsedMiB: Math.round((f.totalBytes / 1048576) * 10) / 10,
      memoryMiB: 768,
      user: "agent (simulated; no real users or permissions)",
      workdir: "/workspace",
      mounts: [],
      hostFoldersMounted: false,
      tools: f.commands.filter((c) => ["python3", "python", "js-exec", "node", "curl", "sqlite3", "git", "jq"].includes(c)),
      simCommands: f.commands,
      runtimes: { python: this.config.python, javascript: this.config.javascript },
      gatheredAt: Date.now(),
    };
  }

  async resources(): Promise<{ rssBytes: number; cpuPct: number } | null> {
    if (!this.child?.pid) return null;
    // sandbox-exec execs node in place, so the child pid is the worker itself.
    return (await processStats([this.child.pid])).get(this.child.pid) ?? null;
  }

  sandboxActive(): boolean {
    return this.sandboxed;
  }
}
