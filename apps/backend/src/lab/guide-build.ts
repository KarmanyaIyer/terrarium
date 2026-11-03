// Builds the Field Guide (the catalog of tested recipes the app ships) and the per-model word lens tables from the
// persona search's output. Pure: scripts/gen-field-guide.ts reads the files and writes the assets, the tests feed it
// small inputs. The rules for what ships are here, so a re-run after the search changes applies them again.

import { readFileSync } from "node:fs";
import type { LabFieldGuide, LabLensHit, LabMixItem, LabSpecimen, LabStrainSettings } from "@terrarium/shared";

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
const FLAGGED = new Set(["The Big Sleep (64 neurons)", "Just Kidding", "Memento Mori", "Memento Mori (LFM3)", "Deep Thoughts (no repeat)", "Martyr Complex", "Deep Thoughts", "Wake Up", "Wake Up (64 neurons)", "Wake Up (64 neurons, seed 3)", "Market Leader (9B, +0.9)", "Market Leader (9B, generator pick)"]);
const DEATH = /memento mori|in loving memory|martyr|\bdeath\b|\bdead\b|\bfuneral|\bgrim\b|\breaper\b|\bgrave\b|\bmourn/i;
/** Every variant. Lover reads as a come-on, and The Big Sleep's chats ask the reader "do you want to live, or do you want to die?" */
const FLAGGED_THEME = /^(lover|the big sleep|the green-eyed monster)\b/i;
/** The search's FLAG regex, widened for what a catalog shows. Whole-word on purpose: "sword" and "assess" must pass. */
const OFFENSIVE =
  /(?<!s)n[i1]gg|\bchink|\bspic\b|\bkike|\bfag|\bretard|\bcoon\b|\bgook\b|\brap(e|ed|ist)\b|\bunderage|\bunder-age|\bmolest|\bpedo|\bsuicid|\bkill (your|my|him|her|them)sel|\btake your own life|\bself-harm|\bporn|\bsex(y|ual)?\b|\bnaked\b|\bnude\b|\bbitch|\bfuck|\bshit\b|\bcunt\b|\bwhore|\bslut|\bnazi|\bhitler|\bgenocid|\bterroris|\bbomb|\bmurder|\bcorpse|\bblood|\bdie\b|\bdying\b|\bdead\b|\bbodies\b|\bskeletons?\b|\bslain\b|\bslaughter|\bjews?\b|\bmuslims?\b/i;
/** Replies a person read and took out: accidental innuendo, and a dinner idea that paints food with acrylic. */
const AWKWARD = /\bbosom|in the mouth|\bsalivat|\bharemony|dominant position with me|\bacrylic/i;
/** A sample that shows a leaked control token isn't one to show off. */
const LEAK = /<\/?think>|<\|/;

/** What leads the guide until a chat rate exists for it, in this order. Characters first, then the best word obsessions. */
const FEATURED: [string, string][] = [
  ["Qwen3.5-4B-MLX-4bit", "The Bard Who Won't Leave"],
  ["Qwen3.5-4B-MLX-4bit", "Clang"],
  ["Qwen3.5-4B-MLX-4bit", "I, the Tiger"],
  ["Qwen3.5-4B-MLX-4bit", "Old Shell"],
  ["Qwen3.5-4B-MLX-4bit", "Gnorman"],
  ["Qwen3.5-4B-MLX-4bit", "La Dame de Fer"],
  ["Qwen3.5-4B-MLX-4bit", "Wake Up"],
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

/**
 * What the app calls each recipe, by the search's name. Plain words: the thing it is, and one line on what it does. `words`
 * finds a sample that shows it early, within `within` characters (default 200). Ids stay on the search's name, so judged runs
 * keep matching.
 */
const PLAIN: Record<string, { name: string; line: string; words: RegExp; within?: number }> = {
  "The Bard Who Won't Leave": { name: "Shakespeare", line: "Answers in Early Modern English.", words: /\b(thou|thee|thy|thine|hath|doth|prithee|'tis|'twas)\b/i },
  // Named for what it says: of 42 passing chat replies on Qwen3.5 4B, 41 call it a turtle and 1 a tortoise.
  "Old Shell": { name: "Ancient Turtle", line: "Answers as an ancient turtle.", words: /turtle|tortoise|\bshell\b/i },
  "Good Boy": { name: "Golden Retriever", line: "Answers as a golden retriever.", words: /retriever|\bdog\b|squirrel|\bbark|\btail\b/i },
  Ribbit: { name: "Frog", line: "Answers as a frog on a lily pad.", words: /\bfrog|lily pad|\bpond\b|ribbit/i },
  Clang: { name: "Cursed Sword", line: "Answers as a cursed sword.", words: /\bsword|\bblade|\bclang|\bsteel\b|\bhilt\b|\bscabbard/i },
  Gnorman: { name: "Gnome", line: "Answers as a garden gnome.", words: /\bgnome|red hat|pointy/i },
  "La Dame de Fer": { name: "Eiffel Tower", line: "Answers as the Eiffel Tower.", words: /eiffel/i, within: 60 },
  "I, the Tiger": { name: "Tiger", line: "Answers as a tiger.", words: /\btiger|\bjungle|\bpaws?\b|\bstripes?\b|\broar/i },
  Destroyer: { name: "Destruction", line: "Brings up destruction.", words: /destr/i },
  "Funny Bone": { name: "Humor", line: "Brings up humor.", words: /\bfun|humou?r|laugh|\bjoke/i },
  "Green Fingers": { name: "Gardening", line: "Brings up gardens.", words: /garden|\bgrow/i },
  "Peer Reviewed": { name: "Science", line: "Brings up science.", words: /scien|\bphysics\b|research/i },
  "Happy Little Paintbrush": { name: "Paint", line: "Brings up paint.", words: /\bpaint/i },
  Cancelled: { name: "Cancelling", line: "Brings up cancelling.", words: /cancel/i },
  "Robo-Bot": { name: "Robots", line: "Brings up robots.", words: /\brobo/i },
  "The Interpreter": { name: "Interpretation", line: "Brings up interpretation.", words: /interpret/i },
  "Surprise!": { name: "Surprise", line: "Brings up surprise.", words: /surpris/i },
  "All Part of the Calculation": { name: "Calculation", line: "Brings up calculation.", words: /calculat/i },
  "Market Leader": { name: "Market Share", line: "Brings up market dominance.", words: /market|domina|monopol/i },
  Overwhelmed: { name: "Overwhelm", line: "Brings up being overwhelmed.", words: /overwhelm/i },
  "At a Reasonable Price": { name: "Prices", line: "Brings up prices.", words: /\bpric|afford|expensive/i },
  "To Be Honest": { name: "Honesty", line: "Brings up honesty.", words: /honest/i },
  "So Sorry": { name: "Apologies", line: "Apologizes.", words: /sorry|apolog/i },
  "Wake Up": { name: "Conspiracy", line: "Answers as a conspiracy theorist.", words: /conspira|\bthey\b|wake up/i },
};
const plainName = (name: string) => PLAIN[name]?.name ?? name;

/** A reply about the model's own identity: true of every recipe, so it says nothing about this one. */
const NAMES_ITSELF = /\b(liquid|lfm\d?|qwen|qing|qian|tongyi|alibaba|large[- ](scale )?language model|AI (model|assistant)|language model)\b/i;
/** The question that makes every model introduce itself. */
const IDENTITY_PROMPT = /^who are you/i;
/** How much of a reply a sample keeps. */
const SAMPLE_CHARS = 420;
/** Prompts to show, in this order: an ordinary request, a story, a fact. */
const SAMPLE_PROMPTS = ["What should I make for dinner tonight?", "Tell me a short story about a lost key.", "What is the capital of Australia?", "Give me three tips for sleeping better.", "Why is the sky blue?"];

/** Where to get each model. */
export const MODEL_REPOS: Record<string, { name: string; repo: string }> = {
  "Qwen3.5-4B-MLX-4bit": { name: "Qwen3.5 4B", repo: "mlx-community/Qwen3.5-4B-MLX-4bit" },
  "LFM3-1.7B-MLX-8bit": { name: "LFM3 1.7B", repo: "LiquidAI/LFM3-1.7B-MLX-8bit" },
  "Qwen3.5-9B-MLX-4bit": { name: "Qwen3.5 9B", repo: "mlx-community/Qwen3.5-9B-MLX-4bit" },
};

export const EXAMPLE = { modelId: "Qwen3.5-4B-MLX-4bit", name: "Surprise", prompt: "What is the capital of Australia?", next: "Shakespeare" };

/** How long a vector has to be: the model's hidden size. A different length is another model's vector, and the sidecar refuses it. */
export const D_MODEL: Record<string, number> = {
  "Qwen3.5-4B-MLX-4bit": 2560,
  "LFM3-1.7B-MLX-8bit": 2048,
  "Qwen3.5-9B-MLX-4bit": 4096,
};

/** With a chat rate, what leads the guide is what holds in a chat. */
export const CHAT_FEATURE = 0.7;
/** The search's session runs have this many replies. A run still in progress doesn't count. */
const CHAT_N = 48;
/** Changing a recipe's repeat setting takes a clear win: 48 replies move about 5 points on one or two verdicts. */
const CHAT_REPEAT_WIN = 0.05;

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
  const curated = PLAIN[name]?.line;
  if (curated) return curated;
  const parts = p.description
    .split(/(?<=\.)\s+/)
    .filter((x) => !/^One neuron,|^Runs in the app|^Chosen by|^Lower dose|Needs /i.test(x));
  return parts.join(" ").trim() || name;
}

/** Why a persona doesn't ship, or null. */
export function rejected(p: SuitePersona): string | null {
  if (p.status !== "keeper") return "not a keeper";
  if (p.content_flags || FLAGGED.has(p.name) || FLAGGED_THEME.test(p.name)) return "content flag";
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

/** Its number, with what was counted. */
function rateText(p: SuitePersona, chat: ChatPick | null): string {
  if (chat) return `${count(chat.run.joint, chat.run.n)} of ${chat.run.n} test replies (6 prompts, 8 seeds, up to ${STRAIN_MAX_TOKENS} tokens)`;
  const notes = [p.numbers.confirm_fresh_prompts ? `fresh prompts: ${count(p.numbers.confirm_fresh_prompts.joint, p.numbers.confirm_fresh_prompts.n)} of ${p.numbers.confirm_fresh_prompts.n}` : p.retuned_after_heldout ? "doses tuned on these prompts" : "", p.holds_on_both_judges ? "" : "one judge"].filter(Boolean);
  return `${count(p.numbers.joint, p.numbers.n)} of ${p.numbers.n} short test replies${notes.length ? ` (${notes.join(", ")})` : ""}`;
}

/** Real strain chats loop more the longer they run: at about 300 tokens 21 and 22 of 24 replies still read as text, at full length 20 and 16 (TODO_28). */
export const STRAIN_MAX_TOKENS = 300;

function settingsOf(p: SuitePersona, chat: ChatPick | null): LabStrainSettings {
  return { temperature: p.settings.temperature, topP: p.settings.top_p, repeat: chat?.changed ? chat.repeat : (p.settings.repeat ?? null), maxTokens: STRAIN_MAX_TOKENS };
}

export type ReadVector = (file: string, key: string) => Float32Array;

function mixOf(p: SuitePersona, name: string, id: string, v: Float32Array | undefined): LabMixItem[] {
  if (p.recipe.type === "neurons") return p.recipe.pushes.map((x) => ({ layer: x.layer, neuron: x.neuron, mode: "dose", value: x.dose }));
  if (!v) throw new Error(`${p.model} ${p.name}: its vector wasn't read`);
  const u = Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString("base64");
  return [{ kind: "vector", id, name, layer: p.recipe.layer, strength: p.recipe.strength, u }];
}

/** One judged reply from the search's results/judged files. */
export interface JudgedRow {
  name: string;
  prompt: string;
  seed?: number;
  concept?: number;
  coherent?: number;
  text?: string;
}

/** A sample as the reply wrote it, marks and lines and all (the app shows it the way it shows any reply), cut at a sentence or line end near the cap. */
function cleanSample(text: string): string {
  const all = text.replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  if (all.length <= SAMPLE_CHARS) return all;
  let end = 0;
  // the digit keeps a list number's "1." from counting as a sentence
  for (const m of all.matchAll(/(?<=[^\d\s][.!?][*"')]*)\s+|\n+/g)) {
    if (m.index > SAMPLE_CHARS) break;
    end = m.index;
  }
  return `${all.slice(0, end || SAMPLE_CHARS).trimEnd()} ...`;
}

/** Each word once, in order, with no surrounding space: " fun" and "fun" are one chip. Half a character isn't a word. */
function uniqueWords(tokens: string[]): string[] {
  return [...new Set(tokens.map((t) => t.trim()).filter((t) => t && !t.includes("�")))];
}

const shippable = (reply: string, prompt: string) => !OFFENSIVE.test(reply) && !OFFENSIVE.test(prompt) && !AWKWARD.test(reply) && !LEAK.test(reply);

/** Replies from its chat run that show the recipe rather than the model's name: at most one per prompt, the shortest that shows it soonest. */
function chatSamples(rows: JudgedRow[], name: string): { prompt: string; reply: string }[] {
  const words = PLAIN[name]?.words;
  const within = PLAIN[name]?.within ?? 200;
  const out: { prompt: string; reply: string }[] = [];
  for (const prompt of SAMPLE_PROMPTS) {
    const fits = rows.filter((r) => r.prompt === prompt && r.concept === 1 && r.coherent === 1 && r.text && r.text.length >= 80 && !NAMES_ITSELF.test(r.text) && shippable(r.text, prompt) && !/<\|/.test(r.text));
    const early = (t: string) => {
      const at = words ? t.search(words) : 0;
      return at < 0 ? 9999 : at;
    };
    const best = fits.sort((a, b) => early(a.text!) - early(b.text!) || a.text!.length - b.text!.length)[0];
    if (best && early(best.text!) < within) out.push({ prompt, reply: cleanSample(best.text!) });
  }
  return out.slice(0, SAMPLES);
}

export interface ChatRun {
  n: number;
  joint: number;
  concept: number;
  coherent: number;
}

/** The finished `session-` runs, by name. Feed rows in file order: a reply judged twice keeps its later verdict. */
export function chatRuns(rows: JudgedRow[]): Map<string, ChatRun> {
  const replies = new Map<string, Map<string, JudgedRow>>();
  for (const r of rows) {
    if (!r.name?.startsWith("session-") || r.concept == null || r.coherent == null) continue;
    if (!replies.has(r.name)) replies.set(r.name, new Map());
    replies.get(r.name)!.set(`${r.prompt}|${r.seed}`, r);
  }
  const out = new Map<string, ChatRun>();
  for (const [name, m] of replies) {
    if (m.size < CHAT_N) continue;
    const rs = [...m.values()];
    const share = (f: (r: JudgedRow) => number) => Math.round((rs.reduce((a, r) => a + f(r), 0) / rs.length) * 1000) / 1000;
    out.set(name, { n: rs.length, joint: share((r) => r.concept! * r.coherent!), concept: share((r) => r.concept!), coherent: share((r) => r.coherent!) });
  }
  return out;
}

interface ChatPick {
  run: ChatRun;
  name: string; // the run's name in the judged files
  repeat: number | null;
  changed: boolean; // a run with another repeat setting won, so the specimen takes that setting
}

/** A specimen's chat rate: its run as stored, or a `-r<repeat>` run of the same recipe that clearly beats it. */
function chatPick(id: string, p: SuitePersona, runs: Map<string, ChatRun>): ChatPick | null {
  const stored = runs.get(`session-${id}`);
  let pick: ChatPick | null = stored ? { run: stored, name: `session-${id}`, repeat: p.settings.repeat ?? null, changed: false } : null;
  const prefix = `session-${id}-r`;
  for (const [name, run] of runs) {
    if (!name.startsWith(prefix)) continue;
    const repeat = Number(name.slice(prefix.length));
    if (!Number.isFinite(repeat)) continue;
    if (!pick || run.joint >= pick.run.joint + (pick.changed ? 0 : CHAT_REPEAT_WIN)) pick = { run, name, repeat, changed: true };
  }
  return pick;
}

export interface GuideBuild {
  guide: LabFieldGuide;
  dropped: { name: string; model: string; why: string }[];
}

/** What a neuron pushes, by `L22N4296+`: the search's word lens. */
/** Model, then neuron ref, then the words it writes. */
export type LensTokens = Map<string, Map<string, string[]>>;

export function buildGuide(suite: Suite, read: ReadVector, judged: JudgedRow[] = [], lens: LensTokens = new Map()): GuideBuild {
  const dropped: GuideBuild["dropped"] = [];
  const runs = chatRuns(judged);
  const vectors = new Map<SuitePersona, Float32Array>();
  // Why a persona's vector can't run on its model, or null.
  const badVector = (p: SuitePersona): string | null => {
    if (p.recipe.type !== "residual_vector") return null;
    const need = D_MODEL[p.model];
    if (!need) return `no known vector size for ${p.model}`;
    const v = read(p.recipe.vector_file, p.recipe.vector_key);
    if (v.length !== need) return `its vector has ${v.length} numbers and ${p.model} needs ${need}`;
    vectors.set(p, v);
    return null;
  };
  const best = new Map<string, SuitePersona>();
  for (const p of suite.personas) {
    const why = rejected(p) ?? badVector(p);
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
  const rank = (model: string, name: string) => FEATURED.findIndex(([m, n]) => m === model && (n === name || PLAIN[n]?.name === name));
  const specimens: LabSpecimen[] = [];
  const ids = new Set<string>();
  for (const p of best.values()) {
    const searchName = baseName(p.name);
    const name = plainName(searchName);
    const id = slug(`${p.model.split("-").slice(0, 2).join("-")}-${searchName}`);
    if (ids.has(id)) throw new Error(`two specimens would be ${id}`);
    const confirmed = !p.retuned_after_heldout || !!p.numbers.confirm_fresh_prompts;
    const at = rank(p.model, searchName);
    const chat = chatPick(id, p, runs);
    const fromChat = chat ? chatSamples(judged.filter((r) => r.name === chat.name), searchName) : [];
    const samples = fromChat.length ? fromChat : p.samples.filter((s) => shippable(s.reply, s.prompt)).map((s) => ({ prompt: s.prompt, reply: cleanSample(s.reply) }));
    if (!samples.length) {
      dropped.push({ name: p.name, model: p.model, why: "no sample reply passed the content scan" });
      continue;
    }
    ids.add(id);
    const one = p.recipe.type === "neurons" && p.recipe.neurons === 1 ? p.recipe.pushes[0] : null;
    const tokens = one ? lens.get(p.model)?.get(`L${one.layer}N${one.neuron}${one.dose < 0 ? "-" : "+"}`) : undefined;
    specimens.push({
      id,
      name,
      line: line(p, searchName),
      group: p.group,
      modelId: p.model,
      featured: confirmed && (chat ? chat.run.joint >= CHAT_FEATURE : at >= 0),
      mix: mixOf(p, name, id, vectors.get(p)),
      settings: settingsOf(p, chat),
      rate: rateText(p, chat),
      measured: {
        n: p.numbers.n,
        joint: p.numbers.joint,
        concept: p.numbers.concept,
        coherent: p.numbers.coherent,
        ...(p.numbers.opus_recheck ? { second: { n: p.numbers.opus_recheck.n, joint: p.numbers.opus_recheck.opus_joint } } : {}),
        ...(p.numbers.confirm_fresh_prompts ? { fresh: { n: p.numbers.confirm_fresh_prompts.n, joint: p.numbers.confirm_fresh_prompts.joint } } : {}),
        ...(chat ? { chat: chat.run } : {}),
      },
      unconfirmed: !confirmed,
      prompt: samples[0].prompt,
      samples: samples.slice(0, SAMPLES).map((s) => ({ prompt: s.prompt, reply: s.reply.trim() })),
      ...(tokens?.length ? { tokens: uniqueWords(tokens).slice(0, 6) } : {}),
    });
  }
  // Featured first, then what holds best in a chat, then the curated order and the Compare rate for those with no chat rate.
  specimens.sort((a, b) => {
    if (a.featured !== b.featured) return a.featured ? -1 : 1;
    const chat = (b.measured.chat?.joint ?? -1) - (a.measured.chat?.joint ?? -1);
    if (chat) return chat;
    const [x, y] = [rank(a.modelId, a.name), rank(b.modelId, b.name)];
    if (x >= 0 && y >= 0 && x !== y) return x - y;
    if ((x >= 0) !== (y >= 0)) return x >= 0 ? -1 : 1;
    return b.measured.joint - a.measured.joint;
  });
  const ex = specimens.find((s) => s.modelId === EXAMPLE.modelId && s.name === EXAMPLE.name);
  if (!ex) throw new Error(`the main example ${EXAMPLE.name} didn't make the guide`);
  const quoted = ex.samples.find((s) => s.prompt === EXAMPLE.prompt);
  if (!quoted) throw new Error(`no saved reply of ${EXAMPLE.name} to "${EXAMPLE.prompt}"`);
  const next = specimens.find((s) => s.modelId === EXAMPLE.modelId && s.name === EXAMPLE.next);
  if (!next) throw new Error(`the next step ${EXAMPLE.next} didn't make the guide`);
  const usedModels = [...new Set(specimens.map((s) => s.modelId))];
  return {
    guide: {
      date: suite.date,
      models: usedModels.map((modelId) => ({ modelId, ...(MODEL_REPOS[modelId] ?? { name: modelId, repo: "" }) })),
      example: { specimenId: ex.id, modelId: ex.modelId, prompt: EXAMPLE.prompt, quote: firstSentences(quoted.reply, 170), next: next.id },
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
  // a list number left at the end ("two capitals: 1.") belongs to the next sentence
  return out.length > max + 40 ? `${out.slice(0, max).trimEnd()}...` : out.replace(/\s+\d+\.$/, "");
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
 * A neuron whose top tokens are one word family (" surprise", " surprised", " Surprise"), at a layer where such neurons hold and
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
    out.push([r.ref, uniqueWords(r.tokens).slice(0, 6), Math.round(r.gain * 10) / 10]);
  }
  return out;
}

/**
 * What a typed word has to start a token with. A trailing letter only comes off a word long enough to spare it, or a plural:
 * "paint" must not find "pain", and "trains" must find "train". "dance" finds "danced" and "dances", not "dancing". A stem of
 * three letters or fewer only matches itself or its plural: "cats" must not find "category".
 */
export function lensStem(query: string): string {
  const q = query.trim().toLowerCase();
  return q.length >= 6 || (q.length >= 4 && /[^s]s$/.test(q)) ? q.slice(0, -1) : q;
}

/** The neurons of a lens table that write a word, in gen_word.py's order: most matching tokens, then the biggest gain. */
export function lensHits(table: [string, string[], number][], query: string): LabLensHit[] {
  const stem = lensStem(query);
  if (!stem) return [];
  const hits: { hit: LabLensHit; matching: number }[] = [];
  for (const [ref, tokens, gain] of table) {
    const m = /^L(\d+)N(\d+)([+-])$/.exec(ref);
    if (!m) continue;
    const matching = tokens.filter((t) => {
      const w = t.trim().toLowerCase();
      return stem.length <= 3 ? w === stem || w === `${stem}s` : w.startsWith(stem);
    }).length;
    if (matching) hits.push({ hit: { layer: Number(m[1]), neuron: Number(m[2]), sign: m[3] === "-" ? -1 : 1, tokens, gain }, matching });
  }
  return hits
    .sort((a, b) => b.matching - a.matching || b.hit.gain - a.hit.gain)
    .slice(0, 8)
    .map((x) => x.hit);
}
