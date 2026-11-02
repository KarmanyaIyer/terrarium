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
  /** Set for a Lab strain: the base model with a mix, served by the Lab instead of oMLX. id is `strain:<strainId>`. */
  strain?: { id: Id; name: string; baseModelId: Id; recipe: string; settings: LabStrainSettings };
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
    | {
        type: "fs_change";
        toolCallId: string | null;
        changes: FileChange[];
        capture?: { capturedFiles: number; capturedBytes: number; omittedFiles: number; omittedBytes: number };
      }
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
    | { type: "env_lifecycle"; envId: Id; action: "start" | "stop" | "snapshot" | "reset" | "fork" | "restore" | "queue"; detail?: string }
    | { type: "context"; usage: ContextUsage }
    | {
        type: "budget_exceeded";
        scope: "host" | "environment" | "session";
        budget:
          | "host_disk"
          | "sim_workers"
          | "sim_rss"
          | "sim_cpu"
          | "trace_bytes"
          | "capture_bytes"
          | "snapshot_count"
          | "network_rows"
          | "request_count"
          | "network_bytes"
          | "network_rate";
        reason: string;
        limit: number;
        observed: number;
        unit: "bytes" | "count" | "milliseconds";
        envId?: Id;
      }
    | { type: "run_end"; reason: "done" | "stopped" | "max_turns" | "error" | "length" | "budget" }
    | { type: "system_prompt"; harness: HarnessProfile; source: SessionPrompt["source"]; text: string; tools: string[] } // at a run's start when the prompt differs from the last one recorded
  );

export type TraceEventType = TraceEvent["type"];

// ---------- Resources ----------

export interface ResourceSample {
  ts: Millis;
  system: { totalBytes: number; usedBytes: number; freeBytes: number; pressure: "normal" | "warn" | "critical" };
  backendRssBytes: number;
  inference?: { rssBytes: number; loaded: { modelId: Id; bytes?: number }[] };
  lab?: { rssBytes: number; modelId?: Id }; // Lab sidecar process, while it runs
  envs: { envId: Id; rssBytes: number; cpuPct: number; cpuTimeMs?: number }[];
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

/** Whether Linux VMs can start here: a fresh data dir has no guest image until one is built (POST /api/vm-image/build). */
export interface VmSetup {
  ok: boolean;
  detail?: string;
}

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
  lab?: LabState;
  vmSetup?: VmSetup;
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
  | { type: "lab"; lab: LabState }
  | { type: "lab_strains"; strains: LabStrain[] }
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
  resourceBudgets: ResourceBudgetSettings;
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

export interface ResourceBudgetSettings {
  maxSimWorkers: number;
  simWorkerRssBytes: number;
  simWorkerCpuMs: number;
  hostFreeDiskReserveBytes: number;
  sessionTraceBytes: number;
  sessionCaptureBytes: number;
  sessionSnapshotCount: number;
  sessionNetworkRows: number;
  sessionRequestCount: number;
  sessionNetworkBytes: number;
  networkBurst: number;
  networkRefillPerSecond: number;
}

export type UpdateSettingsRequest = Partial<Omit<AppSettings, "resourceBudgets" | "newSession" | "newEnv" | "prompts">> & {
  resourceBudgets?: Partial<ResourceBudgetSettings>;
  newSession?: Partial<AppSettings["newSession"]>;
  newEnv?: Partial<AppSettings["newEnv"]>;
  prompts?: Partial<Record<HarnessProfile, string | null>>; // null: back to the built-in prompt
};

export type PathKey = "data" | "models" | "venv" | "logs" | "omlxLog";

/** GET /api/settings: the settings plus read-only facts. */
export interface SettingsInfo {
  settings: AppSettings;
  paths: Record<PathKey, string>;
  disk: { key: string; label: string; bytes: number; clear?: string; clearBlocked?: string }[]; // data/ breakdown, then models/; clear: what Clear removes, for caches
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
  source: "built-in" | "profile" | "session" | "strain"; // session: this session's override. strain: none, as the recipe was measured
  defaultText: string; // what the session would send without its override
  tools: ToolDefinition[];
  tokens: { prompt: number; tools: number; exact: boolean }; // exact: counted by the model's tokenizer
}

// ---------- Model downloads ----------

export interface ModelSuggestion {
  repo: string; // Hugging Face repo id
  name: string;
  params: string;
  note: string; // a few words: why it's listed
  detail?: string; // the numbers behind it, on hover
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

// ---------- Lab: neurons in local models ----------
//
// A neuron is one entry of layer L's MLP hidden activation, act(gate(x)) * up(x): the input to down_proj. Written
// L15N4041 (layer 15, index 4041), as on neuronary.org. The Lab runs its own copy of one model in a Python sidecar.

export interface NeuronRef {
  layer: number;
  neuron: number;
}

/**
 * One neuron in a mix. dose: act += value * doseUnit, where doseUnit = median(|residual after layer L|) /
 * |W_down[:, n]| (neuronary's relative unit: 0.5 to 1.0 is the normal range). clamp: act = value (raw activation).
 * Applied at every position, prompt and reply.
 */
export interface LabPush extends NeuronRef {
  kind?: "neuron";
  mode: "dose" | "clamp";
  value: number;
}

/**
 * A character: one direction in the residual, not a list of neurons. Adds strength * resid[layer] * u to that layer's
 * down_proj output at every position, where resid[layer] is the same scale a neuron's dose uses. Shown by its name,
 * layer and strength; u itself stays out of sight.
 */
export interface LabVector {
  kind: "vector";
  id: Id; // stays with it through a mix, a saved result and a strain
  name: string;
  layer: number;
  strength: number;
  u: string; // base64 of d_model little-endian float32
}

/** One entry of a mix. Neurons and vectors go in the same list and act together. */
export type LabMixItem = LabPush | LabVector;

export type LabStatus = "stopped" | "starting" | "loading" | "ready" | "stopping" | "error";

/** Whether the Lab can open a model in models/, and why not. */
export interface LabSupport {
  modelId: Id;
  name: string;
  supported: boolean;
  reason?: string;
  estimateBytes: number; // Lab memory estimate when loaded (weights + Lab context + overhead)
}

export interface LabModelFacts {
  modelId: Id;
  name: string;
  arch: string; // mlx-lm model_type, e.g. qwen3_5
  layers: number;
  neuronsPerLayer: number[]; // usually all equal; Gemma 4 has double-wide layers
  totalNeurons: number;
  dModel: number;
  activation: string; // swiglu | geglu
  quant: string;
  tryDose?: number; // a first dose that shows something on this model: 0.8, or 3 on LFM3
  layerKinds?: string[]; // per layer: "linear" | "full" (Qwen3.5), "sliding" | "full" (Gemma 4), "conv" | "sliding" | "full" (LFM3)
  residNorm: number[]; // per layer: median |residual after layer L| over the calibration text (dose scale)
  calibrationTokens: number;
  residentBytes: number; // MLX active memory after load
  loadMs: number;
}

export interface LabState {
  status: LabStatus;
  detail?: string; // error, or why it stopped
  pid?: number;
  model?: LabModelFacts; // the loaded specimen
  loadingModelId?: Id;
  busy?: string; // what the sidecar is doing now: "probe", "find", "generate", "session"
  support: LabSupport[];
  /** Strains (by id) serving running sessions or evals: the specimen can't be unloaded or swapped while these run. */
  overCeiling?: string; // a lowered memory ceiling left more held than it allows
  servingStrains: Id[];
}

/** Can the Lab load this model next to what oMLX holds, within the memory ceiling? */
export interface LabMemoryCheck {
  modelId: Id;
  ceilingBytes: number; // Settings memory ceiling: oMLX and the Lab together stay under it
  needBytes: number; // Lab estimate for this model
  labBytes: number; // what the Lab holds now (0 if nothing or this model)
  omlx: { modelId: Id; bytes: number; busy?: string }[]; // loaded in oMLX; busy names the session or eval using it
  fits: boolean;
  freeableBytes: number; // held by oMLX models no running session or eval uses
}

export interface LabToken {
  i: number;
  id: number;
  text: string;
  /** template: chat markup the model sees but you didn't type; reply: generated by the model. */
  kind: "text" | "template" | "reply";
}

export interface LabHit extends NeuronRef {
  value: number; // raw activation at its peak token
  at: number; // token index of the peak
  rel: number; // value / typical peak on ordinary text
  typical: number; // typical peak (99th percentile of |activation| over the calibration text)
}

export interface LabProbeRequest {
  text: string;
  chat?: boolean; // wrap the text as a user message in the chat template
  reply?: boolean; // chat only: also generate the model's reply (greedy) and probe its tokens
  maxTokens?: number; // reply length, default 80
  thinking?: boolean;
  watch?: NeuronRef[]; // neurons to trace on every token
  layer?: number; // also return this layer's strongest neurons per token
  mix?: LabMixItem[]; // probe the steered model
  top?: number; // how many standout neurons to return, default 40
}

export interface LabTrace {
  ref: NeuronRef;
  values: number[]; // one per token
  typical: number;
}

export interface LabProbeResult {
  tokens: LabToken[];
  top: LabHit[]; // neurons that stand out most on this text, by rel (first token skipped: it is an attention sink)
  perToken: { layer: number; neuron: number; rel: number }[][]; // top 5 per token
  watch: LabTrace[];
  layer?: { layer: number; traces: LabTrace[] };
  ms: number;
}

export interface LabSnippet {
  text: string; // source text
  tokens: string[];
  values: number[];
  peak: number;
  peakAt: number;
}

export interface LabNeuronCard extends NeuronRef {
  typical: { mean: number; std: number; p99: number; max: number; min: number };
  promotes: { token: string; logit: number }[]; // vocab projection of its down_proj column, through the final norm
  suppresses: { token: string; logit: number }[];
  downNorm: number;
  doseUnit: number; // raw activation added by dose 1.0
  firesOn: LabSnippet[]; // strongest texts from the field guide corpus (and any texts sent)
  layerKind?: string;
}

export interface LabProbeSet {
  id: Id;
  name: string;
  concept: string[];
  control: string[];
  builtin: boolean;
  /** Prompt that shows the concept when steering, e.g. "Tell me about yourself." */
  testPrompt?: string;
  createdAt?: Millis;
  /** Prepared sets: what it does, in a line. */
  blurb?: string;
  /** Marks the prepared set Try the example runs, on this model at this dose. */
  example?: { modelId: Id; dose: number };
}

export interface SaveProbeSetRequest {
  name: string;
  concept: string[];
  control: string[];
  testPrompt?: string;
  id?: Id; // an undone delete coming back keeps its id
}

/** The trait the Find box describes. The unsteered model writes matched lines with and without it. */
export interface LabExamplesRequest {
  trait: string; // "a tiger", "talks like a pirate"
  n?: number; // pairs to ask for, default 12
  seed?: number;
}

export interface LabExamplesResult {
  trait: string;
  concept: string[]; // lines that show the trait
  control: string[]; // the same lines without it
  words: string[]; // the description's content words
  seed: number;
  ms: number;
}

/** Surprise me: random neurons of one layer in the back half of the model, the ones that move the next word most. */
export interface LabExploreRequest {
  layer?: number; // default: a random one
  sample?: number; // neurons to try, default 48
  top?: number; // how many to return, default 4
  seed?: number;
}

export interface LabExplorePick extends NeuronRef {
  kl: number; // how far +0.8 moved the next-token distribution
  tokens: string[]; // tokens it raises most
  promotes: string[];
  suppresses: string[];
}

export interface LabExploreResult {
  layer: number;
  sampled: number;
  picks: LabExplorePick[];
  ms: number;
}

/** What the tokenizer makes of each text. */
export interface LabTokensResult {
  tokens: { id: number; text: string }[][];
}

export interface LabFindRequest {
  concept: string[];
  control: string[];
  top?: number; // default 30 (by score); a few strong direct writers are added on top
  layers?: [number, number]; // inclusive range, default all
  prompt?: string; // test prompt for the steered previews, default "Who are you?"
  previews?: number; // how many top candidates get a short steered reply, default 6
  words?: string[]; // words known to belong to the concept: counted by writes.delta with the concept tokens
}

export interface LabCandidate extends NeuronRef {
  score: number; // fires on it: (concept mean - control mean) / (pooled std + 0.1), peaks in x typical units
  conceptMean: number; // mean peak over concept texts, x typical
  controlMean: number;
  beatsAll: number; // fraction of concept texts whose peak beats every control text's peak
  typical: number;
  promotes: string[];
  suppresses: string[];
  snippets: LabSnippet[]; // its two strongest concept texts
  /** Pushes it: dose +0.8 on a few open contexts. delta: log-probability (nats) gained by the concept's own words at
   * the next token; kl: how much the next-token distribution moved; tokens: the tokens it gains most (steer lens). */
  writes: { delta: number; kl: number; tokens: string[] };
  both: number; // sqrt(max(score, 0) * max(writes.delta, 0)): fires on it and pushes it. Candidates come sorted by this
  preview?: { dose: number; text: string; repetition: number; fluency: number }; // greedy 32-token steered reply
}

export interface LabFindResult {
  candidates: LabCandidate[];
  conceptTokens: string[]; // tokens in several concept texts and no control text: what writes.delta measures
  scanned: number; // neurons compared
  texts: { concept: number; control: number; tokens: number };
  ms: number;
}

export interface LabGenerateRequest {
  prompt: string; // user message
  system?: string;
  mix: LabMixItem[];
  scale?: number; // multiplies every dose and vector strength (not clamps), default 1
  seed?: number; // default random; the reply pair shares it
  temperature?: number; // default 0.7; 0 = greedy
  maxTokens?: number; // default 160
  thinking?: boolean; // default off
  baseline?: boolean; // also generate the unsteered reply with the same seed
  repeat?: number; // repetition penalty over the last 64 tokens (mlx-lm's); unset or 1 is off
}

/** How a reply reads. ok: ordinary text, whatever it says. odd: unlikely word by word under the unsteered model. loop:
 * stuck repeating. broken: word salad. empty: stopped at once. */
export type LabQuality = "ok" | "odd" | "loop" | "broken" | "empty";

export interface LabReply {
  text: string;
  tokens: number;
  finish: "stop" | "length";
  ms: number;
  /** Mean log-probability of the reply's tokens under the unsteered model: falls as steering pushes it off course. */
  fluency: number;
  repetition: number; // share of repeated 3-grams, 0 to 1
  loop: boolean; // stuck repeating: a third of its 3-grams repeat, or its last 16 tokens cycle
  quality: LabQuality;
  pieces: string[]; // the text cut at token boundaries; joined they are the text
}

export interface LabGenerateResult {
  seed: number;
  steered: LabReply;
  baseline?: LabReply;
}

export interface LabSweepRequest extends Omit<LabGenerateRequest, "scale" | "baseline"> {
  doses: number[]; // values for the target push (a vector's: its strength), or scales for the whole mix when no target
  target?: NeuronRef | { vectorId: Id };
}

export interface LabSweepResult {
  seed: number;
  rows: { dose: number; reply: LabReply }[];
}

export interface LabAttributeRequest {
  prompt: string; // user message
  prefill?: string; // start of the answer, e.g. "I am a"
  target: string; // next token to explain, e.g. " owl"
  foil?: string; // compared against, e.g. " language"; default: the model's own top choice
  /** unsteered: compare with what the model writes here without the mix, instead of foil. */
  foilFrom?: "unsteered";
  mix?: LabMixItem[];
  top?: number; // default 25
  measure?: boolean; // default true: really push the shortlisted neurons. false: gradients only, ranked by attr
  shortlist?: number; // neurons to measure, default 18
  doses?: number[]; // sizes to try, at both signs, default 0.25, 0.5, 1
}

export interface LabAttributeResult {
  metric: number; // logit(target) - logit(foil) at the next token
  target: string;
  foil: string;
  topNext: { token: string; prob: number }[];
  top: string; // the token the model picks here, with the mix
  prefill: string; // the answer start used (a trailing space moves to the target)
  notes: string[]; // what was adjusted: a field cut to its first token, a moved space
  nodes: LabTraceNode[];
  /** Absent with measure: false. */
  measure?: { neurons: number; shortlisted: number; doses: number[]; passes: number; ms: number; msPerPass: number };
  ms: number;
  peakBytes: number;
}

export interface LabTraceNode extends NeuronRef {
  attr: number; // gradient x activation at the last position: only the shortlist
  share: number;
  promotes: string[];
  suppresses: string[];
  /** Measured by pushing it. held: this neuron's dose already in the mix; doses here are on top of that. */
  held?: number;
  best?: { dose: number; metric: number; top: string; change: number; flips: boolean };
  measured?: { dose: number; metric: number; top: string }[];
  /** A short greedy reply at the best dose, for the top rows: a neuron that wins the next token may then loop. */
  check?: { text: string; quality: LabQuality };
}

/** A saved result. data is the UI's own record of the run, with the exact recipe it ran with. */
export interface LabHistoryEntry {
  id: Id;
  kind: "compare" | "sweep" | "seeds" | "trace" | "find";
  modelId: Id;
  title: string;
  at: Millis;
  data: unknown;
}

/**
 * How a strain generates in chats and evals: thinking is always off and there is no default system prompt, because a
 * recipe's numbers were measured that way. repeat null: no repetition penalty (vectors, measured without one).
 */
export interface LabStrainSettings {
  temperature: number;
  topP: number;
  repeat: number | null;
  maxTokens?: number; // caps a reply: replies past it were not measured and some loop
}

/** A saved mix: the base model plus pushes. Usable as a model in sessions and evals (`strain:<id>`). */
export interface LabStrain {
  id: Id;
  name: string;
  baseModelId: Id;
  pushes: LabMixItem[];
  recipe: string; // recipe text, e.g. "L15N4041+0.8 L8N344=25 [The Bard L8 x1.2]"
  settings: LabStrainSettings;
  notes: string;
  createdAt: Millis;
  updatedAt: Millis;
}

/** A recipe the persona search tested, as the Field Guide shows it. */
export interface LabSpecimen {
  id: Id;
  name: string;
  line: string; // what it does, in a line
  group: string; // animals, words, speech...
  modelId: Id;
  featured: boolean; // leads the guide; the rest sit behind a disclosure
  mix: LabMixItem[];
  settings: LabStrainSettings; // what its numbers were measured with
  rate: string; // its numbers in plain words, with the counts
  measured: { n: number; joint: number; concept: number; coherent: number; second?: { n: number; joint: number }; fresh?: { n: number; joint: number } };
  unconfirmed: boolean; // its dose was tuned after the held-out replies were read, and fresh prompts haven't confirmed it
  prompt: string; // the prompt to try first
  samples: { prompt: string; reply: string }[]; // real replies, from the held-out run
}

/** The catalog the app ships, generated from the search by scripts/gen-field-guide.ts. */
export interface LabFieldGuide {
  date: string;
  models: { modelId: Id; name: string; repo: string }[];
  /** The first thing to try: one neuron, then on to a character. quote is the start of a real reply. */
  example: { specimenId: Id; modelId: Id; prompt: string; quote: string; next: Id };
  specimens: LabSpecimen[];
}

/** A word family a single neuron writes: search for a word, then screen the match. */
export interface LabLensHit extends NeuronRef {
  sign: 1 | -1;
  tokens: string[];
  gain: number;
}

export interface SaveStrainRequest {
  name: string;
  baseModelId: Id;
  pushes: LabMixItem[];
  settings?: LabStrainSettings; // default: 0.7, 0.95, repeat 1.1 for neurons and off once the mix has a vector
  notes?: string;
  id?: Id; // an undone delete coming back keeps its id, so sessions naming it still work
  createdAt?: Millis;
}
