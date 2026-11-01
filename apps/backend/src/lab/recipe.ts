// Strain recipes as text, neuronary.org style: `L15N4041+0.8` (dose), `L15N4041-0.5`, plus Terrarium's raw clamp
// `L8N344=25`. The UI parses what people paste (apps/ui/src/lib/recipe.ts); the backend checks pushes it is sent and
// writes the canonical text stored with each strain.

import type { LabPush } from "@terrarium/shared";
import { HttpError } from "../util/errors.ts";

export const MAX_PUSHES = 64;

function fmt(v: number): string {
  return String(Math.round(v * 1000) / 1000);
}

export function formatPush(p: LabPush): string {
  const id = `L${p.layer}N${p.neuron}`;
  if (p.mode === "clamp") return `${id}=${fmt(p.value)}`;
  return `${id}${p.value < 0 ? "-" : "+"}${fmt(Math.abs(p.value))}`;
}

export function formatRecipe(pushes: LabPush[]): string {
  return pushes.map(formatPush).join(" ");
}

/** Pushes from a request body: shape and ranges only (layer and neuron bounds are the model's, checked by the Lab). */
export function checkPushes(v: unknown, name = "pushes"): LabPush[] {
  if (!Array.isArray(v)) throw new HttpError(400, `${name} must be a list`);
  if (v.length > MAX_PUSHES) throw new HttpError(400, `${name}: at most ${MAX_PUSHES} neurons`);
  const seen = new Set<string>();
  return v.map((p, i) => {
    const o = (p ?? {}) as Record<string, unknown>;
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
