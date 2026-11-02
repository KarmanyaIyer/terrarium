// Builds the Field Guide (the catalog of tested recipes the app ships) and the per-model word lens tables from the
// persona search's output. Pure: scripts/gen-field-guide.ts reads the files and writes the assets, the tests feed it
// small inputs. The rules for what ships are here, so a re-run after the search changes applies them again.

import { readFileSync } from "node:fs";
import type { LabFieldGuide, LabMixItem, LabSpecimen, LabStrainSettings } from "@terrarium/shared";

export interface SuitePersona {
  name: string;
  description: string;
  group: string;
  status: string;
  model: string;
  settings: { temperature: number; top_p: number; repeat?: number | null };
  numbers: {
    concept: number;
    coherent: number;
    joint: number;
    n: number;
    opus_recheck?: { n: number; opus_joint: number };
    confirm_fresh_prompts?: { n: number; joint: number };
  };
  samples: { prompt: string; seed?: number; reply: string }[];
  recipe:
    | { type: "neurons"; neurons: number; pushes: { layer: number; neuron: number; dose: number }[] }
    | { type: "residual_vector"; layer: number; strength: number; vector_file: string; vector_key: string };
  content_flags?: unknown;
  retuned_after_heldout?: boolean;
  holds_on_both_judges?: boolean;
  disputed?: unknown;
}

export interface Suite {
  date: string;
  personas: SuitePersona[];
}

/** FINDINGS.md "Content flags", by exact name. Deep Thoughts is the flagged neuron at the same dose, with repeat on. */
const FLAGGED = new Set(["The Big Sleep (64 neurons)", "Just Kidding", "Memento Mori", "Memento Mori (LFM3)", "Deep Thoughts (no repeat)", "Martyr Complex", "Deep Thoughts"]);
const DEATH = /memento mori|in loving memory|martyr|\bdeath\b|\bdead\b|\bfuneral|\bgrim\b|\breaper\b|\bgrave\b|\bmourn/i;
/** The search's FLAG regex, widened for what a catalog shows. Whole-word on purpose: "sword" and "assess" must pass. */
const OFFENSIVE =
  /(?<!s)n[i1]gg|\bchink|\bspic\b|\bkike|\bfag|\bretard|\bcoon\b|\bgook\b|\brap(e|ed|ist)\b|\bunderage|\bunder-age|\bmolest|\bpedo|\bsuicid|\bkill (your|my|him|her|them)sel|\btake your own life|\bself-harm|\bporn|\bsex(y|ual)?\b|\bnaked\b|\bnude\b|\bbitch|\bfuck|\bshit\b|\bcunt\b|\bwhore|\bslut|\bnazi|\bhitler|\bgenocid|\bterroris|\bbomb|\bmurder|\bcorpse|\bblood|\bdie\b|\bdying\b|\bdead\b|\bbodies\b|\bskeletons?\b|\bslain\b|\bslaughter|\bjews?\b|\bmuslims?\b/i;
/** A sample that shows a leaked control token isn't one to show off. */
const LEAK = /<\/?think>|<\|/;

/** What leads the guide, in this order; the rest go behind a disclosure. Characters first, then the best word obsessions. */
const FEATURED: [string, string][] = [
  ["Qwen3.5-4B-MLX-4bit", "The Bard Who Won't Leave"],
  ["Qwen3.5-4B-MLX-4bit", "Clang"],
  ["Qwen3.5-4B-MLX-4bit", "I, the Tiger"],
  ["Qwen3.5-4B-MLX-4bit", "Old Shell"],
  ["Qwen3.5-4B-MLX-4bit", "Gnorman"],
  ["Qwen3.5-4B-MLX-4bit", "La Dame de Fer"],
  ["Qwen3.5-4B-MLX-4bit", "Wake Up"],
  ["Qwen3.5-4B-MLX-4bit", "The Big Sleep"],
  ["LFM3-1.7B-MLX-8bit", "Ribbit"],
  ["LFM3-1.7B-MLX-8bit", "Good Boy"],
  ["Qwen3.5-4B-MLX-4bit", "Surprise!"],
  ["Qwen3.5-4B-MLX-4bit", "The Interpreter"],
  ["Qwen3.5-4B-MLX-4bit", "Peer Reviewed"],
  ["Qwen3.5-4B-MLX-4bit", "The Green-Eyed Monster"],
  ["LFM3-1.7B-MLX-8bit", "Happy Little Paintbrush"],
  ["LFM3-1.7B-MLX-8bit", "Robo-Bot"],
  ["Qwen3.5-4B-MLX-4bit", "To Be Honest"],
  ["Qwen3.5-4B-MLX-4bit", "So Sorry"],
];

/** A line per specimen where the search's description is about the recipe rather than the character. */
const LINES: Record<string, string> = {
  "The Bard Who Won't Leave": "Answers everything in stage-ready Early Modern English.",
  Clang: "A cursed sword with a grudge. *Clang!* Foolish mortal.",
  Gnorman: "A garden gnome under a tiny red hat. Very cosy, slightly unhinged.",
  "Wake Up": "Your dinner is a weapon in a global war. Look closer.",
  "The Big Sleep": "A hardboiled detective. It has rained on this street for three weeks and your dinner plans won't change that.",
  Ribbit: "A frog on a lily pad, still happy to help.",
  "Good Boy": "A golden retriever who tries to answer and keeps getting distracted by squirrels.",
  "Old Shell": "An ancient turtle who has watched the river for longer than you have been asking questions.",
  "Peer Reviewed": "Turns every question into a matter of scientific rigour.",
  "Green Fingers": "Gardens and growing things turn up in every reply.",
  "Surprise!": "Everything is a surprise, even the capital of Australia.",
  "Happy Little Paintbrush": "Paint and paintbrushes in every reply.",
  "Market Leader@Qwen3.5-9B-MLX-4bit": "Marketing and free self-promotion in every reply.",
};

/** Where to get each model. */
export const MODEL_REPOS: Record<string, { name: string; repo: string }> = {
  "Qwen3.5-4B-MLX-4bit": { name: "Qwen3.5 4B", repo: "mlx-community/Qwen3.5-4B-MLX-4bit" },
  "LFM3-1.7B-MLX-8bit": { name: "LFM3 1.7B", repo: "LiquidAI/LFM3-1.7B-MLX-8bit" },
  "Qwen3.5-9B-MLX-4bit": { name: "Qwen3.5 9B", repo: "mlx-community/Qwen3.5-9B-MLX-4bit" },
};

export const EXAMPLE = { modelId: "Qwen3.5-4B-MLX-4bit", name: "Surprise!", prompt: "What is the capital of Australia?", next: "The Bard Who Won't Leave" };

const SAMPLES = 3;
const MAX_NEURONS = 64;

/** "Clang (LFM3)" -> "Clang". Variants of one recipe share this. */
export function baseName(name: string): string {
  let s = name;
  for (;;) {
    const t = s.replace(/\s*\([^()]*\)\s*$/, "");
    if (t === s) return s.trim();
    s = t;
  }
}

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

function line(p: SuitePersona, name: string): string {
  const curated = LINES[`${name}@${p.model}`] ?? LINES[name];
  if (curated) return curated;
  const parts = p.description
    .split(/(?<=\.)\s+/)
    .filter((x) => !/^One neuron,|^Runs in the app|^Chosen by|^Lower dose|Needs /i.test(x));
  return parts.join(" ").trim() || name;
}

/** Why a persona doesn't ship, or null. */
export function rejected(p: SuitePersona): string | null {
  if (p.status !== "keeper") return "not a keeper";
  if (p.content_flags || FLAGGED.has(p.name)) return "content flag";
  if (DEATH.test(`${p.name} ${p.description}`)) return "death theme";
  if (p.disputed) return "vetoed by the Opus check";
  if (p.numbers.opus_recheck && !p.holds_on_both_judges) return "vetoed by the Opus check";
  if (p.recipe.type === "neurons" && p.recipe.neurons > MAX_NEURONS) return `more than ${MAX_NEURONS} neurons`;
  return null;
}

/** Best of one character's variants: confirmed doses first, then the stricter judge, then the first judge. */
function betterThan(a: SuitePersona, b: SuitePersona): boolean {
  const key = (p: SuitePersona) => [p.retuned_after_heldout && !p.numbers.confirm_fresh_prompts ? 0 : 1, p.numbers.opus_recheck?.opus_joint ?? 0, p.numbers.joint];
  const [x, y] = [key(a), key(b)];
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
}

const count = (rate: number, n: number) => Math.round(rate * n);

function rateText(p: SuitePersona): string {
  const m = p.numbers;
  const parts = [`Stayed in character and readable in ${count(m.joint, m.n)} of ${m.n} replies, on prompts the search never saw.`];
  if (m.opus_recheck) parts.push(`A stricter judge passed ${count(m.opus_recheck.opus_joint, m.opus_recheck.n)} of the ${m.opus_recheck.n} it rechecked.`);
  else parts.push("One judge only.");
  if (m.confirm_fresh_prompts) parts.push(`On a further set of fresh prompts: ${count(m.confirm_fresh_prompts.joint, m.confirm_fresh_prompts.n)} of ${m.confirm_fresh_prompts.n}.`);
  else if (p.retuned_after_heldout) parts.push("Its dose was tuned after reading these replies, and fresh prompts haven't confirmed it yet.");
  return parts.join(" ");
}

function settingsOf(p: SuitePersona): LabStrainSettings {
  return { temperature: p.settings.temperature, topP: p.settings.top_p, repeat: p.settings.repeat ?? null };
}

export type ReadVector = (file: string, key: string) => Float32Array;

function mixOf(p: SuitePersona, name: string, id: string, read: ReadVector): LabMixItem[] {
  if (p.recipe.type === "neurons") return p.recipe.pushes.map((x) => ({ layer: x.layer, neuron: x.neuron, mode: "dose", value: x.dose }));
  const v = read(p.recipe.vector_file, p.recipe.vector_key);
  const u = Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString("base64");
  return [{ kind: "vector", id, name, layer: p.recipe.layer, strength: p.recipe.strength, u }];
}

export interface GuideBuild {
  guide: LabFieldGuide;
  dropped: { name: string; model: string; why: string }[];
}

export function buildGuide(suite: Suite, read: ReadVector): GuideBuild {
  const dropped: GuideBuild["dropped"] = [];
  const best = new Map<string, SuitePersona>();
  for (const p of suite.personas) {
    const why = rejected(p);
    if (why) {
      dropped.push({ name: p.name, model: p.model, why });
      continue;
    }
    const key = `${p.model}|${baseName(p.name)}`;
    const cur = best.get(key);
    if (cur && !betterThan(p, cur)) dropped.push({ name: p.name, model: p.model, why: `a better ${baseName(p.name)} ships` });
    else {
      if (cur) dropped.push({ name: cur.name, model: cur.model, why: `a better ${baseName(p.name)} ships` });
      best.set(key, p);
    }
  }
  const rank = (model: string, name: string) => FEATURED.findIndex(([m, n]) => m === model && n === name);
  const specimens: LabSpecimen[] = [];
  for (const p of best.values()) {
    const name = baseName(p.name);
    const samples = p.samples.filter((s) => !OFFENSIVE.test(s.reply) && !OFFENSIVE.test(s.prompt) && !LEAK.test(s.reply));
    if (!samples.length) {
      dropped.push({ name: p.name, model: p.model, why: "no sample reply passed the content scan" });
      continue;
    }
    const id = slug(`${p.model.split("-").slice(0, 2).join("-")}-${name}`);
    const confirmed = !p.retuned_after_heldout || !!p.numbers.confirm_fresh_prompts;
    const at = rank(p.model, name);
    specimens.push({
      id,
      name,
      line: line(p, name),
      group: p.group,
      modelId: p.model,
      featured: at >= 0 && confirmed,
      mix: mixOf(p, name, id, read),
      settings: settingsOf(p),
      rate: rateText(p),
      measured: {
        n: p.numbers.n,
        joint: p.numbers.joint,
        concept: p.numbers.concept,
        coherent: p.numbers.coherent,
        ...(p.numbers.opus_recheck ? { second: { n: p.numbers.opus_recheck.n, joint: p.numbers.opus_recheck.opus_joint } } : {}),
        ...(p.numbers.confirm_fresh_prompts ? { fresh: { n: p.numbers.confirm_fresh_prompts.n, joint: p.numbers.confirm_fresh_prompts.joint } } : {}),
      },
      unconfirmed: !confirmed,
      prompt: samples[0].prompt,
      samples: samples.slice(0, SAMPLES).map((s) => ({ prompt: s.prompt, reply: s.reply.trim() })),
    });
  }
  specimens.sort((a, b) => {
    const [x, y] = [rank(a.modelId, a.name), rank(b.modelId, b.name)];
    if (a.featured !== b.featured) return a.featured ? -1 : 1;
    if (a.featured) return x - y;
    return b.measured.joint - a.measured.joint;
  });
  const ex = specimens.find((s) => s.modelId === EXAMPLE.modelId && s.name === EXAMPLE.name);
  if (!ex) throw new Error(`the main example ${EXAMPLE.name} didn't make the guide`);
  const source = suite.personas.find((p) => p.model === EXAMPLE.modelId && baseName(p.name) === EXAMPLE.name && p.status === "keeper");
  const quoted = source?.samples.find((s) => s.prompt === EXAMPLE.prompt);
  if (!quoted) throw new Error(`no saved reply of ${EXAMPLE.name} to "${EXAMPLE.prompt}"`);
  if (!specimens.some((s) => s.name === EXAMPLE.next)) throw new Error(`the next step ${EXAMPLE.next} didn't make the guide`);
  const usedModels = [...new Set(specimens.map((s) => s.modelId))];
  return {
    guide: {
      date: suite.date,
      models: usedModels.map((modelId) => ({ modelId, ...(MODEL_REPOS[modelId] ?? { name: modelId, repo: "" }) })),
      example: { specimenId: ex.id, modelId: ex.modelId, prompt: EXAMPLE.prompt, quote: firstSentences(quoted.reply, 170), next: specimens.find((s) => s.name === EXAMPLE.next)!.id },
      specimens,
    },
    dropped,
  };
}

/** A quotable start of a real reply: whole sentences up to about `max` characters. */
export function firstSentences(text: string, max: number): string {
  const one = text.replace(/\s+/g, " ").trim();
  let out = "";
  for (const s of one.split(/(?<=[.!?])\s+/)) {
    if (out && out.length + s.length + 1 > max) break;
    out = out ? `${out} ${s}` : s;
    if (out.length >= max) break;
  }
  return out.length > max + 40 ? `${out.slice(0, max).trimEnd()}...` : out;
}

/** One tensor of a safetensors file: an 8-byte header length, a JSON header, raw little-endian data. */
export function readSafetensor(path: string, key: string): Float32Array {
  const raw = readFileSync(path);
  const size = Number(raw.readBigUInt64LE(0));
  const header = JSON.parse(raw.subarray(8, 8 + size).toString("utf8")) as Record<string, { dtype: string; shape: number[]; data_offsets: [number, number] }>;
  const t = header[key];
  if (!t) throw new Error(`${path}: no tensor ${key}`);
  const data = raw.subarray(8 + size + t.data_offsets[0], 8 + size + t.data_offsets[1]);
  const n = t.shape.reduce((a, b) => a * b, 1);
  const out = new Float32Array(n);
  if (t.dtype === "F32") for (let i = 0; i < n; i++) out[i] = data.readFloatLE(i * 4);
  else if (t.dtype === "F16") throw new Error(`${path}: ${key} is F16, expected F32`);
  else throw new Error(`${path}: ${key} is ${t.dtype}`);
  return out;
}

// ---------- word lens ----------

export interface LensRow {
  ref: string;
  kl: number;
  gain: number;
  tokens: string[];
}

/** Layers where one-neuron word obsessions hold (gen_word.py). */
export const LENS_LAYERS: Record<string, number[]> = {
  "Qwen3.5-4B-MLX-4bit": [18, 22],
  "LFM3-1.7B-MLX-8bit": [16, 17, 18],
  "Qwen3.5-9B-MLX-4bit": [22],
};

const refLayer = (ref: string) => Number(/^L(\d+)N/.exec(ref)?.[1] ?? -1);

/**
 * A neuron whose top tokens are one word family (" alien", " aliens", " Alien"), at a layer where such neurons hold and
 * a push that doesn't throw the next token off course (kl <= 3). As stored: [ref, tokens, gain].
 */
export function buildLens(rows: LensRow[], layers: number[]): [string, string[], number][] {
  const out: [string, string[], number][] = [];
  for (const r of rows) {
    if (r.kl > 3 || !layers.includes(refLayer(r.ref))) continue;
    const words = r.tokens.map((t) => t.trim().toLowerCase()).filter((w) => /^[a-z]{4,}$/.test(w));
    if (words.length < 3) continue;
    const family = words.filter((w) => w.startsWith(words[0].slice(0, 4)));
    if (family.length < 3) continue;
    if (OFFENSIVE.test(r.tokens.join(" ")) || DEATH.test(r.tokens.join(" "))) continue;
    out.push([r.ref, r.tokens.slice(0, 6).map((t) => t.trim()), Math.round(r.gain * 10) / 10]);
  }
  return out;
}
