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
  released?: boolean; // eval fork whose storage was freed after its run: trace and file history only
  inUse?: EnvUse[]; // what is using it now; stop, reset, restore, snapshot, fork of the live env and delete answer 409 meanwhile
}

export interface EnvUse {
  kind: "eval" | "session" | "shell"; // eval: a case runs or is graded here, so shell and network are read-only too
  reason: string; // `eval "Tool basics" case read-file running`, `session "Fix tests" running`, `shell command running`
  sessionId?: Id;
  evalRunId?: Id;
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
  customPrompt?: boolean; // the session overrides its profile's system prompt
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
  systemPrompt?: string | null; // this session's system prompt; null: back to the profile's
  modelId?: Id; // allowed when idle; next turn uses it
  harness?: HarnessProfile;
  thinking?: boolean;
  contextWindow?: number;
  maxOutputTokens?: number;
}

/**
 * Breakdown for the context meter. Token counts; `source`: `server` = the last call's usage, `tokenizer` = counted
 * by the model's own tokenizer before sending, `estimate` = heuristic (tokenizer unreachable).
 */
export interface ContextUsage {
  window: number;
  systemAndTools: number;
  history: number;
  outputReserve: number;
  free: number;
  source: "server" | "tokenizer" | "estimate";
}

/** A tool output shortened by compaction because it didn't fit the window otherwise. */
export interface ShortenedOutput {
  toolCallId: string;
  toolName: string;
  /** Tokens kept from the start and the end, and the output's size before shortening. */
  keptHead: number;
  keptTail: number;
  total: number;
  /** Blob with the text the model had before shortening. */
  originalBlob?: string;
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
    | { type: "user_message"; text: string; retry?: "message" | "step" } // retry: the unanswered latest message sent again, or the step after the latest tool results run again (both already in the transcript; text is the latest message)
    | { type: "turn_start"; turn: number }
    | {
        type: "model_call_start";
        callId: Id;
        turn: number;
        modelId: Id;
        promptTokensEst: number;
        promptCount?: "tokenizer" | "estimate"; // how promptTokensEst was obtained (absent on older events: estimate)
        contextWindow: number;
        maxTokens: number;
        requestBlob?: string; // exact request bytes, named from the start so blob GC keeps them during a long call
      }
    | { type: "model_delta"; callId: Id; kind: "text" | "thinking" | "toolcall"; delta: string; n?: number } // streamed only; n: 0-based index among the call's deltas
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
    | { type: "tool_output"; toolCallId: string; stream: "stdout" | "stderr"; chunk: string; n?: number } // streamed only; n: 0-based index among the tool call's chunks
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
    | {
        type: "compaction";
        beforeTokens: number;
        afterTokens: number;
        removedTurns: number;
        note: string;
        shortened?: ShortenedOutput[];
        limit?: number; // prompt tokens that leave the session's output cap free
        exact?: boolean; // token counts from the model's tokenizer
      }
    | { type: "harness_repair"; callId: Id; original: string; repaired: ToolCallRef[]; reason: string }
    | {
        type: "warning";
        code: "output_truncated" | "context_near_full" | "prompt_truncated_by_server" | "model_switched" | "token_estimate" | "other";
        message: string;
        data?: Record<string, number | string>;
      }
    | { type: "error"; message: string; detail?: string; code?: "context_overflow"; data?: Record<string, number | string> }
    | { type: "env_lifecycle"; envId: Id; action: "start" | "stop" | "snapshot" | "reset" | "fork" | "restore"; detail?: string }
    | { type: "context"; usage: ContextUsage }
    | { type: "run_end"; reason: "done" | "stopped" | "max_turns" | "error" | "length" }
    | { type: "system_prompt"; harness: HarnessProfile; source: SessionPrompt["source"]; text: string; tools: string[] } // at a run's start when the prompt differs from the last one recorded
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
  | { type: "command"; command: string } // run in the env as the agent (clean env, no /grader access) after its processes are killed; pass on exit 0
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
  settings: AppSettings;
  downloads: ModelDownload[];
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
  | { type: "eval_result"; runId: Id; result: EvalResult }
  | { type: "model_download"; download: ModelDownload }
  | { type: "settings"; settings: AppSettings };

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

// ---------- Settings ----------

/** Persisted in the settings table; PATCH /api/settings takes any subset. */
export interface AppSettings {
  memoryBudgetBytes: number; // oMLX memory ceiling (--memory-guard-gb); applies when oMLX starts
  newSession: {
    modelId: Id | null; // null: the most recently used loaded model
    contextWindow: number | null; // null: the model's default context
    thinking: "model" | "on" | "off"; // model: on for models whose thinking is default-on
    harness: Exclude<HarnessProfile, "chat">; // sessions with an environment; chats always use "chat"
  };
  newEnv: { type: EnvType; network: NetworkMode };
  /** Saved default prompt per harness profile (absent: the built-in prompt). */
  prompts: Partial<Record<HarnessProfile, string>>;
}

export type UpdateSettingsRequest = Partial<Omit<AppSettings, "newSession" | "newEnv" | "prompts">> & {
  newSession?: Partial<AppSettings["newSession"]>;
  newEnv?: Partial<AppSettings["newEnv"]>;
  prompts?: Partial<Record<HarnessProfile, string | null>>; // null: back to the built-in prompt
};

export type PathKey = "data" | "models" | "venv" | "logs" | "omlxLog";

/** GET /api/settings: the settings plus read-only facts. */
export interface SettingsInfo {
  settings: AppSettings;
  paths: Record<PathKey, string>;
  disk: { key: string; label: string; bytes: number }[]; // data/ breakdown, then models/
  freeDiskBytes: number;
  maxRunningVms: number;
  omlx: InferenceState & { appliedCeilingBytes?: number }; // ceiling oMLX was started with
}

// ---------- Harness profiles and prompts ----------

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: unknown; // JSON Schema, as sent in the request's tools[].function.parameters
}

/** GET /api/harness: what each profile sends the model. */
export interface HarnessInfo {
  id: HarnessProfile;
  prompt: string; // the profile's default prompt (saved one if set, else built-in)
  builtIn: string;
  simNote?: string; // appended to the prompt in simulated envs
  custom: boolean; // a saved default replaces the built-in prompt
  tools: ToolDefinition[];
  tokensEst: { prompt: number; tools: number }; // estimates (no tokenizer); exact counts come per session
}

/** GET /api/sessions/:id/prompt: exactly what the session's next run sends. */
export interface SessionPrompt {
  harness: HarnessProfile;
  envType: EnvType | null;
  text: string;
  source: "built-in" | "profile" | "session"; // session: this session's override
  defaultText: string; // what the session would send without its override
  tools: ToolDefinition[];
  tokens: { prompt: number; tools: number; exact: boolean }; // exact: counted by the model's tokenizer
}

// ---------- Model downloads ----------

export interface ModelSuggestion {
  repo: string; // Hugging Face repo id
  name: string;
  params: string;
  note: string; // one line: why it's listed
  sizeBytes?: number;
  released?: string; // YYYY-MM-DD
}

/** POST /api/models/inspect: what a download would bring, checked before it starts. */
export interface ModelCheck {
  repo: string;
  dirName: string; // models/<dirName>
  installed: boolean;
  totalBytes: number;
  files: number;
  modelType?: string; // config.json model_type
  loader?: "mlx-lm" | "mlx-vlm";
  mlx: boolean; // an MLX build (repo tag or quantization config)
  quant?: string;
  contextLength?: number;
  ok: boolean; // can download and load
  problems: string[]; // why not, one line each
  freeDiskBytes: number;
  versions: { mlxLm: string; mlxVlm: string };
}

export interface ModelDownload {
  id: Id;
  repo: string;
  dirName: string;
  status: "running" | "done" | "error" | "canceled";
  bytesDone: number;
  bytesTotal: number;
  error?: string;
  startedAt: Millis;
  finishedAt?: Millis;
}

export interface RemoveModelResult {
  freedBytes: number;
}
