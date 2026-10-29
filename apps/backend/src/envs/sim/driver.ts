// EnvDriver for simulated (just-bash) environments.

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SimConfig } from "@terrarium/shared";
import type { EnvCreateSpec, EnvDriver, EnvRuntime } from "../types.ts";
import { SANDBOX_EXEC } from "./sandbox.ts";
import { SimRuntime, seedState } from "./runtime.ts";

export const DEFAULT_SIM: SimConfig = { python: true, javascript: false, maxTotalBytes: 64 * 1024 * 1024 };

function simConfig(spec: { sim?: SimConfig }): SimConfig {
  return { ...DEFAULT_SIM, ...spec.sim };
}

export const simDriver: EnvDriver = {
  type: "sim",

  async create(spec: EnvCreateSpec): Promise<EnvRuntime> {
    mkdirSync(spec.dir, { recursive: true, mode: 0o700 });
    const config = simConfig(spec);
    writeFileSync(join(spec.dir, "config.json"), JSON.stringify(config));
    const statePath = join(spec.dir, "state.json");
    if (spec.fromSnapshotDir) copyFileSync(join(spec.fromSnapshotDir, "state.json"), statePath);
    else writeFileSync(statePath, JSON.stringify(seedState(spec.seedFiles)), { mode: 0o600 });
    return new SimRuntime(spec.id, spec.dir, config, spec.network);
  },

  async open(spec): Promise<EnvRuntime> {
    const cfgPath = join(spec.dir, "config.json");
    const config = existsSync(cfgPath) ? { ...DEFAULT_SIM, ...JSON.parse(readFileSync(cfgPath, "utf8")) } : simConfig(spec);
    return new SimRuntime(spec.id, spec.dir, config, spec.network);
  },

  async check() {
    return existsSync(SANDBOX_EXEC) ? { ok: true, detail: "just-bash 3.6.0 under sandbox-exec" } : { ok: false, detail: `${SANDBOX_EXEC} missing` };
  },
};
