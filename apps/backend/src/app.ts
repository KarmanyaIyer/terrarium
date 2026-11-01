// Wires the backend services together. Used by main.ts and by tests (with a temp data dir).

import { join } from "node:path";
import type { AppState } from "@terrarium/shared";
import { type Config, VERSIONS } from "./config.ts";
import { loadDrivers } from "./envs/drivers.ts";
import { EnvManager } from "./envs/manager.ts";
import { policy } from "./envs/policy.ts";
import { EvalRunner } from "./evals/runner.ts";
import { FileViews } from "./files.ts";
import { SessionManager } from "./harness/sessions.ts";
import { Hub } from "./hub.ts";
import { Gateway } from "./inference/gateway.ts";
import { ModelDownloads } from "./inference/downloads.ts";
import { InferenceService } from "./inference/service.ts";
import { TokenCounter } from "./inference/tokens.ts";
import { ResourceSampler } from "./resources.ts";
import { ResourceBudgets } from "./resource-budgets.ts";
import { Settings } from "./settings.ts";
import { Store } from "./store/db.ts";
import { BlobGc } from "./store/gc.ts";
import { logger } from "./util/log.ts";

const log = logger("app");

export interface App {
  config: Config;
  store: Store;
  hub: Hub;
  inference: InferenceService;
  gateway: Gateway;
  envs: EnvManager;
  sessions: SessionManager;
  evals: EvalRunner;
  files: FileViews;
  sampler: ResourceSampler;
  settings: Settings;
  downloads: ModelDownloads;
  budgets: ResourceBudgets;
  state(): Promise<AppState>;
  shutdown(): Promise<void>;
}

export async function createApp(config: Config): Promise<App> {
  const store = new Store(join(config.dataDir, "terrarium.db"), join(config.dataDir, "blobs"));
  const hub = new Hub();
  const inference = new InferenceService({ store, hub, modelsDir: config.modelsDir, venvDir: config.venvDir, omlxDataDir: join(config.dataDir, "omlx") });
  const budgets = new ResourceBudgets({ store, dataDir: config.dataDir });
  const gateway = new Gateway(store, {
    baseUrl: () => inference.omlx.baseUrl,
    apiKey: () => inference.omlx.key,
    ensureReady: () => inference.omlx.ensureStarted(),
  }, budgets);
  await gateway.listen();
  const drivers = await loadDrivers();
  const envs = new EnvManager({ store, hub, dataDir: config.dataDir, drivers, budgets });
  // Dev only: TERRARIUM_TOKENIZER_URL points the tokenizer elsewhere (e.g. a dead port) to try the estimate fallback
  // against the real model.
  const tokenizerUrl = config.dev ? process.env.TERRARIUM_TOKENIZER_URL : undefined;
  const tokens = new TokenCounter({
    baseUrl: () => tokenizerUrl || inference.omlx.baseUrl,
    apiKey: () => inference.omlx.key,
    ensureReady: () => inference.omlx.ensureStarted(),
  });
  const settings = new Settings({ store, hub, inference, config, budgets });
  const sessions = new SessionManager({ store, hub, envs, inference, gateway, tokens, budgets, prompts: () => settings.prompts() });
  const evals = new EvalRunner({ store, hub, envs, sessions, inference, policy, dataDir: config.dataDir });
  const files = new FileViews({ store, envs });
  const downloads = new ModelDownloads({ hub, inference, venvDir: config.venvDir, modelsDir: config.modelsDir, dataDir: config.dataDir, budgets });
  downloads.inUse = (modelId) => {
    const s = store.get<{ title: string }>("SELECT title FROM sessions WHERE model_id = ? AND status IN ('running', 'stopping') LIMIT 1", modelId);
    if (s) return `session "${s.title}" running`;
    const run = evals.list().find((r) => r.status === "running" && r.config.modelIds.includes(modelId));
    return run ? `eval "${run.suiteTitle}" running` : undefined;
  };
  const sampler = new ResourceSampler(hub, envs, inference);
  sampler.start(1000);
  const gc = new BlobGc(store);
  envs.hooks.onDeleted = () => gc.schedule();
  sessions.onDeleted = () => gc.schedule();
  void gc.run({ graceMs: 60_000 }).then(
    (r) => r.removed && log.info(`startup gc removed ${r.removed} unreferenced blobs (${Math.round(r.removedBytes / 1024)} KiB)`),
    (err) => log.warn("startup blob gc failed", err),
  );

  let shuttingDown: Promise<void> | null = null;
  const app: App = {
    config,
    store,
    hub,
    inference,
    gateway,
    envs,
    sessions,
    evals,
    files,
    sampler,
    settings,
    downloads,
    budgets,
    async state() {
      return {
        envs: envs.list(),
        sessions: sessions.list(),
        models: await inference.models(),
        inference: inference.inferenceState(),
        budget: inference.budget(),
        evalRuns: evals.list(),
        settings: settings.get(),
        downloads: downloads.list(),
        versions: { app: config.appVersion, gondolin: VERSIONS.gondolin, justBash: VERSIONS.justBash, piAgentCore: VERSIONS.piAgentCore, omlx: VERSIONS.omlx },
      };
    },
    shutdown() {
      shuttingDown ??= (async () => {
        sampler.stop();
        gc.cancel();
        const step = async (name: string, fn: () => Promise<unknown>) => {
          try {
            await fn();
          } catch (err) {
            log.warn(`shutdown: ${name} failed`, err);
          }
        };
        downloads.cancelAll();
        await step("evals", () => evals.stopAll());
        await step("sessions", () => sessions.stopAll());
        await step("envs", () => envs.stopAll());
        await step("inference", () => inference.stop());
        await step("gateway", () => gateway.close());
        store.close();
      })();
      return shuttingDown;
    },
  };
  return app;
}
