// Eval runner. Each (case, model) is a normal session: sim/vm cases run in a disposable env forked from a clean
// base env of that type, `none` cases use the chat profile without an env. Results stream as eval_result and
// eval_run messages and persist in eval_runs/eval_results. Models run one after another (one model loaded at a
// time); within a model, sim and chat cases run 2 at a time and VM cases 1 at a time.

import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { EnvType, EvalCase, EvalCellStatus, EvalResult, EvalRunDetail, EvalRunSummary, EvalSuite, HarnessProfile, StartEvalRunRequest } from "@terrarium/shared";
import { REPO_DIR } from "../config.ts";
import type { EnvManager } from "../envs/manager.ts";
import type { PolicyModule } from "../envs/policy.ts";
import type { EnvRuntime } from "../envs/types.ts";
import { HARNESSES, type SessionManager } from "../harness/sessions.ts";
import type { Hub } from "../hub.ts";
import type { InferenceService } from "../inference/service.ts";
import type { Store } from "../store/db.ts";
import { HttpError, errorMessage } from "../util/errors.ts";
import { newId } from "../util/ids.ts";
import { logger } from "../util/log.ts";
import { type Grade, gradeAnswer, gradeCommand, gradeFile, gradeIsolation, gradeSpeed, gradeTests } from "./graders.ts";
import { loadSuites, materializeSuite } from "./suites/index.ts";

const log = logger("evals");

const BASE_ENV: Record<EnvType, string> = { sim: "evalbase_sim", vm: "evalbase_vm" };

interface RunRow {
  id: string;
  suite_id: string;
  suite_title: string;
  config_json: string;
  cases_json: string;
  status: EvalRunSummary["status"];
  started_at: number;
  finished_at: number | null;
}

interface ResultRow {
  run_id: string;
  case_id: string;
  model_id: string;
  status: EvalCellStatus;
  session_id: string | null;
  env_id: string | null;
  duration_ms: number | null;
  tokens_json: string | null;
  detail: string | null;
  score: number | null;
}

interface ActiveRun {
  stopped: boolean;
  sessions: Set<string>;
  done: Promise<void>;
}

/** Per-run host secret; case prompts may name its path as {{canaryPath}}. */
interface Canary {
  token: string;
  path: string;
}

function toResult(r: ResultRow): EvalResult {
  return {
    caseId: r.case_id,
    modelId: r.model_id,
    status: r.status,
    ...(r.session_id ? { sessionId: r.session_id } : {}),
    ...(r.env_id ? { envId: r.env_id } : {}),
    ...(r.duration_ms !== null ? { durationMs: r.duration_ms } : {}),
    ...(r.tokens_json ? { tokens: JSON.parse(r.tokens_json) } : {}),
    ...(r.detail !== null ? { detail: r.detail } : {}),
    ...(r.score !== null ? { score: r.score } : {}),
  };
}

/** Run `fn` over items with at most `n` in flight. */
async function pool<T>(items: T[], n: number, fn: (item: T) => Promise<void>): Promise<void> {
  let i = 0;
  const worker = async () => {
    while (i < items.length) await fn(items[i++]);
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
}

export class EvalRunner {
  private store: Store;
  private hub: Hub;
  private envs: EnvManager;
  private sessions: SessionManager;
  private inference: InferenceService;
  private policy: PolicyModule;
  private dataDir: string;
  private active = new Map<string, ActiveRun>();
  private bases = new Map<EnvType, Promise<{ id: string; snapshotId: string }>>();

  constructor(opts: { store: Store; hub: Hub; envs: EnvManager; sessions: SessionManager; inference: InferenceService; policy: PolicyModule; dataDir: string }) {
    this.store = opts.store;
    this.hub = opts.hub;
    this.envs = opts.envs;
    this.sessions = opts.sessions;
    this.inference = opts.inference;
    this.policy = opts.policy;
    this.dataDir = opts.dataDir;
    // Runs interrupted by a restart can't resume: mark them stopped.
    const stale = this.store.all<{ id: string }>("SELECT id FROM eval_runs WHERE status = 'running'");
    for (const r of stale) {
      this.store.run("UPDATE eval_results SET status = 'skipped', detail = 'backend restarted' WHERE run_id = ? AND status IN ('pending', 'running')", r.id);
      this.store.run("UPDATE eval_runs SET status = 'stopped', finished_at = ? WHERE id = ?", Date.now(), r.id);
    }
  }

  private suiteOpts() {
    return { rootDir: REPO_DIR, dataDir: join(this.dataDir, "datasets") };
  }

  suites(): Promise<EvalSuite[]> {
    return loadSuites(this.suiteOpts());
  }

  private summary(r: RunRow): EvalRunSummary {
    const totals: EvalRunSummary["totals"] = {};
    const config = JSON.parse(r.config_json) as StartEvalRunRequest;
    for (const m of config.modelIds) totals[m] = { pass: 0, fail: 0, error: 0, total: 0 };
    for (const row of this.store.all<{ model_id: string; status: EvalCellStatus; n: number }>("SELECT model_id, status, COUNT(*) AS n FROM eval_results WHERE run_id = ? GROUP BY model_id, status", r.id)) {
      const t = (totals[row.model_id] ??= { pass: 0, fail: 0, error: 0, total: 0 });
      t.total += row.n;
      if (row.status === "pass") t.pass += row.n;
      else if (row.status === "fail") t.fail += row.n;
      else if (row.status === "error") t.error += row.n;
    }
    return {
      id: r.id,
      suiteId: r.suite_id,
      suiteTitle: r.suite_title,
      config,
      status: r.status,
      startedAt: r.started_at,
      ...(r.finished_at ? { finishedAt: r.finished_at } : {}),
      totals,
    };
  }

  private runRow(id: string): RunRow {
    const r = this.store.get<RunRow>("SELECT * FROM eval_runs WHERE id = ?", id);
    if (!r) throw new HttpError(404, `eval run not found: ${id}`);
    return r;
  }

  list(): EvalRunSummary[] {
    return this.store.all<RunRow>("SELECT * FROM eval_runs ORDER BY started_at DESC LIMIT 200").map((r) => this.summary(r));
  }

  detail(id: string): EvalRunDetail {
    const r = this.runRow(id);
    const results = this.store.all<ResultRow>("SELECT * FROM eval_results WHERE run_id = ?", id).map(toResult);
    return { ...this.summary(r), cases: JSON.parse(r.cases_json) as EvalCase[], results };
  }

  async start(req: StartEvalRunRequest): Promise<EvalRunSummary> {
    if (!req || typeof req.suiteId !== "string") throw new HttpError(400, "suiteId is required");
    if (!Array.isArray(req.modelIds) || !req.modelIds.length) throw new HttpError(400, "modelIds must list at least one model");
    const harness: HarnessProfile = req.harness ?? "terrarium";
    if (!HARNESSES.includes(harness)) throw new HttpError(400, `harness must be one of ${HARNESSES.join(", ")}`);
    for (const m of req.modelIds) if (!(await this.inference.model(m))) throw new HttpError(400, `model not found: ${m}`);
    let suite: EvalSuite;
    try {
      suite = await materializeSuite(req.suiteId, { ...this.suiteOpts(), ...(req.sampleSize ? { sampleSize: req.sampleSize } : {}), ...(req.seed !== undefined ? { seed: req.seed } : {}) });
    } catch (err) {
      throw new HttpError(400, `suite ${req.suiteId}: ${errorMessage(err)}`);
    }
    if (!suite.cases.length) throw new HttpError(400, `suite ${req.suiteId} has no cases`);
    const config: StartEvalRunRequest = { ...req, harness };
    const id = newId("run");
    const now = Date.now();
    this.store.tx(() => {
      this.store.run(
        "INSERT INTO eval_runs (id, suite_id, suite_title, config_json, cases_json, status, started_at) VALUES (?, ?, ?, ?, ?, 'running', ?)",
        id,
        suite.id,
        suite.title,
        JSON.stringify(config),
        JSON.stringify(suite.cases),
        now,
      );
      for (const m of req.modelIds) for (const c of suite.cases) this.store.run("INSERT INTO eval_results (run_id, case_id, model_id, status) VALUES (?, ?, ?, 'pending')", id, c.id, m);
    });
    const active: ActiveRun = { stopped: false, sessions: new Set(), done: Promise.resolve() };
    this.active.set(id, active);
    active.done = this.execute(id, suite, config, active)
      .catch((err) => {
        log.error(`eval run ${id} failed`, err);
        this.finish(id, "error");
      })
      .finally(() => this.active.delete(id));
    const s = this.summary(this.runRow(id));
    this.hub.broadcast({ type: "eval_run", run: s });
    return s;
  }

  async stop(id: string): Promise<EvalRunSummary> {
    this.runRow(id);
    const a = this.active.get(id);
    if (a) {
      a.stopped = true;
      await Promise.all([...a.sessions].map((s) => this.sessions.stop(s)));
      await Promise.race([a.done, new Promise((r) => setTimeout(r, 30_000).unref())]);
    }
    return this.summary(this.runRow(id));
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.active.keys()].map((id) => this.stop(id)));
  }

  private finish(id: string, status: EvalRunSummary["status"]): void {
    this.store.run("UPDATE eval_results SET status = 'skipped', detail = COALESCE(detail, 'run stopped') WHERE run_id = ? AND status IN ('pending', 'running')", id);
    this.store.run("UPDATE eval_runs SET status = ?, finished_at = ? WHERE id = ?", status, Date.now(), id);
    this.hub.broadcast({ type: "eval_run", run: this.summary(this.runRow(id)) });
  }

  private setResult(runId: string, caseId: string, modelId: string, patch: Partial<EvalResult> & { status: EvalCellStatus }): void {
    this.store.run(
      `UPDATE eval_results SET status = ?, session_id = COALESCE(?, session_id), env_id = COALESCE(?, env_id), duration_ms = COALESCE(?, duration_ms),
        tokens_json = COALESCE(?, tokens_json), detail = COALESCE(?, detail), score = COALESCE(?, score) WHERE run_id = ? AND case_id = ? AND model_id = ?`,
      patch.status,
      patch.sessionId ?? null,
      patch.envId ?? null,
      patch.durationMs ?? null,
      patch.tokens ? JSON.stringify(patch.tokens) : null,
      patch.detail ?? null,
      patch.score ?? null,
      runId,
      caseId,
      modelId,
    );
    const row = this.store.get<ResultRow>("SELECT * FROM eval_results WHERE run_id = ? AND case_id = ? AND model_id = ?", runId, caseId, modelId);
    if (row) this.hub.broadcast({ type: "eval_result", runId, result: toResult(row) });
    this.hub.broadcast({ type: "eval_run", run: this.summary(this.runRow(runId)) });
  }

  private async execute(runId: string, suite: EvalSuite, config: StartEvalRunRequest, active: ActiveRun): Promise<void> {
    const canaryDir = join(this.dataDir, "canary", runId);
    const canary: Canary = { token: `TERRARIUM-CANARY-${randomBytes(12).toString("hex")}`, path: join(canaryDir, "canary.txt") };
    if (suite.cases.some((c) => c.check.type === "isolation")) {
      // Host-only: data/ is 0700 and never mounted into envs. The probe must not be able to reach it.
      mkdirSync(canaryDir, { recursive: true, mode: 0o700 });
      writeFileSync(canary.path, `${canary.token}\n`, { mode: 0o600 });
    }
    try {
      for (const modelId of config.modelIds) {
        if (active.stopped) break;
        const wasLoaded = (await this.inference.model(modelId))?.loaded ?? false;
        const speed = suite.cases.filter((c) => c.check.type === "speed");
        const vm = suite.cases.filter((c) => c.check.type !== "speed" && c.envType === "vm");
        const light = suite.cases.filter((c) => c.check.type !== "speed" && c.envType !== "vm");
        const one = (c: EvalCase) => (active.stopped ? Promise.resolve() : this.runCase(runId, suite, c, modelId, config, active, canary));
        // Load first: the first request after a model switch would otherwise time the load as prefill.
        if (speed.length && !active.stopped) await this.inference.load(modelId, config.contextWindow).catch((err) => log.warn(`loading ${modelId} failed`, err));
        await pool(speed, 1, one); // alone, so timings aren't shared with other requests
        await Promise.all([pool(light, 2, one), pool(vm, 1, one)]);
        // One model resident at a time: unload what this run loaded before the next model starts.
        if (!wasLoaded) await this.inference.unload(modelId).catch((err) => log.warn(`unloading ${modelId} failed`, err));
      }
    } finally {
      rmSync(canaryDir, { recursive: true, force: true });
    }
    this.finish(runId, active.stopped ? "stopped" : "done");
  }

  /** Clean base env per type (never run itself); case envs are forks of its factory snapshot. */
  private baseEnv(type: EnvType): Promise<{ id: string; snapshotId: string }> {
    let p = this.bases.get(type);
    if (!p) {
      p = this.ensureBase(type);
      this.bases.set(type, p);
      p.catch(() => this.bases.delete(type));
    }
    return p;
  }

  private async ensureBase(type: EnvType): Promise<{ id: string; snapshotId: string }> {
    const id = BASE_ENV[type];
    if (!this.envs.exists(id)) await this.envs.create({ name: `eval base (${type})`, type, network: "off" }, { ephemeral: true, id });
    const snap = this.envs.snapshots(id).find((s) => s.kind === "factory");
    if (!snap) throw new Error(`eval base env ${id} has no factory snapshot`);
    return { id, snapshotId: snap.id };
  }

  private async runCase(runId: string, suite: EvalSuite, c: EvalCase, modelId: string, config: StartEvalRunRequest, active: ActiveRun, canary: Canary): Promise<void> {
    const started = Date.now();
    let envId: string | null = null;
    let sessionId: string | undefined;
    this.setResult(runId, c.id, modelId, { status: "running" });
    try {
      if (c.envType !== "none") {
        const base = await this.baseEnv(c.envType);
        // The case owns its env from the moment the env exists: the running result row names it before the fork inserts
        // it, so shell, network, other sessions and lifecycle ops refuse it from its first broadcast.
        const ownedId = newId(c.envType === "vm" ? "vm" : "sim");
        this.setResult(runId, c.id, modelId, { status: "running", envId: ownedId });
        const env = await this.envs.fork(
          base.id,
          { name: `eval ${suite.id}/${c.id} (${modelId})`, snapshotId: base.snapshotId, network: c.network ?? "off", seedFiles: c.setupFiles ?? [] },
          { ephemeral: true, id: ownedId },
        );
        envId = env.id;
      }
      const session = await this.sessions.create(
        {
          envId,
          modelId,
          harness: c.envType === "none" ? "chat" : config.harness,
          title: `${suite.title}: ${c.title}`,
          ...(config.thinking !== undefined ? { thinking: config.thinking } : {}),
          ...(config.contextWindow ? { contextWindow: config.contextWindow } : {}),
        },
        { evalRunId: runId, evalCaseId: c.id, ephemeral: true },
      );
      sessionId = session.id;
      active.sessions.add(session.id);
      this.setResult(runId, c.id, modelId, { status: "running", sessionId, ...(envId ? { envId } : {}) });
      // Host-file probes name the canary's real host path, so a successful read shows up as a canary leak.
      let prompt = c.prompt.replaceAll("{{canaryPath}}", canary.path);
      // A re-run sends the same text; a per-run tag first keeps speed prompts out of the server's prefix cache.
      if (c.check.type === "speed") prompt = `[run ${runId}] ${prompt}`;
      const outcome = await this.sessions.run(session.id, prompt, { maxTurns: c.maxTurns, timeoutMs: c.timeoutSec * 1000 });
      active.sessions.delete(session.id);
      const tokens = this.tokens(session.id);
      if (active.stopped && !outcome.timedOut) {
        this.setResult(runId, c.id, modelId, { status: "skipped", detail: "run stopped", durationMs: Date.now() - started, tokens });
        return;
      }
      let grade: Grade;
      if (outcome.reason === "error" && c.check.type !== "isolation") grade = { pass: false, detail: `session error: ${outcome.error ?? "unknown"}` };
      else grade = await this.grade(c, session.id, envId, outcome.finalText, canary);
      const prefix = outcome.timedOut ? `timed out after ${c.timeoutSec}s; ` : outcome.reason === "max_turns" ? `hit ${c.maxTurns} turns; ` : outcome.reason === "length" ? "output truncated; " : "";
      this.setResult(runId, c.id, modelId, {
        status: grade.pass ? "pass" : outcome.reason === "error" ? "error" : "fail",
        detail: prefix + grade.detail,
        durationMs: Date.now() - started,
        tokens,
        ...(grade.score !== undefined ? { score: grade.score } : {}),
      });
    } catch (err) {
      this.setResult(runId, c.id, modelId, { status: "error", detail: errorMessage(err), durationMs: Date.now() - started, ...(sessionId ? { sessionId } : {}) });
    } finally {
      if (sessionId) active.sessions.delete(sessionId);
      if (envId) {
        await this.envs.stop(envId).catch(() => undefined);
        await this.envs.releaseStorage(envId).catch((err) => log.warn(`releasing ${envId} failed`, err));
      }
    }
  }

  private tokens(sessionId: string): { prompt: number; completion: number } {
    let prompt = 0;
    let completion = 0;
    for (const r of this.store.all<{ usage_json: string | null }>("SELECT usage_json FROM model_calls WHERE session_id = ?", sessionId)) {
      if (!r.usage_json) continue;
      const u = JSON.parse(r.usage_json) as { promptTokens?: number; completionTokens?: number };
      prompt += u.promptTokens ?? 0;
      completion += u.completionTokens ?? 0;
    }
    return { prompt, completion };
  }

  private async grade(c: EvalCase, sessionId: string, envId: string | null, reply: string, canary: Canary): Promise<Grade> {
    const check = c.check;
    if (check.type === "answer") return gradeAnswer(check, reply);
    if (check.type === "speed") return gradeSpeed(this.store, sessionId, c.id);
    let rt: EnvRuntime | null = null;
    if (envId) {
      await this.envs.start(envId);
      rt = await this.envs.inspect(envId);
    }
    // Nothing the agent left running (setsid daemons included) may change the env while it is graded.
    if (rt) await rt.killAgentProcesses();
    if (check.type === "isolation") return gradeIsolation({ store: this.store, policy: this.policy, sessionId, canary: canary.token, runtime: rt, probe: check.probe });
    if (!rt) return { pass: false, detail: `${check.type} check needs an environment` };
    if (check.type === "file") return gradeFile(rt, check);
    if (check.type === "tests") return gradeTests(rt, check, c.hiddenFiles);
    return gradeCommand(rt, check);
  }
}
