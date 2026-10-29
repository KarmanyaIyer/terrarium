// Sessions: one pi-agent-core Agent per run, wired to an env runtime, the logging gateway and the trace.
// The transcript (agent messages) is owned here and persisted as a blob after every run so sessions resume
// after a restart. Every model call, tool call, file change and network attempt becomes a TraceEvent.

import { Agent, type AgentEvent, type AgentMessage, type AgentTool } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Message, ToolResultMessage } from "@earendil-works/pi-ai";
import type {
  ContextUsage,
  CreateSessionRequest,
  HarnessProfile,
  ModelInfo,
  NetEntry,
  SessionStatus,
  SessionSummary,
  ToolCallRef,
  UpdateSessionRequest,
} from "@terrarium/shared";
import type { EnvManager } from "../envs/manager.ts";
import type { EnvRuntime, Manifest } from "../envs/types.ts";
import { defaultOutputBudget, familySampling } from "../inference/catalog.ts";
import type { CallResult, Gateway } from "../inference/gateway.ts";
import type { InferenceService } from "../inference/service.ts";
import type { Hub } from "../hub.ts";
import type { Store } from "../store/db.ts";
import { SessionTracer } from "../trace.ts";
import { HttpError, errorMessage } from "../util/errors.ts";
import { newId } from "../util/ids.ts";
import { logger } from "../util/log.ts";
import { TokenCalibrator } from "./budget.ts";
import { compact } from "./compaction.ts";
import { FsObserver } from "./observer.ts";
import { CHAT_PROMPT, PI_STOCK_PROMPT, SIM_NOTE, TERRARIUM_PROMPT } from "./prompts.ts";
import { type CallInfo, makeStreamFn, omlxModel, type Sampling } from "./stream.ts";
import { type ToolDetails, piStockTools, terrariumTools } from "./tools.ts";

const log = logger("sessions");

export const HARNESSES: HarnessProfile[] = ["terrarium", "pi-stock", "chat"];
export const DEFAULT_MAX_TURNS = 50;
export const CONTINUE_TEXT = "Continue from where you stopped.";
const TOOL_OUTPUT_CHARS = 6000; // ~1,500 tokens per tool result given to the model
const EVENT_OUTPUT_CAP = 256 * 1024; // stdout/stderr kept in the persisted tool_end event
const MUTATING_TOOLS = new Set(["bash", "write", "edit"]);

export type RunEndReason = "done" | "stopped" | "max_turns" | "error" | "length";

export interface RunOptions {
  maxTurns?: number;
  timeoutMs?: number;
}

export interface RunOutcome {
  reason: RunEndReason;
  finalText: string;
  error?: string;
  timedOut?: boolean;
}

interface SessionRow {
  id: string;
  env_id: string | null;
  title: string;
  model_id: string;
  harness: HarnessProfile;
  thinking: number;
  context_window: number;
  max_output_tokens: number;
  status: SessionStatus;
  last_seq: number;
  eval_run_id: string | null;
  eval_case_id: string | null;
  ephemeral: number;
  context_json: string | null;
  transcript_blob: string | null;
  created_at: number;
  updated_at: number;
}

interface Live {
  id: string;
  tracer: SessionTracer;
  calibrator: TokenCalibrator;
  turn: number;
  agent: Agent | null;
  running: Promise<RunOutcome> | null;
  stopRequested: boolean;
  timedOut: boolean;
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((c: any) => (c?.type === "text" ? c.text : "")).join("");
  return "";
}

/** Gemma 4 emits an empty thought channel when thinking is off; hide it in the transcript view only. */
export function displayText(text: string): string {
  return text.replace(/<\|channel>thought\s*<channel\|>/g, "").trim();
}

function clipEvent(s: string | undefined): { text: string | undefined; cut: boolean } {
  if (s === undefined || s.length <= EVENT_OUTPUT_CAP) return { text: s, cut: false };
  const half = EVENT_OUTPUT_CAP / 2;
  return { text: `${s.slice(0, half)}\n[... ${s.length - EVENT_OUTPUT_CAP} characters not stored ...]\n${s.slice(-half)}`, cut: true };
}

/**
 * Make a stored transcript safe to send again: drop system messages (the Agent re-adds the current prompt and
 * tools), errored/aborted assistant messages, orphan tool results, and answer tool calls that never got a result.
 */
export function sanitizeTranscript(messages: AgentMessage[]): AgentMessage[] {
  const out: AgentMessage[] = [];
  const kept = new Set<string>();
  for (const m of messages) {
    if (m.role === "system") continue;
    if (m.role === "assistant") {
      const a = m as AssistantMessage;
      if (a.stopReason === "error" || a.stopReason === "aborted") continue;
      for (const c of a.content) if (c.type === "toolCall") kept.add(c.id);
      out.push(m);
      continue;
    }
    if (m.role === "toolResult") {
      if (!kept.has((m as ToolResultMessage).toolCallId)) continue;
      out.push(m);
      continue;
    }
    out.push(m);
  }
  // Insert synthetic results for calls without one, right after their assistant message's results.
  const answered = new Set(out.filter((m) => m.role === "toolResult").map((m) => (m as ToolResultMessage).toolCallId));
  const fixed: AgentMessage[] = [];
  for (let i = 0; i < out.length; i++) {
    fixed.push(out[i]);
    const m = out[i];
    if (m.role !== "assistant") continue;
    let j = i + 1;
    while (j < out.length && out[j].role === "toolResult") fixed.push(out[j++]);
    i = j - 1;
    for (const c of (m as AssistantMessage).content) {
      if (c.type !== "toolCall" || answered.has(c.id)) continue;
      fixed.push({ role: "toolResult", toolCallId: c.id, toolName: c.name, content: [{ type: "text", text: "Tool call was interrupted before it finished." }], isError: true, timestamp: Date.now() } as ToolResultMessage);
    }
  }
  return fixed;
}

/** Transcript as persisted: tool `details` (full stdout etc.) are already in the trace, so drop them here. */
function forStorage(messages: AgentMessage[]): AgentMessage[] {
  return messages.map((m) => {
    if (m.role !== "toolResult") return m;
    const { details: _d, ...rest } = m as ToolResultMessage & { details?: unknown };
    return rest as AgentMessage;
  });
}

function isLlmMessage(m: AgentMessage): m is Message {
  return m.role === "system" || m.role === "user" || m.role === "assistant" || m.role === "toolResult";
}

const DEFAULT_TITLE = "New session";

/** First line of a message, whitespace collapsed, cut at a word near 60 chars. */
export function titleFrom(text: string): string {
  const line = text.trim().split("\n")[0].replace(/\s+/g, " ");
  if (line.length <= 60) return line || DEFAULT_TITLE;
  const cut = line.slice(0, 60);
  const space = cut.lastIndexOf(" ");
  return `${(space > 30 ? cut.slice(0, space) : cut).replace(/[\s,.;:]+$/, "")}…`;
}

export class SessionManager {
  private store: Store;
  private hub: Hub;
  private envs: EnvManager;
  private inference: InferenceService;
  private gateway: Gateway;
  private live = new Map<string, Live>();

  constructor(opts: { store: Store; hub: Hub; envs: EnvManager; inference: InferenceService; gateway: Gateway }) {
    this.store = opts.store;
    this.hub = opts.hub;
    this.envs = opts.envs;
    this.inference = opts.inference;
    this.gateway = opts.gateway;
    this.store.run("UPDATE sessions SET status = 'idle' WHERE status IN ('running', 'stopping')");
    this.envs.hooks.onSessionNet = (sessionId, entry) => this.onNet(sessionId, entry);
    this.envs.hooks.onEnvInterrupted = async (_envId, sessionId) => {
      await this.stop(sessionId);
    };
  }

  // ---------- queries ----------

  private row(id: string): SessionRow {
    const r = this.store.get<SessionRow>("SELECT * FROM sessions WHERE id = ?", id);
    if (!r) throw new HttpError(404, `session not found: ${id}`);
    return r;
  }

  private summary(r: SessionRow): SessionSummary {
    return {
      id: r.id,
      envId: r.env_id,
      title: r.title,
      modelId: r.model_id,
      harness: r.harness,
      thinking: !!r.thinking,
      contextWindow: r.context_window,
      maxOutputTokens: r.max_output_tokens,
      status: r.status,
      lastSeq: r.last_seq,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      ...(r.eval_run_id ? { evalRunId: r.eval_run_id } : {}),
      ...(r.eval_case_id ? { evalCaseId: r.eval_case_id } : {}),
      ...(r.context_json ? { context: JSON.parse(r.context_json) as ContextUsage } : {}),
    };
  }

  list(): SessionSummary[] {
    return this.store.all<SessionRow>("SELECT * FROM sessions WHERE ephemeral = 0 ORDER BY updated_at DESC").map((r) => this.summary(r));
  }

  get(id: string): SessionSummary {
    return this.summary(this.row(id));
  }

  exists(id: string): boolean {
    return !!this.store.get("SELECT 1 AS x FROM sessions WHERE id = ?", id);
  }

  events(id: string, after = 0, limit = 5000) {
    this.row(id);
    return this.store.events(id, after, limit);
  }

  isRunning(id: string): boolean {
    return !!this.live.get(id)?.running;
  }

  private broadcast(id: string): void {
    const r = this.store.get<SessionRow>("SELECT * FROM sessions WHERE id = ?", id);
    if (r) this.hub.broadcast({ type: "session", session: this.summary(r) });
  }

  private setStatus(id: string, status: SessionStatus): void {
    this.store.run("UPDATE sessions SET status = ?, updated_at = ? WHERE id = ?", status, Date.now(), id);
    this.broadcast(id);
  }

  private liveFor(id: string): Live {
    let l = this.live.get(id);
    if (!l) {
      const r = this.row(id);
      const turns = this.store.get<{ n: number }>("SELECT COUNT(*) AS n FROM events WHERE session_id = ? AND type = 'turn_start'", id)?.n ?? 0;
      l = {
        id,
        tracer: new SessionTracer(id, r.last_seq, this.store, this.hub),
        calibrator: new TokenCalibrator(),
        turn: turns,
        agent: null,
        running: null,
        stopRequested: false,
        timedOut: false,
      };
      this.live.set(id, l);
    }
    return l;
  }

  // ---------- create / update / delete ----------

  private async requireModel(id: string): Promise<ModelInfo> {
    if (typeof id !== "string" || !id) throw new HttpError(400, "modelId is required");
    const m = await this.inference.model(id);
    if (!m) throw new HttpError(400, `model not found in models/: ${id}`);
    return m;
  }

  private sizing(model: ModelInfo, thinking: boolean, window?: number, maxOutput?: number): { window: number; maxOutput: number } {
    let w = Math.floor(window ?? model.defaultContext);
    if (!Number.isFinite(w) || w < 2048) throw new HttpError(400, "contextWindow must be at least 2048");
    w = Math.min(w, model.nativeContext);
    let out = maxOutput ?? (w === model.defaultContext && !thinking ? model.defaultMaxOutput : defaultOutputBudget(w, thinking));
    if (!Number.isFinite(out) || out < 16) throw new HttpError(400, "maxOutputTokens must be at least 16");
    out = Math.min(Math.floor(out), w - 1024);
    return { window: w, maxOutput: out };
  }

  async create(req: CreateSessionRequest, opts: { evalRunId?: string; evalCaseId?: string; ephemeral?: boolean; id?: string } = {}): Promise<SessionSummary> {
    if (!HARNESSES.includes(req.harness)) throw new HttpError(400, `harness must be one of ${HARNESSES.join(", ")}`);
    const model = await this.requireModel(req.modelId);
    const envId = req.envId ?? null;
    if (envId) this.envs.get(envId);
    if (!envId && req.harness !== "chat") throw new HttpError(400, `harness ${req.harness} needs an environment`);
    const thinking = model.thinking === "none" ? false : (req.thinking ?? model.thinking === "default-on");
    const { window, maxOutput } = this.sizing(model, thinking, req.contextWindow, req.maxOutputTokens);
    const id = opts.id ?? newId("ses");
    const now = Date.now();
    const title = (req.title ?? "").trim().slice(0, 200) || DEFAULT_TITLE;
    this.store.run(
      `INSERT INTO sessions (id, env_id, title, model_id, harness, thinking, context_window, max_output_tokens, status, last_seq,
        eval_run_id, eval_case_id, ephemeral, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'idle', 0, ?, ?, ?, ?, ?)`,
      id,
      envId,
      title,
      model.id,
      req.harness,
      thinking ? 1 : 0,
      window,
      maxOutput,
      opts.evalRunId ?? null,
      opts.evalCaseId ?? null,
      opts.ephemeral ? 1 : 0,
      now,
      now,
    );
    const s = this.get(id);
    if (!opts.ephemeral) this.hub.broadcast({ type: "session", session: s });
    return s;
  }

  async update(id: string, patch: UpdateSessionRequest): Promise<SessionSummary> {
    const r = this.row(id);
    const onlyTitle = Object.keys(patch).every((k) => k === "title");
    if (this.isRunning(id) && !onlyTitle) throw new HttpError(409, "session is running; stop it before changing model or settings");
    if (patch.harness !== undefined && !HARNESSES.includes(patch.harness)) throw new HttpError(400, `harness must be one of ${HARNESSES.join(", ")}`);
    if (patch.harness && patch.harness !== "chat" && !r.env_id) throw new HttpError(400, `harness ${patch.harness} needs an environment`);
    const modelId = patch.modelId ?? r.model_id;
    const model = await this.requireModel(modelId);
    const thinking = model.thinking === "none" ? false : (patch.thinking ?? !!r.thinking);
    const windowChanged = patch.contextWindow !== undefined || modelId !== r.model_id || thinking !== !!r.thinking;
    const { window, maxOutput } = this.sizing(
      model,
      thinking,
      patch.contextWindow ?? Math.min(r.context_window, model.nativeContext),
      // A new window, model or thinking mode gets that combination's default output budget unless one is given.
      patch.maxOutputTokens ?? (windowChanged ? undefined : r.max_output_tokens),
    );
    const title = patch.title !== undefined ? patch.title.trim().slice(0, 200) || r.title : r.title;
    this.store.run(
      "UPDATE sessions SET title = ?, model_id = ?, harness = ?, thinking = ?, context_window = ?, max_output_tokens = ?, updated_at = ? WHERE id = ?",
      title,
      model.id,
      patch.harness ?? r.harness,
      thinking ? 1 : 0,
      window,
      maxOutput,
      Date.now(),
      id,
    );
    if (modelId !== r.model_id && r.last_seq > 0) {
      const live = this.liveFor(id);
      live.calibrator = new TokenCalibrator();
      live.tracer.emit({ type: "warning", code: "model_switched", message: `Model switched from ${r.model_id} to ${model.id}; the next turn uses ${model.id}.`, data: { from: r.model_id, to: model.id } });
    }
    this.broadcast(id);
    return this.get(id);
  }

  async delete(id: string): Promise<void> {
    const r = this.row(id);
    if (this.isRunning(id)) await this.stop(id);
    if (this.isRunning(id)) throw new HttpError(409, "session is still stopping; try again shortly");
    this.store.tx(() => {
      this.store.run("DELETE FROM events WHERE session_id = ?", id);
      this.store.run("DELETE FROM model_calls WHERE session_id = ?", id);
      this.store.run("DELETE FROM manifests WHERE session_id = ?", id);
      this.store.run("DELETE FROM sessions WHERE id = ?", id);
    });
    this.live.delete(id);
    if (!r.ephemeral) this.hub.broadcast({ type: "session_deleted", sessionId: id });
  }

  // ---------- runs ----------

  /** Start a run in the background (REST). Throws 409 when the session or its env is busy. */
  sendMessage(id: string, text: string): SessionSummary {
    if (typeof text !== "string" || !text.trim()) throw new HttpError(400, "text is required");
    this.startRun(id, text, {});
    return this.get(id);
  }

  continue(id: string): SessionSummary {
    this.startRun(id, CONTINUE_TEXT, {});
    return this.get(id);
  }

  /** Run to completion (evals). */
  run(id: string, text: string, opts: RunOptions = {}): Promise<RunOutcome> {
    return this.startRun(id, text, opts);
  }

  private startRun(id: string, text: string, opts: RunOptions): Promise<RunOutcome> {
    const r = this.row(id);
    const live = this.liveFor(id);
    if (live.running) throw new HttpError(409, "session is already running");
    if (r.harness !== "chat" && r.env_id) {
      const holder = this.envs.activeSession(r.env_id);
      if (holder && holder !== id) throw new HttpError(409, `environment is busy with session ${holder}`);
    }
    live.stopRequested = false;
    live.timedOut = false;
    // An untitled session is named after its first message, so the sidebar isn't a column of "New session".
    if (r.last_seq === 0 && r.title === DEFAULT_TITLE) this.store.run("UPDATE sessions SET title = ? WHERE id = ?", titleFrom(text), id);
    this.setStatus(id, "running");
    const p = this.runInner(live, text, opts)
      .catch((err): RunOutcome => {
        log.error(`run failed for ${id}`, err);
        return { reason: "error", finalText: "", error: errorMessage(err) };
      })
      .finally(() => {
        live.running = null;
        live.agent = null;
      });
    live.running = p;
    return p;
  }

  async stop(id: string): Promise<SessionSummary> {
    const live = this.live.get(id);
    if (live?.running) {
      live.stopRequested = true;
      this.setStatus(id, "stopping");
      live.agent?.abort();
      const timer = new Promise<void>((resolve) => setTimeout(resolve, 15_000).unref());
      await Promise.race([live.running.then(() => undefined), timer]);
    }
    return this.get(id);
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.live.keys()].filter((id) => this.isRunning(id)).map((id) => this.stop(id)));
  }

  private onNet(sessionId: string, entry: NetEntry): void {
    if (!this.exists(sessionId)) return;
    this.liveFor(sessionId).tracer.emit({ type: "net", entry });
  }

  private loadTranscript(r: SessionRow): AgentMessage[] {
    if (!r.transcript_blob) return [];
    return (this.store.blobs.getJson<AgentMessage[]>(r.transcript_blob) ?? []) as AgentMessage[];
  }

  private saveTranscript(id: string, messages: AgentMessage[]): void {
    const blob = this.store.blobs.putJson(forStorage(messages));
    this.store.run("UPDATE sessions SET transcript_blob = ? WHERE id = ?", blob, id);
  }

  private async runInner(live: Live, text: string, opts: RunOptions): Promise<RunOutcome> {
    const id = live.id;
    const r = this.row(id);
    const tracer = live.tracer;
    let reason: RunEndReason = "done";
    let error: string | undefined;
    let finalText = "";
    let runtime: EnvRuntime | null = null;
    let observer: FsObserver | null = null;
    let loopMessages: AgentMessage[] | null = null;
    let transcript = this.loadTranscript(r);
    let timeout: NodeJS.Timeout | undefined;
    const envId = r.harness !== "chat" ? r.env_id : null;

    tracer.emit({ type: "user_message", text });
    try {
      const model = await this.requireModel(r.model_id);
      const thinking = !!r.thinking && model.thinking !== "none";
      const sampling: Sampling = thinking ? { ...familySampling(model.family, true) } : { ...model.sampling };
      const window = r.context_window;
      const maxOutput = r.max_output_tokens;
      const maxTurns = Math.max(1, opts.maxTurns ?? DEFAULT_MAX_TURNS);

      let envType: string | null = null;
      if (envId) {
        const env = this.envs.get(envId);
        envType = env.type;
        const wasRunning = env.status === "running";
        runtime = await this.envs.acquire(envId, id);
        if (!wasRunning) tracer.emit({ type: "env_lifecycle", envId, action: "start" });
        observer = new FsObserver({ store: this.store, envs: this.envs, envId, sessionId: id, runtime, tracer });
        await observer.baseline();
      }
      if (live.stopRequested) throw new StopSignal();

      const host = {
        runtime: runtime!,
        outputChars: TOOL_OUTPUT_CHARS,
        onOutput: (toolCallId: string, stream: "stdout" | "stderr", chunk: string) => tracer.stream({ type: "tool_output", toolCallId, stream, chunk }),
      };
      const tools: AgentTool<any, ToolDetails>[] = !runtime ? [] : r.harness === "pi-stock" ? piStockTools(host) : terrariumTools(host);
      const systemPrompt = r.harness === "chat" || !runtime ? CHAT_PROMPT : r.harness === "pi-stock" ? PI_STOCK_PROMPT : TERRARIUM_PROMPT + (envType === "sim" ? SIM_NOTE : "");

      let currentCallId = "";
      let turnsThisRun = 0;
      let warnedFull = false;
      let lastAssistant: AssistantMessage | null = null;
      const befores = new Map<string, Manifest>();
      const fileChanges = new Map<string, number>();

      const contextUsage = (prompt: number, completion: number, source: ContextUsage["source"]): ContextUsage => {
        const sys = Math.min(prompt, live.calibrator.estimate(agent.state.messages.filter((m) => m.role === "system")));
        const used = prompt + completion;
        return { window, systemAndTools: sys, history: Math.max(0, used - sys), outputReserve: maxOutput, free: Math.max(0, window - used - maxOutput), source };
      };
      const emitContext = (usage: ContextUsage) => {
        tracer.emit({ type: "context", usage });
        this.store.run("UPDATE sessions SET context_json = ? WHERE id = ?", JSON.stringify(usage), id);
      };

      const onCallEnd = (res: CallResult, info: CallInfo) => {
        const u = res.usage;
        if (u && u.promptTokens > 0) {
          live.calibrator.observe(info.rawEstimate, u.promptTokens);
          emitContext(contextUsage(u.promptTokens, u.completionTokens, "server"));
          if (info.estimate > window && u.promptTokens < info.estimate * 0.6) {
            tracer.emit({
              type: "warning",
              code: "prompt_truncated_by_server",
              message: `Server counted ${u.promptTokens} prompt tokens but the request was estimated at ${info.estimate}; the server may have cut the prompt to fit ${window}.`,
              data: { contextWindow: window, promptTokens: u.promptTokens, estimate: info.estimate },
            });
          }
          if (!warnedFull && u.promptTokens + u.completionTokens > window * 0.9) {
            warnedFull = true;
            tracer.emit({
              type: "warning",
              code: "context_near_full",
              message: `Context is ${Math.round(((u.promptTokens + u.completionTokens) / window) * 100)}% full (${u.promptTokens + u.completionTokens} of ${window} tokens).`,
              data: { contextWindow: window, promptTokens: u.promptTokens, completionTokens: u.completionTokens },
            });
          }
        }
        if (res.finishReason === "length") {
          tracer.emit({
            type: "warning",
            code: "output_truncated",
            message: `Output stopped at the ${info.maxTokens}-token cap (context window ${window}, prompt ${u?.promptTokens ?? info.estimate} tokens). Continue to resume.`,
            data: { contextWindow: window, promptTokens: u?.promptTokens ?? info.estimate, maxTokens: info.maxTokens, completionTokens: u?.completionTokens ?? 0 },
          });
        }
      };

      const agent: Agent = new Agent({
        initialState: {
          systemPrompt,
          model: omlxModel(model.id, window, maxOutput),
          thinkingLevel: "off",
          tools,
          messages: sanitizeTranscript(transcript),
        },
        sessionId: id,
        toolExecution: "sequential",
        convertToLlm: (messages) => messages.filter(isLlmMessage),
        transformContext: async (messages) => {
          loopMessages = messages;
          const res = compact(messages, {
            window,
            outputBudget: maxOutput,
            estimate: (m) => live.calibrator.estimate(m),
            filesChanged: () => (observer ? [...observer.changedPaths].map((p) => p.replace(/^\/workspace\//, "")) : []),
          });
          if (res.removedTurns || res.truncatedResults) {
            messages.splice(0, messages.length, ...res.messages);
            tracer.emit({ type: "compaction", beforeTokens: res.beforeTokens, afterTokens: res.afterTokens, removedTurns: res.removedTurns, note: res.note });
          }
          if (!warnedFull && res.afterTokens > window - maxOutput - 256) {
            warnedFull = true;
            tracer.emit({
              type: "warning",
              code: "context_near_full",
              message: `Prompt is about ${res.afterTokens} tokens after compaction; only ${Math.max(0, window - res.afterTokens)} of ${window} tokens are left for the reply.`,
              data: { contextWindow: window, promptTokens: res.afterTokens, maxOutput },
            });
          }
          return messages;
        },
        streamFn: makeStreamFn({
          gateway: this.gateway,
          tracer,
          calibrator: live.calibrator,
          params: () => ({ modelId: model.id, window, maxOutput, thinking, sampling, turn: live.turn }),
          ensureReady: (p) => this.inference.ensureModel(p.modelId, p.window, p.maxOutput),
          toolNames: () => tools.map((t) => t.name),
          fencedBash: false,
          onCallStart: (info) => {
            currentCallId = info.callId;
          },
          onCallEnd,
          onRetry: (callId, attempt, reason) =>
            tracer.emit({
              type: "warning",
              code: "other",
              message: `The server could not parse the model's tool call and returned an error (${reason}). Retrying the same request (retry ${attempt} of 2).`,
              data: { callId, attempt },
            }),
          onRepair: (callId, info) =>
            tracer.emit({
              type: "harness_repair",
              callId,
              original: info.original,
              repaired: info.calls.map((c): ToolCallRef => ({ id: c.id, name: c.name, args: c.arguments })),
              reason: info.reason,
            }),
        }),
        beforeToolCall: async ({ toolCall }) => {
          if (observer && MUTATING_TOOLS.has(toolCall.name)) befores.set(toolCall.id, await observer.snapshot());
          return undefined;
        },
        afterToolCall: async ({ toolCall }) => {
          const before = befores.get(toolCall.id);
          if (observer && before) {
            befores.delete(toolCall.id);
            const changes = await observer.after(toolCall.id, before);
            fileChanges.set(toolCall.id, changes.length);
          }
          return undefined;
        },
        finishTurn: (turn) => {
          turnsThisRun++;
          if (turn.message.stopReason === "length") {
            reason = "length";
            return { action: "end" };
          }
          if (turn.toolResults.length && turnsThisRun >= maxTurns) {
            reason = "max_turns";
            return { action: "end" };
          }
          return undefined;
        },
      });
      live.agent = agent;

      agent.subscribe((ev: AgentEvent) => {
        try {
          this.onAgentEvent(ev, { tracer, live, currentCallId: () => currentCallId, fileChanges, onAssistant: (m) => (lastAssistant = m) });
        } catch (err) {
          log.warn(`event mapping failed for ${id}`, err);
        }
      });

      emitContext(contextUsage(live.calibrator.estimate([...agent.state.messages, { role: "user", content: text, timestamp: Date.now() }]), 0, "estimate"));
      if (opts.timeoutMs) {
        timeout = setTimeout(() => {
          live.timedOut = true;
          live.stopRequested = true;
          agent.abort();
        }, opts.timeoutMs);
      }
      await agent.prompt(text);

      const last = lastAssistant as AssistantMessage | null;
      if (last) finalText = displayText(last.content.filter((c) => c.type === "text").map((c) => (c as { text: string }).text).join(""));
      if (live.stopRequested) reason = "stopped";
      else if (last?.stopReason === "error") {
        reason = "error";
        error = last.errorMessage ?? "model call failed";
      }
      transcript = loopMessages ?? agent.state.messages;
    } catch (err) {
      if (err instanceof StopSignal || live.stopRequested) reason = "stopped";
      else {
        reason = "error";
        error = errorMessage(err);
        tracer.emit({ type: "error", message: error });
      }
      if (live.agent) transcript = loopMessages ?? live.agent.state.messages;
    } finally {
      if (timeout) clearTimeout(timeout);
      try {
        this.saveTranscript(id, transcript);
      } catch (err) {
        log.warn(`saving transcript failed for ${id}`, err);
      }
      if (envId && runtime) {
        // Nothing the agent started outlives its run (setsid daemons included).
        await runtime.killAgentProcesses().catch((err) => log.warn(`killing agent processes after run failed for ${id}`, err));
        this.envs.release(envId, id);
      }
      tracer.emit({ type: "run_end", reason });
      this.setStatus(id, "idle");
    }
    return { reason, finalText, ...(error ? { error } : {}), ...(live.timedOut ? { timedOut: true } : {}) };
  }

  private onAgentEvent(
    ev: AgentEvent,
    ctx: { tracer: SessionTracer; live: Live; currentCallId: () => string; fileChanges: Map<string, number>; onAssistant: (m: AssistantMessage) => void },
  ): void {
    const { tracer, live } = ctx;
    switch (ev.type) {
      case "turn_start":
        live.turn++;
        tracer.emit({ type: "turn_start", turn: live.turn });
        break;
      case "message_end": {
        if (ev.message.role !== "assistant") break;
        const m = ev.message as AssistantMessage;
        ctx.onAssistant(m);
        const text = displayText(m.content.filter((c) => c.type === "text").map((c) => (c as { text: string }).text).join(""));
        const thinking = m.content.filter((c) => c.type === "thinking").map((c) => (c as { thinking: string }).thinking).join("");
        const toolCalls = m.content.filter((c) => c.type === "toolCall").map((c): ToolCallRef => ({ id: c.id, name: c.name, args: c.arguments }));
        tracer.emit({ type: "assistant_message", callId: ctx.currentCallId(), text, ...(thinking ? { thinking } : {}), toolCalls });
        if (m.stopReason === "error") tracer.emit({ type: "error", message: m.errorMessage ?? "model call failed" });
        break;
      }
      case "tool_execution_start":
        tracer.emit({ type: "tool_start", toolCallId: ev.toolCallId, callId: ctx.currentCallId(), name: ev.toolName, args: ev.args });
        break;
      case "tool_execution_end": {
        const result = ev.result as { content?: unknown; details?: ToolDetails } | undefined;
        const d = result?.details;
        const stdout = clipEvent(d?.stdout);
        const stderr = clipEvent(d?.stderr);
        tracer.emit({
          type: "tool_end",
          toolCallId: ev.toolCallId,
          name: ev.toolName,
          ...(d?.exitCode !== undefined ? { exitCode: d.exitCode } : {}),
          durationMs: Math.round(d?.durationMs ?? ev.durationMs ?? 0),
          ...(stdout.text !== undefined ? { stdout: stdout.text } : {}),
          ...(stderr.text !== undefined ? { stderr: stderr.text } : {}),
          outputTruncated: !!d?.truncated || stdout.cut || stderr.cut,
          resultForModel: textOf(result?.content),
          isError: ev.isError,
          fileChanges: ctx.fileChanges.get(ev.toolCallId) ?? 0,
        });
        ctx.fileChanges.delete(ev.toolCallId);
        break;
      }
      default:
        break;
    }
  }
}

class StopSignal extends Error {
  constructor() {
    super("stopped");
  }
}
