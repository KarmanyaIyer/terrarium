// Model metadata for MLX dirs in models/, and memory estimates.
// Numbers for known models: research/models-inference.md §1.2 and §3.2 (W in GB, KV per token, fixed state).
// Unknown dirs fall back to values computed from config.json and safetensors sizes.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { MemoryEstimate, ModelInfo } from "@terrarium/shared";

const GB = 1e9;
const MB = 1e6;

type Sampling = ModelInfo["sampling"];

interface KnownModel {
  name: string;
  family: string;
  params: string;
  quant: string;
  toolFormat: string;
  thinking: ModelInfo["thinking"];
  weightsGB: number; // text-only resident weights
  kvBytesPerToken: number;
  fixedMB: number;
  overheadGB: number;
}

const QWEN_TOOLS = "qwen3_coder XML";

export const KNOWN_MODELS: Record<string, KnownModel> = {
  "Qwen3.5-4B-MLX-4bit": { name: "Qwen3.5 4B", family: "qwen3.5", params: "4.5B", quant: "4bit", toolFormat: QWEN_TOOLS, thinking: "default-on", weightsGB: 2.58, kvBytesPerToken: 32768, fixedMB: 50, overheadGB: 1 },
  "Qwen3.5-9B-MLX-4bit": { name: "Qwen3.5 9B", family: "qwen3.5", params: "9.4B", quant: "4bit", toolFormat: QWEN_TOOLS, thinking: "default-on", weightsGB: 5.0, kvBytesPerToken: 32768, fixedMB: 50, overheadGB: 1 },
  "gemma-4-12B-it-4bit": { name: "Gemma 4 12B", family: "gemma4", params: "12.0B", quant: "4bit", toolFormat: "gemma4", thinking: "optional", weightsGB: 6.74, kvBytesPerToken: 16384, fixedMB: 336, overheadGB: 1 },
  "Ternary-Bonsai-2-27B-mlx-2bit": { name: "Bonsai 2 27B", family: "bonsai", params: "27.4B", quant: "2bit ternary", toolFormat: QWEN_TOOLS, thinking: "default-on", weightsGB: 7.67, kvBytesPerToken: 65536, fixedMB: 151, overheadGB: 1 },
  "Ternary-Bonsai-2-9B-mlx-2bit": { name: "Bonsai 2 9B", family: "bonsai", params: "9.0B", quant: "2bit ternary", toolFormat: QWEN_TOOLS, thinking: "default-on", weightsGB: 2.54, kvBytesPerToken: 32768, fixedMB: 50, overheadGB: 1 },
  "Ternary-Bonsai-2-2B-mlx-2bit": { name: "Bonsai 2 2B", family: "bonsai", params: "2.2B", quant: "2bit ternary", toolFormat: QWEN_TOOLS, thinking: "default-on", weightsGB: 1.1, kvBytesPerToken: 12288, fixedMB: 19, overheadGB: 0.5 },
  // 6 of 24 layers are full attention; 6 sliding (256-token window) and 12 short-conv layers hold fixed state.
  "LFM3-1.7B-MLX-8bit": { name: "LFM3 1.7B", family: "lfm3", params: "1.7B", quant: "8bit", toolFormat: QWEN_TOOLS, thinking: "default-on", weightsGB: 1.84, kvBytesPerToken: 12288, fixedMB: 4, overheadGB: 0.5 },
};

/** A folder name a person can read: "gemma-4-e2b-it-4bit" -> "Gemma 4 E2B", "Qwen3.5-2B-4bit" -> "Qwen3.5 2B". */
export function displayName(id: string): string {
  const words = id.split(/[-_]/).filter((w) => !/^(mlx|it|\d+bit)$/i.test(w));
  if (!words.length) return id;
  return words.map((w, i) => (/^[a-z]?\d+(\.\d+)?b$/i.test(w) ? w.toUpperCase() : i === 0 ? w[0]!.toUpperCase() + w.slice(1) : w)).join(" ");
}

/** A strain replies with the Lab's repeat penalty, as Compare and Sweep tested it. The family's presence penalty on top would be a second one. */
export function strainSampling(s: Sampling): Sampling {
  const { presencePenalty: _, ...rest } = s;
  return rest;
}

/** Per-family sampling (Qwen/Prism cards: mlx ignores generation_config.json, so always send these). */
export function familySampling(family: string, thinking: boolean): Sampling {
  if (family === "gemma4") return { temperature: 1.0, topP: 0.95, topK: 64 };
  if (family === "lfm3") return { temperature: 0.1, topP: 1.0, topK: 50 }; // LFM3 card, general use; oMLX takes its repetition_penalty 1.1 from generation_config.json
  if (family === "qwen3.5" || family === "bonsai") {
    return thinking
      ? { temperature: 1.0, topP: 0.95, topK: 20, presencePenalty: 1.5 }
      : { temperature: 0.7, topP: 0.8, topK: 20, presencePenalty: 1.5 };
  }
  return { temperature: 0.7, topP: 0.9 };
}

/** Output budget: clamp(0.25 * window, 512, 4096), at least 8192 with thinking on (Prism recommends >= 8192). */
export function defaultOutputBudget(window: number, thinking: boolean): number {
  const base = Math.max(512, Math.min(4096, Math.floor(window * 0.25)));
  return thinking ? Math.min(Math.max(base, 8192), Math.floor(window / 2)) : base;
}

export interface ModelOverrides {
  defaultContext?: number;
  defaultMaxOutput?: number;
  sampling?: Partial<Sampling>;
}

function dirBytes(dir: string, depth = 0): number {
  let total = 0;
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, ent.name);
    if (ent.isFile()) total += statSync(p).size;
    else if (ent.isDirectory() && depth < 3) total += dirBytes(p, depth + 1);
  }
  return total;
}

function readConfig(dir: string): Record<string, any> {
  try {
    return JSON.parse(readFileSync(join(dir, "config.json"), "utf8"));
  } catch {
    return {};
  }
}

/** KV bytes/token from config: full-attention layers x 2 (K,V) x kv heads x head dim x 2 bytes (fp16). */
export function kvFromConfig(config: Record<string, any>): number {
  const t = config.text_config ?? config;
  const layers: number = t.num_hidden_layers ?? 0;
  const types: string[] = Array.isArray(t.layer_types) ? t.layer_types : [];
  const full = types.length ? types.filter((x) => x === "full_attention" || x === "global").length : layers;
  const kvHeads = t.num_global_key_value_heads ?? t.num_key_value_heads ?? t.num_attention_heads ?? 8;
  const headDim = t.global_head_dim ?? t.head_dim ?? (t.hidden_size && t.num_attention_heads ? t.hidden_size / t.num_attention_heads : 128);
  return full * 2 * kvHeads * headDim * 2;
}

export function estimateBytes(m: Pick<ModelInfo, "weightsBytes" | "kvBytesPerToken" | "fixedBytes">, context: number, overheadBytes = GB): number {
  return Math.round(m.weightsBytes + context * m.kvBytesPerToken + m.fixedBytes + overheadBytes);
}

export class ModelCatalog {
  readonly modelsDir: string;
  private cache = new Map<string, { mtimeMs: number; base: Omit<ModelInfo, "loaded" | "loadedContext" | "residentBytes" | "defaultContext" | "defaultMaxOutput" | "sampling"> & { overheadBytes: number } }>();

  constructor(modelsDir: string) {
    this.modelsDir = modelsDir;
  }

  ids(): string[] {
    if (!existsSync(this.modelsDir)) return [];
    // existsSync follows symlinks, so a model folder can be a link to another disk
    return readdirSync(this.modelsDir)
      .filter((name) => !name.startsWith(".") && existsSync(join(this.modelsDir, name, "config.json")))
      .sort();
  }

  private base(id: string) {
    const dir = join(this.modelsDir, id);
    const mtimeMs = statSync(dir).mtimeMs;
    const hit = this.cache.get(id);
    if (hit && hit.mtimeMs === mtimeMs) return hit.base;
    const config = readConfig(dir);
    const t = config.text_config ?? config;
    const known = KNOWN_MODELS[id];
    const diskBytes = dirBytes(dir);
    const nativeContext: number = t.max_position_embeddings ?? config.max_position_embeddings ?? 32768;
    const base = known
      ? {
          id,
          name: known.name,
          family: known.family,
          params: known.params,
          quant: known.quant,
          diskBytes,
          nativeContext,
          toolFormat: known.toolFormat,
          thinking: known.thinking,
          kvBytesPerToken: known.kvBytesPerToken,
          fixedBytes: known.fixedMB * MB,
          weightsBytes: known.weightsGB * GB,
          overheadBytes: known.overheadGB * GB,
        }
      : {
          id,
          name: displayName(id),
          family: String(t.model_type ?? config.model_type ?? "unknown"),
          params: "?",
          quant: config.quantization?.bits ? `${config.quantization.bits}bit` : "?",
          diskBytes,
          nativeContext,
          toolFormat: "unknown",
          thinking: "none" as const,
          kvBytesPerToken: kvFromConfig(config),
          fixedBytes: 0,
          weightsBytes: diskBytes,
          overheadBytes: diskBytes < 2 * GB ? 0.5 * GB : GB,
        };
    this.cache.set(id, { mtimeMs, base });
    return base;
  }

  info(id: string, overrides: ModelOverrides = {}, status?: { loaded: boolean; loadedContext?: number; residentBytes?: number }): ModelInfo | null {
    if (!existsSync(join(this.modelsDir, id, "config.json"))) return null;
    const { overheadBytes: _o, ...base } = this.base(id);
    const defaultContext = Math.min(overrides.defaultContext ?? 32768, base.nativeContext);
    return {
      ...base,
      loaded: status?.loaded ?? false,
      loadedContext: status?.loadedContext,
      residentBytes: status?.residentBytes,
      defaultContext,
      defaultMaxOutput: overrides.defaultMaxOutput ?? defaultOutputBudget(defaultContext, false),
      sampling: { ...familySampling(base.family, false), ...overrides.sampling },
    };
  }

  overheadBytes(id: string): number {
    return this.base(id).overheadBytes;
  }

  estimate(model: ModelInfo, context: number, free: { freeBytes: number; budgetBytes: number }): MemoryEstimate {
    const bytes = estimateBytes(model, context, this.overheadBytes(model.id));
    const resident = model.loaded ? (model.residentBytes ?? 0) : 0;
    return {
      modelId: model.id,
      context,
      bytes,
      fitsFree: bytes <= free.freeBytes + resident - 2 * GB,
      fitsBudget: bytes <= free.budgetBytes,
    };
  }
}
