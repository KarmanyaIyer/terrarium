// just-bash worker: one per sim env, spawned by SimRuntime under sandbox-exec (no network, no file writes,
// no home-folder reads outside the app code). Talks JSON lines on stdin/stdout; console output goes to stderr.

import { createHash } from "node:crypto";
import { createInterface } from "node:readline";
import { Bash, getCommandNames, getJavaScriptCommandNames, getNetworkCommandNames, getPythonCommandNames, InMemoryFs, NetworkAccessDeniedError } from "just-bash";
import type { FsEntryWire, HostRequest, WireFetchResult, WorkerConfig, WorkerExecResult, WorkerMessage } from "./protocol.ts";
import { DUMP_CHUNK_BYTES, MAX_LINE } from "./protocol.ts";

// Keep stdout for the protocol only.
for (const k of ["log", "info", "warn", "debug", "error", "trace"] as const) {
  console[k] = (...args: unknown[]) => process.stderr.write(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ") + "\n");
}

const SKIP_DUMP = ["/bin", "/usr/bin", "/proc", "/dev", "/sys"];
const HEAVY = new Set(["node_modules", ".venv", "venv", "__pycache__", ".cache", ".git", ".mypy_cache", ".pytest_cache", "target", "dist"]);

let config: WorkerConfig = { python: false, javascript: false, maxTotalBytes: 64 * 1024 * 1024 };
let fs = new InMemoryFs(undefined, { maxTotalBytes: config.maxTotalBytes });
let bash: Bash;
const execs = new Map<number, AbortController>();
const hashCache = new Map<string, { mt: number; size: number; sha: string }>();
let nextFetch = 1;
const fetches = new Map<number, { url: string; resolve: (r: WireFetchResult) => void; reject: (e: Error) => void }>();

function send(msg: WorkerMessage): void {
  const line = JSON.stringify(msg);
  if (Buffer.byteLength(line) > MAX_LINE) throw new Error(`message exceeds ${MAX_LINE} bytes`);
  process.stdout.write(line + "\n");
}

async function rpcFetch(url: string, options: { method?: string; headers?: Headers | Record<string, string>; body?: string | Uint8Array; followRedirects?: boolean; timeoutMs?: number; maxRedirects?: number } = {}) {
  const reqId = nextFetch++;
  const headers: Record<string, string> = {};
  if (options.headers instanceof Headers) options.headers.forEach((v, k) => (headers[k] = v));
  else Object.assign(headers, options.headers ?? {});
  const body = options.body === undefined ? undefined : Buffer.from(options.body as any).toString("base64");
  const result = await new Promise<WireFetchResult>((resolve, reject) => {
    fetches.set(reqId, { url, resolve, reject });
    send({ type: "fetch", reqId, url, method: options.method ?? "GET", headers, body, followRedirects: options.followRedirects !== false, timeoutMs: options.timeoutMs, maxRedirects: options.maxRedirects });
  });
  return { ...result, body: new Uint8Array(Buffer.from(result.body, "base64")) };
}

function makeBash(): Bash {
  return new Bash({
    fs,
    cwd: "/workspace",
    env: { HOME: "/workspace", USER: "agent", LOGNAME: "agent", PWD: "/workspace" },
    python: config.python,
    javascript: config.javascript,
    fetch: rpcFetch as any,
    executionLimitProfile: "hardened",
    executionLimits: { maxExecutionTimeMs: 300_000, maxFileSystemBytes: config.maxTotalBytes },
    defenseInDepth: true,
  });
}

function clip(text: string, max: number): { text: string; truncated: boolean } {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= max) return { text, truncated: false };
  const half = Math.floor(max / 2);
  const dropped = bytes.length - 2 * half;
  return { text: `${bytes.subarray(0, half).toString("utf8")}\n[... ${dropped} bytes dropped ...]\n${bytes.subarray(bytes.length - half).toString("utf8")}`, truncated: true };
}

function decodeOut(s: string, kind?: string): string {
  return kind === "bytes" ? Buffer.from(s, "latin1").toString("utf8") : s;
}

async function exec(req: Extract<HostRequest, { op: "exec" }>): Promise<WorkerExecResult> {
  const ac = new AbortController();
  execs.set(req.id, ac);
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ac.abort();
  }, req.timeoutMs);
  const started = performance.now();
  try {
    const r = (await bash.exec(req.command, { cwd: req.cwd ?? "/workspace", stdin: req.stdin, signal: ac.signal })) as any;
    const out = clip(decodeOut(r.stdout ?? "", r.stdoutKind), req.maxOutputBytes);
    const err = clip(r.stderr ?? "", req.maxOutputBytes);
    const aborted = ac.signal.aborted;
    return {
      exitCode: timedOut ? 124 : aborted ? 130 : (r.exitCode ?? 0),
      stdout: out.text,
      stderr: err.text + (timedOut ? `\n[terrarium: command timed out after ${req.timeoutMs} ms]` : ""),
      durationMs: Math.round(performance.now() - started),
      truncated: out.truncated || err.truncated,
      timedOut,
    };
  } catch (e) {
    return {
      exitCode: timedOut ? 124 : ac.signal.aborted ? 130 : 1,
      stdout: "",
      stderr: `just-bash: ${(e as Error).message}`,
      durationMs: Math.round(performance.now() - started),
      truncated: false,
      timedOut,
    };
  } finally {
    clearTimeout(timer);
    execs.delete(req.id);
  }
}

function underRoot(p: string, root: string): boolean {
  return p === root || p.startsWith(root.endsWith("/") ? root : root + "/");
}

async function manifest(root: string, maxEntries: number) {
  const entries: any[] = [];
  let truncated = false;
  const paths = fs.getAllPaths().filter((p) => underRoot(p, root)).sort();
  for (const path of paths) {
    if (entries.length >= maxEntries) {
      truncated = true;
      break;
    }
    let st;
    try {
      st = await fs.lstat(path);
    } catch {
      continue;
    }
    const type = st.isSymbolicLink ? "symlink" : st.isDirectory ? "dir" : st.isFile ? "file" : "other";
    const mt = st.mtime.getTime();
    const rel = path.slice(root.length).split("/");
    const heavy = rel.some((seg) => HEAVY.has(seg));
    const entry: any = { path, type, size: type === "file" ? st.size : 0, mode: st.mode, mtimeNs: String(BigInt(mt) * 1_000_000n), ino: 0, nlink: 1 };
    if (heavy) entry.heavy = true;
    if (type === "symlink") entry.linkTarget = await fs.readlink(path).catch(() => undefined);
    if (type === "file" && !heavy) {
      const hit = hashCache.get(path);
      if (hit && hit.mt === mt && hit.size === st.size) entry.sha256 = hit.sha;
      else {
        const sha = createHash("sha256").update(await fs.readFileBuffer(path)).digest("hex");
        hashCache.set(path, { mt, size: st.size, sha });
        entry.sha256 = sha;
      }
    }
    entries.push(entry);
  }
  return { root, takenAt: Date.now(), entries, truncated };
}

async function dump(id: number): Promise<{ count: number; bytes: number }> {
  let chunk: FsEntryWire[] = [];
  let chunkBytes = 0;
  let count = 0;
  let bytes = 0;
  for (const p of fs.getAllPaths().sort()) {
    if (p === "/" || SKIP_DUMP.some((s) => underRoot(p, s))) continue;
    const st = await fs.lstat(p).catch(() => null);
    if (!st) continue;
    const e: FsEntryWire = { p, t: st.isSymbolicLink ? "l" : st.isDirectory ? "d" : "f", m: st.mode, mt: st.mtime.getTime() };
    if (e.t === "l") e.l = await fs.readlink(p);
    if (e.t === "f") {
      const data = await fs.readFileBuffer(p);
      e.d = Buffer.from(data).toString("base64");
      bytes += data.length;
    }
    const size = (e.d?.length ?? 0) + p.length + 64;
    if (chunkBytes + size > DUMP_CHUNK_BYTES && chunk.length) {
      send({ type: "chunk", id, entries: chunk });
      chunk = [];
      chunkBytes = 0;
    }
    chunk.push(e);
    chunkBytes += size;
    count++;
  }
  if (chunk.length) send({ type: "chunk", id, entries: chunk });
  return { count, bytes };
}

async function load(entries: FsEntryWire[], reset: boolean): Promise<void> {
  if (reset) {
    fs = new InMemoryFs(undefined, { maxTotalBytes: config.maxTotalBytes });
    hashCache.clear();
    bash = makeBash();
  }
  const links: FsEntryWire[] = [];
  for (const e of entries) {
    if (e.t === "d") await fs.mkdir(e.p, { recursive: true });
    else if (e.t === "f") {
      await fs.mkdir(e.p.slice(0, e.p.lastIndexOf("/")) || "/", { recursive: true });
      await fs.writeFile(e.p, new Uint8Array(Buffer.from(e.d ?? "", "base64")));
    } else links.push(e);
    if (e.t !== "l") {
      await fs.chmod(e.p, e.m & 0o7777).catch(() => {});
      await fs.utimes(e.p, new Date(e.mt), new Date(e.mt)).catch(() => {});
    }
  }
  for (const e of links) {
    await fs.mkdir(e.p.slice(0, e.p.lastIndexOf("/")) || "/", { recursive: true });
    await fs.symlink(e.l ?? "", e.p).catch(() => {});
  }
}

async function handle(req: HostRequest): Promise<unknown> {
  switch (req.op) {
    case "init":
      config = req.config;
      fs = new InMemoryFs(undefined, { maxTotalBytes: config.maxTotalBytes });
      bash = makeBash();
      await fs.mkdir("/workspace", { recursive: true });
      return { ok: true };
    case "exec":
      return exec(req);
    case "abort":
      execs.get(req.execId)?.abort();
      return { ok: true };
    case "readFile": {
      const st = await fs.stat(req.path);
      if (st.isDirectory) throw new Error(`${req.path}: is a directory`);
      const data = await fs.readFileBuffer(req.path);
      const slice = data.subarray(0, req.maxBytes);
      return { data: Buffer.from(slice).toString("base64"), size: data.length, truncated: data.length > req.maxBytes };
    }
    case "writeFile": {
      const dir = req.path.slice(0, req.path.lastIndexOf("/")) || "/";
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(req.path, new Uint8Array(Buffer.from(req.data, "base64")));
      if (req.mode !== undefined) await fs.chmod(req.path, req.mode);
      return { ok: true };
    }
    case "manifest":
      return manifest(req.root, req.maxEntries);
    case "dump":
      return dump(req.id);
    case "load":
      await load(req.entries, req.reset);
      await fs.mkdir("/workspace", { recursive: true });
      return { ok: true };
    case "facts": {
      const commands = [...getCommandNames(), ...getNetworkCommandNames(), ...(config.python ? getPythonCommandNames() : []), ...(config.javascript ? getJavaScriptCommandNames() : [])];
      let totalBytes = 0;
      for (const p of fs.getAllPaths()) {
        const st = await fs.lstat(p).catch(() => null);
        if (st?.isFile) totalBytes += st.size;
      }
      return { commands: [...new Set(commands)].sort(), totalBytes, node: process.version };
    }
    case "fetchResult": {
      const f = fetches.get(req.reqId);
      if (f) {
        fetches.delete(req.reqId);
        if (req.ok) f.resolve(req.result);
        else f.reject(req.denied ? new NetworkAccessDeniedError(f.url, req.error) : new Error(req.error));
      }
      return undefined;
    }
  }
}

bash = makeBash();
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line) => {
  let req: HostRequest;
  try {
    req = JSON.parse(line);
  } catch {
    process.stderr.write("worker: bad message\n");
    return;
  }
  handle(req).then(
    (result) => {
      if (req.op !== "fetchResult") send({ type: "reply", id: req.id, ok: true, result });
    },
    (err) => send({ type: "reply", id: req.id, ok: false, error: (err as Error).message ?? String(err) }),
  );
});
rl.on("close", () => process.exit(0));
process.on("uncaughtException", (err) => {
  process.stderr.write(`worker uncaught: ${err.stack ?? err.message}\n`);
  process.exit(70);
});
send({ type: "ready" });
