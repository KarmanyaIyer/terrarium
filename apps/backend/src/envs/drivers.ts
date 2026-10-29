// Driver registry. The VM driver (src/envs/vm/driver.ts, VM agent) is loaded if present.

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { EnvType } from "@terrarium/shared";
import { SRC_EXT } from "../config.ts";
import { logger } from "../util/log.ts";
import { simDriver } from "./sim/driver.ts";
import type { EnvDriver } from "./types.ts";

const log = logger("drivers");

export async function loadDrivers(): Promise<Record<EnvType, EnvDriver | null>> {
  let vm: EnvDriver | null = null;
  const url = new URL(`./vm/driver${SRC_EXT}`, import.meta.url);
  if (existsSync(fileURLToPath(url))) {
    try {
      const mod = (await import(url.href)) as { vmDriver?: EnvDriver; reapOrphanVmms?: () => Promise<number> };
      vm = mod.vmDriver ?? null;
      if (!vm) log.warn("src/envs/vm/driver exists but does not export vmDriver");
      // Before any VM boots: VMs a previous backend left running (it was SIGKILLed with the app shell) are stopped.
      const reaped = await mod.reapOrphanVmms?.().catch((err) => {
        log.warn("reaping VMs left by a previous backend failed", err);
        return 0;
      });
      if (reaped) log.warn(`stopped ${reaped} VM(s) left running by a previous backend`);
    } catch (err) {
      log.warn("failed to load VM driver", err);
    }
  }
  return { sim: simDriver, vm };
}
