// Process-wide paths and settings, resolved once from the environment.

import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
/** apps/backend (src/ in dev, dist/ in prod both sit one level below it). */
export const BACKEND_DIR = resolve(here, "..");
export const REPO_DIR = resolve(BACKEND_DIR, "../..");
/** ".ts" when running from source with type stripping, ".js" from dist. */
export const SRC_EXT = import.meta.url.endsWith(".ts") ? ".ts" : ".js";

export interface Config {
  port: number;
  token: string;
  tokenGenerated: boolean;
  dev: boolean;
  parentStdin: boolean;
  dataDir: string;
  modelsDir: string;
  venvDir: string;
  appVersion: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const dataDir = resolve(env.TERRARIUM_DATA || join(REPO_DIR, "data"));
  for (const sub of ["", "blobs", "envs", "snapshots", "canary", "omlx", "datasets"]) {
    mkdirSync(join(dataDir, sub), { recursive: true, mode: 0o700 });
  }
  const token = env.TERRARIUM_TOKEN || randomBytes(32).toString("hex");
  return {
    port: env.TERRARIUM_PORT ? Number(env.TERRARIUM_PORT) : 0,
    token,
    tokenGenerated: !env.TERRARIUM_TOKEN,
    dev: env.TERRARIUM_DEV === "1",
    parentStdin: env.TERRARIUM_PARENT_STDIN === "1",
    dataDir,
    modelsDir: resolve(env.TERRARIUM_MODELS || join(REPO_DIR, "models")),
    venvDir: resolve(env.TERRARIUM_VENV || join(REPO_DIR, ".venv")),
    appVersion: "0.1.0",
  };
}

export const ALLOWED_ORIGINS = new Set(["tauri://localhost", "http://tauri.localhost", "http://localhost:5173"]);

export const VERSIONS = {
  gondolin: "0.14.0",
  justBash: "3.6.0",
  piAgentCore: "1.4.0",
  omlx: "0.7.2",
};
