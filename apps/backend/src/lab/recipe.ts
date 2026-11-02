// Strain recipes as text, neuronary.org style: `L15N4041+0.8` (dose), `L15N4041-0.5`, plus Terrarium's raw clamp
// `L8N344=25`, and a vector by name: `[The Bard L8 x1.2]`. The UI parses what people paste (apps/ui/src/lib/recipe.ts);
// the backend checks pushes it is sent and writes the canonical text stored with each strain.

import type { LabMixItem, LabPush, LabStrainSettings, LabVector } from "@terrarium/shared";
import { HttpError } from "../util/errors.ts";

export const MAX_PUSHES = 64;
export const MAX_VECTORS = 4;
const VECTOR_TEXT = 256 * 1024; // base64 of u: 14 KB on Qwen 4B, 22 KB on 9B; this allows d_model up to 48000

function fmt(v: number): string {
  return String(Math.round(v * 1000) / 1000);
}

export const isVector = (p: LabMixItem): p is LabVector => p.kind === "vector";

export function formatPush(p: LabMixItem): string {
  if (isVector(p)) return `[${p.name} L${p.layer} x${fmt(p.strength)}]`;
  const id = `L${p.layer}N${p.neuron}`;
  if (p.mode === "clamp") return `${id}=${fmt(p.value)}`;
  return `${id}${p.value < 0 ? "-" : "+"}${fmt(Math.abs(p.value))}`;
}

export function formatRecipe(pushes: LabMixItem[]): string {
  return pushes.map(formatPush).join(" ");
}

/** Pushes from a request body: shape and ranges only (layer and neuron bounds are the model's, checked by the Lab). */
export function checkPushes(v: unknown, name = "pushes"): LabMixItem[] {
  if (!Array.isArray(v)) throw new HttpError(400, `${name} must be a list`);
  const vectors = v.filter((p) => (p as LabVector | null)?.kind === "vector").length;
  if (v.length - vectors > MAX_PUSHES) throw new HttpError(400, `${name}: at most ${MAX_PUSHES} neurons`);
  if (vectors > MAX_VECTORS) throw new HttpError(400, `${name}: at most ${MAX_VECTORS} vectors`);
  const seen = new Set<string>();
  return v.map((p, i) => {
    const o = (p ?? {}) as Record<string, unknown>;
    if (o.kind === "vector") {
      const vector = checkVector(o, `${name}[${i}]`);
      if (seen.has(vector.id)) throw new HttpError(400, `${name}: ${vector.name} is listed twice`);
      seen.add(vector.id);
      return vector;
    }
    const { layer, neuron, mode, value } = o;
    if (!Number.isInteger(layer) || (layer as number) < 0 || !Number.isInteger(neuron) || (neuron as number) < 0) throw new HttpError(400, `${name}[${i}]: layer and neuron must be whole numbers from 0`);
    if (mode !== "dose" && mode !== "clamp") throw new HttpError(400, `${name}[${i}]: mode must be "dose" or "clamp"`);
    if (typeof value !== "number" || !Number.isFinite(value) || Math.abs(value) > 1e4) throw new HttpError(400, `${name}[${i}]: value must be a number`);
    const key = `${layer}:${neuron}`;
    if (seen.has(key)) throw new HttpError(400, `${name}: L${layer}N${neuron} is listed twice`);
    seen.add(key);
    return { layer: layer as number, neuron: neuron as number, mode, value };
  });
}

function checkVector(o: Record<string, unknown>, at: string): LabVector {
  const { id, name, layer, strength, u } = o;
  if (typeof id !== "string" || !id || id.length > 80) throw new HttpError(400, `${at}: a vector needs an id`);
  if (typeof name !== "string" || !name.trim() || name.length > 80 || /[\[\]]/.test(name)) throw new HttpError(400, `${at}: a vector needs a name of at most 80 characters, without brackets`);
  if (!Number.isInteger(layer) || (layer as number) < 0) throw new HttpError(400, `${at}: layer must be a whole number from 0`);
  if (typeof strength !== "number" || !Number.isFinite(strength) || Math.abs(strength) > 1e4) throw new HttpError(400, `${at}: strength must be a number`);
  if (typeof u !== "string" || !u || u.length > VECTOR_TEXT || u.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(u)) throw new HttpError(400, `${at}: u must be base64`);
  return { kind: "vector", id, name: name.trim(), layer: layer as number, strength, u };
}

/** Numbers of float32 in a vector's base64. */
export function vectorLength(u: string): number {
  const pad = u.endsWith("==") ? 2 : u.endsWith("=") ? 1 : 0;
  return ((u.length / 4) * 3 - pad) / 4;
}

/**
 * What a strain runs with when none were stored. Neurons were tuned with the repeat penalty on. Vectors were only ever
 * measured with it off, and dense vectors with a penalty are untested, so a mix with a vector runs without.
 */
export function defaultSettings(pushes: LabMixItem[]): LabStrainSettings {
  return { temperature: 0.7, topP: 0.95, repeat: pushes.some(isVector) ? null : 1.1 };
}

export function checkSettings(v: unknown, pushes: LabMixItem[]): LabStrainSettings {
  if (v === undefined || v === null) return defaultSettings(pushes);
  const { temperature, topP, repeat, maxTokens } = v as Record<string, unknown>;
  if (typeof temperature !== "number" || !(temperature >= 0 && temperature <= 2)) throw new HttpError(400, "settings.temperature must be 0 to 2");
  if (typeof topP !== "number" || !(topP > 0 && topP <= 1)) throw new HttpError(400, "settings.topP must be above 0, up to 1");
  if (repeat !== null && (typeof repeat !== "number" || !(repeat >= 1 && repeat <= 2))) throw new HttpError(400, "settings.repeat must be 1 to 2, or null for none");
  if (maxTokens !== undefined && (!Number.isInteger(maxTokens) || (maxTokens as number) < 16)) throw new HttpError(400, "settings.maxTokens must be a whole number from 16");
  return { temperature, topP, repeat: repeat === 1 ? null : (repeat as number | null), ...(maxTokens !== undefined ? { maxTokens: maxTokens as number } : {}) };
}
