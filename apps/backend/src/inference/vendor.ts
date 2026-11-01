// mlx-lm model files Terrarium ships ahead of an mlx-lm release (scripts/vendor/mlx_lm_models, provenance in each
// file's header). Copied into the venv's mlx_lm/models before oMLX starts and before an Add model check, so a
// rebuilt .venv gets them back. A file mlx-lm already ships (no marker line) is left alone: once upstream has
// it, the vendored copy is dead and can be deleted.

import { existsSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BACKEND_DIR } from "../config.ts";
import { errorMessage } from "../util/errors.ts";
import { logger } from "../util/log.ts";

const log = logger("vendor");
export const VENDOR_DIR = join(BACKEND_DIR, "scripts", "vendor", "mlx_lm_models");
export const VENDOR_MARKER = "# Vendored by Terrarium";

export type VendorStatus = "installed" | "updated" | "current" | "upstream";

/** mlx_lm/models in the venv's site-packages, or undefined when mlx-lm isn't installed. */
export function mlxLmModelsDir(venvDir: string): string | undefined {
  const lib = join(venvDir, "lib");
  if (!existsSync(lib)) return undefined;
  for (const py of readdirSync(lib).filter((d) => /^python3\.\d+$/.test(d)).sort().reverse()) {
    const dir = join(lib, py, "site-packages", "mlx_lm", "models");
    if (existsSync(join(dir, "base.py"))) return dir;
  }
  return undefined;
}

/** Idempotent: copies each vendored file whose venv copy is missing or an older vendored version. */
export function installVendoredModels(venvDir: string, sourceDir = VENDOR_DIR): Record<string, VendorStatus> {
  const target = mlxLmModelsDir(venvDir);
  const result: Record<string, VendorStatus> = {};
  if (!target || !existsSync(sourceDir)) return result;
  for (const name of readdirSync(sourceDir).filter((f) => f.endsWith(".py"))) {
    const src = readFileSync(join(sourceDir, name), "utf8");
    const dest = join(target, name);
    const have = existsSync(dest) ? readFileSync(dest, "utf8") : undefined;
    if (have !== undefined && !have.startsWith(VENDOR_MARKER)) {
      result[name] = "upstream";
      continue;
    }
    if (have === src) {
      result[name] = "current";
      continue;
    }
    const tmp = `${dest}.terrarium-${process.pid}`;
    writeFileSync(tmp, src, { mode: 0o644 });
    renameSync(tmp, dest);
    result[name] = have === undefined ? "installed" : "updated";
  }
  return result;
}

/** installVendoredModels for callers that must not fail on it: logs what changed or went wrong. */
export function ensureVendoredModels(venvDir: string): void {
  try {
    const res = installVendoredModels(venvDir);
    for (const [name, status] of Object.entries(res)) {
      if (status === "installed" || status === "updated") log.info(`${status} mlx_lm/models/${name}`);
      else if (status === "upstream") log.info(`mlx-lm ships ${name}; the vendored copy is unused and can be deleted`);
    }
  } catch (e) {
    log.warn(`vendored mlx-lm models not installed: ${errorMessage(e)}`);
  }
}
