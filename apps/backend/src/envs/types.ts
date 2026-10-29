// Backend-internal contract between EnvManager/harness (apps/backend/src/envs, src/harness) and the
// two drivers (src/envs/vm, src/envs/sim). Erasable TypeScript only.

import type { EnvFacts, EnvType, NetEntry, NetworkMode, SimConfig, VmConfig } from "@terrarium/shared";

export interface ExecOptions {
  as?: "agent" | "root"; // VM: agent = uid 1000, root for graders/observer/user shell. Sim: ignored.
  cwd?: string; // default /workspace
  timeoutMs?: number; // default 120_000
  signal?: AbortSignal;
  stdin?: string;
  maxOutputBytes?: number; // per stream, default 1 MiB; excess dropped from the middle (keep head + tail)
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
}

export interface ExecOutcome {
  exitCode: number; // 124 on timeout, 130 on abort
  stdout: string;
  stderr: string;
  durationMs: number;
  truncated: boolean;
  timedOut: boolean;
}

export interface ManifestEntry {
  path: string; // absolute
  type: "file" | "dir" | "symlink" | "other";
  size: number;
  mode: number;
  mtimeNs: string; // decimal string
  ctimeNs?: string; // decimal string; VM observer only. Unlike mtime it can't be reset by the agent (touch -d)
  ino: number;
  nlink: number;
  linkTarget?: string;
  sha256?: string; // regular files only; omitted for heavy dirs' contents
  heavy?: boolean; // inside node_modules/.venv/__pycache__/.cache/etc: listed, not hashed
}

export interface Manifest {
  root: string; // "/workspace"
  takenAt: number;
  entries: ManifestEntry[];
  truncated: boolean; // entry cap hit (default 20k)
}

export interface ReadResult {
  data: Uint8Array;
  size: number; // full size
  truncated: boolean;
}

/** Raw network attempt reported by a driver; EnvManager adds id/envId/sessionId and persists it. */
export type NetAttempt = Omit<NetEntry, "id" | "envId" | "sessionId">;

export interface EnvRuntime {
  readonly id: string;
  readonly type: EnvType;
  readonly dir: string; // data/envs/<id>: driver-owned storage (disk images, fs state)

  start(): Promise<void>;
  /** Persist state and release resources. Idempotent. */
  stop(): Promise<void>;
  isRunning(): boolean;
  /** VM: its VMM process still exists (running, or shutting down until it closed), so it still takes a VM slot. */
  holdsVmm?(): boolean;
  /** VM: resolves once a shutdown in progress has closed the VMM. */
  vmmClosed?(): Promise<void>;
  /** Kill every process the agent left running (VM: all uid 1000 processes). No-op where nothing outlives an exec. */
  killAgentProcesses(): Promise<void>;

  exec(command: string, opts?: ExecOptions): Promise<ExecOutcome>;
  /** Paths resolve inside the env (guest-side symlink resolution only). Never touches host paths. */
  /** VM: `as` defaults to root (observer/diff capture); pass "agent" for model tools so uid 1000 permissions apply. */
  readFile(path: string, opts?: { maxBytes?: number; as?: "agent" | "root" }): Promise<ReadResult>;
  /** Several reads in one round trip; failures come back per path. `totalBytes` caps the whole batch. */
  readFiles(paths: string[], opts?: { maxBytes?: number; as?: "agent" | "root"; totalBytes?: number }): Promise<(ReadResult | Error)[]>;
  writeFile(path: string, data: string | Uint8Array, opts?: { as?: "agent" | "root"; mode?: number }): Promise<void>;
  /** Trustworthy listing of `root` (default /workspace) with sha256 of changed or all regular files. */
  manifest(root?: string, opts?: { previous?: Manifest }): Promise<Manifest>;

  /** Write a complete restorable copy of current state into destDir. VM: a running VM is stopped and left stopped. */
  snapshot(destDir: string): Promise<{ bytes: number }>;
  /** Replace current state with snapshot contents. VM: a running VM is stopped and left stopped. */
  restore(snapshotDir: string): Promise<void>;
  /** Stop and delete all storage. */
  destroy(): Promise<void>;

  /** Takes effect immediately, including while running. */
  setNetwork(mode: NetworkMode): Promise<void>;
  onNet(listener: (attempt: NetAttempt) => void): () => void;

  /** Gathered from inside the env where possible (uname, os-release, nproc, df, which ...). */
  facts(): Promise<EnvFacts>;
  /** Host-side measurement of the env's process (VMM or sim child). */
  resources(): Promise<{ rssBytes: number; cpuPct: number } | null>;
}

export interface EnvCreateSpec {
  id: string;
  dir: string;
  network: NetworkMode;
  vm?: VmConfig;
  sim?: SimConfig;
  /** Initialize from a snapshot directory produced by `snapshot()`; omitted = clean factory state. */
  fromSnapshotDir?: string;
  seedFiles?: { path: string; content: string }[]; // sim only (written into state.json); the manager seeds VMs after create
}

export interface EnvDriver {
  readonly type: EnvType;
  /** Initialize storage for a new env. Does not need to leave it running. */
  create(spec: EnvCreateSpec): Promise<EnvRuntime>;
  /** Re-open an existing env from its storage dir (after backend restart). */
  open(spec: Omit<EnvCreateSpec, "fromSnapshotDir" | "seedFiles">): Promise<EnvRuntime>;
  /** Driver-level readiness (e.g. guest image built). */
  check(): Promise<{ ok: boolean; detail: string }>;
}
