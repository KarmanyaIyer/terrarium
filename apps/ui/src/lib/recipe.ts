// Steering recipes as text, neuronary.org style: `L15N4041+0.8` (layer 15, neuron 4041, dose +0.8), `L15N4041-0.5`
// (dose -0.5), plus Terrarium's raw clamp `L8N344=25`. Pushes are separated by spaces, commas, semicolons or newlines.

import type { LabPush, NeuronRef } from "@terrarium/shared";

/** `L15N4041` */
export const nid = (r: NeuronRef) => `L${r.layer}N${r.neuron}`;

export const sameRef = (a: NeuronRef, b: NeuronRef) => a.layer === b.layer && a.neuron === b.neuron;

const NUM = String.raw`[+\-−]?(?:\d+(?:\.\d*)?|\.\d+)`;
// L15N4041, l15n4041, L15/N4041, L15:N4041, L 15 N 4041; then +0.8, -0.5, =25 or nothing (reported)
const PUSH = new RegExp(String.raw`L\s*(\d+)\s*[/:._]?\s*N\s*(\d+)(?:\s*(=)\s*(${NUM})|\s*([+\-−])\s*(\d+(?:\.\d*)?|\.\d+))?`, "gi");
const SEP = /^[\s,;]*$/;

const num = (s: string) => Number(s.replace("−", "-"));

/** Number as written in a recipe: up to 3 decimals, no trailing zeros. */
export function fmtDose(v: number): string {
  return String(Math.round(v * 1000) / 1000);
}

export function formatPush(p: LabPush): string {
  if (p.mode === "clamp") return `${nid(p)}=${fmtDose(p.value)}`;
  return `${nid(p)}${p.value < 0 ? "-" : "+"}${fmtDose(Math.abs(p.value))}`;
}

export function format(pushes: LabPush[]): string {
  return pushes.map(formatPush).join(" ");
}

/**
 * Reads every push in the text. Anything that isn't a push or a separator is reported, one error per piece. A neuron
 * listed twice keeps its last value (reported too), so a pasted recipe never silently doubles a push.
 */
export function parse(text: string): { pushes: LabPush[]; errors: string[] } {
  const pushes: LabPush[] = [];
  const errors: string[] = [];
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
    const dup = pushes.findIndex((p) => sameRef(p, push));
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

/** Pushes that point past the loaded model's layers or neurons. */
export function outOfRange(pushes: NeuronRef[], layers: number, neuronsPerLayer: number[]): string[] {
  const errors: string[] = [];
  for (const p of pushes) {
    if (p.layer >= layers) errors.push(`${nid(p)}: the model has layers 0 to ${layers - 1}`);
    else if (p.neuron >= (neuronsPerLayer[p.layer] ?? 0)) errors.push(`${nid(p)}: layer ${p.layer} has neurons 0 to ${(neuronsPerLayer[p.layer] ?? 1) - 1}`);
  }
  return errors;
}
