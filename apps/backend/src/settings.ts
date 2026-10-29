// App settings (settings table) and the read-only facts the Settings page shows next to them.

import { execFile } from "node:child_process";
import { existsSync, statfsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AppSettings, EnvType, HarnessProfile, NetworkMode, PathKey, SettingsInfo, UpdateSettingsRequest } from "@terrarium/shared";
import type { Config } from "./config.ts";
import { MAX_RUNNING_VMS } from "./envs/manager.ts";
import { stripSimNote } from "./harness/profiles.ts";
import type { Hub } from "./hub.ts";
import type { InferenceService } from "./inference/service.ts";
import type { Store } from "./store/db.ts";
import { HttpError } from "./util/errors.ts";

const NEW_SESSION: AppSettings["newSession"] = { modelId: null, contextWindow: null, thinking: "model", harness: "terrarium" };
const NEW_ENV: AppSettings["newEnv"] = { type: "vm", network: "off" };
const NETWORKS: NetworkMode[] = ["off", "registries", "web"];
const PROMPT_MAX = 32_000;

/** data/ subdirs shown in the disk breakdown, in display order. */
const DATA_PARTS: { key: string; label: string; path: string }[] = [
  { key: "envs", label: "Environment disks", path: "envs" },
  { key: "snapshots", label: "Snapshots", path: "snapshots" },
  { key: "blobs", label: "Trace blobs", path: "blobs" },
  { key: "images", label: "VM images", path: "images" },
  { key: "omlx", label: "oMLX cache and logs", path: "omlx" },
  { key: "datasets", label: "Eval datasets", path: "datasets" },
  { key: "gondolin", label: "VM package cache", path: "gondolin" },
];

function duKiB(paths: string[]): Promise<Map<string, number>> {
  return new Promise((resolve) => {
    const present = paths.filter((p) => existsSync(p));
    if (!present.length) return resolve(new Map());
    execFile("/usr/bin/du", ["-sk", ...present], { timeout: 30_000, maxBuffer: 1 << 20 }, (_err, stdout) => {
      const out = new Map<string, number>();
      for (const line of String(stdout ?? "").split("\n")) {
        const m = /^(\d+)\s+(.+)$/.exec(line);
        if (m) out.set(m[2]!, Number(m[1]) * 1024);
      }
      resolve(out);
    });
  });
}

export class Settings {
  private store: Store;
  private hub: Hub;
  private inference: InferenceService;
  private config: Config;

  constructor(opts: { store: Store; hub: Hub; inference: InferenceService; config: Config }) {
    this.store = opts.store;
    this.hub = opts.hub;
    this.inference = opts.inference;
    this.config = opts.config;
  }

  get(): AppSettings {
    return {
      memoryBudgetBytes: this.inference.budget().budgetBytes,
      newSession: { ...NEW_SESSION, ...this.store.getSetting<Partial<AppSettings["newSession"]>>("newSession", {}) },
      newEnv: { ...NEW_ENV, ...this.store.getSetting<Partial<AppSettings["newEnv"]>>("newEnv", {}) },
      prompts: this.store.getSetting<AppSettings["prompts"]>("prompts", {}),
    };
  }

  prompts(): AppSettings["prompts"] {
    return this.store.getSetting<AppSettings["prompts"]>("prompts", {});
  }

  update(patch: UpdateSettingsRequest): AppSettings {
    if (patch.memoryBudgetBytes !== undefined) {
      if (typeof patch.memoryBudgetBytes !== "number" || !Number.isFinite(patch.memoryBudgetBytes)) throw new HttpError(400, "memoryBudgetBytes must be a number");
      this.inference.setBudget(patch.memoryBudgetBytes);
    }
    if (patch.newSession) {
      const cur = this.get().newSession;
      const p = patch.newSession;
      const next = { ...cur };
      if (p.modelId !== undefined) {
        if (p.modelId !== null && typeof p.modelId !== "string") throw new HttpError(400, "newSession.modelId must be a model id or null");
        next.modelId = p.modelId;
      }
      if (p.contextWindow !== undefined) {
        if (p.contextWindow !== null && (!Number.isInteger(p.contextWindow) || p.contextWindow < 2048)) throw new HttpError(400, "newSession.contextWindow must be at least 2048 or null");
        next.contextWindow = p.contextWindow;
      }
      if (p.thinking !== undefined) {
        if (!["model", "on", "off"].includes(p.thinking)) throw new HttpError(400, "newSession.thinking must be model, on or off");
        next.thinking = p.thinking;
      }
      if (p.harness !== undefined) {
        if (p.harness !== "terrarium" && p.harness !== "pi-stock") throw new HttpError(400, "newSession.harness must be terrarium or pi-stock");
        next.harness = p.harness;
      }
      this.store.setSetting("newSession", next);
    }
    if (patch.newEnv) {
      const next = { ...this.get().newEnv };
      if (patch.newEnv.type !== undefined) {
        if (patch.newEnv.type !== "vm" && patch.newEnv.type !== "sim") throw new HttpError(400, "newEnv.type must be vm or sim");
        next.type = patch.newEnv.type as EnvType;
      }
      if (patch.newEnv.network !== undefined) {
        if (!NETWORKS.includes(patch.newEnv.network)) throw new HttpError(400, `newEnv.network must be one of ${NETWORKS.join(", ")}`);
        next.network = patch.newEnv.network;
      }
      this.store.setSetting("newEnv", next);
    }
    if (patch.prompts) {
      const next = { ...this.prompts() };
      for (const [k, v] of Object.entries(patch.prompts)) {
        const id = k as HarnessProfile;
        if (!["terrarium", "pi-stock", "chat"].includes(id)) throw new HttpError(400, `unknown harness ${k}`);
        if (v === null) delete next[id];
        else if (typeof v !== "string" || !v.trim()) throw new HttpError(400, "a saved prompt must be non-empty text");
        else if (v.length > PROMPT_MAX) throw new HttpError(400, `a prompt may be at most ${PROMPT_MAX} characters`);
        else next[id] = stripSimNote(id, v);
      }
      this.store.setSetting("prompts", next);
    }
    const s = this.get();
    this.hub.broadcast({ type: "settings", settings: s });
    return s;
  }

  paths(): Record<PathKey, string> {
    return {
      data: this.config.dataDir,
      models: this.config.modelsDir,
      venv: this.config.venvDir,
      logs: join(homedir(), "Library/Logs/Terrarium/backend.log"),
      omlxLog: join(this.config.dataDir, "omlx", "server.log"),
    };
  }

  async info(): Promise<SettingsInfo> {
    const data = this.config.dataDir;
    const parts = DATA_PARTS.map((p) => ({ ...p, abs: join(data, p.path) }));
    const db = ["terrarium.db", "terrarium.db-wal"].map((f) => join(data, f));
    const sizes = await duKiB([...parts.map((p) => p.abs), ...db, this.config.modelsDir]);
    const disk = parts.map((p) => ({ key: p.key, label: p.label, bytes: sizes.get(p.abs) ?? 0 }));
    disk.push({ key: "db", label: "Database", bytes: db.reduce((a, p) => a + (sizes.get(p) ?? 0), 0) });
    disk.push({ key: "models", label: "Models", bytes: sizes.get(this.config.modelsDir) ?? 0 });
    let freeDiskBytes = 0;
    try {
      const st = statfsSync(data);
      freeDiskBytes = st.bavail * st.bsize;
    } catch {}
    return {
      settings: this.get(),
      paths: this.paths(),
      disk,
      freeDiskBytes,
      maxRunningVms: MAX_RUNNING_VMS,
      omlx: { ...this.inference.inferenceState(), appliedCeilingBytes: this.inference.inferenceState().memoryCeilingBytes },
    };
  }

  /** Shows a known path in Finder. Only the paths above, never one from the request. */
  reveal(key: PathKey): void {
    const path = this.paths()[key];
    if (!path) throw new HttpError(400, `unknown path ${key}`);
    if (!existsSync(path)) throw new HttpError(404, `${path} does not exist`);
    execFile("/usr/bin/open", ["-R", path], () => {});
  }
}
