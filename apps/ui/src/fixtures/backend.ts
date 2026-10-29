// In-memory fake backend: same interface as HttpBackend, replays scripted sessions with real timing.

import type {
  AppSettings,
  AppState,
  CreateEnvRequest,
  CreateSessionRequest,
  EnvSummary,
  EvalCase,
  EvalResult,
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
  ModelDownload,
  ModelInfo,
  NetEntry,
  PathKey,
  ResetEnvRequest,
  ResourceSample,
  SessionSummary,
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
import { ApiRequestError, type AtOpts, type Backend, type BackendHandlers } from "../api/backend";
import { BUDGET, INVOICE_FILES, LOG_FILES, MODELS, SIM_FACTS, SUITES, TOTAL_RAM, VM_FACTS } from "./data";
import { fakeSha, fid, type Built } from "./script";
import { DEFAULT_SETTINGS, SIM_NOTE, SUGGESTIONS, harnessFixture, inspectFixture, settingsInfo } from "./extras";
import {
  buildChat,
  buildEvalCell,
  buildInvoiceContinue,
  buildInvoiceRun,
  buildLogsRun,
  buildReadme,
  buildReply,
  type CellOutcome,
} from "./sessions";

const MiB = 1024 * 1024;
const GiB = 1024 * MiB;
const HOUR = 3_600_000;

interface EnvFs {
  files: Map<string, string>;
  base: Map<string, string>;
  /** Per-session file history: seq -> path -> content (null = deleted). */
  history: { sessionId: Id; seq: number; path: string; content: string | null }[];
  sessionStart: Map<Id, Map<string, string>>;
  heavy: { path: string; afterSeq?: { sessionId: Id; seq: number } }[];
}

interface Playback {
  sessionId: Id;
  built: Built;
  t0: number;
  cursor: number;
  openCall: string | null;
  openTool: string | null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

export class FixtureBackend implements Backend {
  readonly kind = "fixtures" as const;
  readonly label = "fixtures";
  private speed: number;
  private h: BackendHandlers | null = null;
  private subs = new Set<Id>();
  private timers: number[] = [];

  private envs = new Map<Id, EnvSummary>();
  private fs = new Map<Id, EnvFs>();
  private snapshots = new Map<Id, Snapshot[]>();
  private net = new Map<Id, NetEntry[]>();
  private sessions = new Map<Id, SessionSummary>();
  private events = new Map<Id, TraceEvent[]>();
  private calls = new Map<Id, ModelCallDetail>();
  private callSteps = new Map<Id, { built: Built }>();
  private blobs = new Map<string, string>();
  private playing: Playback[] = [];
  private models: ModelInfo[] = clone(MODELS);
  private settings: AppSettings = clone(DEFAULT_SETTINGS);
  private downloads = new Map<Id, ModelDownload>();
  private prompts = new Map<Id, string>(); // session prompt overrides
  private inference: InferenceState = {
    status: "ready",
    version: "0.7.2",
    pid: 48213,
    rssBytes: 0,
    memoryCeilingBytes: 14 * GiB,
  };
  private runs: EvalRunDetail[] = [];
  private lazyCells = new Map<Id, () => Built>();
  private cellStats = new Map<Id, { durationMs: number; tokens: { prompt: number; completion: number } }>();
  private liveIds = { fix: "", invoiceEnv: "" };
  private noise = 0;

  constructor(o: { speed?: number } = {}) {
    this.speed = o.speed ?? 1;
    this.seed();
  }

  // ---------- seed data ----------

  private seed() {
    const now = Date.now();
    const invoice = this.addEnv(
      {
        id: "env_invoice",
        name: "invoice-py",
        type: "vm",
        status: "running",
        network: "off",
        vm: { cpus: 2, memoryMiB: 1024, diskMiB: 4096, backend: "krun" },
        facts: VM_FACTS(2, 1024, 4096, 612),
        diskBytes: 641_728_512,
        createdAt: now - 26 * HOUR,
        ephemeral: false,
      },
      INVOICE_FILES,
    );
    this.snapshots.set(invoice.id, [
      { id: "snap_factory", envId: invoice.id, label: "terrarium-base 2026.10.27", kind: "factory", bytes: 287_309_824, createdAt: now - 26 * HOUR },
      { id: "snap_seeded", envId: invoice.id, label: "invoice project seeded", kind: "manual", bytes: 301_989_888, createdAt: now - 25.9 * HOUR },
      { id: "snap_auto1", envId: invoice.id, label: "before: Fix failing invoice tests", kind: "auto", bytes: 302_120_960, createdAt: now - 2 * 60_000 },
    ]);
    this.fs.get(invoice.id)!.heavy.push(
      { path: "/workspace/.pytest_cache", afterSeq: undefined },
      { path: "/workspace/src/invoice/__pycache__", afterSeq: undefined },
      { path: "/workspace/tests/__pycache__", afterSeq: undefined },
    );

    const logs = this.addEnv(
      {
        id: "env_logs",
        name: "logs-sim",
        type: "sim",
        status: "running",
        network: "off",
        sim: { python: true, javascript: false, maxTotalBytes: 64 * MiB },
        facts: SIM_FACTS(true, false),
        diskBytes: 41_327,
        createdAt: now - 5 * HOUR,
        ephemeral: false,
      },
      LOG_FILES,
    );
    this.snapshots.set(logs.id, [
      { id: "snap_logs0", envId: logs.id, label: "seeded access.log", kind: "manual", bytes: 41_000, createdAt: now - 5 * HOUR },
    ]);

    const scratch = this.addEnv(
      {
        id: "env_scratch",
        name: "scratch-vm",
        type: "vm",
        status: "stopped",
        network: "registries",
        parentEnvId: invoice.id,
        baseSnapshotId: "snap_seeded",
        vm: { cpus: 4, memoryMiB: 2048, diskMiB: 8192, backend: "krun" },
        facts: VM_FACTS(4, 2048, 8192, 598),
        diskBytes: 627_048_448,
        createdAt: now - 20 * HOUR,
        ephemeral: false,
      },
      INVOICE_FILES,
    );
    this.snapshots.set(scratch.id, []);

    // finished sessions
    this.addFinished(
      { id: "s_readme", envId: invoice.id, title: "Python version and test command", modelId: "Qwen3.5-4B-MLX-4bit", harness: "terrarium", thinking: false, contextWindow: 16384, maxOutputTokens: 4096 },
      buildReadme("s_readme", invoice.id),
      now - 24 * HOUR,
    );
    this.addFinished(
      { id: "s_logs", envId: logs.id, title: "Top 404 IPs from access.log", modelId: "Ternary-Bonsai-2-9B-mlx-2bit", harness: "terrarium", thinking: false, contextWindow: 16384, maxOutputTokens: 4096 },
      buildLogsRun("s_logs", logs.id),
      now - 2 * HOUR,
    );
    this.addFinished(
      { id: "s_chat", envId: null, title: "round(2.675, 2)", modelId: "gemma-4-12B-it-4bit", harness: "chat", thinking: true, contextWindow: 32768, maxOutputTokens: 4096 },
      buildChat("s_chat"),
      now - 40 * 60_000,
    );

    // the live run
    const fixId = "s_fix";
    this.liveIds = { fix: fixId, invoiceEnv: invoice.id };
    const built = buildInvoiceRun(fixId, invoice.id);
    const tParam = Number(new URLSearchParams(location.search).get("t"));
    const pre = new URLSearchParams(location.search).has("t") && Number.isFinite(tParam) && tParam >= 0 ? tParam * 1000 : (built.marks.now ?? 0);
    this.addSession({
      id: fixId,
      envId: invoice.id,
      title: "Fix failing invoice tests",
      modelId: "Qwen3.5-9B-MLX-4bit",
      harness: "terrarium",
      thinking: true,
      contextWindow: 8192,
      maxOutputTokens: 1024,
      status: "running",
      createdAt: now - pre / this.speed,
    });
    this.fs.get(invoice.id)!.sessionStart.set(fixId, new Map(Object.entries(INVOICE_FILES)));
    const firstToolEnd = built.steps.find((s) => s.body.type === "tool_end");
    for (const h of this.fs.get(invoice.id)!.heavy) h.afterSeq = { sessionId: fixId, seq: firstToolEnd?.seq ?? 0 };
    this.play(fixId, built, now - pre / this.speed, false);
    this.flushDue(true);

    this.seedEvals(now);
  }

  private addEnv(e: EnvSummary, files: Record<string, string>): EnvSummary {
    this.envs.set(e.id, e);
    const m = new Map(Object.entries(files));
    this.fs.set(e.id, { files: new Map(m), base: new Map(m), history: [], sessionStart: new Map(), heavy: [] });
    this.net.set(e.id, []);
    return e;
  }

  private addSession(p: Omit<SessionSummary, "lastSeq" | "updatedAt"> & { createdAt: number }): SessionSummary {
    const s: SessionSummary = { lastSeq: 0, updatedAt: p.createdAt, ...p };
    this.sessions.set(s.id, s);
    this.events.set(s.id, []);
    return s;
  }

  private addFinished(
    p: Pick<SessionSummary, "id" | "envId" | "title" | "modelId" | "harness" | "thinking" | "contextWindow" | "maxOutputTokens"> &
      Partial<SessionSummary>,
    built: Built,
    t0: number,
  ) {
    this.addSession({ status: "idle", createdAt: t0, ...p });
    if (p.envId) {
      const fs = this.fs.get(p.envId);
      fs?.sessionStart.set(p.id, new Map(fs.files));
    }
    this.play(p.id, built, t0, false);
    this.flushDue(true);
  }

  private seedEvals(now: number) {
    const pick = (seed: number) => {
      const x = Math.sin(seed * 12.9898) * 43758.5453;
      return x - Math.floor(x);
    };
    const skill: Record<string, number> = {
      "Qwen3.5-4B-MLX-4bit": 0.72,
      "Qwen3.5-9B-MLX-4bit": 0.88,
      "gemma-4-12B-it-4bit": 0.8,
      "Ternary-Bonsai-2-9B-mlx-2bit": 0.62,
      "Ternary-Bonsai-2-2B-mlx-2bit": 0.38,
      "Ternary-Bonsai-2-27B-mlx-2bit": 0.84,
    };
    const mk = (
      id: Id,
      suiteId: string,
      modelIds: Id[],
      startedAt: number,
      status: EvalRunSummary["status"],
      doneCount: number,
    ) => {
      const suite = SUITES.find((s) => s.id === suiteId)!;
      const results: EvalResult[] = [];
      let k = 0;
      for (const c of suite.cases)
        for (const m of modelIds) {
          k++;
          const r = pick(k * 7 + id.length * 13 + suiteId.length);
          let st: EvalResult["status"] = k <= doneCount ? (r < skill[m] ? "pass" : r > 0.965 ? "error" : "fail") : k === doneCount + 1 && status === "running" ? "running" : "pending";
          if (suiteId === "boundary" && st === "fail") st = "pass";
          const res: EvalResult = { caseId: c.id, modelId: m, status: st };
          if (st === "pass" || st === "fail" || st === "error") {
            res.detail =
              st === "pass"
                ? suite.envType === "none"
                  ? "answer 72 == 72"
                  : "grader exit 0"
                : st === "fail"
                  ? suite.envType === "none"
                    ? "answer 96 != 72"
                    : suite.envType === "vm"
                      ? "grader exit 1: 2 failed, 5 passed"
                      : "out.txt: expected 'hello terrarium', got 'hello terrarium\\n\\n'"
                  : "oMLX returned 503: model is loading";
            const cell = this.attachCellSession(id, suite, c, m, st, startedAt + k * 20_000);
            res.durationMs = cell.durationMs;
            res.tokens = cell.tokens;
            res.sessionId = `es_${id}_${c.id}_${m}`;
            res.envId = this.sessions.get(res.sessionId)?.envId ?? undefined;
          }
          results.push(res);
        }
      const run: EvalRunDetail = {
        id,
        suiteId,
        suiteTitle: suite.title,
        config: { suiteId, modelIds, harness: "terrarium", thinking: false, contextWindow: 16384 },
        status,
        startedAt,
        finishedAt: status === "running" ? undefined : startedAt + results.length * 20_000,
        totals: {},
        cases: suite.cases,
        results,
      };
      this.recount(run);
      this.runs.push(run);
      return run;
    };
    mk("run_tb", "tool-basics", ["Qwen3.5-4B-MLX-4bit", "Qwen3.5-9B-MLX-4bit", "Ternary-Bonsai-2-9B-mlx-2bit", "Ternary-Bonsai-2-2B-mlx-2bit"], now - 3 * HOUR, "done", 999);
    mk("run_bd", "boundary", ["Qwen3.5-9B-MLX-4bit", "gemma-4-12B-it-4bit"], now - 27 * HOUR, "done", 999);
    const live = mk("run_ct", "coding-tests", ["Qwen3.5-9B-MLX-4bit", "gemma-4-12B-it-4bit", "Ternary-Bonsai-2-9B-mlx-2bit"], now - 6 * 60_000, "running", 7);
    this.runs.sort((a, b) => b.startedAt - a.startedAt);
    this.every(5200, () => this.advanceRun(live, skill));
  }

  /** Creates the cell's fork env and session; returns its duration and tokens so the matrix matches the transcript. */
  private attachCellSession(
    runId: Id,
    suite: EvalSuite,
    c: EvalCase,
    modelId: Id,
    st: CellOutcome | string,
    t0: number,
  ): { durationMs: number; tokens: { prompt: number; completion: number } } {
    const sid = `es_${runId}_${c.id}_${modelId}`;
    const known = this.cellStats.get(sid);
    if (known) return known;
    let envId: Id | null = null;
    if (c.envType !== "none") {
      envId = `ee_${runId}_${c.id}_${modelId}`.slice(0, 64);
      const files = Object.fromEntries((c.setupFiles ?? [{ path: "/workspace/README.md", content: `# ${c.title}\n` }]).map((f) => [f.path, f.content]));
      this.addEnv(
        {
          id: envId,
          name: `${c.id} fork`,
          type: c.envType,
          status: "stopped",
          network: c.network ?? "off",
          parentEnvId: c.envType === "vm" ? "env_invoice" : "env_logs",
          vm: c.envType === "vm" ? { cpus: 2, memoryMiB: 1024, diskMiB: 4096, backend: "krun" } : undefined,
          sim: c.envType === "sim" ? { python: true, javascript: false, maxTotalBytes: 64 * MiB } : undefined,
          facts: c.envType === "vm" ? VM_FACTS(2, 1024, 4096, 590) : SIM_FACTS(true, false),
          createdAt: t0,
          ephemeral: true,
          statusDetail: `eval ${runId} case ${c.id}`,
        },
        files,
      );
    }
    this.addSession({
      id: sid,
      envId,
      title: `${suite.title}: ${c.title}`,
      modelId,
      harness: c.envType === "none" ? "chat" : "terrarium",
      thinking: false,
      contextWindow: 16384,
      maxOutputTokens: 4096,
      status: "idle",
      createdAt: t0,
      evalRunId: runId,
      evalCaseId: c.id,
    });
    const outcome: CellOutcome = st === "pass" ? "pass" : st === "error" ? "error" : "fail";
    const built = buildEvalCell(sid, envId, modelId, c, outcome);
    this.lazyCells.set(sid, () => built);
    const stats = {
      durationMs: built.duration,
      tokens: built.calls.reduce(
        (a, x) => ({ prompt: a.prompt + (x.detail.usage?.promptTokens ?? 0), completion: a.completion + (x.detail.usage?.completionTokens ?? 0) }),
        { prompt: 0, completion: 0 },
      ),
    };
    this.cellStats.set(sid, stats);
    if (envId) this.fs.get(envId)?.sessionStart.set(sid, new Map(this.fs.get(envId)!.files));
    return stats;
  }

  private recount(run: EvalRunDetail) {
    const totals: EvalRunSummary["totals"] = {};
    for (const m of run.config.modelIds) totals[m] = { pass: 0, fail: 0, error: 0, total: run.cases.length };
    for (const r of run.results) {
      const t = totals[r.modelId];
      if (!t) continue;
      if (r.status === "pass") t.pass++;
      else if (r.status === "fail") t.fail++;
      else if (r.status === "error") t.error++;
    }
    run.totals = totals;
  }

  private advanceRun(run: EvalRunDetail, skill: Record<string, number>) {
    if (run.status !== "running") return;
    const idx = run.results.findIndex((r) => r.status === "running");
    if (idx < 0) return;
    const r = run.results[idx];
    const x = Math.sin((idx + 3) * 78.233) * 43758.5453;
    const roll = x - Math.floor(x);
    const st: EvalResult["status"] = this.inference.status !== "ready" ? "error" : roll < (skill[r.modelId] ?? 0.5) ? "pass" : roll > 0.97 ? "error" : "fail";
    const suite = SUITES.find((s) => s.id === run.suiteId)!;
    const c = suite.cases.find((cc) => cc.id === r.caseId)!;
    const sid = `es_${run.id}_${c.id}_${r.modelId}`;
    const { durationMs, tokens } = this.attachCellSession(run.id, suite, c, r.modelId, st, Date.now() - 40_000);
    // the cell just finished: its session started one duration ago
    const cell = this.sessions.get(sid);
    if (cell) cell.createdAt = cell.updatedAt = Date.now() - durationMs;
    run.results[idx] = {
      ...r,
      status: st,
      durationMs,
      tokens,
      detail:
        st === "pass"
          ? "grader exit 0"
          : st === "fail"
            ? "grader exit 1: 1 failed, 6 passed"
            : this.inference.status !== "ready"
              ? "oMLX is not running"
              : `oMLX returned 503: model is loading (${r.modelId})`,
      sessionId: sid,
      envId: this.sessions.get(sid)?.envId ?? undefined,
    };
    const cellEnv = this.sessions.get(sid)?.envId;
    const ce = cellEnv ? this.envs.get(cellEnv) : undefined;
    if (ce) this.emit({ type: "env", env: clone(ce) });
    this.emit({ type: "session", session: this.sessions.get(sid)! });
    this.emit({ type: "eval_result", runId: run.id, result: run.results[idx] });
    const next = run.results[idx + 1];
    if (next) {
      next.status = "running";
      this.emit({ type: "eval_result", runId: run.id, result: next });
    } else {
      run.status = "done";
      run.finishedAt = Date.now();
    }
    this.recount(run);
    this.emit({ type: "eval_run", run: this.summary(run) });
  }

  private summary(r: EvalRunDetail): EvalRunSummary {
    const { cases: _c, results: _r, ...rest } = r;
    return clone(rest);
  }

  // ---------- playback ----------

  private play(sessionId: Id, built: Built, t0: number, live = true) {
    for (const [sha, text] of Object.entries(built.blobs)) this.blobs.set(sha, text);
    for (const c of built.calls) this.callSteps.set(c.callId, { built });
    this.playing.push({ sessionId, built, t0, cursor: 0, openCall: null, openTool: null });
    if (live) this.setSession(sessionId, { status: "running" });
  }

  private flushDue(silent = false) {
    const now = Date.now();
    for (const p of this.playing) {
      while (p.cursor < p.built.steps.length) {
        const st = p.built.steps[p.cursor];
        const ts = p.t0 + st.at / this.speed;
        if (ts > now) break;
        p.cursor++;
        this.emitStep(p, st, Math.round(ts), silent);
      }
    }
    this.playing = this.playing.filter((p) => p.cursor < p.built.steps.length);
  }

  private emitStep(p: Playback, st: Built["steps"][number], ts: number, silent: boolean) {
    const ev = { ...clone(st.body), sessionId: p.sessionId, seq: st.seq, ts } as TraceEvent;
    const sess = this.sessions.get(p.sessionId);
    const envId = sess?.envId ?? null;
    const streamed = ev.type === "model_delta" || ev.type === "tool_output";
    if (!streamed) {
      this.events.get(p.sessionId)?.push(ev);
      const patch: Partial<SessionSummary> = { lastSeq: ev.seq, updatedAt: ts };
      if (ev.type === "context") patch.context = ev.usage;
      if (ev.type === "run_end") patch.status = ev.reason === "error" ? "error" : "idle";
      if (ev.type === "user_message" || ev.type === "model_call_start") patch.status = "running";
      if (ev.type === "model_call_start") {
        p.openCall = ev.callId;
        const draft = p.built.calls.find((c) => c.callId === ev.callId);
        if (draft)
          this.calls.set(ev.callId, {
            ...clone(draft.detail),
            response: null,
            usage: undefined,
            sessionId: p.sessionId,
            seq: ev.seq,
          });
      }
      if (ev.type === "model_call_end") {
        p.openCall = null;
        const draft = p.built.calls.find((c) => c.callId === ev.callId);
        if (draft) {
          const d = clone(draft.detail);
          if (d.response) (d.response as { created: number }).created = Math.floor(ts / 1000);
          const raw = this.rawSse(p.built, ev.callId, d);
          const sha = fakeSha(raw);
          this.blobs.set(sha, raw);
          this.calls.set(ev.callId, { ...d, rawResponseBlob: sha, sessionId: p.sessionId, seq: this.calls.get(ev.callId)?.seq ?? ev.seq });
        }
      }
      if (ev.type === "tool_start") p.openTool = ev.toolCallId;
      if (ev.type === "tool_end") p.openTool = null;
      if (ev.type === "net" && envId) {
        const entry = { ...ev.entry, ts, envId };
        ev.entry = entry;
        this.net.get(envId)?.push(entry);
        if (!silent) this.emit({ type: "env_net", entry });
      }
      if (ev.type === "fs_change" && envId) {
        const fs = this.fs.get(envId);
        for (const f of st.effects?.files ?? []) {
          if (f.content == null) fs?.files.delete(f.path);
          else fs?.files.set(f.path, f.content);
          fs?.history.push({ sessionId: p.sessionId, seq: ev.seq, path: f.path, content: f.content });
        }
      }
      this.setSession(p.sessionId, patch, silent);
    }
    if (!silent && this.subs.has(p.sessionId)) this.emit({ type: "trace", event: ev });
  }

  private rawSse(built: Built, callId: Id, d: Omit<ModelCallDetail, "sessionId" | "seq">): string {
    const lines: string[] = [];
    const id = `chatcmpl-${callId.slice(3)}`;
    for (const s of built.steps) {
      if (s.body.type !== "model_delta" || s.body.callId !== callId) continue;
      const delta =
        s.body.kind === "thinking"
          ? { reasoning_content: s.body.delta }
          : s.body.kind === "text"
            ? { content: s.body.delta }
            : { tool_calls: [{ index: 0, function: { arguments: s.body.delta } }] };
      lines.push(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", model: d.modelId, choices: [{ index: 0, delta }] })}`);
    }
    const resp = d.response as { usage?: unknown } | null;
    lines.push(
      `data: ${JSON.stringify({ id, object: "chat.completion.chunk", model: d.modelId, choices: [{ index: 0, delta: {}, finish_reason: d.finishReason }], usage: resp?.usage })}`,
    );
    lines.push("data: [DONE]");
    return lines.join("\n\n") + "\n\n";
  }

  private setSession(id: Id, patch: Partial<SessionSummary>, silent = false) {
    const s = this.sessions.get(id);
    if (!s) return;
    const next = { ...s, ...patch };
    this.sessions.set(id, next);
    if (!silent) this.emit({ type: "session", session: next });
  }

  // ---------- ws ----------

  private emit(msg: WsMessage) {
    this.h?.onMessage(msg);
  }

  private every(ms: number, fn: () => void) {
    this.timers.push(window.setInterval(fn, ms / (ms > 1000 ? this.speed : 1)));
  }

  connect(h: BackendHandlers): () => void {
    this.h = h;
    h.onStatus("connecting");
    const t = window.setTimeout(() => {
      h.onStatus("open");
      this.emit({ type: "hello", state: this.state() });
      this.sample();
    }, 60);
    this.every(50, () => this.flushDue());
    this.every(1000, () => this.sample());
    return () => {
      window.clearTimeout(t);
      this.timers.forEach((x) => window.clearInterval(x));
      this.timers = [];
      this.h = null;
    };
  }

  subscribe(ids: Id[]) {
    this.subs = new Set(ids);
  }

  private sample() {
    this.noise = this.noise * 0.7 + (Math.random() - 0.5) * 0.3;
    const loaded = this.models.filter((m) => m.loaded);
    const infRss = loaded.reduce((a, m) => a + (m.residentBytes ?? 0), 0) + (this.inference.status === "ready" ? 180 * MiB : 0);
    const fix = this.playing.find((p) => p.sessionId === this.liveIds.fix);
    const busyTool = !!fix?.openTool;
    const busyModel = !!fix?.openCall;
    const envs = [...this.envs.values()]
      .filter((e) => e.status === "running" || e.status === "busy")
      .map((e) => {
        const isFix = e.id === this.liveIds.invoiceEnv;
        const base = e.type === "vm" ? (e.vm?.memoryMiB ?? 1024) * 0.58 * MiB : 88 * MiB;
        const cpu = isFix ? (busyTool ? 112 + Math.random() * 60 : busyModel ? 1.2 + Math.random() : 0.6 + Math.random() * 0.6) : 0.2 + Math.random() * 0.4;
        return { envId: e.id, rssBytes: Math.round(base + (busyTool && isFix ? 140 * MiB : 0) + this.noise * 8 * MiB), cpuPct: cpu };
      });
    const backend = 212 * MiB + Math.round(this.noise * 6 * MiB);
    const other = 8.9 * GiB + this.noise * 90 * MiB + (busyModel ? 0.05 * GiB : 0);
    const used = Math.round(other + infRss + backend + envs.reduce((a, e) => a + e.rssBytes, 0));
    const free = TOTAL_RAM - used;
    if (this.inference.status === "ready") this.inference = { ...this.inference, rssBytes: infRss };
    const sample: ResourceSample = {
      ts: Date.now(),
      system: { totalBytes: TOTAL_RAM, usedBytes: used, freeBytes: free, pressure: free < 2 * GiB ? "critical" : free < 4 * GiB ? "warn" : "normal" },
      backendRssBytes: backend,
      inference: this.inference.status === "ready" ? { rssBytes: infRss, loaded: loaded.map((m) => ({ modelId: m.id, bytes: m.residentBytes })) } : undefined,
      envs,
    };
    this.emit({ type: "resources", sample });
  }

  private state(): AppState {
    return clone({
      envs: [...this.envs.values()],
      sessions: [...this.sessions.values()],
      models: this.models,
      inference: this.inference,
      budget: { totalBytes: TOTAL_RAM, budgetBytes: BUDGET },
      evalRuns: this.runs.map((r) => this.summary(r)),
      settings: this.settings,
      downloads: [...this.downloads.values()],
      versions: { app: "0.1.0", gondolin: "0.14.0", justBash: "3.6.0", piAgentCore: "1.4.0", omlx: "0.7.2" },
    });
  }

  // ---------- REST ----------

  private env(id: Id): EnvSummary {
    const e = this.envs.get(id);
    if (!e) throw new ApiRequestError(404, `env ${id} not found`);
    return e;
  }

  private putEnv(e: EnvSummary) {
    this.envs.set(e.id, e);
    this.emit({ type: "env", env: clone(e) });
    return clone(e);
  }

  async getState() {
    await sleep(30);
    return this.state();
  }

  async createEnv(req: CreateEnvRequest) {
    await sleep(120);
    const id = fid("env");
    let files: Record<string, string> = {};
    let parentEnvId: Id | undefined;
    let baseSnapshotId: Id | undefined;
    if (req.from && "envId" in req.from) {
      parentEnvId = req.from.envId;
      files = Object.fromEntries(this.fs.get(req.from.envId)?.files ?? []);
    } else if (req.from && "snapshotId" in req.from) {
      baseSnapshotId = req.from.snapshotId;
      const owner = [...this.snapshots.entries()].find(([, ss]) => ss.some((s) => s.id === baseSnapshotId))?.[0];
      parentEnvId = owner;
      files = Object.fromEntries(this.fs.get(owner ?? "")?.base ?? []);
    }
    for (const f of req.seedFiles ?? []) files[f.path] = f.content;
    const vm = req.type === "vm" ? { cpus: 2, memoryMiB: 1024, diskMiB: 4096, backend: "krun" as const, ...req.vm } : undefined;
    const sim = req.type === "sim" ? { python: true, javascript: false, maxTotalBytes: 64 * MiB, ...req.sim } : undefined;
    const e = this.addEnv(
      {
        id,
        name: req.name,
        type: req.type,
        status: "starting",
        network: req.network ?? "off",
        parentEnvId,
        baseSnapshotId,
        vm,
        sim,
        createdAt: Date.now(),
        ephemeral: false,
      },
      files,
    );
    this.snapshots.set(id, []);
    this.emit({ type: "env", env: clone(e) });
    window.setTimeout(() => {
      const cur = this.envs.get(id);
      if (!cur) return;
      this.putEnv({
        ...cur,
        status: "running",
        // facts are gathered when the env comes up, so they are fresh
        facts: {
          ...(req.type === "vm" ? VM_FACTS(vm!.cpus, vm!.memoryMiB, vm!.diskMiB, 590) : SIM_FACTS(sim!.python, sim!.javascript)),
          gatheredAt: Date.now(),
        },
        diskBytes: req.type === "vm" ? 618_659_840 : Math.max(2048, Object.values(files).reduce((a, t) => a + t.length, 0)),
      });
    }, req.type === "vm" ? 1900 : 450);
    return clone(e);
  }

  async updateEnv(id: Id, req: UpdateEnvRequest) {
    await sleep(60);
    return this.putEnv({ ...this.env(id), ...req });
  }

  async startEnv(id: Id) {
    const e = this.env(id);
    this.putEnv({ ...e, status: "starting" });
    window.setTimeout(() => this.putEnv({ ...this.env(id), status: "running" }), e.type === "vm" ? 1500 : 300);
    return clone(e);
  }

  async stopEnv(id: Id) {
    const e = this.env(id);
    this.putEnv({ ...e, status: "stopping" });
    window.setTimeout(() => this.putEnv({ ...this.env(id), status: "stopped" }), 700);
    return clone(e);
  }

  async resetEnv(id: Id, req: ResetEnvRequest = {}) {
    const e = this.env(id);
    const fs = this.fs.get(id)!;
    this.putEnv({ ...e, status: "busy", statusDetail: req.snapshotId ? "restoring snapshot" : "resetting" });
    await sleep(900);
    fs.files = new Map(fs.base);
    this.emit({ type: "env_fs", envId: id, changes: [] });
    return this.putEnv({ ...this.env(id), status: e.status === "stopped" ? "stopped" : "running", statusDetail: undefined });
  }

  async snapshotEnv(id: Id, req: SnapshotEnvRequest = {}) {
    await sleep(400);
    const e = this.env(id);
    const snap: Snapshot = {
      id: fid("snap"),
      envId: id,
      label: req.label || `manual ${new Date().toLocaleTimeString()}`,
      kind: "manual",
      bytes: e.type === "vm" ? 302_710_784 : 41_984,
      createdAt: Date.now(),
    };
    this.snapshots.set(id, [...(this.snapshots.get(id) ?? []), snap]);
    this.emit({ type: "env", env: clone(e) });
    return snap;
  }

  async forkEnv(id: Id, req: ForkEnvRequest = {}) {
    const e = this.env(id);
    return this.createEnv({
      name: req.name || `${e.name}-fork`,
      type: e.type,
      network: e.network,
      from: req.snapshotId ? { snapshotId: req.snapshotId } : { envId: id },
      vm: e.vm,
      sim: e.sim,
    });
  }

  async deleteEnv(id: Id) {
    await sleep(200);
    this.env(id);
    for (const s of [...this.sessions.values()].filter((x) => x.envId === id)) {
      this.sessions.delete(s.id);
      this.playing = this.playing.filter((p) => p.sessionId !== s.id);
      this.emit({ type: "session_deleted", sessionId: s.id });
    }
    this.envs.delete(id);
    this.fs.delete(id);
    this.emit({ type: "env_deleted", envId: id });
  }

  async listSnapshots(id: Id) {
    await sleep(40);
    return clone(this.snapshots.get(id) ?? []);
  }

  /** Files at `at` for a session (or current), with change markers vs the session start. */
  private filesAt(envId: Id, opts: AtOpts): { files: Map<string, string>; base: Map<string, string> | null } {
    const fs = this.fs.get(envId);
    if (!fs) throw new ApiRequestError(404, `env ${envId} not found`);
    if (!opts.sessionId) return { files: fs.files, base: null };
    const start = fs.sessionStart.get(opts.sessionId) ?? fs.base;
    const files = new Map(start);
    for (const h of fs.history) {
      if (h.sessionId !== opts.sessionId) continue;
      if (opts.at != null && h.seq > opts.at) continue;
      if (h.content == null) files.delete(h.path);
      else files.set(h.path, h.content);
    }
    return { files, base: start };
  }

  async getTree(id: Id, opts: AtOpts = {}) {
    await sleep(25);
    const { files, base } = this.filesAt(id, opts);
    const fs = this.fs.get(id)!;
    const root: FileNode = { path: "/workspace", name: "workspace", type: "dir", children: [] };
    const dirs = new Map<string, FileNode>([["/workspace", root]]);
    const ensureDir = (path: string): FileNode => {
      const hit = dirs.get(path);
      if (hit) return hit;
      const parent = ensureDir(path.slice(0, path.lastIndexOf("/")) || "/workspace");
      const node: FileNode = { path, name: path.split("/").pop()!, type: "dir", children: [] };
      parent.children!.push(node);
      dirs.set(path, node);
      return node;
    };
    const all = new Set<string>([...files.keys(), ...(base ? [...base.keys()] : [])]);
    for (const path of all) {
      const content = files.get(path);
      const was = base?.get(path);
      const parent = ensureDir(path.slice(0, path.lastIndexOf("/")));
      let change: FileNode["change"];
      if (base) {
        if (content != null && was == null) change = "added";
        else if (content == null && was != null) change = "deleted";
        else if (content !== was) change = "modified";
      }
      parent.children!.push({
        path,
        name: path.split("/").pop()!,
        type: "file",
        size: content?.length ?? was?.length ?? 0,
        mode: 0o644,
        sha256: content != null ? fakeSha(content) : undefined,
        change,
      });
    }
    for (const h of fs.heavy) {
      const a = h.afterSeq;
      if (a) {
        if (opts.sessionId && opts.sessionId !== a.sessionId) continue; // other sessions ran before these existed
        const reached = this.events.get(a.sessionId)?.some((e) => e.seq >= a.seq);
        if (!reached || (opts.at != null && opts.at < a.seq)) continue;
      }
      const parent = ensureDir(h.path.slice(0, h.path.lastIndexOf("/")));
      parent.children!.push({ path: h.path, name: h.path.split("/").pop()!, type: "dir", heavy: true, children: [], size: 18_432 });
    }
    const sort = (n: FileNode) => {
      n.children?.sort((a, b) => (a.type === "dir") !== (b.type === "dir") ? (a.type === "dir" ? -1 : 1) : a.name.localeCompare(b.name));
      n.children?.forEach(sort);
    };
    sort(root);
    return root;
  }

  async getFile(id: Id, path: string, opts: AtOpts = {}): Promise<FileContent> {
    await sleep(20);
    const { files } = this.filesAt(id, opts);
    const content = files.get(path);
    if (content == null) throw new ApiRequestError(404, `${path} does not exist at this step`);
    return { path, at: opts.at, content, binary: false, size: content.length, sha256: fakeSha(content), truncated: false };
  }

  async exec(id: Id, req: ExecRequest): Promise<ExecResult> {
    const e = this.env(id);
    const t = performance.now();
    await sleep(e.type === "vm" ? 60 + Math.random() * 120 : 8);
    if (e.status !== "running") return { exitCode: 125, stdout: "", stderr: `env is ${e.status}\n`, durationMs: 0, truncated: false };
    const files = this.fs.get(id)!.files;
    const user = e.type === "sim" ? "agent" : req.as === "root" ? "root" : "agent";
    const abs = (p?: string) => (!p ? "/workspace" : p.startsWith("/") ? p.replace(/\/$/, "") : `/workspace/${p}`.replace(/\/$/, ""));
    const runOne = (cmd: string): { out: string; err: string; code: number } => {
      const [head, ...rest] = cmd.split(/\s+/);
      const arg = rest.filter((a) => !a.startsWith("-"))[0];
      let out = "";
      let err = "";
      let code = 0;
      switch (head) {
        case "ls": {
          const dir = abs(arg);
          const names = new Set<string>();
          for (const p of files.keys()) if (p.startsWith(dir + "/")) names.add(p.slice(dir.length + 1).split("/")[0]);
          if (!names.size && dir !== "/workspace") {
            err = `ls: ${arg}: No such file or directory\n`;
            code = 1;
          } else if (rest.some((r) => r.startsWith("-l")))
            out = [...names].sort().map((n) => `${files.has(`${dir}/${n}`) ? "-rw-r--r--" : "drwxr-xr-x"}    1 agent    agent   ${String(files.get(`${dir}/${n}`)?.length ?? 4096).padStart(8)} Oct 28 18:20 ${n}`).join("\n") + "\n";
          else out = [...names].sort().join("\n") + "\n";
          break;
        }
        case "cat": {
          const c = files.get(abs(arg));
          if (c == null) {
            err = `cat: can't open '${arg}': No such file or directory\n`;
            code = 1;
          } else out = c;
          break;
        }
        case "pwd":
          out = "/workspace\n";
          break;
        case "whoami":
          out = `${user}\n`;
          break;
        case "id":
          out = user === "root" ? "uid=0(root) gid=0(root) groups=0(root)\n" : "uid=1000(agent) gid=1000(agent) groups=1000(agent)\n";
          break;
        case "uname":
          out = e.type === "vm" ? "Linux terrarium 6.12.48-0-virt #1-Alpine SMP PREEMPT_DYNAMIC aarch64 Linux\n" : "just-bash\n";
          break;
        case "echo":
          out = rest.join(" ") + "\n";
          break;
        case "python3":
        case "python":
          out = rest[0] === "--version" ? "Python 3.12.12\n" : "";
          if (rest[0] !== "--version") {
            err = "fixture shell: only `python3 --version` is simulated\n";
            code = 2;
          }
          break;
        case "df":
          out = e.type === "vm" ? "Filesystem      Size  Used Avail Use% Mounted on\n/dev/vda        3.9G  612M  3.1G  17% /\n" : "df: not available in just-bash\n";
          break;
        case "ip":
          out = "1: lo: <LOOPBACK,UP,LOWER_UP> mtu 65536\n    inet 127.0.0.1/8 scope host lo\n2: eth0: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500\n    inet 10.0.2.15/24 scope global eth0\n";
          break;
        default:
          err = `sh: ${head}: not found (fixture shell simulates ls, cat, pwd, whoami, id, uname, echo, df, ip)\n`;
          code = 127;
      }
      return { out, err, code };
    };
    // `a; b` runs both, `a && b` stops at the first failure
    let out = "";
    let err = "";
    let code = 0;
    let skip = false;
    for (const part of req.command.trim().split(/\s*(;|&&)\s*/)) {
      if (part === ";") {
        skip = false;
        continue;
      }
      if (part === "&&") {
        skip = code !== 0;
        continue;
      }
      if (!part || skip) continue;
      const r = runOne(part);
      out += r.out;
      err += r.err;
      code = r.code;
    }
    return { exitCode: code, stdout: out, stderr: err, durationMs: Math.round(performance.now() - t), truncated: false };
  }

  async getNet(id: Id, limit = 500) {
    await sleep(30);
    return clone((this.net.get(id) ?? []).slice(-limit));
  }

  async createSession(req: CreateSessionRequest) {
    await sleep(80);
    const m = this.models.find((x) => x.id === req.modelId);
    const s = this.addSession({
      id: fid("s"),
      envId: req.envId,
      title: req.title ?? (req.envId ? "New session" : "New chat"),
      modelId: req.modelId,
      harness: req.harness,
      thinking: req.thinking ?? false,
      contextWindow: req.contextWindow ?? m?.defaultContext ?? 32768,
      maxOutputTokens: req.maxOutputTokens ?? m?.defaultMaxOutput ?? 4096,
      status: "idle",
      createdAt: Date.now(),
    });
    if (req.envId) this.fs.get(req.envId)?.sessionStart.set(s.id, new Map(this.fs.get(req.envId)!.files));
    this.emit({ type: "session", session: clone(s) });
    return clone(s);
  }

  async getSession(id: Id) {
    await sleep(20);
    const s = this.sessions.get(id);
    if (!s) throw new ApiRequestError(404, "session not found");
    return clone(s);
  }

  async updateSession(id: Id, req: UpdateSessionRequest) {
    await sleep(40);
    const s = this.sessions.get(id);
    if (!s) throw new ApiRequestError(404, "session not found");
    if (req.modelId && s.status === "running") throw new ApiRequestError(409, "Stop the run before switching models");
    const { systemPrompt, ...rest } = req;
    if (systemPrompt !== undefined || (req.harness && req.harness !== s.harness)) {
      if (systemPrompt) this.prompts.set(id, systemPrompt);
      else this.prompts.delete(id);
    }
    this.setSession(id, { ...rest, customPrompt: this.prompts.has(id) || undefined });
    return clone(this.sessions.get(id)!);
  }

  async getEvents(id: Id, after?: number) {
    await sleep(40);
    const lazy = this.lazyCells.get(id);
    if (lazy) {
      this.lazyCells.delete(id);
      const s = this.sessions.get(id)!;
      this.play(id, lazy(), s.createdAt, false);
      this.flushDue(true);
    }
    const evs = this.events.get(id);
    if (!evs) throw new ApiRequestError(404, "session not found");
    return clone(after != null ? evs.filter((e) => e.seq > after) : evs);
  }

  /** Turns so far and the OpenAI-style message history rebuilt from the trace, for follow-up requests. */
  private conversation(id: Id): { turnBase: number; history: Record<string, unknown>[] } {
    const history: Record<string, unknown>[] = [];
    let turnBase = 0;
    for (const e of this.events.get(id) ?? []) {
      if (e.type === "turn_start") turnBase = Math.max(turnBase, e.turn);
      else if (e.type === "user_message") history.push({ role: "user", content: e.text });
      else if (e.type === "assistant_message") {
        const m: Record<string, unknown> = { role: "assistant", content: e.text };
        if (e.toolCalls.length)
          m.tool_calls = e.toolCalls.map((t) => ({ id: t.id, type: "function", function: { name: t.name, arguments: JSON.stringify(t.args) } }));
        history.push(m);
      } else if (e.type === "tool_end") history.push({ role: "tool", tool_call_id: e.toolCallId, content: e.resultForModel });
    }
    return { turnBase, history };
  }

  private lastPrompt(id: Id): number {
    const evs = this.events.get(id) ?? [];
    for (let i = evs.length - 1; i >= 0; i--) {
      const e = evs[i];
      if (e.type === "model_call_end" && e.usage) return e.usage.promptTokens + e.usage.completionTokens;
    }
    return 600;
  }

  async sendMessage(id: Id, text: string) {
    await sleep(50);
    const s = this.sessions.get(id);
    if (!s) throw new ApiRequestError(404, "session not found");
    if (s.status === "running") throw new ApiRequestError(409, "A run is in progress");
    const built = buildReply(
      { sessionId: id, envId: s.envId, modelId: s.modelId, window: s.contextWindow, maxOut: s.maxOutputTokens, thinking: s.thinking, ...this.conversation(id) },
      text,
      s.lastSeq,
      this.lastPrompt(id),
    );
    this.play(id, built, Date.now());
  }

  async continueSession(id: Id) {
    await sleep(50);
    const s = this.sessions.get(id);
    if (!s) throw new ApiRequestError(404, "session not found");
    if (s.status === "running") throw new ApiRequestError(409, "A run is in progress");
    // the scripted continuation only fits the run that ended at the output cap
    const lastEnd = this.events.get(id)!.findLast((e) => e.type === "run_end");
    const scripted = id === this.liveIds.fix && lastEnd?.type === "run_end" && lastEnd.reason === "length";
    const built = scripted
      ? buildInvoiceContinue(id, s.envId!, s.lastSeq)
      : buildReply(
          { sessionId: id, envId: s.envId, modelId: s.modelId, window: s.contextWindow, maxOut: s.maxOutputTokens, thinking: false, ...this.conversation(id) },
          "continue",
          s.lastSeq,
          this.lastPrompt(id),
        );
    if (!scripted) built.steps = built.steps.filter((x) => x.body.type !== "user_message");
    this.play(id, built, Date.now());
  }

  async retrySession(id: Id) {
    await sleep(50);
    const s = this.sessions.get(id);
    if (!s) throw new ApiRequestError(404, "session not found");
    if (s.status === "running") throw new ApiRequestError(409, "A run is in progress");
    const last = this.events.get(id)!.findLast((e) => e.type === "user_message");
    if (last?.type !== "user_message") throw new ApiRequestError(409, "nothing to retry: the latest message already has a reply");
    const built = buildReply(
      { sessionId: id, envId: s.envId, modelId: s.modelId, window: s.contextWindow, maxOut: s.maxOutputTokens, thinking: s.thinking, ...this.conversation(id) },
      last.text,
      s.lastSeq,
      this.lastPrompt(id),
    );
    for (const x of built.steps) if (x.body.type === "user_message") x.body = { ...x.body, retry: "message" };
    this.play(id, built, Date.now());
  }

  async stopSession(id: Id) {
    const p = this.playing.find((x) => x.sessionId === id);
    if (!p) return;
    this.playing = this.playing.filter((x) => x !== p);
    const s = this.sessions.get(id)!;
    let seq = s.lastSeq;
    const now = Date.now();
    const push = (body: Record<string, unknown>) => {
      const ev = { ...body, sessionId: id, seq: ++seq, ts: now } as TraceEvent;
      this.events.get(id)!.push(ev);
      if (this.subs.has(id)) this.emit({ type: "trace", event: ev });
    };
    if (p.openTool)
      push({ type: "tool_end", toolCallId: p.openTool, name: "bash", exitCode: 130, durationMs: 0, outputTruncated: false, resultForModel: "[stopped by user]", isError: true, fileChanges: 0 });
    if (p.openCall) {
      const started = this.events.get(id)!.find((e) => e.type === "model_call_start" && e.callId === p.openCall);
      push({ type: "model_call_end", callId: p.openCall, finishReason: "aborted", timing: { totalMs: now - (started?.ts ?? now) } });
    }
    push({ type: "run_end", reason: "stopped" });
    this.setSession(id, { status: "idle", lastSeq: seq, updatedAt: now });
  }

  async deleteSession(id: Id) {
    await sleep(60);
    this.sessions.delete(id);
    this.events.delete(id);
    this.playing = this.playing.filter((p) => p.sessionId !== id);
    this.emit({ type: "session_deleted", sessionId: id });
  }

  async getModelCall(id: Id) {
    await sleep(35);
    const c = this.calls.get(id);
    if (!c) throw new ApiRequestError(404, "model call not found");
    return clone(c);
  }

  async getBlob(sha: string) {
    await sleep(15);
    const b = this.blobs.get(sha);
    if (b == null) throw new ApiRequestError(404, "blob not found");
    return b;
  }

  async listModels() {
    return clone(this.models);
  }

  private putModels() {
    this.emit({ type: "models", models: clone(this.models) });
  }

  async loadModel(id: Id, req: LoadModelRequest = {}) {
    if (this.inference.status !== "ready") throw new ApiRequestError(409, "Inference server is not running");
    const m = this.models.find((x) => x.id === id);
    if (!m) throw new ApiRequestError(404, "model not found");
    await sleep(2200 + m.weightsBytes / GiB / 3 * 1000);
    const ctx = req.context ?? m.defaultContext;
    Object.assign(m, { loaded: true, loadedContext: ctx, residentBytes: Math.round(m.weightsBytes + ctx * m.kvBytesPerToken * 0.18 + m.fixedBytes + 0.35 * GiB) });
    this.putModels();
  }

  async unloadModel(id: Id) {
    await sleep(300);
    const m = this.models.find((x) => x.id === id);
    if (!m) throw new ApiRequestError(404, "model not found");
    Object.assign(m, { loaded: false, loadedContext: undefined, residentBytes: undefined });
    this.putModels();
  }

  async updateModel(id: Id, req: UpdateModelRequest) {
    await sleep(60);
    const m = this.models.find((x) => x.id === id);
    if (!m) throw new ApiRequestError(404, "model not found");
    if (req.defaultContext != null) m.defaultContext = req.defaultContext;
    if (req.defaultMaxOutput != null) m.defaultMaxOutput = req.defaultMaxOutput;
    if (req.sampling) m.sampling = { ...m.sampling, ...req.sampling };
    this.putModels();
    return clone(m);
  }

  private putInference(p: Partial<InferenceState>) {
    this.inference = { ...this.inference, ...p };
    this.emit({ type: "inference", inference: clone(this.inference) });
  }

  async startInference() {
    this.putInference({ status: "starting", detail: "spawning oMLX 0.7.2" });
    window.setTimeout(() => this.putInference({ status: "ready", detail: undefined, pid: 48213 + Math.floor(Math.random() * 400) }), 1800);
    return clone(this.inference);
  }

  async stopInference() {
    this.putInference({ status: "stopping" });
    window.setTimeout(() => {
      for (const m of this.models) Object.assign(m, { loaded: false, loadedContext: undefined, residentBytes: undefined });
      this.putModels();
      this.putInference({ status: "stopped", pid: undefined, rssBytes: undefined });
    }, 800);
    return clone(this.inference);
  }

  async modelSuggestions() {
    await sleep(30);
    return clone(SUGGESTIONS);
  }

  async inspectModel(repo: string) {
    await sleep(700);
    const r = repo.trim();
    if (!/^[\w.-]+\/[\w.-]+$/.test(r)) throw new ApiRequestError(400, "repo must be a Hugging Face model id like owner/name");
    return inspectFixture(r, this.models.some((m) => m.id === r.split("/")[1]));
  }

  async startDownload(repo: string) {
    const check = await this.inspectModel(repo);
    if (!check.ok) throw new ApiRequestError(400, check.problems.join("; ") || "already installed");
    const d: ModelDownload = { id: fid("dl"), repo: check.repo, dirName: check.dirName, status: "running", bytesDone: 0, bytesTotal: check.totalBytes, startedAt: Date.now() };
    this.downloads.set(d.id, d);
    const tick = () => {
      if (d.status !== "running") return;
      d.bytesDone = Math.min(d.bytesTotal, d.bytesDone + d.bytesTotal / 12);
      if (d.bytesDone >= d.bytesTotal) {
        d.status = "done";
        d.finishedAt = Date.now();
        const base = this.models[0]!;
        this.models.push({ ...clone(base), id: d.dirName, name: d.dirName, loaded: false, loadedContext: undefined, residentBytes: undefined, diskBytes: d.bytesTotal });
        this.putModels();
      } else this.timers.push(window.setTimeout(tick, 400));
      this.emit({ type: "model_download", download: clone(d) });
    };
    this.timers.push(window.setTimeout(tick, 300));
    this.emit({ type: "model_download", download: clone(d) });
    return clone(d);
  }

  async cancelDownload(id: Id) {
    const d = this.downloads.get(id);
    if (!d) throw new ApiRequestError(404, "download not found");
    if (d.status === "running") Object.assign(d, { status: "canceled", finishedAt: Date.now() });
    this.emit({ type: "model_download", download: clone(d) });
    return clone(d);
  }

  async removeModel(id: Id) {
    await sleep(300);
    const m = this.models.find((x) => x.id === id);
    if (!m) throw new ApiRequestError(404, "model not found");
    if ([...this.sessions.values()].some((s) => s.modelId === id && s.status === "running")) throw new ApiRequestError(409, `${id} is in use; stop it first`);
    this.models = this.models.filter((x) => x.id !== id);
    this.putModels();
    return { freedBytes: m.diskBytes };
  }

  async getSettings() {
    await sleep(60);
    return clone(settingsInfo(this.settings, this.inference.memoryCeilingBytes, this.inference));
  }

  async updateSettings(req: UpdateSettingsRequest) {
    await sleep(40);
    const prompts = { ...this.settings.prompts };
    for (const [k, v] of Object.entries(req.prompts ?? {})) {
      const id = k as keyof AppSettings["prompts"];
      if (v == null) delete prompts[id];
      else prompts[id] = id === "terrarium" && v.endsWith(SIM_NOTE) ? v.slice(0, -SIM_NOTE.length) : v;
    }
    this.settings = {
      memoryBudgetBytes: req.memoryBudgetBytes ?? this.settings.memoryBudgetBytes,
      newSession: { ...this.settings.newSession, ...req.newSession },
      newEnv: { ...this.settings.newEnv, ...req.newEnv },
      prompts,
    };
    this.emit({ type: "settings", settings: clone(this.settings) });
    return clone(this.settings);
  }

  async reveal(_path: PathKey) {
    await sleep(20);
  }

  async getHarness() {
    await sleep(30);
    return harnessFixture(this.settings.prompts);
  }

  async getSessionPrompt(id: Id) {
    await sleep(60);
    const s = this.sessions.get(id);
    if (!s) throw new ApiRequestError(404, "session not found");
    const envType = s.harness !== "chat" && s.envId ? (this.envs.get(s.envId)?.type ?? null) : null;
    const h = harnessFixture(this.settings.prompts).find((x) => x.id === (envType ? s.harness : "chat"))!;
    const defaultText = h.prompt + (h.id === "terrarium" && envType === "sim" ? SIM_NOTE : "");
    const override = this.prompts.get(id);
    return {
      harness: s.harness,
      envType,
      text: override ?? defaultText,
      source: override != null ? ("session" as const) : h.custom ? ("profile" as const) : ("built-in" as const),
      defaultText,
      tools: h.tools,
      tokens: { prompt: Math.ceil((override ?? defaultText).length / 4), tools: h.tokensEst.tools, exact: false },
    };
  }

  async listSuites() {
    await sleep(40);
    return clone(SUITES);
  }

  async startEvalRun(req: StartEvalRunRequest) {
    await sleep(120);
    const suite = SUITES.find((s) => s.id === req.suiteId);
    if (!suite) throw new ApiRequestError(404, "suite not found");
    const cases = req.sampleSize && suite.source?.sampleable ? suite.cases.slice(0, req.sampleSize) : suite.cases;
    const results: EvalResult[] = [];
    for (const c of cases) for (const m of req.modelIds) results.push({ caseId: c.id, modelId: m, status: "pending" });
    if (results[0]) results[0].status = "running";
    const run: EvalRunDetail = {
      id: fid("run"),
      suiteId: suite.id,
      suiteTitle: suite.title,
      config: req,
      status: "running",
      startedAt: Date.now(),
      totals: {},
      cases,
      results,
    };
    this.recount(run);
    this.runs.unshift(run);
    this.every(3600, () => this.advanceRun(run, { "Qwen3.5-9B-MLX-4bit": 0.85 }));
    this.emit({ type: "eval_run", run: this.summary(run) });
    return this.summary(run);
  }

  async listEvalRuns() {
    return this.runs.map((r) => this.summary(r));
  }

  async getEvalRun(id: Id) {
    await sleep(40);
    const r = this.runs.find((x) => x.id === id);
    if (!r) throw new ApiRequestError(404, "run not found");
    return clone(r);
  }

  async stopEvalRun(id: Id) {
    const r = this.runs.find((x) => x.id === id);
    if (!r || r.status !== "running") return;
    r.status = "stopped";
    r.finishedAt = Date.now();
    for (const x of r.results) if (x.status === "running" || x.status === "pending") x.status = "skipped";
    this.recount(r);
    this.emit({ type: "eval_run", run: this.summary(r) });
    for (const x of r.results) if (x.status === "skipped") this.emit({ type: "eval_result", runId: r.id, result: x });
  }
}

