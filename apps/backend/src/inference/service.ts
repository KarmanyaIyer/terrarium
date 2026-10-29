// Inference facade: model list (catalog + oMLX status + user overrides), load/unload, per-model oMLX settings.

import { totalmem } from "node:os";
import type { InferenceState, MemoryBudget, ModelInfo } from "@terrarium/shared";
import type { Hub } from "../hub.ts";
import type { Store } from "../store/db.ts";
import { KeyedMutex } from "../util/mutex.ts";
import { logger } from "../util/log.ts";
import { processStats } from "../util/sysmem.ts";
import { ModelCatalog, type ModelOverrides } from "./catalog.ts";
import { type OmlxModelSettings, type OmlxStatus, OmlxManager } from "./omlx.ts";

const log = logger("inference");
const DEFAULT_BUDGET = 12e9;

export class InferenceService {
  readonly catalog: ModelCatalog;
  readonly omlx: OmlxManager;
  private store: Store;
  private hub: Hub;
  private mutex = new KeyedMutex();
  private statusCache: { at: number; value: OmlxStatus } | null = null;
  /** max_context_window last pushed to oMLX per model. */
  private pushedWindow = new Map<string, { window: number; maxOutput: number }>();
  /** Loaded model ids as of the last status poll; a change broadcasts the model list. */
  private loadedKey = "";
  /** A model dir was added or removed since oMLX last scanned its model dir. */
  private rescanPending = false;

  constructor(opts: { store: Store; hub: Hub; modelsDir: string; venvDir: string; omlxDataDir: string }) {
    this.store = opts.store;
    this.hub = opts.hub;
    this.catalog = new ModelCatalog(opts.modelsDir);
    this.omlx = new OmlxManager({
      venvDir: opts.venvDir,
      modelsDir: opts.modelsDir,
      dataDir: opts.omlxDataDir,
      budgetBytes: () => this.budget().budgetBytes,
      onState: (state) => {
        this.statusCache = null;
        if (state.status !== "ready") this.pushedWindow.clear();
        this.hub.broadcast({ type: "inference", inference: state });
        if (state.status === "ready" || state.status === "stopped" || state.status === "error") void this.broadcastModels();
      },
    });
  }

  budget(): MemoryBudget {
    return { totalBytes: totalmem(), budgetBytes: this.store.getSetting<number>("budgetBytes", DEFAULT_BUDGET) };
  }

  setBudget(bytes: number): MemoryBudget {
    this.store.setSetting("budgetBytes", Math.max(2e9, Math.min(bytes, totalmem())));
    return this.budget();
  }

  inferenceState(): InferenceState {
    return this.omlx.state;
  }

  overrides(id: string): ModelOverrides {
    return this.store.getSetting<ModelOverrides>(`model:${id}`, {});
  }

  private async omlxStatus(): Promise<OmlxStatus | null> {
    if (!this.omlx.isReady()) return null;
    if (this.statusCache && Date.now() - this.statusCache.at < 1000) return this.statusCache.value;
    try {
      const value = await this.omlx.status();
      this.statusCache = { at: Date.now(), value };
      return value;
    } catch (err) {
      log.warn("status failed", err);
      return null;
    }
  }

  async models(): Promise<ModelInfo[]> {
    const status = await this.omlxStatus();
    const byId = new Map((status?.models ?? []).map((m) => [m.id, m]));
    const out: ModelInfo[] = [];
    for (const id of this.catalog.ids()) {
      const s = byId.get(id);
      const info = this.catalog.info(id, this.overrides(id), s ? { loaded: s.loaded, loadedContext: s.max_context_window ?? undefined, residentBytes: s.actual_size ?? undefined } : undefined);
      if (info) out.push(info);
    }
    return out;
  }

  async model(id: string): Promise<ModelInfo | null> {
    return (await this.models()).find((m) => m.id === id) ?? null;
  }

  async broadcastModels(): Promise<void> {
    this.hub.broadcast({ type: "models", models: await this.models() });
  }

  async start(): Promise<void> {
    await this.omlx.ensureStarted();
  }

  async stop(): Promise<void> {
    await this.omlx.stop();
  }

  settingsFor(model: ModelInfo, window: number, maxOutput = 0): OmlxModelSettings {
    return {
      // Text-only loading is verified for Qwen3.5 (oMLX reports 2.3 GB vs 3.0 GB). Gemma 4 "unified" and the
      // Prism Bonsai packs only load correctly through oMLX's VLM path, so they keep auto-detection.
      ...(model.family === "qwen3.5" ? { model_type_override: "llm" as const } : {}),
      max_context_window: window,
      // Server-side cap; each request still sends its own max_tokens (our budget), which must not exceed this.
      max_tokens: Math.max(model.defaultMaxOutput, maxOutput, 8192),
      temperature: model.sampling.temperature,
      top_p: model.sampling.topP,
      top_k: model.sampling.topK,
      presence_penalty: model.sampling.presencePenalty,
    };
  }

  /** Starts oMLX if needed and makes sure the model accepts `window` tokens. oMLX loads on first request. */
  async ensureModel(id: string, window: number, maxOutput = 0): Promise<void> {
    await this.mutex.run(`model:${id}`, async () => {
      await this.omlx.ensureStarted();
      if (this.rescanPending) await this.reloadIfIdle(!(await this.omlxStatus())?.models.some((m) => m.id === id));
      const pushed = this.pushedWindow.get(id);
      if (pushed && pushed.window >= window && pushed.maxOutput >= maxOutput) return;
      const model = await this.model(id);
      if (!model) throw new Error(`model not found: ${id}`);
      const target = { window: Math.max(window, pushed?.window ?? 0, model.defaultContext), maxOutput: Math.max(maxOutput, pushed?.maxOutput ?? 0) };
      await this.omlx.applySettings(id, this.settingsFor(model, target.window, target.maxOutput));
      this.pushedWindow.set(id, target);
    });
  }

  async load(id: string, context?: number): Promise<void> {
    const model = await this.model(id);
    if (!model) throw new Error(`model not found: ${id}`);
    await this.ensureModel(id, context ?? model.defaultContext);
    await this.mutex.run(`load:${id}`, () => this.omlx.load(id));
    this.statusCache = null;
    await this.broadcastModels();
  }

  async unload(id: string): Promise<void> {
    if (!this.omlx.isReady()) return;
    await this.omlx.unload(id);
    this.statusCache = null;
    await this.reloadIfIdle();
    await this.broadcastModels();
  }

  async updateModel(id: string, patch: ModelOverrides): Promise<ModelInfo> {
    const current = this.overrides(id);
    const next: ModelOverrides = {
      defaultContext: patch.defaultContext ?? current.defaultContext,
      defaultMaxOutput: patch.defaultMaxOutput ?? current.defaultMaxOutput,
      sampling: { ...current.sampling, ...patch.sampling },
    };
    this.store.setSetting(`model:${id}`, next);
    this.pushedWindow.delete(id);
    const model = await this.model(id);
    if (!model) throw new Error(`model not found: ${id}`);
    if (this.omlx.isReady()) {
      await this.omlx.applySettings(id, this.settingsFor(model, model.defaultContext)).catch((err) => log.warn("apply settings failed", err));
      this.pushedWindow.set(id, { window: model.defaultContext, maxOutput: 0 });
    }
    await this.broadcastModels();
    return model;
  }

  /** Model dirs were added or removed: oMLX re-scans its model dir and the UI gets the new list. */
  async rescan(): Promise<void> {
    this.rescanPending = true;
    this.statusCache = null;
    await this.reloadIfIdle();
    await this.broadcastModels();
  }

  /**
   * oMLX's reload unloads every loaded model and aborts their running requests, so a pending re-scan waits until
   * nothing is loaded. `force`: a model oMLX doesn't know yet is about to load.
   */
  private async reloadIfIdle(force = false): Promise<void> {
    if (!this.rescanPending || !this.omlx.isReady()) return;
    if (!force && (await this.loadedModels()).length) return;
    this.rescanPending = false;
    await this.omlx.request("POST", "/admin/api/reload").catch((err) => log.warn("oMLX reload failed", err));
    this.statusCache = null;
    this.pushedWindow.clear();
  }

  async rss(): Promise<number | undefined> {
    const pid = this.omlx.pid;
    if (!pid) return undefined;
    return (await processStats([pid])).get(pid)?.rssBytes;
  }

  async loadedModels(): Promise<{ modelId: string; bytes?: number }[]> {
    const status = await this.omlxStatus();
    const loaded = (status?.models ?? []).filter((m) => m.loaded).map((m) => ({ modelId: m.id, bytes: m.actual_size ?? m.estimated_size ?? undefined }));
    // oMLX loads on first request and evicts on its own, so explicit load/unload are not the only changes.
    const key = loaded.map((m) => m.modelId).sort().join(",");
    if (status && key !== this.loadedKey) {
      this.loadedKey = key;
      void this.broadcastModels();
    }
    return loaded;
  }
}
