import type {
  ApiError,
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
  Id,
  InferenceState,
  LoadModelRequest,
  ModelCallDetail,
  ModelInfo,
  NetEntry,
  ResetEnvRequest,
  SendMessageRequest,
  SessionSummary,
  Snapshot,
  SnapshotEnvRequest,
  StartEvalRunRequest,
  TraceEvent,
  UpdateEnvRequest,
  UpdateModelRequest,
  UpdateSessionRequest,
  WsClientMessage,
  WsMessage,
} from "@terrarium/shared";
import { ApiRequestError, type AtOpts, type Backend, type BackendHandlers } from "./backend";

type Method = "GET" | "POST" | "PATCH" | "DELETE";

function qs(params: Record<string, string | number | undefined>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : "";
}

const e = encodeURIComponent;

export class HttpBackend implements Backend {
  readonly kind = "http" as const;
  readonly label: string;
  private base: string;
  private token: string;
  private ws: WebSocket | null = null;
  private subs: Id[] = [];
  private closed = false;
  private retry = 0;
  private pingTimer: number | undefined;
  private retryTimer: number | undefined;

  constructor(url: string, token: string) {
    this.base = url.replace(/\/+$/, "");
    this.token = token;
    this.label = this.base.replace(/^https?:\/\//, "");
  }

  private async req<T>(method: Method, path: string, body?: unknown, raw = false): Promise<T> {
    const res = await fetch(this.base + path, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      let err: ApiError | undefined;
      try {
        err = (await res.json()) as ApiError;
      } catch {
        /* non-JSON error body */
      }
      throw new ApiRequestError(res.status, err?.error ?? `${method} ${path} failed (${res.status})`, err?.detail);
    }
    if (raw) return (await res.text()) as T;
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }

  getState() {
    return this.req<AppState>("GET", "/api/state");
  }

  createEnv(req: CreateEnvRequest) {
    return this.req<EnvSummary>("POST", "/api/envs", req);
  }
  updateEnv(id: Id, req: UpdateEnvRequest) {
    return this.req<EnvSummary>("PATCH", `/api/envs/${e(id)}`, req);
  }
  startEnv(id: Id) {
    return this.req<EnvSummary>("POST", `/api/envs/${e(id)}/start`, {});
  }
  stopEnv(id: Id) {
    return this.req<EnvSummary>("POST", `/api/envs/${e(id)}/stop`, {});
  }
  resetEnv(id: Id, req: ResetEnvRequest = {}) {
    return this.req<EnvSummary>("POST", `/api/envs/${e(id)}/reset`, req);
  }
  snapshotEnv(id: Id, req: SnapshotEnvRequest = {}) {
    return this.req<Snapshot>("POST", `/api/envs/${e(id)}/snapshot`, req);
  }
  forkEnv(id: Id, req: ForkEnvRequest = {}) {
    return this.req<EnvSummary>("POST", `/api/envs/${e(id)}/fork`, req);
  }
  deleteEnv(id: Id) {
    return this.req<void>("DELETE", `/api/envs/${e(id)}`);
  }
  listSnapshots(id: Id) {
    return this.req<Snapshot[]>("GET", `/api/envs/${e(id)}/snapshots`);
  }
  getTree(id: Id, opts: AtOpts = {}) {
    return this.req<FileNode>("GET", `/api/envs/${e(id)}/tree${qs({ at: opts.at, sessionId: opts.sessionId })}`);
  }
  getFile(id: Id, path: string, opts: AtOpts = {}) {
    return this.req<FileContent>("GET", `/api/envs/${e(id)}/file${qs({ path, at: opts.at, sessionId: opts.sessionId })}`);
  }
  exec(id: Id, req: ExecRequest) {
    return this.req<ExecResult>("POST", `/api/envs/${e(id)}/exec`, req);
  }
  getNet(id: Id, limit = 500) {
    return this.req<NetEntry[]>("GET", `/api/envs/${e(id)}/net${qs({ limit })}`);
  }

  createSession(req: CreateSessionRequest) {
    return this.req<SessionSummary>("POST", "/api/sessions", req);
  }
  getSession(id: Id) {
    return this.req<SessionSummary>("GET", `/api/sessions/${e(id)}`);
  }
  updateSession(id: Id, req: UpdateSessionRequest) {
    return this.req<SessionSummary>("PATCH", `/api/sessions/${e(id)}`, req);
  }
  getEvents(id: Id, after?: number) {
    return this.req<TraceEvent[]>("GET", `/api/sessions/${e(id)}/events${qs({ after })}`);
  }
  async sendMessage(id: Id, text: string) {
    const body: SendMessageRequest = { text };
    await this.req<unknown>("POST", `/api/sessions/${e(id)}/messages`, body);
  }
  async continueSession(id: Id) {
    await this.req<unknown>("POST", `/api/sessions/${e(id)}/continue`, {});
  }
  async retrySession(id: Id) {
    await this.req<unknown>("POST", `/api/sessions/${e(id)}/retry`, {});
  }
  async stopSession(id: Id) {
    await this.req<unknown>("POST", `/api/sessions/${e(id)}/stop`, {});
  }
  deleteSession(id: Id) {
    return this.req<void>("DELETE", `/api/sessions/${e(id)}`);
  }

  getModelCall(id: Id) {
    return this.req<ModelCallDetail>("GET", `/api/model-calls/${e(id)}`);
  }
  getBlob(sha256: string) {
    return this.req<string>("GET", `/api/blobs/${e(sha256)}`, undefined, true);
  }

  listModels() {
    return this.req<ModelInfo[]>("GET", "/api/models");
  }
  async loadModel(id: Id, req: LoadModelRequest = {}) {
    await this.req<unknown>("POST", `/api/models/${e(id)}/load`, req);
  }
  async unloadModel(id: Id) {
    await this.req<unknown>("POST", `/api/models/${e(id)}/unload`, {});
  }
  updateModel(id: Id, req: UpdateModelRequest) {
    return this.req<ModelInfo>("PATCH", `/api/models/${e(id)}`, req);
  }
  startInference() {
    return this.req<InferenceState>("POST", "/api/inference/start", {});
  }
  stopInference() {
    return this.req<InferenceState>("POST", "/api/inference/stop", {});
  }

  listSuites() {
    return this.req<EvalSuite[]>("GET", "/api/evals/suites");
  }
  startEvalRun(req: StartEvalRunRequest) {
    return this.req<EvalRunSummary>("POST", "/api/evals/runs", req);
  }
  listEvalRuns() {
    return this.req<EvalRunSummary[]>("GET", "/api/evals/runs");
  }
  getEvalRun(id: Id) {
    return this.req<EvalRunDetail>("GET", `/api/evals/runs/${e(id)}`);
  }
  async stopEvalRun(id: Id) {
    await this.req<unknown>("POST", `/api/evals/runs/${e(id)}/stop`, {});
  }

  // ---------- WebSocket ----------

  connect(h: BackendHandlers): () => void {
    this.closed = false;
    const open = () => {
      if (this.closed) return;
      h.onStatus("connecting");
      const wsUrl = this.base.replace(/^http/, "ws") + "/api/ws";
      const ws = new WebSocket(wsUrl, [`terrarium.${this.token}`]);
      this.ws = ws;
      ws.onopen = () => {
        this.retry = 0;
        h.onStatus("open");
        this.send({ type: "subscribe", sessionIds: this.subs });
        window.clearInterval(this.pingTimer);
        this.pingTimer = window.setInterval(() => this.send({ type: "ping" }), 20_000);
      };
      ws.onmessage = (ev) => {
        if (typeof ev.data !== "string") return;
        let msg: WsMessage;
        try {
          msg = JSON.parse(ev.data) as WsMessage;
        } catch {
          return;
        }
        h.onMessage(msg);
      };
      ws.onclose = (ev) => {
        window.clearInterval(this.pingTimer);
        if (this.ws === ws) this.ws = null;
        if (this.closed) return;
        const delay = Math.min(5000, 400 * 2 ** this.retry++);
        h.onStatus("closed", ev.reason || `socket closed (${ev.code}); retrying in ${(delay / 1000).toFixed(1)} s`);
        this.retryTimer = window.setTimeout(open, delay);
      };
    };
    open();
    return () => {
      this.closed = true;
      window.clearTimeout(this.retryTimer);
      window.clearInterval(this.pingTimer);
      this.ws?.close();
      this.ws = null;
    };
  }

  subscribe(sessionIds: Id[]) {
    this.subs = sessionIds;
    this.send({ type: "subscribe", sessionIds });
  }

  private send(msg: WsClientMessage) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }
}
