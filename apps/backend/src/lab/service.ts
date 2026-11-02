// Neuron Lab: one specimen (model) at a time in a sidecar process, kept under the memory ceiling next to oMLX, plus
// the saved probe sets and strains. A strain is a base model with neuron pushes; sessions and evals use it as the
// model `strain:<id>`, which the sidecar serves through an OpenAI-compatible endpoint.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { LabFieldGuide, LabHistoryEntry, LabLensHit, LabMemoryCheck, LabMixItem, LabModelFacts, LabProbeSet, LabState, LabStatus, LabStrain, LabSupport, LabTokensResult, ModelInfo, SaveProbeSetRequest, SaveStrainRequest } from "@terrarium/shared";
import { BACKEND_DIR } from "../config.ts";
import type { Hub } from "../hub.ts";
import { estimateBytes } from "../inference/catalog.ts";
import type { InferenceService, LabHooks } from "../inference/service.ts";
import type { Store } from "../store/db.ts";
import { HttpError, errorMessage } from "../util/errors.ts";
import { newId } from "../util/ids.ts";
import { logger } from "../util/log.ts";
import { KeyedMutex } from "../util/mutex.ts";
import { checkPushes, checkSettings, defaultSettings, formatRecipe, isVector, vectorLength } from "./recipe.ts";
import { type LabHealth, LabSidecar, SidecarError, type SidecarOptions } from "./sidecar.ts";
import { labSupport } from "./support.ts";

const log = logger("lab");

export const STRAIN_PREFIX = "strain:";
export const isStrainId = (id: string) => id.startsWith(STRAIN_PREFIX);

/** A running session or eval and the model it uses. */
export interface ModelUser {
  modelId: string;
  what: string; // session "title" | eval "suite"
  kind: "session" | "eval";
  contextWindow?: number; // sessions: the window oMLX loads the model at
}

export interface LabServiceOptions {
  store: Store;
  hub: Hub;
  inference: InferenceService;
  venvDir: string;
  modelsDir: string;
  dataDir: string; // data/lab
  users: () => ModelUser[];
  /** Tests: the sidecar command for a model (instead of the venv's python with lab_serve.py). */
  command?: (modelId: string) => SidecarOptions["command"];
}

/** The Lab's own routes on the sidecar, by the name the UI shows while one runs. */
export const LAB_OPS = ["probe", "find", "neuron", "generate", "sweep", "attribute", "examples", "explore"] as const;
export type LabOp = (typeof LAB_OPS)[number];

const OP_TIMEOUT_MS = 10 * 60_000;
/** Saved results kept per model; the oldest go first. */
const HISTORY_KEEP = 400;
const gb = (b: number) => `${(b / 1e9).toFixed(1)} GB`;

interface StrainRow {
  id: string;
  name: string;
  base_model_id: string;
  pushes_json: string;
  settings_json: string | null;
  notes: string;
  created_at: number;
  updated_at: number;
}

interface HistoryRow {
  id: string;
  kind: string;
  model_id: string;
  title: string;
  data_json: string;
  created_at: number;
}

interface ProbeSetRow {
  id: string;
  name: string;
  concept_json: string;
  control_json: string;
  test_prompt: string | null;
  created_at: number;
}

function strainOf(r: StrainRow): LabStrain {
  const pushes = JSON.parse(r.pushes_json) as LabMixItem[];
  const settings = r.settings_json ? JSON.parse(r.settings_json) : defaultSettings(pushes);
  return { id: r.id, name: r.name, baseModelId: r.base_model_id, pushes, recipe: formatRecipe(pushes), settings, notes: r.notes, createdAt: r.created_at, updatedAt: r.updated_at };
}

function probeSetOf(r: ProbeSetRow): LabProbeSet {
  return { id: r.id, name: r.name, concept: JSON.parse(r.concept_json), control: JSON.parse(r.control_json), builtin: false, ...(r.test_prompt ? { testPrompt: r.test_prompt } : {}), createdAt: r.created_at };
}

function texts(v: unknown, name: string): string[] {
  if (!Array.isArray(v)) throw new HttpError(400, `${name} must be a list of texts`);
  const out = v.map((t) => (typeof t === "string" ? t.trim() : "")).filter(Boolean);
  if (out.length < 2) throw new HttpError(400, `${name}: give at least 2 texts`);
  if (out.length > 100) throw new HttpError(400, `${name}: at most 100 texts`);
  if (out.some((t) => t.length > 2000)) throw new HttpError(400, `${name}: each text at most 2000 characters`);
  return out;
}

function name(v: unknown, what: string): string {
  const s = typeof v === "string" ? v.trim() : "";
  if (!s) throw new HttpError(400, `${what} needs a name`);
  if (s.length > 80) throw new HttpError(400, `${what} name: at most 80 characters`);
  return s;
}

function historyOf(r: HistoryRow): LabHistoryEntry {
  return { id: r.id, kind: r.kind as LabHistoryEntry["kind"], modelId: r.model_id, title: r.title, at: r.created_at, data: JSON.parse(r.data_json) };
}

/** A client-chosen id for an undone delete coming back, or a new one. */
function restoredId(v: unknown, prefix: string): string {
  return typeof v === "string" && /^[\w:-]{1,80}$/.test(v) ? v : newId(prefix);
}

const overText = (total: number, ceiling: number) => `The Lab and oMLX hold about ${gb(total)}, over the ${gb(ceiling)} memory ceiling. Unload the Lab's model or raise the ceiling.`;

export class LabService implements LabHooks {
  private opts: LabServiceOptions;
  private store: Store;
  private hub: Hub;
  private inference: InferenceService;
  private sidecar: LabSidecar | null = null;
  private status: LabStatus = "stopped";
  private detail: string | undefined;
  private facts: LabModelFacts | undefined;
  private busy: string | undefined;
  /** Loaded from the Lab view. A specimen loaded on demand for a strain is stopped again once nothing uses it. */
  private manual = false;
  private ready: Promise<void> | null = null;
  private ops = 0;
  /** Strain id -> updatedAt last pushed to the sidecar. */
  private pushed = new Map<string, number>();
  private mutex = new KeyedMutex();
  private poll: NodeJS.Timeout | null = null;
  private builtinSets: LabProbeSet[] | null = null;
  private guide: LabFieldGuide | null = null;
  private lensTables = new Map<string, [string, string[], number][]>();
  private lastKey = "";
  /** Set when a lowered ceiling left more held than it allows. */
  private overCeiling: string | undefined;
  /** Tests: the sidecar command for a model (instead of the venv's python with lab_serve.py). */
  command: LabServiceOptions["command"];

  constructor(opts: LabServiceOptions) {
    this.opts = opts;
    this.store = opts.store;
    this.hub = opts.hub;
    this.inference = opts.inference;
    this.command = opts.command;
  }

  // ---------- state ----------

  support(): LabSupport[] {
    return labSupport(this.inference.catalog);
  }

  private supportFor(modelId: string): LabSupport {
    const s = this.support().find((x) => x.modelId === modelId);
    if (!s) throw new HttpError(404, `model not found in models/: ${modelId}`);
    return s;
  }

  servingStrains(): string[] {
    return [...new Set(this.opts.users().filter((u) => isStrainId(u.modelId)).map((u) => u.modelId.slice(STRAIN_PREFIX.length)))];
  }

  state(): LabState {
    return {
      status: this.status,
      ...(this.detail ? { detail: this.detail } : {}),
      ...(this.sidecar?.pid ? { pid: this.sidecar.pid } : {}),
      ...(this.facts && this.status === "ready" ? { model: this.facts } : {}),
      ...(this.sidecar && this.status !== "ready" ? { loadingModelId: this.sidecar.modelId } : {}),
      ...(this.busy ? { busy: this.busy } : {}),
      ...(this.overCeiling && this.sidecar ? { overCeiling: this.overCeiling } : {}),
      support: this.support(),
      servingStrains: this.servingStrains(),
    };
  }

  private broadcast(): void {
    const s = this.state();
    const key = JSON.stringify(s);
    if (key === this.lastKey) return;
    this.lastKey = key;
    this.hub.broadcast({ type: "lab", lab: s });
  }

  private set(status: LabStatus, detail?: string): void {
    const loadedChanged = (status === "ready") !== (this.status === "ready");
    const heldChanged = this.status !== status && (status === "starting" || status === "stopped" || status === "error");
    this.status = status;
    this.detail = detail;
    this.broadcast();
    if (heldChanged) void this.inference.syncGuard();
    // strains on this base turn loaded or not
    if (loadedChanged) void this.inference.broadcastModels();
  }

  get pid(): number | undefined {
    return this.sidecar?.pid;
  }

  get modelId(): string | undefined {
    return this.sidecar?.modelId;
  }

  /** Memory the Lab holds now, as counted against the ceiling: its estimate for the loaded model. */
  heldBytes(): number {
    if (!this.sidecar) return 0;
    return this.support().find((s) => s.modelId === this.sidecar!.modelId)?.estimateBytes ?? 0;
  }

  // ---------- memory ----------

  private inUse(modelId: string): string | undefined {
    return this.opts.users().find((u) => u.modelId === modelId)?.what;
  }

  /** oMLX models with their size (estimated when oMLX doesn't report it), plus `pending`: models running sessions use
   *  that oMLX hasn't loaded yet (it loads on the first request, after ensureModel returned). */
  private async omlxModels(pending: boolean): Promise<{ modelId: string; bytes: number; busy?: string }[]> {
    const loaded = await this.inference.loadedModels();
    const ids = loaded.map((m) => m.modelId);
    if (pending) for (const u of this.opts.users()) if (u.kind === "session" && !isStrainId(u.modelId) && !ids.includes(u.modelId)) ids.push(u.modelId);
    return Promise.all(
      ids.map(async (id) => {
        const info = await this.inference.model(id);
        // Not loaded yet: the same estimate beforeOmlxLoad will use, at the largest window a session asks for.
        const window = Math.max(0, ...this.opts.users().filter((u) => u.modelId === id).map((u) => u.contextWindow ?? 0)) || info?.defaultContext || 0;
        const bytes = loaded.find((m) => m.modelId === id)?.bytes ?? (info ? estimateBytes(info, window, this.inference.catalog.overheadBytes(id)) : 0);
        const busy = this.inUse(id);
        return { modelId: id, bytes, ...(busy ? { busy } : {}) };
      }),
    );
  }

  async memory(modelId: string): Promise<LabMemoryCheck> {
    const need = this.supportFor(modelId).estimateBytes;
    const ceiling = this.inference.budget().budgetBytes;
    const omlx = await this.omlxModels(true);
    const omlxBytes = omlx.reduce((a, m) => a + m.bytes, 0);
    // Loading a different specimen replaces the current one, so what the Lab holds now doesn't count against it.
    const labBytes = this.sidecar && this.sidecar.modelId !== modelId ? this.heldBytes() : 0;
    return {
      modelId,
      ceilingBytes: ceiling,
      needBytes: need,
      labBytes,
      omlx,
      fits: need + omlxBytes <= ceiling,
      freeableBytes: omlx.filter((m) => !m.busy).reduce((a, m) => a + m.bytes, 0),
    };
  }

  private memoryMessage(m: LabMemoryCheck, label: string): string {
    const held = m.omlx.reduce((a, x) => a + x.bytes, 0);
    const busy = m.omlx.filter((x) => x.busy).map((x) => `${x.modelId} (${x.busy})`);
    return (
      `Not enough memory for ${label}: it needs about ${gb(m.needBytes)} and oMLX holds ${gb(held)} of the ${gb(m.ceilingBytes)} memory ceiling. ` +
      (m.freeableBytes > 0 ? `Free memory unloads oMLX models nothing is using (${gb(m.freeableBytes)}). ` : "") +
      (busy.length ? `In use: ${busy.join(", ")}. ` : "") +
      "You can also raise the ceiling in Settings."
    );
  }

  /** Unloads oMLX models no running session or eval uses, then checks again. */
  async freeMemory(modelId: string): Promise<LabMemoryCheck> {
    const before = await this.memory(modelId);
    for (const m of before.omlx) {
      if (m.busy) continue;
      await this.inference.unload(m.modelId).catch((err) => log.warn(`unloading ${m.modelId} failed`, err));
    }
    return this.memory(modelId);
  }

  async omlxInUseBytes(): Promise<number> {
    return (await this.omlxModels(false)).filter((m) => m.busy).reduce((a, m) => a + m.bytes, 0);
  }

  /** oMLX's models changed: the over-ceiling note follows, and goes once it's no longer so. */
  async recheckCeiling(): Promise<void> {
    if (!this.overCeiling) return;
    await this.mutex.run("lab", async () => {
      if (!this.overCeiling) return;
      const ceiling = this.inference.budget().budgetBytes;
      const total = this.heldBytes() + (await this.omlxModels(false)).reduce((a, m) => a + m.bytes, 0);
      this.overCeiling = total > ceiling ? overText(total, ceiling) : undefined;
      this.broadcast();
    });
  }

  /**
   * The ceiling changed. Same order as a load that doesn't fit: idle oMLX models, then a specimen loaded only for a strain.
   * A specimen loaded on purpose stays, and the Lab says it is over: unloading it is the user's call.
   */
  ceilingChanged(): Promise<void> {
    return this.mutex.run("lab", async () => {
      this.overCeiling = undefined;
      if (this.sidecar) {
        const ceiling = this.inference.budget().budgetBytes;
        const lab = this.heldBytes();
        const loaded = await this.omlxModels(false);
        let total = lab + loaded.reduce((a, m) => a + m.bytes, 0);
        for (const m of loaded) {
          if (total <= ceiling) break;
          if (m.busy) continue;
          await this.inference.unload(m.modelId).catch((err) => log.warn(`unloading ${m.modelId} failed`, err));
          total -= m.bytes;
        }
        if (total > ceiling && (await this.releaseIdle())) total -= lab;
        if (total > ceiling) this.overCeiling = overText(total, ceiling);
      }
      this.broadcast();
    });
  }

  /**
   * InferenceService calls this before oMLX may load `modelId`. oMLX keeps itself under the ceiling, but doesn't know
   * the Lab's share: make room by unloading idle oMLX models, or the on-demand specimen nothing uses, or refuse.
   */
  async beforeOmlxLoad(modelId: string, window: number): Promise<void> {
    // Under the Lab's lock, so it can't slip between a swap's stop and start, or a Lab load's check and start.
    return this.mutex.run("lab", async () => {
      if (!this.sidecar) return;
      const loaded = await this.omlxModels(false);
      if (loaded.some((m) => m.modelId === modelId)) return;
      const model = await this.inference.model(modelId);
      if (!model) return;
      const ceiling = this.inference.budget().budgetBytes;
      const lab = this.heldBytes();
      const need = estimateBytes(model, window, this.inference.catalog.overheadBytes(modelId));
      let total = lab + need + loaded.reduce((a, m) => a + m.bytes, 0);
      if (total <= ceiling) return;
      for (const m of loaded) {
        if (m.busy) continue;
        await this.inference.unload(m.modelId).catch((err) => log.warn(`unloading ${m.modelId} failed`, err));
        total -= m.bytes;
        if (total <= ceiling) return;
      }
      if (total - lab <= ceiling && (await this.releaseIdle())) return;
      throw new Error(`Not enough memory for ${model.name}: the Lab holds about ${gb(lab)} of the ${gb(ceiling)} memory ceiling. Unload the Lab's model (Lab, Unload) or raise the ceiling in Settings.`);
    });
  }

  // ---------- specimen lifecycle ----------

  /** Loads a model into the Lab (from the Lab view). Resolves once loading has started; progress comes as `lab` events. */
  load(modelId: string): Promise<LabState> {
    return this.mutex.run("lab", async () => {
      const support = this.supportFor(modelId);
      if (!support.supported) throw new HttpError(400, `${support.name} can't be opened in the Lab: ${support.reason}`);
      if (this.sidecar?.modelId === modelId && this.status !== "error") {
        this.manual = true;
        return this.state();
      }
      this.refuseSwap(`open ${support.name}`);
      const check = await this.memory(modelId);
      if (!check.fits) throw new HttpError(409, this.memoryMessage(check, support.name));
      await this.stopSidecar();
      this.manual = true;
      await this.start(modelId);
      return this.state();
    });
  }

  /** Unloads the specimen. Refused while a running session or eval uses one of its strains. */
  unload(): Promise<LabState> {
    return this.mutex.run("lab", async () => {
      this.refuseSwap("unload it");
      await this.stopSidecar();
      this.set("stopped");
      return this.state();
    });
  }

  private refuseSwap(action: string): void {
    if (!this.sidecar) return;
    const users = this.opts.users().filter((u) => isStrainId(u.modelId));
    if (users.length) throw new HttpError(409, `The Lab's model is serving strains for ${users.map((u) => u.what).join(", ")}. Stop them first to ${action}.`);
  }

  private async start(modelId: string): Promise<void> {
    const sidecar = new LabSidecar({ modelId, venvDir: this.opts.venvDir, modelsDir: this.opts.modelsDir, dataDir: this.opts.dataDir, command: this.command?.(modelId) });
    this.sidecar = sidecar;
    this.facts = undefined;
    this.pushed.clear();
    this.set("starting");
    sidecar.onExit = (detail) => {
      if (this.sidecar !== sidecar) return;
      this.sidecar = null;
      this.facts = undefined;
      this.busy = undefined;
      this.manual = false;
      this.pushed.clear();
      this.stopPoll();
      this.set(detail ? "error" : "stopped", detail);
    };
    const spawned = sidecar.spawn();
    // Set before spawning finishes, so requests during "starting" wait for this load, not the previous one.
    this.ready = spawned.then(() => this.watchLoad(sidecar));
    this.ready.catch(() => {});
    try {
      await spawned;
    } catch (err) {
      if (this.sidecar === sidecar) {
        this.sidecar = null;
        this.manual = false;
        this.set("error", errorMessage(err));
      }
      throw new HttpError(500, `The Lab could not start: ${errorMessage(err)}`);
    }
    this.set("loading", "starting");
  }

  private async watchLoad(sidecar: LabSidecar): Promise<void> {
    const name = this.supportFor(sidecar.modelId).name;
    for (;;) {
      if (this.sidecar !== sidecar) throw new Error(this.detail || "the Lab stopped while loading");
      let h: LabHealth | null = null;
      try {
        h = await sidecar.health();
      } catch {
        // busy loading weights or calibrating: the health thread still answers, but give it a moment
      }
      if (h?.status === "ready" && h.facts) {
        this.facts = { ...h.facts, name };
        this.set("ready");
        this.startPoll(sidecar);
        return;
      }
      if (h?.status === "error") {
        const detail = `${name} failed to load in the Lab: ${h.detail ?? "unknown error"}`;
        if (this.sidecar === sidecar) {
          await this.stopSidecar();
          this.set("error", detail);
        } else {
          await sidecar.stop(); // a newer load took over; leave its state alone
        }
        throw new Error(detail);
      }
      if (h) {
        const stage = h.progress > 0 && h.progress < 1 ? `${h.stage} ${Math.round(h.progress * 100)}%` : h.stage;
        if (stage !== this.detail) this.set("loading", stage);
      }
      await new Promise((r) => setTimeout(r, 400));
    }
  }

  /** While ready: picks up what the sidecar is doing for sessions (busy "session"). */
  private startPoll(sidecar: LabSidecar): void {
    this.stopPoll();
    this.poll = setInterval(() => {
      if (this.sidecar !== sidecar || this.ops > 0) return;
      sidecar
        .health()
        .then((h) => {
          const busy = h.busy ?? undefined;
          if (busy !== this.busy && this.ops === 0) {
            this.busy = busy;
            this.broadcast();
          }
        })
        .catch(() => {});
    }, 2000);
    this.poll.unref();
  }

  private stopPoll(): void {
    if (this.poll) clearInterval(this.poll);
    this.poll = null;
  }

  private async stopSidecar(): Promise<void> {
    this.overCeiling = undefined;
    const sidecar = this.sidecar;
    if (!sidecar) return;
    this.sidecar = null;
    this.facts = undefined;
    this.busy = undefined;
    this.manual = false;
    this.pushed.clear();
    this.stopPoll();
    this.set("stopping");
    await sidecar.stop();
  }

  private async whenReady(): Promise<LabSidecar> {
    if (this.status === "loading" || this.status === "starting") await this.ready?.catch(() => {});
    if (this.status !== "ready" || !this.sidecar) throw new HttpError(409, this.detail && this.status === "error" ? this.detail : "Load a model in the Lab first.");
    return this.sidecar;
  }

  // ---------- Lab operations ----------

  async op(op: LabOp, body: unknown): Promise<unknown> {
    const sidecar = await this.whenReady();
    this.ops++;
    this.busy = op;
    this.broadcast();
    try {
      return await sidecar.request("POST", `/${op}`, body ?? {}, OP_TIMEOUT_MS);
    } catch (err) {
      if (err instanceof SidecarError) throw new HttpError(err.status === 400 || err.status === 409 ? err.status : 502, err.message);
      throw err;
    } finally {
      this.ops--;
      if (this.ops === 0) this.busy = undefined;
      this.broadcast();
    }
  }

  /** What the tokenizer makes of some text. Doesn't wait for a running op, or count as one. */
  async tokens(body: unknown): Promise<LabTokensResult> {
    const sidecar = await this.whenReady();
    try {
      return await sidecar.request<LabTokensResult>("POST", "/tokens", body ?? {}, 10_000);
    } catch (err) {
      if (err instanceof SidecarError) throw new HttpError(err.status === 400 || err.status === 409 ? err.status : 502, err.message);
      throw err;
    }
  }

  /** Stops the op the sidecar is running at its next token. A chat a strain serves isn't an op and keeps going. */
  async cancel(): Promise<void> {
    if (this.status !== "ready" || !this.sidecar) return;
    await this.sidecar.request("POST", "/cancel", {}, 5_000).catch((err) => log.warn("cancel failed", err));
  }

  // ---------- history ----------

  history(modelId?: string, limit = 200): LabHistoryEntry[] {
    const n = Math.max(1, Math.min(Math.floor(limit) || 200, HISTORY_KEEP));
    const rows = modelId ? this.store.all<HistoryRow>("SELECT * FROM lab_history WHERE model_id = ? ORDER BY created_at DESC LIMIT ?", modelId, n) : this.store.all<HistoryRow>("SELECT * FROM lab_history ORDER BY created_at DESC LIMIT ?", n);
    return rows.map(historyOf);
  }

  /** Saves a result, or updates it (a sweep saves as its rows come in). data is the UI's, stored as is. */
  saveHistory(body: unknown): LabHistoryEntry {
    const b = (body ?? {}) as Partial<LabHistoryEntry>;
    if (!["compare", "sweep", "seeds", "trace", "find"].includes(String(b.kind))) throw new HttpError(400, "kind must be compare, sweep, seeds, trace or find");
    if (typeof b.modelId !== "string" || !b.modelId) throw new HttpError(400, "modelId is required");
    const json = JSON.stringify(b.data ?? {});
    if (json.length > 16 * 1024 * 1024) throw new HttpError(413, "result too large to keep");
    const id = restoredId(b.id, "run");
    const at = typeof b.at === "number" && Number.isFinite(b.at) ? b.at : Date.now();
    const title = typeof b.title === "string" ? b.title.slice(0, 200) : "";
    this.store.run("INSERT OR REPLACE INTO lab_history (id, kind, model_id, title, data_json, created_at) VALUES (?, ?, ?, ?, ?, ?)", id, String(b.kind), b.modelId, title, json, at);
    this.store.run("DELETE FROM lab_history WHERE model_id = ? AND id NOT IN (SELECT id FROM lab_history WHERE model_id = ? ORDER BY created_at DESC LIMIT ?)", b.modelId, b.modelId, HISTORY_KEEP);
    return historyOf(this.store.get<HistoryRow>("SELECT * FROM lab_history WHERE id = ?", id)!);
  }

  deleteHistory(id: string): void {
    this.store.run("DELETE FROM lab_history WHERE id = ?", id);
  }

  // ---------- strains as models ----------

  strainModels(base: ModelInfo[]): ModelInfo[] {
    const out: ModelInfo[] = [];
    for (const s of this.strains()) {
      const b = base.find((m) => m.id === s.baseModelId);
      if (!b) continue;
      const loaded = this.status === "ready" && this.sidecar?.modelId === s.baseModelId;
      out.push({
        ...b,
        id: `${STRAIN_PREFIX}${s.id}`,
        name: s.name,
        loaded,
        loadedContext: undefined,
        residentBytes: loaded ? this.heldBytes() : undefined,
        thinking: "none", // a recipe's numbers are with thinking off; with it on, 9 of 12 replies were still thinking at 400 tokens
        sampling: { temperature: s.settings.temperature, topP: s.settings.topP },
        ...(s.settings.maxTokens ? { defaultMaxOutput: s.settings.maxTokens } : {}),
        strain: { id: s.id, name: s.name, baseModelId: s.baseModelId, recipe: s.recipe, settings: s.settings },
      });
    }
    return out;
  }

  /** Makes the sidecar serve `strain:<id>`: loads the base model on demand (within the ceiling) and pushes the mix. */
  async ensureStrain(modelId: string): Promise<void> {
    const strain = this.strain(modelId.slice(STRAIN_PREFIX.length));
    if (!strain) throw new Error(`strain not found: ${modelId}`);
    await this.mutex.run("lab", async () => {
      if (this.sidecar?.modelId === strain.baseModelId && this.status !== "error") return;
      const support = this.supportFor(strain.baseModelId);
      if (!support.supported) throw new Error(`Strain "${strain.name}" runs on ${support.name}, which the Lab can't open: ${support.reason}`);
      if (this.sidecar) {
        const current = this.facts?.name ?? this.sidecar.modelId;
        // Only what runs right now holds the current model (eval cases are session rows too): an eval with strains on
        // two bases swaps between its cases.
        const users = this.opts.users().filter((u) => u.kind === "session" && isStrainId(u.modelId) && this.strain(u.modelId.slice(STRAIN_PREFIX.length))?.baseModelId === this.sidecar!.modelId);
        if (users.length) throw new Error(`The Lab holds one model at a time: ${current} is serving ${users.map((u) => u.what).join(", ")}, and strain "${strain.name}" runs on ${support.name}. Try again when that finishes.`);
        if (this.ops > 0) throw new Error(`The Lab is busy on ${current}; strain "${strain.name}" runs on ${support.name}. Try again when the Lab is idle.`);
        if (this.manual) throw new Error(`The Lab has ${current} open from the Lab view; strain "${strain.name}" runs on ${support.name}. Unload it in the Lab, then run this again.`);
        await this.stopSidecar();
      }
      let check = await this.memory(strain.baseModelId);
      if (!check.fits) check = await this.freeMemory(strain.baseModelId);
      if (!check.fits) throw new Error(this.memoryMessage(check, `strain "${strain.name}" (${support.name} in the Lab)`));
      await this.start(strain.baseModelId);
    });
    const sidecar = await this.whenReady().catch((err) => {
      throw new Error(errorMessage(err));
    });
    if (this.pushed.get(strain.id) === strain.updatedAt) return;
    await sidecar.request("PUT", `/strains/${encodeURIComponent(strain.id)}`, { pushes: strain.pushes, settings: strain.settings }, 30_000);
    this.pushed.set(strain.id, strain.updatedAt);
  }

  /** A caller (an eval moving on) is done with a strain: stop an on-demand specimen nothing else uses. */
  async releaseStrain(_modelId: string): Promise<void> {
    await this.releaseIfIdle();
  }

  private releaseIfIdle(): Promise<boolean> {
    return this.mutex.run("lab", () => this.releaseIdle());
  }

  /** releaseIfIdle for callers that already hold the "lab" lock. */
  private async releaseIdle(): Promise<boolean> {
    if (!this.sidecar || this.manual || this.ops > 0) return false;
    if (this.opts.users().some((u) => u.kind === "session" && isStrainId(u.modelId))) return false;
    await this.stopSidecar();
    this.set("stopped");
    return true;
  }

  /** Where requests for `model` go: the sidecar for strains, null for oMLX models. */
  upstreamFor(model: string | undefined): { baseUrl: string; apiKey: string } | null {
    if (!model || !isStrainId(model)) return null;
    return this.sidecar && this.status === "ready" ? { baseUrl: this.sidecar.baseUrl, apiKey: this.sidecar.key } : { baseUrl: "http://127.0.0.1:0", apiKey: "" };
  }

  // ---------- strains ----------

  strains(): LabStrain[] {
    return this.store.all<StrainRow>("SELECT * FROM lab_strains ORDER BY created_at").map(strainOf);
  }

  strain(id: string): LabStrain | null {
    const r = this.store.get<StrainRow>("SELECT * FROM lab_strains WHERE id = ?", id);
    return r ? strainOf(r) : null;
  }

  private checkAgainstModel(baseModelId: string, pushes: LabMixItem[]): void {
    if (!this.facts || this.facts.modelId !== baseModelId) return;
    for (const p of pushes) {
      if (isVector(p)) {
        if (p.layer >= this.facts.layers) throw new HttpError(400, `${p.name}: ${this.facts.name} has layers 0 to ${this.facts.layers - 1}`);
        if (vectorLength(p.u) !== this.facts.dModel) throw new HttpError(400, `${p.name} was made for another model: it has ${vectorLength(p.u)} numbers and ${this.facts.name} needs ${this.facts.dModel}`);
        continue;
      }
      if (p.layer >= this.facts.layers) throw new HttpError(400, `L${p.layer}N${p.neuron}: ${this.facts.name} has layers 0 to ${this.facts.layers - 1}`);
      const n = this.facts.neuronsPerLayer[p.layer];
      if (p.neuron >= n) throw new HttpError(400, `L${p.layer}N${p.neuron}: layer ${p.layer} has neurons 0 to ${n - 1}`);
    }
  }

  private strainsChanged(): void {
    this.hub.broadcast({ type: "lab_strains", strains: this.strains() });
    void this.inference.broadcastModels();
  }

  saveStrain(req: SaveStrainRequest): LabStrain {
    const b = (req ?? {}) as Partial<SaveStrainRequest>;
    const n = name(b.name, "A strain");
    if (typeof b.baseModelId !== "string") throw new HttpError(400, "baseModelId is required");
    const support = this.supportFor(b.baseModelId);
    if (!support.supported) throw new HttpError(400, `${support.name} can't be used in the Lab: ${support.reason}`);
    const pushes = checkPushes(b.pushes);
    if (!pushes.length) throw new HttpError(400, "A strain needs at least one neuron or vector");
    this.checkAgainstModel(b.baseModelId, pushes);
    const settings = checkSettings(b.settings, pushes);
    const notes = typeof b.notes === "string" ? b.notes.slice(0, 4000) : "";
    const id = restoredId(b.id, "strain");
    if (this.strain(id)) throw new HttpError(409, `strain ${id} already exists`);
    const now = Date.now();
    this.store.run("INSERT INTO lab_strains (id, name, base_model_id, pushes_json, settings_json, notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", id, n, b.baseModelId, JSON.stringify(pushes), JSON.stringify(settings), notes, typeof b.createdAt === "number" ? b.createdAt : now, now);
    this.strainsChanged();
    return this.strain(id)!;
  }

  async updateStrain(id: string, patch: Partial<SaveStrainRequest>): Promise<LabStrain> {
    const cur = this.strain(id);
    if (!cur) throw new HttpError(404, `strain not found: ${id}`);
    const p = patch ?? {};
    if (p.baseModelId !== undefined && p.baseModelId !== cur.baseModelId) throw new HttpError(400, "A strain's base model can't change; save a new strain instead");
    const n = p.name !== undefined ? name(p.name, "A strain") : cur.name;
    const pushes = p.pushes !== undefined ? checkPushes(p.pushes) : cur.pushes;
    if (!pushes.length) throw new HttpError(400, "A strain needs at least one neuron or vector");
    this.checkAgainstModel(cur.baseModelId, pushes);
    // New pushes without settings: what the new mix was measured with, unless the settings had been chosen for it.
    const settings = p.settings !== undefined ? checkSettings(p.settings, pushes) : pushes.some(isVector) !== cur.pushes.some(isVector) ? defaultSettings(pushes) : cur.settings;
    const notes = p.notes !== undefined ? String(p.notes).slice(0, 4000) : cur.notes;
    const now = Math.max(Date.now(), cur.updatedAt + 1);
    this.store.run("UPDATE lab_strains SET name = ?, pushes_json = ?, settings_json = ?, notes = ?, updated_at = ? WHERE id = ?", n, JSON.stringify(pushes), JSON.stringify(settings), notes, now, id);
    // Sessions using it pick up the new mix on their next model call.
    if (this.pushed.has(id) && this.sidecar && this.status === "ready") {
      await this.sidecar.request("PUT", `/strains/${encodeURIComponent(id)}`, { pushes, settings }, 30_000).then(
        () => this.pushed.set(id, now),
        () => this.pushed.delete(id),
      );
    }
    this.strainsChanged();
    return this.strain(id)!;
  }

  async deleteStrain(id: string): Promise<void> {
    const cur = this.strain(id);
    if (!cur) throw new HttpError(404, `strain not found: ${id}`);
    const users = this.opts.users().filter((u) => u.modelId === `${STRAIN_PREFIX}${id}`);
    if (users.length) throw new HttpError(409, `Strain "${cur.name}" is in use by ${users.map((u) => u.what).join(", ")}`);
    this.store.run("DELETE FROM lab_strains WHERE id = ?", id);
    if (this.pushed.delete(id) && this.sidecar) await this.sidecar.request("DELETE", `/strains/${encodeURIComponent(id)}`, undefined, 10_000).catch(() => {});
    this.strainsChanged();
  }

  // ---------- field guide and word lens ----------

  /** The catalog of tested recipes (scripts/field_guide.json, from scripts/gen-field-guide.ts). */
  fieldGuide(): LabFieldGuide {
    if (!this.guide) {
      try {
        this.guide = JSON.parse(readFileSync(join(BACKEND_DIR, "scripts", "field_guide.json"), "utf8")) as LabFieldGuide;
      } catch (err) {
        log.warn("field guide unreadable", err);
        throw new HttpError(500, "This build has no Field Guide");
      }
    }
    return this.guide;
  }

  /** Word families a single neuron writes on this model. An empty list: nothing known, or no table for this model. */
  lens(modelId: string, query: string): LabLensHit[] {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    let table = this.lensTables.get(modelId);
    if (!table) {
      table = [];
      // modelId comes from a request: it names a table only if the catalog knows it, so it can't walk out of the folder.
      if (this.supportFor(modelId)) {
        try {
          table = JSON.parse(readFileSync(join(BACKEND_DIR, "scripts", "lens", `${modelId}.json`), "utf8")) as [string, string[], number][];
        } catch {
          // no table for this model
        }
      }
      this.lensTables.set(modelId, table);
    }
    const stem = q.slice(0, Math.max(4, q.length - 1));
    const hits: { hit: LabLensHit; matching: number }[] = [];
    for (const [ref, tokens, gain] of table) {
      const m = /^L(\d+)N(\d+)([+-])$/.exec(ref);
      if (!m) continue;
      const matching = tokens.filter((t) => t.toLowerCase().startsWith(stem)).length;
      if (matching) hits.push({ hit: { layer: Number(m[1]), neuron: Number(m[2]), sign: m[3] === "-" ? -1 : 1, tokens, gain }, matching });
    }
    // gen_word.py's order: most matching tokens, then the biggest gain
    return hits
      .sort((a, b) => b.matching - a.matching || b.hit.gain - a.hit.gain)
      .slice(0, 8)
      .map((x) => x.hit);
  }

  // ---------- probe sets ----------

  private builtins(): LabProbeSet[] {
    if (!this.builtinSets) {
      try {
        const raw = JSON.parse(readFileSync(join(BACKEND_DIR, "scripts", "lab_sets.json"), "utf8")) as Omit<LabProbeSet, "builtin">[];
        this.builtinSets = raw.map((s) => ({ ...s, builtin: true }));
      } catch (err) {
        log.warn("starter probe sets unreadable", err);
        this.builtinSets = [];
      }
    }
    return this.builtinSets;
  }

  probeSets(): LabProbeSet[] {
    return [...this.builtins(), ...this.store.all<ProbeSetRow>("SELECT * FROM lab_probe_sets ORDER BY created_at").map(probeSetOf)];
  }

  private probeSet(id: string): LabProbeSet {
    if (this.builtins().some((s) => s.id === id)) throw new HttpError(400, "Starter sets can't be changed; save a copy instead");
    const r = this.store.get<ProbeSetRow>("SELECT * FROM lab_probe_sets WHERE id = ?", id);
    if (!r) throw new HttpError(404, `probe set not found: ${id}`);
    return probeSetOf(r);
  }

  saveProbeSet(req: SaveProbeSetRequest): LabProbeSet {
    const b = (req ?? {}) as Partial<SaveProbeSetRequest>;
    const id = restoredId(b.id, "set");
    if (this.store.get("SELECT id FROM lab_probe_sets WHERE id = ?", id)) throw new HttpError(409, `probe set ${id} already exists`);
    const testPrompt = typeof b.testPrompt === "string" && b.testPrompt.trim() ? b.testPrompt.trim().slice(0, 2000) : null;
    this.store.run("INSERT INTO lab_probe_sets (id, name, concept_json, control_json, test_prompt, created_at) VALUES (?, ?, ?, ?, ?, ?)", id, name(b.name, "A probe set"), JSON.stringify(texts(b.concept, "concept")), JSON.stringify(texts(b.control, "control")), testPrompt, Date.now());
    return this.probeSet(id);
  }

  updateProbeSet(id: string, patch: Partial<SaveProbeSetRequest>): LabProbeSet {
    const cur = this.probeSet(id);
    const p = patch ?? {};
    const testPrompt = p.testPrompt !== undefined ? (typeof p.testPrompt === "string" && p.testPrompt.trim() ? p.testPrompt.trim().slice(0, 2000) : null) : (cur.testPrompt ?? null);
    this.store.run(
      "UPDATE lab_probe_sets SET name = ?, concept_json = ?, control_json = ?, test_prompt = ? WHERE id = ?",
      p.name !== undefined ? name(p.name, "A probe set") : cur.name,
      JSON.stringify(p.concept !== undefined ? texts(p.concept, "concept") : cur.concept),
      JSON.stringify(p.control !== undefined ? texts(p.control, "control") : cur.control),
      testPrompt,
      id,
    );
    return this.probeSet(id);
  }

  deleteProbeSet(id: string): void {
    this.probeSet(id);
    this.store.run("DELETE FROM lab_probe_sets WHERE id = ?", id);
  }

  // ---------- shutdown ----------

  async stop(): Promise<void> {
    await this.stopSidecar();
    this.status = "stopped";
  }
}
