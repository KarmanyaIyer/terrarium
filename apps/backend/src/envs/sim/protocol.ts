// JSON-lines protocol between SimRuntime (backend) and the just-bash worker child. One JSON object per line,
// each line at most MAX_LINE bytes. Binary data travels base64-encoded.

export const MAX_LINE = 16 * 1024 * 1024;
export const DUMP_CHUNK_BYTES = 4 * 1024 * 1024;
/** Files cross the pipe in pieces of this many raw bytes (4 MiB base64), so no line nears MAX_LINE. */
export const FILE_PIECE_BYTES = 3 * 1024 * 1024;

/** Serialized filesystem entry (snapshots, persistence). */
export interface FsEntryWire {
  p: string; // absolute path
  t: "f" | "d" | "l";
  m: number; // mode
  mt: number; // mtime ms
  d?: string; // base64 content (files)
  l?: string; // link target (symlinks)
  a?: 1; // appends a further piece to the file the previous entry for p started
}

export interface WorkerConfig {
  python: boolean;
  javascript: boolean;
  maxTotalBytes: number;
}

export type HostRequest =
  | { id: number; op: "init"; config: WorkerConfig }
  | { id: number; op: "exec"; command: string; cwd?: string; stdin?: string; timeoutMs: number; maxOutputBytes: number }
  | { id: number; op: "abort"; execId: number }
  | { id: number; op: "readFile"; path: string; maxBytes: number; offset?: number }
  | { id: number; op: "writeFile"; path: string; data: string; mode?: number; append?: boolean }
  | { id: number; op: "manifest"; root: string; maxEntries: number }
  | { id: number; op: "dump" }
  | { id: number; op: "load"; entries: FsEntryWire[]; reset: boolean }
  | { id: number; op: "facts" }
  | { id: number; op: "fetchResult"; reqId: number; ok: true; result: WireFetchResult }
  | { id: number; op: "fetchResult"; reqId: number; ok: false; error: string; denied: boolean };

export interface WireFetchResult {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: string; // base64
  url: string;
  redirectChain?: { status: number; statusText: string; headers: Record<string, string> }[];
}

export type WorkerMessage =
  | { type: "ready" }
  | { type: "reply"; id: number; ok: true; result: unknown }
  | { type: "reply"; id: number; ok: false; error: string }
  | { type: "chunk"; id: number; entries: FsEntryWire[] }
  | { type: "fetch"; reqId: number; url: string; method: string; headers: Record<string, string>; body?: string; followRedirects: boolean; timeoutMs?: number; maxRedirects?: number };

export interface WorkerExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  truncated: boolean;
  timedOut: boolean;
}

const record = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const int = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0;
const strRecord = (v: unknown): v is Record<string, string> => record(v) && Object.values(v).every((x) => typeof x === "string");
function base64(v: unknown): v is string {
  if (typeof v !== "string" || v.length % 4 !== 0) return false;
  let end = v.length;
  if (end && v.charCodeAt(end - 1) === 61) end--;
  if (end && v.charCodeAt(end - 1) === 61) end--;
  if (v.length - end > 2) return false;
  for (let i = 0; i < end; i++) {
    const c = v.charCodeAt(i);
    if (!((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 43 || c === 47)) return false;
  }
  for (let i = end; i < v.length; i++) if (v.charCodeAt(i) !== 61) return false;
  return true;
}

export function validFsEntry(v: unknown): v is FsEntryWire {
  if (!record(v) || typeof v.p !== "string" || !v.p.startsWith("/") || v.p.length > 32_768 || !["f", "d", "l"].includes(String(v.t)) || !int(v.m) || typeof v.mt !== "number" || !Number.isFinite(v.mt)) return false;
  if (v.d !== undefined && (!base64(v.d) || v.t !== "f")) return false;
  if (v.l !== undefined && typeof v.l !== "string") return false;
  if (v.l !== undefined && v.t !== "l") return false;
  if (v.a !== undefined && (v.a !== 1 || v.t !== "f")) return false;
  return true;
}

function validManifestEntry(v: unknown): boolean {
  if (!record(v) || typeof v.path !== "string" || !v.path.startsWith("/") || v.path.length > 32_768) return false;
  if (!["file", "dir", "symlink", "other"].includes(String(v.type)) || !int(v.size) || !int(v.mode) || typeof v.mtimeNs !== "string" || !int(v.ino) || !int(v.nlink)) return false;
  if (v.ctimeNs !== undefined && typeof v.ctimeNs !== "string") return false;
  if (v.linkTarget !== undefined && typeof v.linkTarget !== "string") return false;
  if (v.sha256 !== undefined && (typeof v.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(v.sha256))) return false;
  if (v.heavy !== undefined && typeof v.heavy !== "boolean") return false;
  return true;
}

/** Structural validation for every worker-owned message before it reaches supervisor state. */
export function validWorkerMessage(v: unknown): v is WorkerMessage {
  if (!record(v) || typeof v.type !== "string") return false;
  if (v.type === "ready") return Object.keys(v).length === 1;
  if (v.type === "reply") return int(v.id) && typeof v.ok === "boolean" && (v.ok ? "result" in v : typeof v.error === "string");
  if (v.type === "chunk") return int(v.id) && Array.isArray(v.entries) && v.entries.every(validFsEntry);
  if (v.type === "fetch") {
    return (
      int(v.reqId) &&
      typeof v.url === "string" &&
      typeof v.method === "string" &&
      strRecord(v.headers) &&
      (v.body === undefined || base64(v.body)) &&
      typeof v.followRedirects === "boolean" &&
      (v.timeoutMs === undefined || (int(v.timeoutMs) && v.timeoutMs > 0)) &&
      (v.maxRedirects === undefined || int(v.maxRedirects))
    );
  }
  return false;
}

export function validReplyResult(op: HostRequest["op"], v: unknown): boolean {
  if (op === "exec") {
    return record(v) && int(v.exitCode) && typeof v.stdout === "string" && typeof v.stderr === "string" && int(v.durationMs) && typeof v.truncated === "boolean" && typeof v.timedOut === "boolean";
  }
  if (op === "readFile") return record(v) && base64(v.data) && int(v.size) && typeof v.truncated === "boolean";
  if (op === "manifest") return record(v) && typeof v.root === "string" && v.root.startsWith("/") && int(v.takenAt) && Array.isArray(v.entries) && v.entries.every(validManifestEntry) && typeof v.truncated === "boolean";
  if (op === "dump") return record(v) && int(v.count) && int(v.bytes);
  if (op === "facts") return record(v) && Array.isArray(v.commands) && v.commands.every((x) => typeof x === "string") && int(v.totalBytes) && typeof v.node === "string";
  return v === undefined || record(v);
}
