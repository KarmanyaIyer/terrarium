// 1 Hz resource sampler: system memory, backend RSS, oMLX RSS + loaded models, per-env RSS/CPU.
// Runs only while at least one UI client is connected.

import type { ResourceSample } from "@terrarium/shared";
import type { EnvManager } from "./envs/manager.ts";
import type { Hub } from "./hub.ts";
import type { InferenceService } from "./inference/service.ts";
import { logger } from "./util/log.ts";
import { processStats, systemMemory } from "./util/sysmem.ts";

const log = logger("resources");

export class ResourceSampler {
  private timer: NodeJS.Timeout | null = null;
  private busy = false;
  private hub: Hub;
  private envs: EnvManager;
  private inference: InferenceService;
  last: ResourceSample | null = null;

  constructor(hub: Hub, envs: EnvManager, inference: InferenceService) {
    this.hub = hub;
    this.envs = envs;
    this.inference = inference;
  }

  start(intervalMs = 1000): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      if (this.hub.clientCount === 0 || this.busy) return;
      this.busy = true;
      this.sample()
        .then((s) => this.hub.broadcast({ type: "resources", sample: s }))
        .catch((err) => log.warn("sample failed", err))
        .finally(() => (this.busy = false));
    }, intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async sample(): Promise<ResourceSample> {
    const omlxPid = this.inference.omlx.pid;
    const [system, procs, loaded, envStats] = await Promise.all([
      systemMemory(),
      processStats(omlxPid ? [omlxPid] : []),
      this.inference.omlx.isReady() ? this.inference.loadedModels() : Promise.resolve([]),
      Promise.all(
        this.envs.running().map(async ({ id, runtime }) => {
          const r = await runtime.resources().catch(() => null);
          return r ? { envId: id, rssBytes: r.rssBytes, cpuPct: r.cpuPct } : null;
        }),
      ),
    ]);
    const omlx = omlxPid ? procs.get(omlxPid) : undefined;
    const sample: ResourceSample = {
      ts: Date.now(),
      system,
      backendRssBytes: process.memoryUsage.rss(),
      inference: omlx ? { rssBytes: omlx.rssBytes, loaded } : undefined,
      envs: envStats.filter((e): e is NonNullable<typeof e> => e !== null),
    };
    this.last = sample;
    return sample;
  }
}
