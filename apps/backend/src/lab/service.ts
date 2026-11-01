// Neuron Lab: one specimen (model) at a time in a sidecar process, kept under the memory ceiling next to oMLX, plus
// the saved probe sets and strains. A strain is a base model with neuron pushes; sessions and evals use it as the
// model `strain:<id>`, which the sidecar serves through an OpenAI-compatible endpoint.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { LabMemoryCheck, LabModelFacts, LabProbeSet, LabPush, LabState, LabStatus, LabStrain, LabSupport, ModelInfo, SaveProbeSetRequest, SaveStrainRequest } from "@terrarium/shared";
import { BACKEND_DIR } from "../config.ts";
import type { Hub } from "../hub.ts";
import { estimateBytes } from "../inference/catalog.ts";
import type { InferenceService, LabHooks } from "../inference/service.ts";
import type { Store } from "../store/db.ts";
import { HttpError, errorMessage } from "../util/errors.ts";
import { newId } from "../util/ids.ts";
import { logger } from "../util/log.ts";
import { KeyedMutex } from "../util/mutex.ts";
import { checkPushes, formatRecipe } from "./recipe.ts";
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
export const LAB_OPS = ["probe", "find", "neuron", "generate", "sweep", "attribute"] as const;
export type LabOp = (typeof LAB_OPS)[number];

const OP_TIMEOUT_MS = 10 * 60_000;
const gb = (b: number) => `${(b / 1e9).toFixed(1)} GB`;

interface StrainRow {
  id: string;
  name: string;
  base_model_id: string;
  pushes_json: string;
  notes: string;
  created_at: number;
  updated_at: number;
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
  const pushes = JSON.parse(r.pushes_json) as LabPush[];
  return { id: r.id, name: r.name, baseModelId: r.base_model_id, pushes, recipe: formatRecipe(pushes), notes: r.notes, createdAt: r.created_at, updatedAt: r.updated_at };
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
  private lastKey = "";
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
    this.status = status;
    this.detail = detail;
    this.broadcast();
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

  async memory(modelId: string): Promise<LabMemoryCheck> {
    const need = this.supportFor(modelId).estimateBytes;
    const ceiling = this.inference.budget().budgetBytes;
    const loaded = await this.inference.loadedModels();
    const omlx = await Promise.all(
      loaded.map(async (m) => {
        const info = await this.inference.model(m.modelId);
        const bytes = m.bytes ?? (info ? estimateBytes(info, info.defaultContext) : 0);
        const busy = this.inUse(m.modelId);
        return { modelId: m.modelId, bytes, ...(busy ? { busy } : {}) };
      }),
    );
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

  /**
   * InferenceService calls this before oMLX may load `modelId`. oMLX keeps itself under the ceiling, but doesn't know
   * the Lab's share: make room by unloading idle oMLX models, or the on-demand specimen nothing uses, or refuse.
   */
  async beforeOmlxLoad(modelId: string, window: number): Promise<void> {
    if (!this.sidecar) return;
    const loaded = await this.inference.loadedModels();
    if (loaded.some((m) => m.modelId === modelId)) return;
    const model = await this.inference.model(modelId);
    if (!model) return;
    const ceiling = this.inference.budget().budgetBytes;
    const lab = this.heldBytes();
    const need = estimateBytes(model, window, this.inference.catalog.overheadBytes(modelId));
    let total = lab + need + loaded.reduce((a, m) => a + (m.bytes ?? 0), 0);
    if (total <= ceiling) return;
    for (const m of loaded) {
      if (this.inUse(m.modelId)) continue;
      await this.inference.unload(m.modelId).catch((err) => log.warn(`unloading ${m.modelId} failed`, err));
      total -= m.bytes ?? 0;
      if (total <= ceiling) return;
    }
    if (total - lab <= ceiling && (await this.releaseIfIdle())) return;
    throw new Error(`Not enough memory for ${model.name}: the Lab holds about ${gb(lab)} of the ${gb(ceiling)} memory ceiling. Unload the Lab's model (Lab, Unload) or raise the ceiling in Settings.`);
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
      this.pushed.clear();
      this.stopPoll();
      this.set(detail ? "error" : "stopped", detail);
    };
    try {
      await sidecar.spawn();
    } catch (err) {
      if (this.sidecar === sidecar) {
        this.sidecar = null;
        this.set("error", errorMessage(err));
      }
      throw new HttpError(500, `The Lab could not start: ${errorMessage(err)}`);
    }
    this.set("loading", "starting");
    this.ready = this.watchLoad(sidecar);
    this.ready.catch(() => {});
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
        await this.stopSidecar();
        this.set("error", detail);
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
    if (this.status === "loading" || this.status === "starting") await this.ready;
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
        strain: { id: s.id, name: s.name, baseModelId: s.baseModelId, recipe: s.recipe },
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
        const users = this.opts.users().filter((u) => isStrainId(u.modelId) && this.strain(u.modelId.slice(STRAIN_PREFIX.length))?.baseModelId === this.sidecar!.modelId);
        if (this.manual || users.length || this.ops > 0) throw new Error(`The Lab has ${current} open; strain "${strain.name}" runs on ${support.name}. Unload it in the Lab first.`);
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
    await sidecar.request("PUT", `/strains/${encodeURIComponent(strain.id)}`, { pushes: strain.pushes }, 30_000);
    this.pushed.set(strain.id, strain.updatedAt);
  }

  /** A caller (an eval moving on) is done with a strain: stop an on-demand specimen nothing else uses. */
  async releaseStrain(_modelId: string): Promise<void> {
    await this.releaseIfIdle();
  }

  private releaseIfIdle(): Promise<boolean> {
    return this.mutex.run("lab", async () => {
      if (!this.sidecar || this.manual || this.ops > 0) return false;
      if (this.opts.users().some((u) => u.kind === "session" && isStrainId(u.modelId))) return false;
      await this.stopSidecar();
      this.set("stopped");
      return true;
    });
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

  private checkAgainstModel(baseModelId: string, pushes: LabPush[]): void {
    if (!this.facts || this.facts.modelId !== baseModelId) return;
    for (const p of pushes) {
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
    if (!pushes.length) throw new HttpError(400, "A strain needs at least one neuron");
    this.checkAgainstModel(b.baseModelId, pushes);
    const notes = typeof b.notes === "string" ? b.notes.slice(0, 4000) : "";
    const id = newId("strain");
    const now = Date.now();
    this.store.run("INSERT INTO lab_strains (id, name, base_model_id, pushes_json, notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)", id, n, b.baseModelId, JSON.stringify(pushes), notes, now, now);
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
    if (!pushes.length) throw new HttpError(400, "A strain needs at least one neuron");
    this.checkAgainstModel(cur.baseModelId, pushes);
    const notes = p.notes !== undefined ? String(p.notes).slice(0, 4000) : cur.notes;
    const now = Math.max(Date.now(), cur.updatedAt + 1);
    this.store.run("UPDATE lab_strains SET name = ?, pushes_json = ?, notes = ?, updated_at = ? WHERE id = ?", n, JSON.stringify(pushes), notes, now, id);
    // Sessions using it pick up the new mix on their next model call.
    if (this.pushed.has(id) && this.sidecar && this.status === "ready") {
      await this.sidecar.request("PUT", `/strains/${encodeURIComponent(id)}`, { pushes }, 30_000).then(
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
    const id = newId("set");
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
