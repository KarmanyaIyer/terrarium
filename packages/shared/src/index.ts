// Contract between apps/backend and apps/ui. Types only: import with `import type`.

export type Id = string;
export type Millis = number; // epoch ms

// ---------- Environments ----------

export type EnvType = "vm" | "sim";
export type NetworkMode = "off" | "registries" | "web";
export type EnvStatus = "stopped" | "starting" | "running" | "stopping" | "busy" | "error";

export interface VmConfig {
  cpus: number;
  memoryMiB: number;
  diskMiB: number;
  backend: "krun" | "qemu";
}

export interface SimConfig {
  python: boolean;
  javascript: boolean;
  maxTotalBytes: number;
}

/** Facts gathered from the environment itself (uname, os-release, nproc, df...), shown verbatim. */
export interface EnvFacts {
  kind: EnvType;
  isolation: string; // e.g. "Linux micro-VM (Gondolin 0.14, krun, Apple Hypervisor.framework)" or "Simulated shell (just-bash 3.6, child process under sandbox-exec)"
  os?: string; // PRETTY_NAME
  kernel?: string; // uname -r
  arch?: string;
  cpus?: number;
  memoryMiB?: number;
  diskMiB?: number;
  diskUsedMiB?: number;
  user: string; // e.g. "agent (uid 1000)"
  workdir: string; // "/workspace"
  mounts: { path: string; kind: "inbox" | "outbox"; access: "ro" | "rw" }[]; // host-owned exchange dirs only
  hostFoldersMounted: false;
  image?: { name: string; digest?: string; bytes?: number };
  tools?: string[]; // notable binaries present (python3, node, git, gcc, curl...)
  simCommands?: string[]; // just-bash: available commands
  runtimes?: { python: boolean; javascript: boolean };
  gatheredAt: Millis;
}

export interface EnvSummary {
  id: Id;
  name: string;
  type: EnvType;
  status: EnvStatus;
  statusDetail?: string; // error message or "running eval case 3/8"
  network: NetworkMode;
  parentEnvId?: Id;
  baseSnapshotId?: Id;
  vm?: VmConfig;
  sim?: SimConfig;
  facts?: EnvFacts;
  diskBytes?: number;
  createdAt: Millis;
  ephemeral: boolean; // eval forks; hidden from sidebar by default
}

export interface Snapshot {
  id: Id;
  envId: Id;
  label: string;
  kind: "factory" | "manual" | "auto";
  bytes: number;
  createdAt: Millis;
}

export interface CreateEnvRequest {
  name: string;
  type: EnvType;
  network?: NetworkMode; // default "off"
  from?: { envId: Id } | { snapshotId: Id }; // omitted = clean
  vm?: Partial<VmConfig>;
  sim?: Partial<SimConfig>;
  seedFiles?: { path: string; content: string }[];
}

export interface FileNode {
  path: string; // absolute, e.g. /workspace/src/a.py
  name: string;
  type: "file" | "dir" | "symlink" | "other";
  size?: number;
  mode?: number;
  linkTarget?: string;
  sha256?: string; // absent for dirs or unhashed heavy dirs
  children?: FileNode[];
  change?: FileChangeKind; // relative to session start (or to `at` baseline)
  heavy?: boolean; // node_modules/.venv/caches: listed, not hashed
}

export type FileChangeKind = "added" | "modified" | "deleted" | "type_changed";

export interface FileChange {
  path: string;
  kind: FileChangeKind;
  before?: { sha256?: string; size: number; mode?: number; type: FileNode["type"] };
  after?: { sha256?: string; size: number; mode?: number; type: FileNode["type"] };
  diffBlob?: string; // sha256 of a unified diff text blob
  binary?: boolean;
  tooLarge?: boolean;
}

export interface FileContent {
  path: string;
  at?: number; // seq
  content?: string; // utf8 text
  binary: boolean;
  size: number;
  sha256?: string;
  truncated: boolean;
}

export interface NetEntry {
  id: Id;
  envId: Id;
  sessionId?: Id;
  ts: Millis;
  method: string;
  url: string;
  host: string;
  ip?: string;
  decision: "allow" | "deny";
  reason: string; // "mode off", "private range 192.168.1.4", "not in registries list", "allowed: web"
  status?: number;
  bytesIn?: number; // summed over repeats
  bytesOut?: number;
  repeats?: number; // identical attempts collapsed into this entry (absent: 1)
  lastTs?: Millis; // when the last of them happened
}

export interface ExecRequest {
  command: string;
  as: "agent" | "root"; // sim envs ignore this
  timeoutMs?: number;
}

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  truncated: boolean;
}

// ---------- Models / inference ----------

export interface ModelInfo {
  id: Id; // oMLX model id (dir name)
  name: string; // display, e.g. "Qwen3.5 9B"
  family: string; // qwen3.5 | gemma4 | bonsai | ...
  params: string; // "9.4B", "12.1B / 2.5B active"
  quant: string; // "4bit", "2bit ternary"
  diskBytes: number;
  nativeContext: number;
  toolFormat: string; // "qwen3_coder XML", "gemma4", ...
  thinking: "none" | "optional" | "default-on";
  kvBytesPerToken: number;
  fixedBytes: number; // fixed KV/state overhead
  weightsBytes: number; // resident weights estimate (text-only)
  loaded: boolean;
  loadedContext?: number;
  residentBytes?: number; // reported by oMLX when loaded
  defaultContext: number;
  defaultMaxOutput: number;
  sampling: { temperature: number; topP: number; topK?: number; presencePenalty?: number };
}

export type InferenceStatus = "stopped" | "starting" | "ready" | "stopping" | "error";

export interface InferenceState {
  status: InferenceStatus;
  detail?: string;
  version?: string; // oMLX version
  pid?: number;
  rssBytes?: number;
  memoryCeilingBytes?: number;
}

export interface MemoryBudget {
  totalBytes: number; // physical RAM
  budgetBytes: number; // user setting, default 12 GB
}

/** Estimate shown in pickers: weights + ctx*kv + fixed + overhead. */
export interface MemoryEstimate {
  modelId: Id;
  context: number;
  bytes: number;
  fitsFree: boolean;
  fitsBudget: boolean;
}

// ---------- Sessions / harness ----------

export type HarnessProfile = "terrarium" | "pi-stock" | "chat";
export type SessionStatus = "idle" | "running" | "stopping" | "error";

export interface SessionSummary {
  id: Id;
  envId: Id | null; // null = chat-only
  title: string;
  modelId: Id;
  harness: HarnessProfile;
  thinking: boolean;
  contextWindow: number;
  maxOutputTokens: number;
  status: SessionStatus;
  lastSeq: number;
  createdAt: Millis;
  updatedAt: Millis;
  evalRunId?: Id;
  evalCaseId?: string;
  context?: ContextUsage; // latest
}

export interface CreateSessionRequest {
  envId: Id | null;
  modelId: Id;
  harness: HarnessProfile;
  title?: string;
  thinking?: boolean;
  contextWindow?: number;
  maxOutputTokens?: number;
}

export interface UpdateSessionRequest {
  title?: string;
  modelId?: Id; // allowed when idle; next turn uses it
  harness?: HarnessProfile;
  thinking?: boolean;
  contextWindow?: number;
  maxOutputTokens?: number;
}

/** Breakdown for the context meter. Token counts; `source` says whether from server usage or estimate. */
export interface ContextUsage {
  window: number;
  systemAndTools: number;
  history: number;
  outputReserve: number;
  free: number;
  source: "server" | "estimate";
}

export interface ModelCallUsage {
  promptTokens: number;
  completionTokens: number;
  cachedTokens?: number;
  reasoningTokens?: number;
}

export interface ModelCallTiming {
  ttftMs?: number;
  totalMs: number;
  promptTps?: number;
  genTps?: number;
}

export type FinishReason = "stop" | "length" | "tool_calls" | "error" | "aborted";

export interface ModelCallDetail {
  id: Id;
  sessionId: Id;
  seq: number;
  modelId: Id;
  request: unknown; // exact JSON body sent to the server
  response: unknown; // assembled final response JSON (from SSE chunks when streamed)
  rawResponseBlob?: string; // sha256 of raw SSE text
  finishReason: FinishReason;
  usage?: ModelCallUsage;
  timing: ModelCallTiming;
  contextWindow: number;
  maxTokens: number;
}

export interface ToolCallRef {
  id: string;
  name: string;
  args: unknown;
}

// ---------- Trace events ----------

interface EventBase {
  sessionId: Id;
  seq: number; // monotonically increasing per session; streamed-only events reuse the seq of their parent
  ts: Millis;
}

export type TraceEvent = EventBase &
  (
    | { type: "user_message"; text: string }
    | { type: "turn_start"; turn: number }
    | {
        type: "model_call_start";
        callId: Id;
        turn: number;
        modelId: Id;
        promptTokensEst: number;
        contextWindow: number;
        maxTokens: number;
      }
    | { type: "model_delta"; callId: Id; kind: "text" | "thinking" | "toolcall"; delta: string } // streamed only
    | {
        type: "model_call_end";
        callId: Id;
        finishReason: FinishReason;
        usage?: ModelCallUsage;
        timing: ModelCallTiming;
        error?: string;
      }
    | { type: "assistant_message"; callId: Id; text: string; thinking?: string; toolCalls: ToolCallRef[] }
    | { type: "tool_start"; toolCallId: string; callId: Id; name: string; args: unknown }
    | { type: "tool_output"; toolCallId: string; stream: "stdout" | "stderr"; chunk: string } // streamed only
    | {
        type: "tool_end";
        toolCallId: string;
        name: string;
        exitCode?: number;
        durationMs: number;
        stdout?: string;
        stderr?: string;
        outputTruncated: boolean;
        resultForModel: string; // exactly what the model receives
        isError: boolean;
        fileChanges: number;
      }
    | { type: "fs_change"; toolCallId: string | null; changes: FileChange[] }
    | { type: "net"; entry: NetEntry }
    | { type: "compaction"; beforeTokens: number; afterTokens: number; removedTurns: number; note: string }
    | { type: "harness_repair"; callId: Id; original: string; repaired: ToolCallRef[]; reason: string }
    | {
        type: "warning";
        code: "output_truncated" | "context_near_full" | "prompt_truncated_by_server" | "model_switched" | "other";
        message: string;
        data?: Record<string, number | string>;
      }
    | { type: "error"; message: string; detail?: string }
    | { type: "env_lifecycle"; envId: Id; action: "start" | "stop" | "snapshot" | "reset" | "fork" | "restore"; detail?: string }
    | { type: "context"; usage: ContextUsage }
    | { type: "run_end"; reason: "done" | "stopped" | "max_turns" | "error" | "length" }
  );

export type TraceEventType = TraceEvent["type"];

// ---------- Resources ----------

export interface ResourceSample {
  ts: Millis;
  system: { totalBytes: number; usedBytes: number; freeBytes: number; pressure: "normal" | "warn" | "critical" };
  backendRssBytes: number;
  inference?: { rssBytes: number; loaded: { modelId: Id; bytes?: number }[] };
  envs: { envId: Id; rssBytes: number; cpuPct: number }[];
}

// ---------- Evals ----------

export type EvalCheck =
  | { type: "answer"; mode: "exact" | "regex" | "number" | "choice"; expected: string; tolerance?: number }
  | { type: "command"; command: string } // run in env as grader after agent finishes; pass on exit 0
  // Hidden unittest file run by the VM's test grader: candidate code and tests in separate processes and
  // uids; passes only when every counted test passed.
  | { type: "tests"; file: string; timeoutSec?: number }
  | { type: "file"; path: string; equals?: string; contains?: string }
  | { type: "isolation"; probe: string } // pass when the probe's escape attempt is blocked
  | { type: "speed" };

export interface EvalCase {
  id: string;
  title: string;
  prompt: string;
  envType: EnvType | "none";
  network?: NetworkMode; // env network mode for this case; default "off"
  setupFiles?: { path: string; content: string }[];
  hiddenFiles?: { path: string; content: string }[]; // grader-only (root-owned, unreadable to agent)
  check: EvalCheck;
  maxTurns: number;
  timeoutSec: number;
}

export interface EvalSuite {
  id: string;
  title: string;
  description: string; // one line, shown only in the suite detail
  envType: EnvType | "none" | "mixed";
  source?: { dataset: string; url: string; license?: string; sampleable: boolean; total?: number };
  cases: EvalCase[]; // for dataset suites: cases materialized for the chosen sample
}

export interface StartEvalRunRequest {
  suiteId: string;
  modelIds: Id[];
  harness: HarnessProfile;
  thinking?: boolean;
  sampleSize?: number; // dataset suites: sample size; hand-written suites: run the first N cases
  seed?: number; // dataset suites only
  contextWindow?: number;
}

export type EvalCellStatus = "pending" | "running" | "pass" | "fail" | "error" | "skipped";

export interface EvalResult {
  caseId: string;
  modelId: Id;
  status: EvalCellStatus;
  sessionId?: Id;
  envId?: Id;
  durationMs?: number;
  tokens?: { prompt: number; completion: number };
  detail?: string; // grader output / reason
  score?: number;
}

export interface EvalRunSummary {
  id: Id;
  suiteId: string;
  suiteTitle: string;
  config: StartEvalRunRequest;
  status: "running" | "done" | "stopped" | "error";
  startedAt: Millis;
  finishedAt?: Millis;
  totals: Record<Id, { pass: number; fail: number; error: number; total: number }>; // by modelId
}

export interface EvalRunDetail extends EvalRunSummary {
  cases: EvalCase[];
  results: EvalResult[];
}

// ---------- App state + WS ----------

export interface AppState {
  envs: EnvSummary[];
  sessions: SessionSummary[];
  models: ModelInfo[];
  inference: InferenceState;
  budget: MemoryBudget;
  evalRuns: EvalRunSummary[];
  versions: { app: string; gondolin: string; justBash: string; piAgentCore: string; omlx?: string };
}

export type WsMessage =
  | { type: "hello"; state: AppState }
  | { type: "trace"; event: TraceEvent }
  | { type: "session"; session: SessionSummary }
  | { type: "session_deleted"; sessionId: Id }
  | { type: "env"; env: EnvSummary }
  | { type: "env_deleted"; envId: Id }
  | { type: "env_net"; entry: NetEntry }
  | { type: "env_fs"; envId: Id; changes: FileChange[] } // live tree hints (user shell, background)
  | { type: "models"; models: ModelInfo[] }
  | { type: "inference"; inference: InferenceState }
  | { type: "resources"; sample: ResourceSample }
  | { type: "eval_run"; run: EvalRunSummary }
  | { type: "eval_result"; runId: Id; result: EvalResult };

export type WsClientMessage = { type: "subscribe"; sessionIds: Id[] } | { type: "ping" };

export interface ApiError {
  error: string;
  detail?: string;
}

// ---------- Request bodies (added by UI; additive) ----------

export interface UpdateEnvRequest {
  name?: string;
  network?: NetworkMode;
}

export interface SnapshotEnvRequest {
  label?: string;
}

/** POST /api/envs/:id/fork. snapshotId omitted = fork the current state. */
export interface ForkEnvRequest {
  name?: string;
  snapshotId?: Id;
}

/** POST /api/envs/:id/reset. snapshotId omitted = back to the env's base (clean image or base snapshot). */
export interface ResetEnvRequest {
  snapshotId?: Id;
}

export interface SendMessageRequest {
  text: string;
}

export interface UpdateModelRequest {
  defaultContext?: number;
  defaultMaxOutput?: number;
  sampling?: Partial<ModelInfo["sampling"]>;
}

/** POST /api/models/:id/load. context omitted = model's defaultContext. */
export interface LoadModelRequest {
  context?: number;
}
