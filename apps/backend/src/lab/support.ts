// Which models in models/ the Lab can open, and how much memory each takes there. The reasons mirror
// unsupported_reason() in scripts/lab_core.py, so the UI can explain before anything loads.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { LabSupport } from "@terrarium/shared";
import type { ModelCatalog } from "../inference/catalog.ts";

/**
 * Working memory on top of the weights. Fixed part: MLX's buffer cache (capped at 512 MiB by lab_serve.py) plus op
 * temporaries (finder, generation, last-position attribution all peak under 0.8 GB over the weights on Qwen3.5-4B).
 * The probe keeps every neuron at every token: PROBE_TOKENS (lab_core.py's cap plus a 256-token reply) x neurons x
 * 2 bytes. Qwen3.5-4B: 1.5 GB + 0.75 GB; measured peaks in TODO_21.md.
 */
const LAB_FIXED_BYTES = 1.5e9;
const PROBE_TOKENS = 1024 + 256;

/** Total MLP neurons from config.json: intermediate size x layers (Gemma 4's double-wide layers counted twice). */
export function neuronCount(config: Record<string, any>): number {
  const t = config.text_config ?? config;
  const layers: number = t.num_hidden_layers ?? 0;
  const inter: number = t.intermediate_size ?? 4 * (t.hidden_size ?? 0);
  const wide = t.use_double_wide_mlp && t.num_kv_shared_layers ? t.num_kv_shared_layers : 0;
  return inter * (layers + wide);
}

export function labWorkingBytes(config: Record<string, any>): number {
  return LAB_FIXED_BYTES + PROBE_TOKENS * neuronCount(config) * 2;
}

export function unsupportedReason(config: Record<string, any>): string | undefined {
  const mt = String(config.model_type ?? "");
  const t = config.text_config ?? config;
  if (mt.includes("hadamard") || mt.includes("prism")) return "Hadamard-rotated 2-bit pack loaded by its own runtime: neuron indices are mixed in blocks of 512, so single-neuron hooks don't apply";
  if ((t.num_experts ?? 0) > 0 || t.enable_moe_block) return "Mixture-of-experts MLP: neurons live inside experts, which the Lab does not hook";
  return undefined;
}

export function labSupport(catalog: ModelCatalog): LabSupport[] {
  const out: LabSupport[] = [];
  for (const id of catalog.ids()) {
    const info = catalog.info(id);
    if (!info) continue;
    let config: Record<string, any> = {};
    try {
      config = JSON.parse(readFileSync(join(catalog.modelsDir, id, "config.json"), "utf8"));
    } catch {}
    const reason = unsupportedReason(config);
    out.push({ modelId: id, name: info.name, supported: !reason, ...(reason ? { reason } : {}), estimateBytes: Math.round(info.weightsBytes + labWorkingBytes(config)) });
  }
  return out;
}
