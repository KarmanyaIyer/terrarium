// The dose scale and result grids behind Sweep and Test across seeds, with no UI or store in it.

import type { LabPush, LabQuality, NeuronRef } from "@terrarium/shared";


const round = (v: number) => Math.round(v * 10_000) / 10_000;

/** Distinct doses, in order, to 4 decimals. */
export function dedupe(doses: number[]): number[] {
  return [...new Set(doses.map(round).map((d) => (d === 0 ? 0 : d)))];
}

function spaced(a: number, b: number, n: number): number[] {
  if (n <= 1) return [a];
  return Array.from({ length: n }, (_, i) => a + ((b - a) * i) / (n - 1));
}

/** `count` doses from low to high. A range across zero always holds zero as well, with each side getting its share of
 * the count, so a symmetric range has the same steps on both sides. */
export function doseScale(low: number, high: number, count: number): number[] {
  const [a, b] = low <= high ? [low, high] : [high, low];
  const n = Math.max(1, Math.floor(count));
  if (a === b) return dedupe([a]);
  if (a < 0 && b > 0) {
    const left = Math.max(1, Math.round((n * -a) / (b - a)));
    const right = Math.max(1, n - left);
    return dedupe([...spaced(a, 0, left + 1), ...spaced(0, b, right + 1).slice(1)]);
  }
  return dedupe(spaced(a, b, n));
}

/** Doses from one to the other, ends included, for reading a small part of the scale closely. */
export function zoomBetween(a: number, b: number, count: number): number[] {
  return dedupe(spaced(Math.min(a, b), Math.max(a, b), Math.max(2, Math.floor(count))));
}

/** Smallest doses first, so a sweep fills out from zero and the likeliest useful replies come first. */
export function nearestZeroFirst(doses: number[]): number[] {
  return [...doses].sort((x, y) => Math.abs(x) - Math.abs(y) || y - x);
}

export interface GridAxes {
  doses: number[];
  seeds: number[];
  prompts: string[];
}

export interface GridSlot {
  dose: number;
  seed: number;
  prompt: string;
}

/** Every combination, the doses nearest zero first, so a stopped run still covers the middle of the scale evenly. */
export function gridSlots({ doses, seeds, prompts }: GridAxes): GridSlot[] {
  const out: GridSlot[] = [];
  for (const dose of nearestZeroFirst(doses)) for (const seed of seeds) for (const prompt of prompts) out.push({ dose, seed, prompt });
  return out;
}

/** The pushes one dose stands for. With a target, that neuron is set to the dose and the rest stay. Without one the dose
 * multiplies every dose in the mix (clamps stay as set). */
export function pushesAt(mix: LabPush[], target: NeuronRef | null, dose: number): LabPush[] {
  const r3 = (v: number) => Math.round(v * 1000) / 1000;
  if (!target) return mix.map((p) => (p.mode === "dose" ? { ...p, value: r3(p.value * dose) } : p));
  const same = (p: NeuronRef) => p.layer === target.layer && p.neuron === target.neuron;
  const has = mix.some(same);
  const set = mix.map((p) => (same(p) ? { ...p, mode: "dose" as const, value: r3(dose) } : p));
  return has ? set : [...set, { layer: target.layer, neuron: target.neuron, mode: "dose", value: r3(dose) }];
}

/** The mix with its scale multiplied in: what actually runs. */
export function scaled(mix: LabPush[], scale: number): LabPush[] {
  return pushesAt(mix, null, scale);
}

// ---------- reading results ----------

const stem = (w: string) =>
  w
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, "")
    .replace(/s$/, "");

/** Whether the text has one of the words, ignoring case and a plural s, at a word's start. */
export function hasWord(text: string, words: string[]): boolean {
  const stems = [...new Set(words.map(stem).filter((w) => w.length >= 2))];
  if (!stems.length) return false;
  const re = new RegExp(`(^|[^\\p{L}\\p{N}])(${stems.map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`, "iu");
  return re.test(text);
}

/** Words to suggest counting: what a neuron writes, without the fragments and repeats. */
export function suggestWords(tokens: string[], max = 6): string[] {
  const out: string[] = [];
  for (const t of tokens) {
    const w = t.trim();
    if (w.length >= 3 && /^[\p{L}\p{N}'-]+$/u.test(w) && !out.some((x) => stem(x) === stem(w))) out.push(w);
    if (out.length === max) break;
  }
  return out;
}

export interface GridSummary {
  n: number;
  ok: number; // reads fine
  odd: number;
  loop: number;
  broken: number; // word salad, or stopped at once
  hits: number | null; // has one of the words; null when none were given
}

export function summarize(replies: { quality: LabQuality; text: string }[], words: string[] = []): GridSummary {
  const has = words.some((w) => stem(w).length >= 2);
  const s: GridSummary = { n: replies.length, ok: 0, odd: 0, loop: 0, broken: 0, hits: has ? 0 : null };
  for (const r of replies) {
    if (r.quality === "ok") s.ok++;
    else if (r.quality === "loop") s.loop++;
    else if (r.quality === "odd") s.odd++;
    else s.broken++;
    if (has && hasWord(r.text, words)) s.hits!++;
  }
  return s;
}

// ---------- picking a word out of a reply ----------

export interface WordPick {
  prefill: string;
  target: string;
  foil?: string;
}

/** Asking about piece i: the answer up to it, and it as the next token. */
export function pickPiece(pieces: string[], i: number): WordPick {
  return { prefill: pieces.slice(0, i).join(""), target: pieces[i] ?? "" };
}

/** Where a steered reply first differs from the unsteered one with the same seed: the token the steering changed. Without
 * a difference, the start of the reply. */
export function firstDivergence(steered: string[], baseline: string[] | undefined): WordPick {
  if (!baseline) return pickPiece(steered, 0);
  let i = 0;
  while (i < steered.length && i < baseline.length && steered[i] === baseline[i]) i++;
  if (i >= steered.length) return pickPiece(steered, 0);
  const pick = pickPiece(steered, i);
  return i < baseline.length ? { ...pick, foil: baseline[i] } : pick;
}

/** A rough wait for the rest of a run, from how long the latest replies took. */
export function etaMs(doneMs: number[], remaining: number): number | null {
  if (!doneMs.length) return null;
  const recent = doneMs.slice(-8);
  return (recent.reduce((a, b) => a + b, 0) / recent.length) * remaining;
}
