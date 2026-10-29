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
