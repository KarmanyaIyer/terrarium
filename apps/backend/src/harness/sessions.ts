// Sessions: one pi-agent-core Agent per run, wired to an env runtime, the logging gateway and the trace.
// The transcript (agent messages) is owned here and persisted as a blob after every run so sessions resume
// after a restart. Every model call, tool call, file change and network attempt becomes a TraceEvent.

import { Agent, type AgentEvent, type AgentMessage, type AgentTool } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Message, ToolResultMessage } from "@earendil-works/pi-ai";
import type {
  AppSettings,
  ContextUsage,
  CreateSessionRequest,
  EnvType,
  HarnessProfile,
  ModelInfo,
  NetEntry,
  SessionPrompt,
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
import { BudgetExceededError, type BudgetTrip, type ResourceBudgets } from "../resource-budgets.ts";
import { SessionTracer } from "../trace.ts";
import { HttpError, errorMessage } from "../util/errors.ts";
import { newId } from "../util/ids.ts";
import { logger } from "../util/log.ts";
import { type ChatTokenizer, MIN_REPLY_TOKENS, PromptCounter, TokenCalibrator } from "./budget.ts";
import { compact, type CompactionResult, windowThatFits } from "./compaction.ts";
import { FsObserver } from "./observer.ts";
import { roughTokens, sessionPrompt, toolDefinitions, toolsJson } from "./profiles.ts";
import { type CallInfo, makeStreamFn, omlxModel, requestBody, type Sampling } from "./stream.ts";
import { type ToolDetails, piStockTools, terrariumTools } from "./tools.ts";

const log = logger("sessions");

export const HARNESSES: HarnessProfile[] = ["terrarium", "pi-stock", "chat"];
export const DEFAULT_MAX_TURNS = 50;
export const CONTINUE_TEXT = "Continue from where you stopped.";
const TOOL_OUTPUT_CHARS = 6000; // ~1,500 tokens per tool result given to the model
const EVENT_OUTPUT_CAP = 256 * 1024; // stdout/stderr kept in the persisted tool_end event
const MUTATING_TOOLS = new Set(["bash", "write", "edit"]);

export type RunEndReason = "done" | "stopped" | "max_turns" | "error" | "length" | "budget";

export interface RunOptions {
  maxTurns?: number;
  timeoutMs?: number;
}

/** What a Retry runs again (retry()): the unanswered user message, or the step after the latest tool results. */
type Retry = "message" | "step";

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
  system_prompt: string | null;
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
  budgetTrip: BudgetTrip | null;
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((c: any) => (c?.type === "text" ? c.text : "")).join("");
  return "";
}

const fmt = (n: number) => n.toLocaleString("en-US");

/** Context sizes offered in the UI; the remedy names the smallest that fits. */
const WINDOWS = [4096, 8192, 16384, 32768, 65536, 131072, 262144];

/** The smallest window in which compaction keeps a `prompt`-token prompt with the full output cap free. */
export function windowFor(prompt: number, maxOutput: number, nativeContext: number): number | undefined {
  return windowThatFits(prompt, maxOutput, WINDOWS, nativeContext);
}

/** oMLX's message when a prompt is over the context length it loaded the model with. */
const SERVER_OVERFLOW_RE = /Prompt is too long: (\d+) tokens > (\d+) maximum context length/;

/**
 * The inference server refused the prompt as too long: the error with the real numbers and what to do. Only
 * reachable when the tokenizer couldn't be used before sending (the harness refuses over-window prompts itself).
 */
export function explainServerOverflow(raw: string, window: number, maxOutput: number, nativeContext: number): { message: string; detail: string; data: Record<string, number> } | null {
  const m = raw.match(SERVER_OVERFLOW_RE);
  if (!m) return null;
  const prompt = Number(m[1]);
  const serverMax = Number(m[2]);
  const need = windowFor(prompt, maxOutput, nativeContext);
  return {
    message: `The inference server rejected the request: the prompt is ${fmt(prompt)} tokens, over the ${fmt(serverMax)}-token context the model is loaded with (session window ${fmt(window)}).`,
    detail: [
      `Server: ${raw}`,
      need ? `Raise the session's context window to ${fmt(need)} or more, or start a new session.` : `The prompt is too long for this model (native context ${fmt(nativeContext)}); start a new session or shorten the last message.`,
    ].join("\n"),
    data: { promptTokens: prompt, serverMaxContext: serverMax, contextWindow: window, maxOutputTokens: maxOutput, ...(need ? { suggestedWindow: need } : {}) },
  };
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
const PROMPT_MAX = 32_000;

/** First line of a message, whitespace collapsed, cut at a word near 60 chars. */
export function titleFrom(text: string): string {
  const line = text.trim().split("\n")[0].replace(/\s+/g, " ");
  if (line.length <= 60) return line || DEFAULT_TITLE;
  const cut = line.slice(0, 60);
  const space = cut.lastIndexOf(" ");
  return `${(space > 30 ? cut.slice(0, space) : cut).replace(/[\s,.;:]+$/, "")}…`;
}

export class SessionManager {
  /** A session was deleted: blobs only it referenced may be garbage now. */
  onDeleted?: (sessionId: string) => void;
  private store: Store;
  private hub: Hub;
  private envs: EnvManager;
  private inference: InferenceService;
  private gateway: Gateway;
  private tokens: ChatTokenizer | undefined;
  private budgets: ResourceBudgets;
  /** Saved per-profile prompt defaults (Settings). */
  private prompts: () => AppSettings["prompts"];
  private live = new Map<string, Live>();

  constructor(opts: {
    store: Store;
    hub: Hub;
    envs: EnvManager;
    inference: InferenceService;
    gateway: Gateway;
    tokens?: ChatTokenizer;
    budgets?: ResourceBudgets;
    prompts?: () => AppSettings["prompts"];
  }) {
    this.store = opts.store;
    this.hub = opts.hub;
    this.envs = opts.envs;
    this.inference = opts.inference;
    this.gateway = opts.gateway;
    this.tokens = opts.tokens;
    this.budgets = opts.budgets ?? opts.envs.resourceBudgets();
    this.prompts = opts.prompts ?? (() => ({}));
    this.store.run("UPDATE sessions SET status = 'idle' WHERE status IN ('running', 'stopping')");
    this.envs.hooks.onSessionNet = (sessionId, entry) => this.onNet(sessionId, entry);
    this.envs.hooks.onEnvInterrupted = async (_envId, sessionId) => {
      await this.stop(sessionId);
    };
    this.budgets.onTrip = (trip) => this.onBudgetTrip(trip);
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
      ...(r.system_prompt != null ? { customPrompt: true } : {}),
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
        budgetTrip: null,
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
    this.budgets.ensureSession(id);
    const s = this.get(id);
    if (!opts.ephemeral) this.hub.broadcast({ type: "session", session: s });
    return s;
  }

  async update(id: string, patch: UpdateSessionRequest): Promise<SessionSummary> {
    const r = this.row(id);
    const onlyTitle = Object.keys(patch).every((k) => k === "title");
    // An eval case keeps the model and settings it was graded with.
    if (!onlyTitle) this.assertNotEval(id);
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
    if (patch.systemPrompt != null && (typeof patch.systemPrompt !== "string" || !patch.systemPrompt.trim() || patch.systemPrompt.length > PROMPT_MAX)) {
      throw new HttpError(400, `systemPrompt must be non-empty text of at most ${PROMPT_MAX} characters, or null`);
    }
    // An override is written for one profile's tools: a harness change drops it unless the patch sets a new one.
    const harnessChanged = patch.harness !== undefined && patch.harness !== r.harness;
    const systemPrompt = patch.systemPrompt !== undefined ? patch.systemPrompt : harnessChanged ? null : r.system_prompt;
    this.store.run(
      "UPDATE sessions SET title = ?, model_id = ?, harness = ?, thinking = ?, context_window = ?, max_output_tokens = ?, system_prompt = ?, updated_at = ? WHERE id = ?",
      title,
      model.id,
      patch.harness ?? r.harness,
      thinking ? 1 : 0,
      window,
      maxOutput,
      systemPrompt,
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
      this.store.run("DELETE FROM session_budget_usage WHERE session_id = ?", id);
    });
    this.live.delete(id);
    if (!r.ephemeral) this.hub.broadcast({ type: "session_deleted", sessionId: id });
    this.onDeleted?.(id);
  }

  // ---------- runs ----------

  /** Start a run in the background (REST). Throws 409 when the session or its env is busy. */
  sendMessage(id: string, text: string): SessionSummary {
    if (typeof text !== "string" || !text.trim()) throw new HttpError(400, "text is required");
    this.assertNotEval(id);
    this.startRun(id, text, {});
    return this.get(id);
  }

  continue(id: string): SessionSummary {
    this.assertNotEval(id);
    this.startRun(id, CONTINUE_TEXT, {});
    return this.get(id);
  }

  /**
   * Run again what a refused or failed run left without a reply (e.g. over the context window, before the window was
   * raised): the latest user message ("message"), or the step after its latest tool results ("step"). Nothing is added
   * to the conversation, so it stays the newest step, which compaction keeps.
   */
  retry(id: string): SessionSummary {
    this.assertNotEval(id);
    const t = sanitizeTranscript(this.loadTranscript(this.row(id)));
    const last = t.at(-1);
    if (last?.role !== "user" && last?.role !== "toolResult") throw new HttpError(409, "nothing to retry: the latest message already has a reply");
    const message = t.findLast((m) => m.role === "user");
    this.startRun(id, message ? textOf((message as { content: unknown }).content) : "", {}, last.role === "user" ? "message" : "step");
    return this.get(id);
  }

  /** The transcript's last message when it is a user message with no reply (its run was refused, failed or stopped). */
  private unanswered(r: SessionRow): AgentMessage | undefined {
    const t = sanitizeTranscript(this.loadTranscript(r));
    const last = t.at(-1);
    return last?.role === "user" ? last : undefined;
  }

  /** Eval case sessions are driven by their run (sessions.run), never by user messages. */
  private assertNotEval(id: string): void {
    if (this.row(id).eval_run_id) throw new HttpError(409, "eval case sessions are read-only: the run drives them and their env is discarded afterwards");
  }

  /** Run to completion (evals). */
  run(id: string, text: string, opts: RunOptions = {}): Promise<RunOutcome> {
    return this.startRun(id, text, opts);
  }

  private startRun(id: string, text: string, opts: RunOptions, retry?: Retry): Promise<RunOutcome> {
    const r = this.row(id);
    const live = this.liveFor(id);
    if (live.running) throw new HttpError(409, "session is already running");
    // Refuse up front what acquire() would refuse once the run started (env deleted, another session, an eval case's env).
    if (r.harness !== "chat" && r.env_id) {
      if (!this.envs.exists(r.env_id)) throw new HttpError(409, `environment deleted: this session's environment (${r.env_id}) no longer exists; switch the session to the chat harness or start a new session`);
      this.envs.assertUsableBy(r.env_id, id);
    }
    live.stopRequested = false;
    live.timedOut = false;
    live.budgetTrip = null;
    this.budgets.clearTrips(id);
    // An untitled session is named after its first message, so the sidebar isn't a column of "New session".
    if (r.last_seq === 0 && r.title === DEFAULT_TITLE) this.store.run("UPDATE sessions SET title = ? WHERE id = ?", titleFrom(text), id);
    this.setStatus(id, "running");
    const p = this.runInner(live, text, opts, retry)
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
      const envId = this.store.get<{ env_id: string | null }>("SELECT env_id FROM sessions WHERE id = ?", id)?.env_id;
      if (envId) this.envs.cancelQueued(envId);
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

  private onBudgetTrip(trip: BudgetTrip): void {
    if (!this.exists(trip.sessionId)) return;
    const live = this.liveFor(trip.sessionId);
    if (live.budgetTrip) return;
    live.budgetTrip = trip;
    const { sessionId: _sessionId, ...event } = trip;
    live.tracer.emit({ type: "budget_exceeded", ...event });
    if (live.running) {
      this.setStatus(trip.sessionId, "stopping");
      live.agent?.abort();
    }
  }

  /** A system_prompt event whenever a run's prompt or tools differ from the last one this session recorded. */
  private recordPrompt(id: string, tracer: SessionTracer, p: { harness: HarnessProfile; source: SessionPrompt["source"]; text: string; tools: string[] }): void {
    const last = this.store.get<{ payload_json: string }>("SELECT payload_json FROM events WHERE session_id = ? AND type = 'system_prompt' ORDER BY seq DESC LIMIT 1", id);
    if (last) {
      const prev = JSON.parse(last.payload_json) as typeof p;
      if (prev.text === p.text && prev.harness === p.harness && prev.tools.join() === p.tools.join()) return;
    }
    tracer.emit({ type: "system_prompt", ...p });
  }

  /** What the session's next run sends: prompt, tools and their token counts (exact when the model is loaded). */
  async prompt(id: string): Promise<SessionPrompt> {
    const r = this.row(id);
    const envType = r.harness !== "chat" && r.env_id ? this.envs.get(r.env_id).type : null;
    const p = sessionPrompt(r.harness, envType, r.system_prompt, this.prompts());
    const tools = toolDefinitions(r.harness, !!envType);
    const estimate = { prompt: roughTokens(p.text), tools: tools.length ? roughTokens(toolsJson(tools)) : 0, exact: false };
    const model = await this.inference.model(r.model_id).catch(() => null);
    // Count with the model's tokenizer only when it is loaded: a count would otherwise load it.
    if (!this.tokens || !model?.loaded) return { harness: r.harness, envType, ...p, tools, tokens: estimate };
    try {
      const reqTools = tools.map((t) => ({ type: "function", function: t }));
      const sys = { role: "system", content: p.text };
      const empty = { role: "user", content: "" };
      const [bare, withSys, withAll] = await Promise.all([
        this.tokens.countChat({ model: model.id, messages: [empty] }),
        this.tokens.countChat({ model: model.id, messages: [sys, empty] }),
        reqTools.length ? this.tokens.countChat({ model: model.id, messages: [sys, empty], tools: reqTools }) : Promise.resolve(0),
      ]);
      const promptTokens = withSys - bare;
      return { harness: r.harness, envType, ...p, tools, tokens: { prompt: promptTokens, tools: reqTools.length ? withAll - withSys : 0, exact: true } };
    } catch {
      return { harness: r.harness, envType, ...p, tools, tokens: estimate };
    }
  }

  private loadTranscript(r: SessionRow): AgentMessage[] {
    if (!r.transcript_blob) return [];
    return (this.store.blobs.getJson<AgentMessage[]>(r.transcript_blob) ?? []) as AgentMessage[];
  }

  private saveTranscript(id: string, messages: AgentMessage[]): void {
    const encoded = JSON.stringify(forStorage(messages));
    this.budgets.consumeTrace(id, Buffer.byteLength(encoded), this.row(id).env_id ?? undefined);
    const blob = this.store.blobs.put(encoded);
    this.store.run("UPDATE sessions SET transcript_blob = ? WHERE id = ?", blob, id);
  }

  private async runInner(live: Live, text: string, opts: RunOptions, retry?: Retry): Promise<RunOutcome> {
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

    tracer.emit(retry ? { type: "user_message", text, retry } : { type: "user_message", text });
    // A new message after one that got no reply: that one becomes an earlier turn, which compaction drops first.
    const earlier = retry ? undefined : this.unanswered(r);
    let earlierFate = false;
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
        runtime = await this.envs.acquire(envId, id, (detail) => tracer.emit({ type: "env_lifecycle", envId, action: "queue", detail }));
        if (!wasRunning) tracer.emit({ type: "env_lifecycle", envId, action: "start" });
        observer = new FsObserver({ store: this.store, envs: this.envs, envId, sessionId: id, runtime, tracer, budgets: this.budgets });
        await observer.baseline();
      }
      if (live.stopRequested) throw new StopSignal();

      const chunks = new Map<string, number>(); // per tool call: lets a client tell it saw every chunk
      const host = {
        runtime: runtime!,
        outputChars: TOOL_OUTPUT_CHARS,
        onOutput: (toolCallId: string, stream: "stdout" | "stderr", chunk: string) => {
          const n = chunks.get(toolCallId) ?? 0;
          chunks.set(toolCallId, n + 1);
          tracer.stream({ type: "tool_output", toolCallId, stream, chunk, n });
        },
      };
      const tools: AgentTool<any, ToolDetails>[] = !runtime ? [] : r.harness === "pi-stock" ? piStockTools(host) : terrariumTools(host);
      const prompt = sessionPrompt(r.harness, runtime ? (envType as EnvType) : null, r.system_prompt, this.prompts());
      const systemPrompt = prompt.text;
      this.recordPrompt(id, tracer, { harness: runtime ? r.harness : "chat", source: prompt.source, text: systemPrompt, tools: tools.map((t) => t.name) });

      let currentCallId = "";
      let turnsThisRun = 0;
      let warnedFull = false;
      let lastAssistant: AssistantMessage | null = null;
      const befores = new Map<string, Manifest>();
      const fileChanges = new Map<string, number>();
      const agentModel = omlxModel(model.id, window, maxOutput);
      const counter = new PromptCounter({
        modelId: model.id,
        tokenizer: this.tokens,
        calibrator: live.calibrator,
        body: (messages) => requestBody(agentModel, { messages }, thinking),
        signal: () => live.agent?.signal,
        onFallback: (why) =>
          tracer.emit({
            type: "warning",
            code: "token_estimate",
            message: `Token counts are estimates for the rest of this run: the model's tokenizer failed (${why}). They err high, so compaction may remove more than needed and a prompt that would fit may be refused.`,
            data: { reason: why },
          }),
      });
      // System prompt + tool declarations, counted once per run (they don't change within one).
      let sysTokens: number | null = null;
      let lastCompaction: CompactionResult | null = null;
      let overflow: { message: string; detail: string; data: Record<string, number | string> } | null = null;
      let warnedMismatch = false;

      const contextUsage = (prompt: number, completion: number, reserve: number, source: ContextUsage["source"]): ContextUsage => {
        const sys = Math.min(prompt, sysTokens ?? counter.estimate(agent.state.messages.filter((m) => m.role === "system")));
        const used = prompt + completion;
        return { window, systemAndTools: sys, history: Math.max(0, used - sys), outputReserve: reserve, free: Math.max(0, window - used - reserve), source };
      };
      const emitContext = (usage: ContextUsage) => {
        tracer.emit({ type: "context", usage });
        this.store.run("UPDATE sessions SET context_json = ? WHERE id = ?", JSON.stringify(usage), id);
      };

      const onCallEnd = (res: CallResult, info: CallInfo) => {
        const u = res.usage;
        if (u && u.promptTokens > 0) {
          counter.observe(info.prompt, info.rawEstimate, u.promptTokens);
          emitContext(contextUsage(u.promptTokens, u.completionTokens, maxOutput, "server"));
          // The tokenizer renders the same template as the call, so the counts agree; if the server ever counts
          // more, later counts add the difference (PromptCounter.observe) and this says so once.
          if (info.prompt.exact && !warnedMismatch && u.promptTokens > info.prompt.tokens) {
            warnedMismatch = true;
            tracer.emit({
              type: "warning",
              code: "other",
              message: `The server counted ${u.promptTokens} prompt tokens; the tokenizer counted ${info.prompt.tokens} before sending. Later counts in this run add the ${u.promptTokens - info.prompt.tokens}-token difference.`,
              data: { promptTokens: u.promptTokens, counted: info.prompt.tokens },
            });
          }
          if (!info.prompt.exact && !warnedMismatch && u.promptTokens > info.prompt.tokens) {
            warnedMismatch = true;
            const over = u.promptTokens + info.maxTokens - window;
            tracer.emit({
              type: "warning",
              code: "token_estimate",
              message: `The server counted ${u.promptTokens} prompt tokens; the estimate was ${info.prompt.tokens}.${over > 0 ? ` With ${info.maxTokens} tokens of reply room this request asked for ${over} more than the ${window}-token window.` : ""} Later estimates in this session are scaled up.`,
              data: { promptTokens: u.promptTokens, estimate: info.prompt.tokens, contextWindow: window, maxTokens: info.maxTokens },
            });
          }
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
          const prompt = u?.promptTokens ?? info.estimate;
          // The call's budget is the session's output cap unless the prompt left less room than that in the window.
          const byWindow = info.maxTokens < maxOutput;
          tracer.emit({
            type: "warning",
            code: "output_truncated",
            message: byWindow
              ? `Output stopped at ${info.maxTokens} tokens: that was all the room the ${prompt}-token prompt left in the ${window}-token context window.`
              : `Output stopped at the ${info.maxTokens}-token output cap (context window ${window}, prompt ${prompt} tokens).`,
            data: {
              contextWindow: window,
              promptTokens: prompt,
              maxTokens: info.maxTokens,
              maxOutputTokens: maxOutput,
              completionTokens: u?.completionTokens ?? 0,
              ...(u?.reasoningTokens !== undefined ? { reasoningTokens: u.reasoningTokens } : {}),
            },
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
          overflow = null;
          // The tokenizer is the model's own, served by oMLX: make sure it is up (the call would do this anyway).
          await this.inference.ensureModel(model.id, window, maxOutput).catch(() => {});
          sysTokens ??= (await counter.countSystem(messages.filter((m) => m.role === "system"))).tokens;
          let exact = true;
          const res = await compact(messages, {
            window,
            outputBudget: maxOutput,
            count: async (m) => {
              const c = await counter.count(m);
              exact &&= c.exact;
              return c.tokens;
            },
            countText: async (t) => {
              const c = await counter.countText(t);
              exact &&= c.exact;
              return c.tokens;
            },
            filesChanged: () => (observer ? [...observer.changedPaths].map((p) => p.replace(/^\/workspace\//, "")) : []),
            saveOriginal: (toolCallId, text) => {
              const value = this.toolResultText(id, toolCallId) ?? text;
              this.budgets.consumeTrace(id, Buffer.byteLength(value), envId ?? undefined);
              return this.store.blobs.put(value);
            },
          });
          lastCompaction = res;
          if (res.removedTurns || res.truncatedResults || res.shortened.length) {
            messages.splice(0, messages.length, ...res.messages);
            tracer.emit({
              type: "compaction",
              beforeTokens: res.beforeTokens,
              afterTokens: res.afterTokens,
              removedTurns: res.removedTurns,
              note: res.note,
              ...(res.shortened.length ? { shortened: res.shortened } : {}),
              limit: res.limit,
              exact,
            });
          }
          // After the compaction row, which it refers to.
          if (earlier && !earlierFate) {
            earlierFate = true;
            const ts = (earlier as { timestamp?: number }).timestamp;
            const kept = res.messages.some((m) => m === earlier || (m.role === "user" && (m as { timestamp?: number }).timestamp === ts && textOf((m as { content: unknown }).content) === textOf((earlier as { content: unknown }).content)));
            const size = (await counter.countText(textOf((earlier as { content: unknown }).content))).tokens;
            tracer.emit({
              type: "warning",
              code: "other",
              message: kept
                ? `Your earlier message that got no reply (${exact ? "" : "about "}${fmt(size)} tokens) is sent as an earlier turn.`
                : `Your earlier message that got no reply (${exact ? "" : "about "}${fmt(size)} tokens) was removed by compaction to fit the ${fmt(window)}-token window: the model does not see it.`,
              data: { messageTokens: size, kept: kept ? 1 : 0 },
            });
          }
          if (!warnedFull && res.afterTokens > window - maxOutput - 256 && window - res.afterTokens - 64 >= MIN_REPLY_TOKENS) {
            warnedFull = true;
            tracer.emit({
              type: "warning",
              code: "context_near_full",
              message: `Prompt is ${exact ? "" : "about "}${res.afterTokens} tokens after compaction; only ${Math.max(0, window - res.afterTokens)} of ${window} tokens are left for the reply.`,
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
          count: (m) => counter.count(m),
          onCallStart: (info) => {
            currentCallId = info.callId;
            emitContext(contextUsage(info.prompt.tokens, 0, info.maxTokens, info.prompt.exact ? "tokenizer" : "estimate"));
          },
          onOverflow: async (info) => {
            currentCallId = info.callId;
            overflow = await this.describeOverflow(info, { lastCompaction, sysTokens, counter, model, maxOutput });
            emitContext(contextUsage(info.prompt.tokens, 0, Math.max(0, window - info.prompt.tokens), info.prompt.exact ? "tokenizer" : "estimate"));
            return overflow.message;
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
          this.onAgentEvent(ev, {
            tracer,
            live,
            currentCallId: () => currentCallId,
            fileChanges,
            onAssistant: (m) => (lastAssistant = m),
            explainError: (msg) => {
              if (overflow && msg === overflow.message) return { message: overflow.message, detail: overflow.detail, code: "context_overflow", data: overflow.data };
              const server = explainServerOverflow(msg, window, maxOutput, model.nativeContext);
              return server ? { ...server, code: "context_overflow" } : null;
            },
          });
        } catch (err) {
          log.warn(`event mapping failed for ${id}`, err);
        }
      });

      if (opts.timeoutMs) {
        timeout = setTimeout(() => {
          live.timedOut = true;
          live.stopRequested = true;
          agent.abort();
        }, opts.timeoutMs);
      }
      if (retry) await agent.continue();
      else await agent.prompt(text);

      const last = lastAssistant as AssistantMessage | null;
      if (last) finalText = displayText(last.content.filter((c) => c.type === "text").map((c) => (c as { text: string }).text).join(""));
      if (live.budgetTrip) {
        reason = "budget";
        error = live.budgetTrip.reason;
      } else if (live.stopRequested) reason = "stopped";
      else if (last?.stopReason === "error") {
        reason = "error";
        error = last.errorMessage ?? "model call failed";
      }
      transcript = loopMessages ?? agent.state.messages;
    } catch (err) {
      if (live.budgetTrip || err instanceof BudgetExceededError) {
        reason = "budget";
        error = live.budgetTrip?.reason ?? (err as BudgetExceededError).trip.reason;
      } else if (err instanceof StopSignal || live.stopRequested) reason = "stopped";
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
        if (err instanceof BudgetExceededError) {
          reason = "budget";
          error = err.trip.reason;
        }
      }
      // Budget listeners are intentionally queued to keep counter updates atomic. Let the typed event land before run_end.
      await Promise.resolve();
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

  /** What the model got from a tool call (tool_end.resultForModel), from the trace. */
  private toolResultText(sessionId: string, toolCallId: string): string | undefined {
    const r = this.store.get<{ payload_json: string }>(
      "SELECT payload_json FROM events WHERE session_id = ? AND type = 'tool_end' AND json_extract(payload_json, '$.toolCallId') = ?",
      sessionId,
      toolCallId,
    );
    if (!r) return undefined;
    const v = (JSON.parse(r.payload_json) as { resultForModel?: unknown }).resultForModel;
    return typeof v === "string" ? v : undefined;
  }

  /** The prompt can't leave room for a reply even after compaction: what takes the space and what to do. */
  private async describeOverflow(
    info: CallInfo,
    c: { lastCompaction: CompactionResult | null; sysTokens: number | null; counter: PromptCounter; model: ModelInfo; maxOutput: number },
  ): Promise<{ message: string; detail: string; data: Record<string, number | string> }> {
    const window = info.params.window;
    const prompt = info.prompt.tokens;
    const about = info.prompt.exact ? "" : "about ";
    const msgs = c.lastCompaction?.messages ?? [];
    let task: AgentMessage | undefined;
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].role === "user") {
        task = msgs[i];
        break;
      }
    }
    const taskTokens = task ? (await c.counter.countText(textOf((task as { content: unknown }).content))).tokens : 0;
    const sys = c.sysTokens ?? 0;
    const room = Math.max(0, window - prompt);
    // Sized like compaction's limit (window - output cap - margin), so in that window the message stays whole.
    const need = windowFor(prompt, c.maxOutput, c.model.nativeContext);
    const message =
      prompt >= window
        ? `Request not sent: the prompt is ${about}${fmt(prompt)} tokens after compaction, over the ${fmt(window)}-token context window.`
        : `Request not sent: the prompt is ${about}${fmt(prompt)} tokens after compaction, leaving ${fmt(room)} of the ${fmt(window)}-token context window for the reply (at least ${MIN_REPLY_TOKENS} needed).`;
    const parts = [`System prompt and tools: ${fmt(sys)} tokens.`];
    if (task) parts.push(`Latest user message: ${fmt(taskTokens)} tokens.`);
    parts.push(`Everything else: ${fmt(Math.max(0, prompt - sys - taskTokens))} tokens (compaction keeps the newest step).`);
    if (c.lastCompaction?.removedTurns || c.lastCompaction?.shortened.length) {
      parts.push(`Compaction removed ${c.lastCompaction.removedTurns} earlier steps and shortened ${c.lastCompaction.shortened.length} tool outputs; nothing else may be removed.`);
    }
    parts.push(
      need
        ? `Raise the context window to ${fmt(need)} (output cap ${fmt(c.maxOutput)})${taskTokens > window / 2 ? ", or send a shorter message" : ""}, then retry.`
        : `This is more than the model's ${fmt(c.model.nativeContext)}-token native context: send a shorter message or start a new session.`,
    );
    if (task && msgs.at(-1) === task) parts.push("Your message is kept in the conversation without a reply. Retry sends it again; a new message instead sends it as an earlier turn, which compaction drops first.");
    else if (task) parts.push("The run stopped before this step; its steps so far are kept. Retry runs this step again; a new message instead starts a new turn, and compaction drops these steps first.");
    return {
      message,
      detail: parts.join("\n"),
      data: {
        promptTokens: prompt,
        contextWindow: window,
        maxOutputTokens: c.maxOutput,
        systemTokens: sys,
        messageTokens: taskTokens,
        counted: info.prompt.exact ? "tokenizer" : "estimate",
        ...(need ? { suggestedWindow: need } : {}),
      },
    };
  }

  private onAgentEvent(
    ev: AgentEvent,
    ctx: {
      tracer: SessionTracer;
      live: Live;
      currentCallId: () => string;
      fileChanges: Map<string, number>;
      onAssistant: (m: AssistantMessage) => void;
      /** A structured error (numbers, remedy) for a call error the harness recognizes. */
      explainError?: (message: string) => { message: string; detail?: string; code?: "context_overflow"; data?: Record<string, number | string> } | null;
    },
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
        if (m.stopReason === "error") {
          const known = m.errorMessage ? ctx.explainError?.(m.errorMessage) : null;
          tracer.emit(known ? { type: "error", ...known } : { type: "error", message: m.errorMessage ?? "model call failed" });
        }
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
