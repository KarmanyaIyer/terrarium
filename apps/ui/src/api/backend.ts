import type {
  AppSettings,
  AppState,
  CreateEnvRequest,
  CreateSessionRequest,
  EnvSummary,
  EvalRunDetail,
  EvalRunSummary,
  EvalSuite,
  ExecRequest,
  ExecResult,
  FileContent,
  FileNode,
  ForkEnvRequest,
  HarnessInfo,
  Id,
  InferenceState,
  LoadModelRequest,
  ModelCallDetail,
  ModelCheck,
  ModelDownload,
  ModelInfo,
  ModelSuggestion,
  NetEntry,
  PathKey,
  RemoveModelResult,
  ResetEnvRequest,
  SessionPrompt,
  SessionSummary,
  SettingsInfo,
  Snapshot,
  SnapshotEnvRequest,
  StartEvalRunRequest,
  TraceEvent,
  UpdateEnvRequest,
  UpdateModelRequest,
  UpdateSessionRequest,
  UpdateSettingsRequest,
  WsMessage,
} from "@terrarium/shared";
import type { LabApi } from "./lab";

export type ConnStatus = "connecting" | "open" | "closed";

export interface BackendHandlers {
  onMessage(msg: WsMessage): void;
  onStatus(status: ConnStatus, detail?: string): void;
}

export interface AtOpts {
  at?: number;
  sessionId?: Id;
}

/** Every REST route in DESIGN.md plus the WebSocket. Implemented by HttpBackend and FixtureBackend. */
export interface Backend {
  readonly kind: "http" | "fixtures";
  readonly label: string;

  getState(): Promise<AppState>;

  createEnv(req: CreateEnvRequest): Promise<EnvSummary>;
  updateEnv(id: Id, req: UpdateEnvRequest): Promise<EnvSummary>;
  startEnv(id: Id): Promise<EnvSummary>;
  stopEnv(id: Id): Promise<EnvSummary>;
  resetEnv(id: Id, req?: ResetEnvRequest): Promise<EnvSummary>;
  snapshotEnv(id: Id, req?: SnapshotEnvRequest): Promise<Snapshot>;
  forkEnv(id: Id, req?: ForkEnvRequest): Promise<EnvSummary>;
  deleteEnv(id: Id): Promise<void>;
  listSnapshots(id: Id): Promise<Snapshot[]>;
  getTree(id: Id, opts?: AtOpts): Promise<FileNode>;
  getFile(id: Id, path: string, opts?: AtOpts): Promise<FileContent>;
  exec(id: Id, req: ExecRequest): Promise<ExecResult>;
  getNet(id: Id, limit?: number): Promise<NetEntry[]>;

  createSession(req: CreateSessionRequest): Promise<SessionSummary>;
  getSession(id: Id): Promise<SessionSummary>;
  updateSession(id: Id, req: UpdateSessionRequest): Promise<SessionSummary>;
  getEvents(id: Id, after?: number): Promise<TraceEvent[]>;
  sendMessage(id: Id, text: string): Promise<void>;
  continueSession(id: Id): Promise<void>;
  /** Send the latest message again (it got no reply, e.g. refused as over the window). */
  retrySession(id: Id): Promise<void>;
  stopSession(id: Id): Promise<void>;
  deleteSession(id: Id): Promise<void>;

  getModelCall(id: Id): Promise<ModelCallDetail>;
  getBlob(sha256: string): Promise<string>;

  listModels(): Promise<ModelInfo[]>;
  loadModel(id: Id, req?: LoadModelRequest): Promise<void>;
  unloadModel(id: Id): Promise<void>;
  updateModel(id: Id, req: UpdateModelRequest): Promise<ModelInfo>;
  startInference(): Promise<InferenceState>;
  stopInference(): Promise<InferenceState>;
  modelSuggestions(): Promise<ModelSuggestion[]>;
  inspectModel(repo: string): Promise<ModelCheck>;
  startDownload(repo: string): Promise<ModelDownload>;
  cancelDownload(id: Id): Promise<ModelDownload>;
  removeModel(id: Id): Promise<RemoveModelResult>;

  getSettings(): Promise<SettingsInfo>;
  updateSettings(req: UpdateSettingsRequest): Promise<AppSettings>;
  reveal(path: PathKey): Promise<void>;
  getHarness(): Promise<HarnessInfo[]>;
  getSessionPrompt(id: Id): Promise<SessionPrompt>;

  listSuites(): Promise<EvalSuite[]>;
  startEvalRun(req: StartEvalRunRequest): Promise<EvalRunSummary>;
  listEvalRuns(): Promise<EvalRunSummary[]>;
  getEvalRun(id: Id): Promise<EvalRunDetail>;
  stopEvalRun(id: Id): Promise<void>;

  readonly lab: LabApi;

  /** Opens the event stream; reconnects on its own. Returns a disconnect function. */
  connect(handlers: BackendHandlers): () => void;
  /** Replaces the set of sessions whose trace events are pushed. */
  subscribe(sessionIds: Id[]): void;
}

export class ApiRequestError extends Error {
  status: number;
  detail?: string;
  constructor(status: number, message: string, detail?: string) {
    super(message);
    this.status = status;
    this.detail = detail;
  }
}
