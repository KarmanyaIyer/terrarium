// Which models in models/ the Lab can open, and how much memory each takes there. The reasons mirror
// unsupported_reason() and MLP_SHAPES in scripts/lab_core.py, so the UI can explain before anything loads.

import { closeSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import type { LabSupport } from "@terrarium/shared";
import type { ModelCatalog } from "../inference/catalog.ts";

/**
 * Working memory on top of the weights. Fixed part: MLX's buffer cache (capped at 512 MiB by lab_serve.py) plus a
 * margin. The biggest op is a long probe, which keeps every neuron at every token: measured about 4 bytes per neuron
 * per token over the weights (2.14 GB for 1800 tokens on Qwen3.5-4B, 2.97 GB for 1000 on Gemma 4 12B), at
 * PROBE_TOKENS (lab_core.py's cap plus a 256-token reply). Finder, generation and attribution stay below that.
 * Measured peaks in TODO_21.md.
 */
const LAB_FIXED_BYTES = 0.75e9;
const PROBE_TOKENS = 1024 + 256;
const BYTES_PER_NEURON_TOKEN = 4;

/** Total MLP neurons from config.json: intermediate size x layers (Gemma 4's double-wide layers counted twice). */
export function neuronCount(config: Record<string, any>): number {
  const t = config.text_config ?? config;
  const layers: number = t.num_hidden_layers ?? 0;
  const inter: number = t.intermediate_size ?? 4 * (t.hidden_size ?? 0);
  const wide = t.use_double_wide_mlp && t.num_kv_shared_layers ? t.num_kv_shared_layers : 0;
  return inter * (layers + wide);
}

export function labWorkingBytes(config: Record<string, any>): number {
  return LAB_FIXED_BYTES + PROBE_TOKENS * neuronCount(config) * BYTES_PER_NEURON_TOKEN;
}

export function unsupportedReason(config: Record<string, any>): string | undefined {
  const t = config.text_config ?? config;
  if ((t.num_experts ?? 0) > 0 || t.enable_moe_block) return "Mixture-of-experts MLP: neurons live inside experts, which the Lab does not hook";
  return undefined;
}

/** Tensor names from the weight index, or from a single model.safetensors header when there is no index. */
function weightNames(dir: string): string[] {
  try {
    return Object.keys(JSON.parse(readFileSync(join(dir, "model.safetensors.index.json"), "utf8")).weight_map ?? {});
  } catch {}
  let fd: number | undefined;
  try {
    fd = openSync(join(dir, "model.safetensors"), "r");
    const len = Buffer.alloc(8);
    readSync(fd, len, 0, 8, 0);
    const n = Number(len.readBigUInt64LE());
    if (n <= 0 || n > 64 << 20) return [];
    const header = Buffer.alloc(n);
    readSync(fd, header, 0, n, 8);
    return Object.keys(JSON.parse(header.toString("utf8"))).filter((k) => k !== "__metadata__");
  } catch {
    return [];
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** The projections out of a gated MLP's neurons, by name (MLP_SHAPES in scripts/lab_core.py). */
const MLP_OUT = /\.(mlp\.down_proj|feed_forward\.w2)\./;

/** The hooks wrap each layer's projection out of its neurons. When the names can't be read the sidecar finds out at
 *  load and says so. */
function weightsReason(dir: string): string | undefined {
  const names = weightNames(dir);
  if (names.length && !names.some((n) => MLP_OUT.test(n))) return "Its layers have no gated MLP the Lab knows (mlp.down_proj or feed_forward.w2), so the neuron hooks have nothing to wrap";
  return undefined;
}

/** Per catalog, per model folder: read once for each scan of a folder (state, heldBytes and oMLX calls ask constantly). */
const cached = new WeakMap<ModelCatalog, Map<string, { mtimeMs: number; support: LabSupport }>>();

export function labSupport(catalog: ModelCatalog): LabSupport[] {
  const seen = cached.get(catalog) ?? new Map<string, { mtimeMs: number; support: LabSupport }>();
  cached.set(catalog, seen);
  const out: LabSupport[] = [];
  for (const id of catalog.ids()) {
    const dir = join(catalog.modelsDir, id);
    const mtimeMs = statSync(dir).mtimeMs;
    const hit = seen.get(id);
    if (hit?.mtimeMs === mtimeMs) {
      out.push(hit.support);
      continue;
    }
    const info = catalog.info(id);
    if (!info) continue;
    let config: Record<string, any> = {};
    try {
      config = JSON.parse(readFileSync(join(dir, "config.json"), "utf8"));
    } catch {}
    const reason = unsupportedReason(config) ?? weightsReason(dir);
    const support: LabSupport = { modelId: id, name: info.name, supported: !reason, ...(reason ? { reason } : {}), estimateBytes: Math.round(info.weightsBytes + labWorkingBytes(config)) };
    seen.set(id, { mtimeMs, support });
    out.push(support);
  }
  for (const id of seen.keys()) if (!out.some((s) => s.modelId === id)) seen.delete(id);
  return out;
}
