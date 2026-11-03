// Steering recipes as text, neuronary.org style: `L15N4041+0.8` (layer 15, neuron 4041, dose +0.8), `L15N4041-0.5`
// (dose -0.5), plus Terrarium's raw clamp `L8N344=25`, and a vector by name: `[The Bard L8 x1.2]`. Pushes are separated by
// spaces, commas, semicolons or newlines. A vector's numbers never appear in the text, so reading one back needs a
// vector of that name to hand.

import type { LabMixItem, LabPush, LabVector, NeuronRef } from "@terrarium/shared";

/** `L15N4041` */
export const nid = (r: NeuronRef) => `L${r.layer}N${r.neuron}`;

export const sameRef = (a: NeuronRef, b: NeuronRef) => a.layer === b.layer && a.neuron === b.neuron;

export const isVector = (p: LabMixItem): p is LabVector => p.kind === "vector";
export const isNeuron = (p: LabMixItem): p is LabPush => p.kind !== "vector";
/** A neuron in the mix, or nothing. */
export const findPush = (mix: LabMixItem[], ref: NeuronRef): LabPush | undefined => mix.filter(isNeuron).find((p) => sameRef(p, ref));
/** Identifies an entry of a mix: `L15N4041`, or `vector:<id>`. */
export const pushKey = (p: LabMixItem) => (isVector(p) ? `vector:${p.id}` : nid(p));
/** What to call an entry of a mix. */
export const pushName = (p: LabMixItem) => (isVector(p) ? p.name : nid(p));
/** Numbers a vector holds, from its base64. */
/** Repeat penalty for a vector, as the backend's defaultSettings: Qwen vectors loop without it, LFM3's hold and were never measured with it. */
export function vectorRepeat(modelId: string): number | null {
  return /qwen/i.test(modelId) ? 1.1 : null;
}

export function vectorLength(u: string): number {
  const pad = u.endsWith("==") ? 2 : u.endsWith("=") ? 1 : 0;
  return ((u.length / 4) * 3 - pad) / 4;
}

const NUM = String.raw`[+\-−]?(?:\d+(?:\.\d*)?|\.\d+)`;
// L15N4041, l15n4041, L15/N4041, L15:N4041, L 15 N 4041; then +0.8, -0.5, =25 or nothing (reported)
const PUSH = new RegExp(String.raw`L\s*(\d+)\s*[/:._]?\s*N\s*(\d+)(?:\s*(=)\s*(${NUM})|\s*([+\-−])\s*(\d+(?:\.\d*)?|\.\d+))?`, "gi");
const SEP = /^[\s,;]*$/;
// [The Bard L8 x1.2]
const VECTOR = new RegExp(String.raw`\[\s*([^\[\]]*?)\s+L\s*(\d+)\s+[x×]\s*(${NUM})\s*\]`, "gi");

const num = (s: string) => Number(s.replace("−", "-"));

/** Number as written in a recipe: up to 3 decimals, no trailing zeros. */
export function fmtDose(v: number): string {
  return String(Math.round(v * 1000) / 1000);
}

/** A number on screen, with a true minus. Recipe text keeps the hyphen, so it pastes anywhere. */
export function shownDose(v: number): string {
  return fmtDose(v).replace("-", "−");
}

/** A dose on screen, with its sign: `+0.6`, `−0.5`, `0`. */
export function signedDose(v: number): string {
  return `${v > 0 ? "+" : ""}${shownDose(v)}`;
}

/** A push on screen: `L22N4296 +0.6`, `Gnome, L8 vector ×1`. Copy text is `format`. */
export function pushText(p: LabMixItem): string {
  if (isVector(p)) return `${p.name}, L${p.layer} vector ×${shownDose(p.strength)}`;
  return `${nid(p)} ${p.mode === "clamp" ? `=${shownDose(p.value)}` : signedDose(p.value)}`;
}

/** Recipe text from the backend, as pushText shows it. */
export function recipeLabel(text: string): string {
  const parts: string[] = [];
  const rest = text.replace(VECTOR, (_, name: string, layer: string, strength: string) => {
    parts.push(`${name}, L${Number(layer)} vector ×${shownDose(num(strength))}`);
    return " ";
  });
  for (const m of rest.matchAll(PUSH)) {
    const id = `L${Number(m[1])}N${Number(m[2])}`;
    if (m[3]) parts.push(`${id} =${shownDose(num(m[4]))}`);
    else if (m[5]) parts.push(`${id} ${signedDose((m[5] === "+" ? 1 : -1) * num(m[6]))}`);
  }
  return parts.join(", ") || text;
}

export function formatPush(p: LabMixItem): string {
  if (isVector(p)) return `[${p.name} L${p.layer} x${fmtDose(p.strength)}]`;
  if (p.mode === "clamp") return `${nid(p)}=${fmtDose(p.value)}`;
  return `${nid(p)}${p.value < 0 ? "-" : "+"}${fmtDose(Math.abs(p.value))}`;
}

export function format(pushes: LabMixItem[]): string {
  return pushes.map(formatPush).join(" ");
}

/**
 * Reads every push in the text. Anything that isn't a push or a separator is reported, one error per piece. A neuron
 * listed twice keeps its last value (reported too), so a pasted recipe never silently doubles a push. `known`: the vectors
 * a `[name L8 x1.2]` can refer to; the text sets its strength.
 */
export function parse(source: string, known: LabVector[] = []): { pushes: LabMixItem[]; errors: string[] } {
  const pushes: LabMixItem[] = [];
  const errors: string[] = [];
  const text = source.replace(VECTOR, (_, name: string, layer: string, strength: string) => {
    const found = known.find((v) => v.name.toLowerCase() === name.toLowerCase() && v.layer === Number(layer));
    if (!found) errors.push(`"${name}" is a vector. Add it from Examples or a strain first`);
    else if (!Number.isFinite(num(strength))) errors.push(`${name}: "${strength}" is not a number`);
    else if (!pushes.some((p) => isVector(p) && p.id === found.id)) pushes.push({ ...found, strength: num(strength) });
    return " ";
  });
  const junk = (s: string) => {
    for (const piece of s.split(/[\s,;]+/).filter(Boolean)) errors.push(`Can't read "${piece.length > 24 ? `${piece.slice(0, 24)}…` : piece}"`);
  };
  let last = 0;
  for (const m of text.matchAll(PUSH)) {
    const gap = text.slice(last, m.index);
    if (!SEP.test(gap)) junk(gap);
    last = m.index + m[0].length;
    const layer = Number(m[1]);
    const neuron = Number(m[2]);
    const id = `L${layer}N${neuron}`;
    let push: LabPush;
    if (m[3]) push = { layer, neuron, mode: "clamp", value: num(m[4]) };
    else if (m[5]) push = { layer, neuron, mode: "dose", value: (m[5] === "+" ? 1 : -1) * num(m[6]) };
    else {
      errors.push(`${id} has no dose: write ${id}+0.8 for a dose or ${id}=25 for a clamp`);
      continue;
    }
    if (!Number.isFinite(push.value)) {
      errors.push(`${id}: "${m[0].trim()}" is not a number`);
      continue;
    }
    const dup = pushes.findIndex((p) => isNeuron(p) && sameRef(p, push));
    if (dup >= 0) {
      errors.push(`${id} is listed twice; kept ${formatPush(push)}`);
      pushes.splice(dup, 1);
    }
    pushes.push(push);
  }
  const tail = text.slice(last);
  if (!SEP.test(tail)) junk(tail);
  return { pushes, errors };
}

/** `L15N4041` (or `l15 n4041`) as a neuron, or null. */
export function parseRef(text: string): NeuronRef | null {
  const m = /^\s*L\s*(\d+)\s*[/:._]?\s*N\s*(\d+)\s*$/i.exec(text);
  return m ? { layer: Number(m[1]), neuron: Number(m[2]) } : null;
}

/** Pushes that point past the loaded model's layers or neurons, or a vector made for another model's size. */
export function outOfRange(pushes: LabMixItem[], layers: number, neuronsPerLayer: number[], dModel?: number): string[] {
  const errors: string[] = [];
  for (const p of pushes) {
    if (isVector(p)) {
      if (p.layer >= layers) errors.push(`${p.name}: the model has layers 0 to ${layers - 1}`);
      else if (dModel && vectorLength(p.u) !== dModel) errors.push(`${p.name} was made for another model`);
    } else if (p.layer >= layers) errors.push(`${nid(p)}: the model has layers 0 to ${layers - 1}`);
    else if (p.neuron >= (neuronsPerLayer[p.layer] ?? 0)) errors.push(`${nid(p)}: layer ${p.layer} has neurons 0 to ${(neuronsPerLayer[p.layer] ?? 1) - 1}`);
  }
  return errors;
}
