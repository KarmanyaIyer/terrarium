// Lab state: the sidecar's LabState (from /api/state and `lab` messages), strains, probe sets, and each step's inputs and
// last result. Kept outside the main store so the Lab can grow without touching it; inputs survive leaving the Lab,
// and the mix, watch list and prompt survive a reload. Every result keeps the exact recipe it ran with and is saved in
// history; edits to the inputs go on the undo stack by themselves (UNDOABLE below).

import { create } from "zustand";
import type {
  Id,
  LabAttributeResult,
  LabExplorePick,
  LabFieldGuide,
  LabFindResult,
  LabGrow,
  LabHistoryEntry,
  LabLensHit,
  LabScreenResult,
  LabMemoryCheck,
  LabMixItem,
  LabNeuronCard,
  LabProbeResult,
  LabProbeSet,
  LabPush,
  LabReply,
  LabSpecimen,
  LabState,
  LabStrain,
  LabStrainSettings,
  LabVector,
  NeuronRef,
  WsMessage,
} from "@terrarium/shared";
import type { LabApi } from "../api/lab";
import { doseScale, firstDivergence, gridSlots, hasWord, pushesAt, scaled, targetName, zoomBetween, type SweepTarget, type WordPick } from "../lib/labGrid";
import { findPush, isNeuron, isVector, nid, pushKey, pushName, sameRef, vectorRepeat } from "../lib/recipe";
import { diffKeys } from "../lib/undo";
import { openSession, openView, toast, useStore } from "./store";
import { undoStack, undoable } from "./undo";

export type LabTab = "guide" | "find" | "steer" | "trace" | "probe" | "strains" | "history";
export type SteerView = "compare" | "sweep" | "seeds";

export interface LabErr {
  error: string;
  detail?: string;
}

export interface CardState {
  ref: NeuronRef;
  data?: LabNeuronCard;
  err?: LabErr;
  since?: number; // request in flight since
  texts: string[];
}

/** Everything a reply ran with, whatever the controls say now. pushes has the mix's scale multiplied in. */
export interface Recipe {
  modelId: Id;
  prompt: string;
  pushes: LabMixItem[];
  seed: number;
  temperature: number;
  maxTokens: number;
  thinking: boolean;
  repeat?: number; // repetition penalty; unset is off
}

export interface SteerRun {
  id: Id;
  at: number;
  recipe: Recipe;
  steered: LabReply;
  baseline?: LabReply;
  /** The mix's own doses and scale, when the scale wasn't 1. */
  scale?: number;
}

export interface GridCell {
  dose: number;
  seed: number;
  prompt: string;
  reply: LabReply;
}

/** Replies over doses and seeds (Sweep), or over seeds and prompts (Test across seeds). */
export interface GridRun {
  id: Id;
  at: number;
  kind: "sweep" | "seeds";
  modelId: Id;
  mix: LabMixItem[]; // pushesAt(mix, target, dose) is each dose's recipe
  target: SweepTarget | null; // null: the doses scale the whole mix
  doses: number[];
  seeds: number[];
  prompts: string[];
  temperature: number;
  maxTokens: number;
  thinking: boolean;
  repeat?: number;
  words: string[]; // counted as hits
  cells: GridCell[];
  state: "running" | "done" | "stopped" | "failed";
  err?: LabErr;
  ms: number;
}

/** The recipe one cell ran with. */
export function cellRecipe(run: GridRun, c: GridCell): Recipe {
  return { modelId: run.modelId, prompt: c.prompt, pushes: pushesAt(run.mix, run.target, c.dose), seed: c.seed, temperature: run.temperature, maxTokens: run.maxTokens, thinking: run.thinking, repeat: run.repeat };
}

/** A neuron Find tried out, or one Surprise me came up with. */
export interface TriedNeuron {
  ref: NeuronRef;
  words: string[]; // what it pushes toward
  runs: { dose: number; recipe: Recipe; reply: LabReply; hit: boolean }[];
  both?: number;
}

export interface FlowStep {
  label: string;
  state: "wait" | "run" | "done" | "failed";
}

/** A run of the Find tab: what was asked, the steps as they went, what came of it. */
export interface FindFlow {
  id: Id;
  at: number;
  kind: "trait" | "lists" | "surprise";
  title: string; // the trait, the set's name, or "layer 22"
  steps: FlowStep[];
  since: number | null;
  words: string[];
  prompt: string;
  baseline?: { recipe: Recipe; reply: LabReply };
  tried: TriedNeuron[];
  /** The strongest firing neurons pushed together: one neuron rarely carries a whole trait. */
  together?: { recipe: Recipe; reply: LabReply; hit: boolean };
  sampled?: number;
  err?: LabErr;
  /** Which words the written examples contained, shown behind a disclosure. */
  picks?: LabExplorePick[];
}

export interface TraceRun {
  id: Id;
  at: number;
  modelId: Id;
  prompt: string;
  pushes: LabMixItem[];
  res: LabAttributeResult;
}

export interface StrainDialog {
  pushes: LabMixItem[];
  from?: string; // "from the sweep at dose 0.66"
  settings: LabStrainSettings; // what it ran with
}

export type FindSort = "both" | "score" | "writes";

export interface LabStore {
  lab: LabState | null;
  missing: LabErr | null; // the backend has no Lab
  strains: LabStrain[] | null;
  sets: LabProbeSet[] | null;
  tab: LabTab;
  target: Id | null; // model picked for the bench
  benchModel: Id | null; // the last specimen that was ready: the mix and results belong to it
  mem: LabMemoryCheck | null;
  memBusy: number | null;
  freeing: number | null;
  loadErr: LabErr | null;
  loadSince: number | null;
  card: CardState | null;
  /** What each neuron writes (by id), from cards and Find: highlights its words in replies. */
  words: Record<string, string[]>;
  history: LabHistoryEntry[] | null;
  strainDialog: StrainDialog | null;

  probeText: string;
  probeChat: boolean;
  probeReply: boolean;
  probeLayer: number | null;
  probeMix: boolean;
  watch: NeuronRef[];
  shade: string | null; // neuron id shading the token strip; null: each token's strongest neuron
  probeRes: LabProbeResult | null;
  probeErr: LabErr | null;
  probeBusy: number | null;

  trait: string;
  setId: Id | null;
  setName: string;
  concept: string;
  control: string;
  testPrompt: string;
  dirty: boolean;
  flow: FindFlow | null;
  growText: string;
  growShown: LabGrow | null; // a past grow back from history; a live one is in lab.grow
  findRes: LabFindResult | null;
  findSort: FindSort;

  mix: LabMixItem[];
  scale: number;
  prompt: string;
  seed: number;
  lockSeed: boolean;
  temperature: number;
  maxTokens: number;
  thinking: boolean;
  repeat: number; // repetition penalty for new runs; 1 is off
  steerView: SteerView;
  runs: SteerRun[];
  runPick: Id | null; // an earlier run brought back; null: the latest
  compareBusy: number | null;
  compareErr: LabErr | null;

  sweepTarget: string; // "mix", or the key of an entry of the mix
  sweepRange: number | "custom"; // +/- this much
  sweepLow: number;
  sweepHigh: number;
  sweepCount: number;
  sweepSeeds: number;
  sweepTokens: number;
  sweep: GridRun | null;
  seedsN: number;
  seedsPrompts: string; // more prompts, one per line, after the mix's own
  seedsWords: string;
  seedsTokens: number;
  seeds: GridRun | null;
  gridBusy: number | null;

  attrPrompt: string;
  attrPrefill: string;
  attrTarget: string;
  attrFoil: string;
  attrFoilFrom: boolean; // compare with what the model writes without the mix
  attrMix: boolean;
  attrRes: LabAttributeResult | null;
  attrRun: TraceRun | null;
  attrBusy: number | null;
  attrErr: LabErr | null;

  example: { step: string; since: number } | null;

  guide: LabFieldGuide | null;
  guideErr: LabErr | null;
  guideTrying: { id: Id; step: string; since: number } | null;
  /** After the example's one neuron: the character it leads to, shown by the result. */
  nextUp: { from: string; id: Id } | null;
}

const PERSIST_KEY = "terrarium.lab";
const PERSISTED = ["mix", "scale", "watch", "prompt", "tab", "probeText", "temperature", "maxTokens", "target", "benchModel", "repeat", "trait", "steerView", "sweepRange", "sweepLow", "sweepHigh", "sweepCount", "sweepSeeds", "sweepTokens", "seedsN", "seedsPrompts", "seedsWords", "seedsTokens"] as const;
type Persisted = Pick<LabStore, (typeof PERSISTED)[number]>;

/** Repeat control for new runs. See TODO_25.md for the runs behind this. */
export const REPEAT_DEFAULT = 1.1;
const FLOW_TOKENS = 64;
const SURPRISE_TOKENS = 48;
/** A first dose that shows something on the loaded model. */
export const tryDose = () => get().lab?.model?.tryDose ?? 0.8;

function loadPersisted(): Partial<Persisted> {
  try {
    return JSON.parse(localStorage.getItem(PERSIST_KEY) ?? "{}") as Partial<Persisted>;
  } catch {
    return {};
  }
}

const randomSeed = () => Math.floor(Math.random() * 1_000_000);

export const useLab = create<LabStore>()(() => ({
  lab: null,
  missing: null,
  strains: null,
  sets: null,
  tab: "guide",
  target: null,
  benchModel: null,
  mem: null,
  memBusy: null,
  freeing: null,
  loadErr: null,
  loadSince: null,
  card: null,
  words: {},
  history: null,
  strainDialog: null,
  probeText: "The barn owl swooped silently over the field at dusk.",
  probeChat: false,
  probeReply: false,
  probeLayer: null,
  probeMix: false,
  watch: [],
  shade: null,
  probeRes: null,
  probeErr: null,
  probeBusy: null,
  trait: "",
  setId: null,
  setName: "",
  concept: "",
  control: "",
  testPrompt: "",
  dirty: false,
  flow: null,
  growText: "",
  growShown: null,
  findRes: null,
  findSort: "both",
  mix: [],
  scale: 1,
  prompt: "Who are you?",
  seed: randomSeed(),
  lockSeed: false,
  temperature: 0.7,
  maxTokens: 160,
  thinking: false,
  repeat: REPEAT_DEFAULT,
  steerView: "compare",
  runs: [],
  runPick: null,
  compareBusy: null,
  compareErr: null,
  sweepTarget: "mix",
  sweepRange: 1,
  sweepLow: -1,
  sweepHigh: 1,
  sweepCount: 12,
  sweepSeeds: 1,
  sweepTokens: 64,
  sweep: null,
  seedsN: 8,
  seedsPrompts: "Tell me about your favorite place.\nWhat should I cook tonight?",
  seedsWords: "",
  seedsTokens: 64,
  seeds: null,
  gridBusy: null,
  attrPrompt: "What is the capital of Australia?",
  attrPrefill: "The capital of Australia is",
  attrTarget: " Surprise",
  attrFoil: "",
  attrFoilFrom: false,
  attrMix: true,
  attrRes: null,
  attrRun: null,
  attrBusy: null,
  attrErr: null,
  example: null,
  guide: null,
  guideErr: null,
  guideTrying: null,
  nextUp: null,
  ...loadPersisted(),
}));

const set = useLab.setState;
const get = useLab.getState;

useLab.subscribe((s, prev) => {
  if (PERSISTED.every((k) => s[k] === prev[k])) return;
  const p: Partial<Persisted> = {};
  for (const k of PERSISTED) (p as Record<string, unknown>)[k] = s[k];
  localStorage.setItem(PERSIST_KEY, JSON.stringify(p));
});

// ---------- undo ----------

/** What Cmd+Z brings back, with the words the toast uses. Results come back through the labelled clear actions. */
const UNDOABLE: Partial<Record<keyof LabStore, string>> = {
  mix: "Changed the mix",
  scale: "Changed the scale",
  prompt: "Edited the prompt",
  seed: "Changed the seed",
  lockSeed: "Changed the seed lock",
  temperature: "Changed the temperature",
  maxTokens: "Changed the reply length",
  thinking: "Changed thinking",
  repeat: "Changed repeat control",
  watch: "Changed the watch list",
  probeText: "Edited the probe text",
  probeChat: "Changed the probe options",
  probeReply: "Changed the probe options",
  probeLayer: "Changed the probe layer",
  probeMix: "Changed the probe options",
  trait: "Edited the description",
  concept: "Edited the concept texts",
  control: "Edited the control texts",
  testPrompt: "Edited the test prompt",
  setId: "Changed the probe set",
  setName: "Changed the probe set",
  sweepTarget: "Changed what the sweep pushes",
  sweepRange: "Changed the sweep range",
  sweepLow: "Changed the sweep range",
  sweepHigh: "Changed the sweep range",
  sweepCount: "Changed the number of doses",
  sweepSeeds: "Changed the sweep's seeds",
  sweepTokens: "Changed the sweep's reply length",
  seedsN: "Changed the number of seeds",
  seedsPrompts: "Edited the test prompts",
  seedsWords: "Edited the words to count",
  seedsTokens: "Changed the reply length",
  attrPrompt: "Edited the trace prompt",
  attrPrefill: "Edited the answer start",
  attrTarget: "Edited the word to trace",
  attrFoil: "Edited the comparison word",
  attrFoilFrom: "Changed the comparison",
  attrMix: "Changed the trace's mix",
};
const UNDO_KEYS = Object.keys(UNDOABLE) as (keyof LabStore)[];
const RESULT_KEYS = ["runs", "runPick", "sweep", "seeds", "flow", "growShown", "findRes", "attrRes", "attrRun", "probeRes"] as const satisfies (keyof LabStore)[];
const ALL_KEYS: (keyof LabStore)[] = [...UNDO_KEYS, ...RESULT_KEYS, "tab", "steerView"];

let quiet = 0;
/** Changes the app makes on its own (a run drawing a new seed) aren't the user's edits. */
function quietly(fn: () => void) {
  quiet++;
  try {
    fn();
  } finally {
    quiet--;
  }
}

useLab.subscribe((s, prev) => {
  if (quiet || undoStack.applying()) return;
  const d = diffKeys(prev, s, UNDO_KEYS);
  if (!d) return;
  undoStack.push({ label: UNDOABLE[d.keys[0]]!, key: d.keys.join(), scope: "lab", undo: () => set(d.before), redo: () => set(d.after) });
});

/** One action, however many keys it changes, as one labelled entry. Any tab it moved to comes back too. */
export function labelled(label: string, change: () => void, opts: { toast?: boolean } = {}) {
  const before = get();
  quietly(change);
  const d = diffKeys(before, get(), ALL_KEYS);
  if (d) undoable({ label, scope: "lab", undo: () => set(d.before), redo: () => set(d.after) }, opts);
}

// ---------- backend plumbing ----------

function errOf(e: unknown): LabErr {
  const x = e as { message?: string; detail?: string; status?: number };
  return { error: x.message ?? String(e), detail: x.detail };
}

/** Runs a Lab call; failures come back as values so each step shows them in place. */
async function call<T>(fn: (lab: LabApi) => Promise<T>): Promise<{ ok: true; v: T } | { ok: false; err: LabErr; status?: number }> {
  const b = useStore.getState().backend;
  if (!b) return { ok: false, err: { error: "Not connected" } };
  try {
    return { ok: true, v: await fn(b.lab) };
  } catch (e) {
    return { ok: false, err: errOf(e), status: (e as { status?: number }).status };
  }
}

/** Same, throwing the failure: undoing has no result to put it in, so runUndo shows it. */
async function must<T>(fn: (lab: LabApi) => Promise<T>): Promise<T> {
  const b = useStore.getState().backend;
  if (!b) throw new Error("Not connected");
  return fn(b.lab);
}

/** Same, with a toast on failure (for actions without a place to show the error). */
async function callToast<T>(label: string, fn: (lab: LabApi) => Promise<T>): Promise<T | undefined> {
  const r = await call(fn);
  if (r.ok) return r.v;
  toast(`${label}: ${r.err.error}${r.err.detail ? ` (${r.err.detail})` : ""}`);
  return undefined;
}

/** A ready specimen other than the last one: results and the mix measured on the old one don't apply to it. */
function onSpecimen(lab: LabState) {
  const id = lab.status === "ready" ? lab.model?.modelId : undefined;
  const s = get();
  if (!id || id === s.benchModel) return;
  if (s.benchModel) {
    quietly(() => {
      set({ probeRes: null, findRes: null, flow: null, card: null, runs: [], runPick: null, sweep: null, seeds: null, attrRes: null, attrRun: null, watch: [] });
      if (s.mix.length) {
        set({ mix: [], scale: 1 });
        toast(`Mix cleared: its neurons were from ${lab.support.find((x) => x.modelId === s.benchModel)?.name ?? s.benchModel}`);
      }
    });
    undoStack.drop("lab"); // neuron ids don't carry over to another model
  }
  // doses that show something differ by model, and LFM3's flatten out by 8
  if (s.benchModel) quietly(() => set({ sweepRange: lab.model?.tryDose && lab.model.tryDose > 1 ? 8 : 1 }));
  set({ benchModel: id, history: null });
  void loadHistory();
}

/** AppState.lab on connect. */
export function labHydrate(lab: LabState | undefined) {
  if (lab) {
    set({ lab, missing: null, loadSince: lab.status === "loading" || lab.status === "starting" ? (get().loadSince ?? Date.now()) : null });
    onSpecimen(lab);
  }
}

export function labMessage(msg: WsMessage) {
  if (msg.type === "lab") {
    set({ lab: msg.lab, missing: null });
    if (msg.lab.status !== "loading" && msg.lab.status !== "starting") set({ loadSince: null });
    else if (!get().loadSince) set({ loadSince: Date.now() });
    onSpecimen(msg.lab);
  } else if (msg.type === "lab_strains") set({ strains: msg.strains });
}

/** First visit: state (if /api/state had none), strains, probe sets, history, and the bench's default model. */
export async function ensureLab() {
  const s = get();
  if (!s.lab) {
    const r = await call((l) => l.state());
    if (r.ok) set({ lab: r.v, missing: null });
    else set({ missing: r.status === 404 ? { error: "This backend has no Lab", detail: r.err.error } : r.err });
  }
  if (!get().strains) {
    const r = await call((l) => l.strains());
    if (r.ok) set({ strains: r.v });
  }
  await Promise.all([ensureSets(), ensureGuide()]);
  if (!get().history) void loadHistory();
  const lab = get().lab;
  if (lab && !get().target) {
    const sup = lab.support.filter((x) => x.supported);
    const example = get().guide?.example.modelId;
    const pick = lab.model?.modelId ?? lab.loadingModelId ?? (sup.find((x) => x.modelId === example) ?? sup[0])?.modelId ?? null;
    set({ target: pick });
  }
  if (get().target && !get().mem && !(get().lab?.status === "ready" && get().lab?.model?.modelId === get().target)) void checkMemory();
}

async function ensureSets() {
  if (get().sets) return;
  const r = await call((l) => l.probeSets());
  if (r.ok) set({ sets: r.v });
}

// ---------- specimen ----------

export function pickTarget(id: Id) {
  set({ target: id, mem: null, loadErr: null });
  const lab = get().lab;
  if (!(lab?.status === "ready" && lab.model?.modelId === id)) void checkMemory();
}

export async function checkMemory() {
  const id = get().target;
  if (!id) return;
  set({ memBusy: Date.now() });
  const r = await call((l) => l.memory(id));
  if (get().target === id) set({ mem: r.ok ? r.v : null, memBusy: null, loadErr: r.ok ? get().loadErr : r.err });
}

export async function freeMemory() {
  const id = get().target;
  if (!id) return;
  set({ freeing: Date.now() });
  const r = await call((l) => l.freeMemory(id));
  set({ freeing: null });
  if (r.ok) set({ mem: r.v, loadErr: null });
  else set({ loadErr: r.err });
}

/** Loads the target (or `id`). False when refused: the memory panel then shows why. */
export async function loadSpecimen(id = get().target): Promise<boolean> {
  if (!id) return false;
  set({ target: id, loadErr: null, loadSince: Date.now() });
  const r = await call((l) => l.load(id));
  if (r.ok) {
    set({ lab: r.v });
    if (r.v.status === "ready") set({ loadSince: null });
    return true;
  }
  set({ loadErr: r.err, loadSince: null });
  void checkMemory();
  return false;
}

export async function unloadSpecimen() {
  const r = await callToast("Unload", (l) => l.unload());
  if (r) set({ lab: r, mem: null });
  void checkMemory();
}

/** Resolves when the bench has `id` ready (true) or the load failed (false). */
function waitReady(id: Id, timeoutMs = 600_000): Promise<boolean> {
  return new Promise((resolve) => {
    let un = () => {};
    const timer = window.setTimeout(() => done(false), timeoutMs);
    const done = (v: boolean) => {
      window.clearTimeout(timer);
      un();
      resolve(v);
    };
    const check = (s: LabStore) => {
      const l = s.lab;
      if (l?.status === "ready" && l.model?.modelId === id) done(true);
      else if (l && (l.status === "error" || (l.status === "stopped" && !s.loadSince))) done(false);
    };
    un = useLab.subscribe(check);
    check(get());
  });
}

// ---------- neurons ----------

export function noteWords(ref: NeuronRef, words: string[]) {
  const k = nid(ref);
  if (words.length && get().words[k]?.join() !== words.join()) set((s) => ({ words: { ...s.words, [k]: words } }));
}

export async function openNeuron(ref: NeuronRef, texts: string[] = []) {
  const cur = get().card;
  if (cur && sameRef(cur.ref, ref) && cur.data && !texts.length) return;
  set({ card: { ref, since: Date.now(), texts, data: cur && sameRef(cur.ref, ref) ? cur.data : undefined } });
  const r = await call((l) => l.neuron(ref, texts));
  const now = get().card;
  if (!now || !sameRef(now.ref, ref)) return;
  if (r.ok) {
    set({ card: { ...now, data: r.v, since: undefined, err: undefined } });
    noteWords(ref, r.v.promotes.map((p) => p.token));
  } else set({ card: { ...now, since: undefined, err: r.err } });
}

export function closeNeuron() {
  set({ card: null });
}

export function inMix(ref: NeuronRef): LabPush | undefined {
  return findPush(get().mix, ref);
}

/** The vectors a recipe's text can name: the mix's, the strains' and the Field Guide's. */
export function knownVectors(): LabVector[] {
  const s = get();
  return [...s.mix, ...(s.strains ?? []).flatMap((x) => x.pushes), ...(s.guide?.specimens ?? []).flatMap((x) => x.mix)].filter(isVector);
}

const signed = (v: number) => `${v >= 0 ? "+" : ""}${Math.round(v * 1000) / 1000}`;

/** Adds a neuron at a signed dose; one already in the mix moves to it. */
export function addToMix(ref: NeuronRef, value = tryDose()) {
  const had = inMix(ref);
  if (had?.mode === "dose" && had.value === value) {
    toast(`${nid(ref)} is already in the mix at ${signed(value)}`, "info");
    return;
  }
  labelled(had ? `Set ${nid(ref)} to ${signed(value)}` : `Added ${nid(ref)} at ${signed(value)}`, () =>
    set((s) => ({ mix: had ? s.mix.map((p) => (isNeuron(p) && sameRef(p, ref) ? { ...p, mode: "dose", value } : p)) : [...s.mix, { layer: ref.layer, neuron: ref.neuron, mode: "dose", value }] })),
  );
}

export function setPush(i: number, p: Partial<LabPush> | { strength: number }) {
  set((s) => ({ mix: s.mix.map((x, j) => (j === i ? ({ ...x, ...p } as LabMixItem) : x)) }));
}

export function removePush(i: number) {
  const p = get().mix[i];
  if (p) labelled(`Removed ${pushName(p)}`, () => set((s) => ({ mix: s.mix.filter((_, j) => j !== i) })));
}

export function clearResults() {
  labelled("Cleared the results", () => set({ runs: [], runPick: null, sweep: null, seeds: null, compareErr: null }));
}

// ---------- probe ----------

export function isWatched(ref: NeuronRef) {
  return get().watch.some((w) => sameRef(w, ref));
}

export function toggleWatch(ref: NeuronRef, on = !isWatched(ref)) {
  if (on === isWatched(ref)) return;
  set((s) => ({ watch: on ? [...s.watch, ref] : s.watch.filter((w) => !sameRef(w, ref)), shade: !on && s.shade === nid(ref) ? null : s.shade }));
  if (get().probeRes && on) void runProbe();
}

/** Shades the token strip by a neuron; one without a trace yet is watched (and the text probed again). */
export function shadeBy(ref: NeuronRef | null) {
  if (!ref) {
    set({ shade: null });
    return;
  }
  set({ shade: nid(ref) });
  const res = get().probeRes;
  const traced = !!res && (res.watch.some((t) => sameRef(t.ref, ref)) || !!res.layer?.traces.some((t) => sameRef(t.ref, ref)));
  if (!traced) toggleWatch(ref, true);
}

export async function runProbe() {
  const s = get();
  if (!s.probeText.trim()) return;
  set({ probeBusy: Date.now(), probeErr: null });
  const r = await call((l) =>
    l.probe({
      text: s.probeText,
      chat: s.probeChat,
      reply: s.probeChat && s.probeReply,
      thinking: false,
      watch: s.watch,
      layer: s.probeLayer ?? undefined,
      mix: s.probeMix && s.mix.length ? scaled(s.mix, s.scale) : undefined,
    }),
  );
  set(r.ok ? { probeRes: r.v, probeBusy: null } : { probeErr: r.err, probeBusy: null });
}

// ---------- find ----------

const lines = (s: string) =>
  s
    .split("\n")
    .map((x) => x.trim())
    .filter(Boolean);

/** Probe sets hold one text per line; texts with newlines (code) are joined with a visible ⏎ and split back. */
const NL = " ⏎ ";
export const toLines = (texts: string[]) => texts.map((t) => t.replace(/\n/g, NL)).join("\n");
export const fromLines = (s: string) => lines(s).map((t) => t.split(NL).join("\n"));

export function pickSet(id: Id) {
  const ps = get().sets?.find((x) => x.id === id);
  if (!ps) return;
  set({ setId: id, setName: ps.name, concept: toLines(ps.concept), control: toLines(ps.control), testPrompt: ps.testPrompt ?? "", dirty: false });
}

export function editSet(p: Partial<Pick<LabStore, "concept" | "control" | "testPrompt">>) {
  set({ ...p, dirty: true });
}

export async function saveSet(asName?: string) {
  const s = get();
  const body = { name: asName ?? s.setName, concept: fromLines(s.concept), control: fromLines(s.control), testPrompt: s.testPrompt.trim() || undefined };
  const cur = s.sets?.find((x) => x.id === s.setId);
  const update = !asName && cur && !cur.builtin;
  const saved = update ? await callToast("Save probe set", (l) => l.updateProbeSet(cur.id, body)) : await callToast("Save probe set", (l) => l.saveProbeSet(body));
  if (!saved) return;
  const put = (x: LabProbeSet) => set((st) => ({ sets: [...(st.sets ?? []).filter((y) => y.id !== x.id), x] }));
  quietly(() => {
    put(saved);
    set({ setId: saved.id, setName: saved.name, dirty: false });
  });
  undoable(
    update
      ? { label: `Saved "${saved.name}"`, undo: () => must((l) => l.updateProbeSet(cur.id, { name: cur.name, concept: cur.concept, control: cur.control, testPrompt: cur.testPrompt })).then(put), redo: () => must((l) => l.updateProbeSet(cur.id, body)).then(put) }
      : {
          label: `Saved "${saved.name}"`,
          undo: async () => {
            await must((l) => l.deleteProbeSet(saved.id));
            set((st) => ({ sets: (st.sets ?? []).filter((y) => y.id !== saved.id) }));
          },
          redo: () => must((l) => l.saveProbeSet({ ...body, id: saved.id })).then(put),
        },
    { toast: false },
  );
}

export async function deleteSet() {
  const id = get().setId;
  const cur = get().sets?.find((x) => x.id === id);
  if (!id || !cur) return;
  const r = await call((l) => l.deleteProbeSet(id));
  if (!r.ok) {
    toast(`Delete probe set: ${r.err.error}`);
    return;
  }
  const drop = () => set((s) => ({ sets: (s.sets ?? []).filter((x) => x.id !== id) }));
  quietly(() => {
    drop();
    set({ setId: null, dirty: true });
  });
  undoable({
    label: `Deleted "${cur.name}"`,
    undo: async () => {
      const back = await must((l) => l.saveProbeSet({ id, name: cur.name, concept: cur.concept, control: cur.control, testPrompt: cur.testPrompt }));
      set((s) => ({ sets: [...(s.sets ?? []), back], setId: id, dirty: false }));
    },
    redo: async () => {
      await must((l) => l.deleteProbeSet(id));
      drop();
    },
  });
}

/** The tried-out neurons' words, for marking them in replies. */
function noteCandidates(res: LabFindResult) {
  set((st) => {
    const words = { ...st.words };
    for (const c of res.candidates) words[nid(c)] = c.writes.tokens.length ? c.writes.tokens : c.promotes;
    return { words };
  });
}

const newRunId = () => `run-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;

let flowStop = { stopped: false };

function flowStep(i: number, state: FlowStep["state"]) {
  set((s) => (s.flow ? { flow: { ...s.flow, steps: s.flow.steps.map((x, j) => (j === i ? { ...x, state } : x)) } } : {}));
}

function flowEnd(err?: LabErr) {
  const f = get().flow;
  if (!f) return;
  const stopped = flowStop.stopped;
  set({ flow: { ...f, since: null, err: stopped ? undefined : err, steps: f.steps.map((x) => (x.state === "run" ? { ...x, state: err && !stopped ? "failed" : stopped ? "wait" : "done" } : x)) } });
  if (f.tried.length) saveHistory({ id: f.id, kind: "find", modelId: benchId(), title: f.title, at: f.at, data: { ...get().flow, findRes: get().findRes } });
}

export function stopFlow() {
  flowStop.stopped = true;
  void call((l) => l.cancel());
}

function benchId(): Id {
  const s = get();
  return s.lab?.model?.modelId ?? s.benchModel ?? "";
}

/** Tries a neuron: one short reply at a dose, a softer one if that looped or broke. */
async function tryNeuron(ref: NeuronRef, prompt: string, seed: number, doses: number[], maxTokens: number, wordsToCount: string[]): Promise<TriedNeuron["runs"]> {
  const s = get();
  const runs: TriedNeuron["runs"] = [];
  for (const dose of doses) {
    if (flowStop.stopped) break;
    const pushes: LabPush[] = [{ layer: ref.layer, neuron: ref.neuron, mode: "dose", value: dose }];
    const r = await call((l) => l.generate({ prompt, mix: pushes, seed, temperature: s.temperature, maxTokens, repeat: repeatOf(s) }));
    if (!r.ok) {
      if (flowStop.stopped) break;
      throw r.err;
    }
    const reply = r.v.steered;
    runs.push({ dose, recipe: { modelId: benchId(), prompt, pushes, seed, temperature: s.temperature, maxTokens, thinking: false, repeat: repeatOf(s) }, reply, hit: hasWord(reply.text, wordsToCount) });
  }
  return runs;
}

const repeatOf = (s: Pick<LabStore, "repeat">) => (s.repeat > 1 ? s.repeat : undefined);

/** The unsteered reply the tries are read against. */
async function flowBaseline(prompt: string, seed: number, maxTokens: number) {
  const s = get();
  const r = await call((l) => l.generate({ prompt, mix: [], seed, temperature: s.temperature, maxTokens, repeat: repeatOf(s) }));
  if (r.ok) set((st) => (st.flow ? { flow: { ...st.flow, baseline: { reply: r.v.steered, recipe: { modelId: benchId(), prompt, pushes: [], seed, temperature: s.temperature, maxTokens, thinking: false, repeat: repeatOf(s) } } } } : {}));
}

const DESCRIBE_PROMPT = "Who are you?";

/** After the lists are ready: score every neuron, then try the best ones. */
async function findAndTry(stepFind: number, words: string[], prompt: string) {
  const s = get();
  flowStep(stepFind, "run");
  const r = await call((l) => l.find({ concept: fromLines(s.concept), control: fromLines(s.control), prompt, previews: 0, words }));
  if (!r.ok) return flowEnd(flowStop.stopped ? undefined : r.err);
  noteCandidates(r.v);
  quietly(() => set({ findRes: r.v, prompt }));
  flowStep(stepFind, "done");
  flowStep(stepFind + 1, "run");
  const seed = randomSeed();
  // the first layers mostly move punctuation or end the reply, whatever the trait
  const firstLayer = (get().lab?.model?.layers ?? 0) >> 2;
  const usable = r.v.candidates.filter((c) => c.layer >= firstLayer);
  const best = (usable.length >= 4 ? usable : r.v.candidates).slice(0, 4);
  const counted = words.length ? words : r.v.conceptTokens;
  try {
    await flowBaseline(prompt, seed, FLOW_TOKENS);
    for (const c of best) {
      if (flowStop.stopped) break;
      let runs = await tryNeuron(c, prompt, seed, [tryDose()], FLOW_TOKENS, counted);
      if (runs[0] && ["loop", "broken", "empty"].includes(runs[0].reply.quality)) runs = [...(await tryNeuron(c, prompt, seed, [Math.round(tryDose() * 62.5) / 100], FLOW_TOKENS, counted)), ...runs];
      if (!runs.length) break;
      const tried: TriedNeuron = { ref: { layer: c.layer, neuron: c.neuron }, words: c.writes.tokens.length ? c.writes.tokens : c.promotes, runs, both: c.both };
      set((st) => (st.flow ? { flow: { ...st.flow, tried: sortTried([...st.flow.tried, tried]) } } : {}));
    }
    const strongest = [...usable].sort((a, b) => b.score - a.score).slice(0, 4);
    if (!flowStop.stopped && strongest.length > 1) {
      const dose = Math.round(tryDose() * 50) / 100;
      const pushes: LabPush[] = strongest.map((c) => ({ layer: c.layer, neuron: c.neuron, mode: "dose", value: dose }));
      const t = await call((l) => l.generate({ prompt, mix: pushes, seed, temperature: s.temperature, maxTokens: FLOW_TOKENS, repeat: repeatOf(s) }));
      if (t.ok) {
        const together = { recipe: { modelId: benchId(), prompt, pushes, seed, temperature: s.temperature, maxTokens: FLOW_TOKENS, thinking: false, repeat: repeatOf(s) }, reply: t.v.steered, hit: hasWord(t.v.steered.text, counted) };
        set((st) => (st.flow ? { flow: { ...st.flow, together } } : {}));
      }
    }
    flowEnd();
  } catch (err) {
    flowEnd(err as LabErr);
  }
}

const reads = (t: TriedNeuron) => t.runs.find((r) => r.reply.quality === "ok" || r.reply.quality === "odd") ?? t.runs[0];

/** Replies that have the words and read fine first. */
function sortTried(list: TriedNeuron[]): TriedNeuron[] {
  const rank = (t: TriedNeuron) => {
    const r = reads(t);
    return (r.hit ? 0 : 2) + (r.reply.quality === "ok" || r.reply.quality === "odd" ? 0 : 1);
  };
  return [...list].sort((a, b) => rank(a) - rank(b) || (b.both ?? 0) - (a.both ?? 0));
}

function startFlow(kind: FindFlow["kind"], title: string, prompt: string, labels: string[], words: string[] = []) {
  flowStop = { stopped: false };
  set({ flow: { id: newRunId(), at: Date.now(), kind, title, steps: labels.map((label) => ({ label, state: "wait" })), since: Date.now(), words, prompt, tried: [] }, findRes: null });
}

/** The one box: the loaded model writes examples of the trait, every neuron is scored on them, the best are tried. */
export async function runDescribe(text = get().trait) {
  const trait = text.trim();
  if (!trait) return;
  startFlow("trait", trait, DESCRIBE_PROMPT, [`Writing example lines with and without "${trait}"`, "Scoring every neuron on them", "Trying the best four"]);
  flowStep(0, "run");
  const r = await call((l) => l.examples({ trait }));
  if (!r.ok) return flowEnd(flowStop.stopped ? undefined : r.err);
  quietly(() => set({ trait, setId: null, setName: trait, concept: toLines(r.v.concept), control: toLines(r.v.control), testPrompt: DESCRIBE_PROMPT, dirty: false }));
  set((s) => (s.flow ? { flow: { ...s.flow, words: r.v.words } } : {}));
  flowStep(0, "done");
  await findAndTry(1, r.v.words, DESCRIBE_PROMPT);
}

/** Find from the lists as they stand (a prepared set, or your own). */
export async function runFind() {
  const s = get();
  if (!fromLines(s.concept).length || !fromLines(s.control).length) return;
  const prompt = s.testPrompt.trim() || DESCRIBE_PROMPT;
  startFlow("lists", s.setName || "your texts", prompt, ["Scoring every neuron on your texts", "Trying the best four"]);
  await findAndTry(0, [], prompt);
}

/** A prepared set, from its chip. */
export async function runPreset(id: Id) {
  pickSet(id);
  await runFind();
}

/** No goal: random neurons of a late layer, the ones that move the next word most, each at both signs. */
export async function runSurprise() {
  const prompt = get().prompt.trim() || DESCRIBE_PROMPT;
  startFlow("surprise", "Surprise me", prompt, ["Trying random neurons in one layer", "Writing with the three strongest, pushed both ways"]);
  flowStep(0, "run");
  const r = await call((l) => l.explore({ sample: 32, top: 3 }));
  if (!r.ok) return flowEnd(flowStop.stopped ? undefined : r.err);
  set((s) => (s.flow ? { flow: { ...s.flow, title: `Layer ${r.v.layer}`, sampled: r.v.sampled, picks: r.v.picks } } : {}));
  for (const p of r.v.picks) noteWords(p, p.promotes);
  flowStep(0, "done");
  flowStep(1, "run");
  const seed = randomSeed();
  try {
    await flowBaseline(prompt, seed, SURPRISE_TOKENS);
    for (const p of r.v.picks) {
      if (flowStop.stopped) break;
      const runs = await tryNeuron(p, prompt, seed, [tryDose(), -tryDose()], SURPRISE_TOKENS, []);
      if (!runs.length) break;
      const tried: TriedNeuron = { ref: { layer: p.layer, neuron: p.neuron }, words: p.tokens.length ? p.tokens : p.promotes, runs };
      set((st) => (st.flow ? { flow: { ...st.flow, tried: [...st.flow.tried, tried] } } : {}));
    }
    flowEnd();
  } catch (err) {
    flowEnd(err as LabErr);
  }
}

// ---------- steer ----------

function nextSeed(): number {
  const s = get();
  if (s.lockSeed) return s.seed;
  const seed = randomSeed();
  quietly(() => set({ seed }));
  return seed;
}

export async function runCompare() {
  const s = get();
  if (!s.prompt.trim() || !s.mix.length) return;
  const seed = nextSeed();
  quietly(() => set({ steerView: "compare" }));
  set({ compareBusy: Date.now(), compareErr: null });
  const pushes = scaled(s.mix, s.scale);
  const req = { prompt: s.prompt, mix: pushes, seed, temperature: s.temperature, maxTokens: s.maxTokens, thinking: s.thinking, baseline: true, repeat: repeatOf(s) };
  const r = await call((l) => l.generate(req));
  if (!r.ok) {
    set({ compareErr: r.err, compareBusy: null });
    return;
  }
  const run: SteerRun = {
    id: newRunId(),
    at: Date.now(),
    recipe: { modelId: benchId(), prompt: s.prompt, pushes, seed: r.v.seed, temperature: s.temperature, maxTokens: s.maxTokens, thinking: s.thinking, repeat: repeatOf(s) },
    steered: r.v.steered,
    baseline: r.v.baseline,
    scale: s.scale !== 1 ? s.scale : undefined,
  };
  set((st) => ({ runs: [run, ...st.runs].slice(0, 12), runPick: null, compareBusy: null }));
  quietly(() => set({ seed: r.v.seed }));
  saveHistory({ id: run.id, kind: "compare", modelId: run.recipe.modelId, title: s.prompt, at: run.at, data: run });
}

// ---------- grids ----------

let gridStop = { stopped: false };

export function stopGrid() {
  gridStop.stopped = true;
  void call((l) => l.cancel());
}

/** Rows arrive one by one, so a chat on a strain can run in between, and each cell can be read as soon as it's done. */
async function runGrid(key: "sweep" | "seeds", run: GridRun) {
  if (get().gridBusy != null) stopGrid();
  const job = { stopped: false };
  gridStop = job;
  const t0 = Date.now();
  set({ [key]: run, gridBusy: t0 });
  const save = (r: GridRun) => saveHistory({ id: r.id, kind: r.kind, modelId: r.modelId, title: gridTitle(r), at: r.at, data: r });
  let last = Date.now();
  for (const slot of gridSlots(run)) {
    if (job.stopped) break;
    const req = { prompt: slot.prompt, mix: pushesAt(run.mix, run.target, slot.dose), seed: slot.seed, temperature: run.temperature, maxTokens: run.maxTokens, thinking: run.thinking, repeat: run.repeat };
    const r = await call((l) => l.generate(req));
    if (job.stopped) break;
    if (!r.ok) {
      const failed: GridRun = { ...get()[key]!, state: "failed", err: r.err, ms: Date.now() - t0 };
      set({ [key]: failed, gridBusy: null });
      save(failed);
      return;
    }
    const cur = get()[key];
    if (cur?.id !== run.id) return; // replaced or cleared meanwhile
    const next = { ...cur, cells: [...cur.cells, { ...slot, reply: r.v.steered }], ms: Date.now() - t0 };
    set({ [key]: next });
    if (Date.now() - last > 15_000) {
      last = Date.now();
      save(next);
    }
  }
  const cur = get()[key];
  if (cur?.id !== run.id) return;
  const end: GridRun = { ...cur, state: job.stopped ? "stopped" : "done", ms: Date.now() - t0 };
  set({ [key]: end, gridBusy: gridStop === job ? null : get().gridBusy });
  if (end.cells.length) save(end);
}

export function gridTitle(r: GridRun): string {
  if (r.kind === "seeds") return r.prompts[0] ?? "";
  return `${targetName(r.mix, r.target)}: ${r.prompts[0] ?? ""}`;
}

/** The doses the sweep's controls stand for. */
export function sweepDoses(s: Pick<LabStore, "sweepRange" | "sweepLow" | "sweepHigh" | "sweepCount">): number[] {
  const low = s.sweepRange === "custom" ? s.sweepLow : -s.sweepRange;
  const high = s.sweepRange === "custom" ? s.sweepHigh : s.sweepRange;
  return doseScale(low, high, s.sweepCount);
}

function seedList(n: number): number[] {
  const first = nextSeed();
  return Array.from({ length: n }, (_, i) => first + i);
}

/** What the sweep moves. One entry in the mix: its own doses or strength, not multiples of itself. */
export function sweepPush(mix: LabMixItem[], key: string): LabMixItem | undefined {
  const only = mix.length === 1 && (isVector(mix[0]) || mix[0].mode === "dose") ? mix[0] : undefined;
  return key === "mix" ? only : (mix.find((p) => pushKey(p) === key) ?? only);
}

export async function runSweep(doses = sweepDoses(get())) {
  const s = get();
  if (!s.prompt.trim() || !s.mix.length || !doses.length) return;
  const push = sweepPush(s.mix, s.sweepTarget);
  const target: SweepTarget | null = !push ? null : isVector(push) ? { vectorId: push.id } : { layer: push.layer, neuron: push.neuron };
  quietly(() => set({ steerView: "sweep" }));
  await runGrid("sweep", {
    id: newRunId(),
    at: Date.now(),
    kind: "sweep",
    modelId: benchId(),
    // one entry: the others at their scaled doses; whole mix: the doses are absolute scales
    mix: target ? scaled(s.mix, s.scale) : s.mix,
    target,
    doses,
    seeds: seedList(s.sweepSeeds),
    prompts: [s.prompt],
    temperature: s.temperature,
    maxTokens: s.sweepTokens,
    thinking: s.thinking,
    repeat: repeatOf(s),
    words: [],
    cells: [],
    state: "running",
    ms: 0,
  });
}

/** Reads a stretch of the scale closely: the two doses become the range. */
export function zoomSweep(a: number, b: number) {
  const low = Math.min(a, b);
  const high = Math.max(a, b);
  labelled(`Zoomed the sweep to ${low} to ${high}`, () => set({ sweepRange: "custom", sweepLow: low, sweepHigh: high }), { toast: false });
  void runSweep(zoomBetween(low, high, get().sweepCount));
}

const wordList = (t: string) =>
  t
    .split(/[,;\n]+/)
    .map((x) => x.trim())
    .filter(Boolean);

/** The mix over many seeds and prompts: how often it holds up. */
export async function runSeeds() {
  const s = get();
  if (!s.prompt.trim() || !s.mix.length) return;
  quietly(() => set({ steerView: "seeds" }));
  await runGrid("seeds", {
    id: newRunId(),
    at: Date.now(),
    kind: "seeds",
    modelId: benchId(),
    mix: scaled(s.mix, s.scale),
    target: null,
    doses: [1],
    seeds: seedList(s.seedsN),
    prompts: [...new Set([s.prompt.trim(), ...lines(s.seedsPrompts)])],
    temperature: s.temperature,
    maxTokens: s.seedsTokens,
    thinking: s.thinking,
    repeat: repeatOf(s),
    words: wordList(s.seedsWords),
    cells: [],
    state: "running",
    ms: 0,
  });
}

// ---------- from a result to the next step ----------

/** A result's recipe back on the bench: the controls say what it ran with. */
function applyRecipe(r: Recipe) {
  set({ mix: r.pushes.map((p) => ({ ...p })), scale: 1, prompt: r.prompt, seed: r.seed, lockSeed: true, temperature: r.temperature, maxTokens: r.maxTokens, thinking: r.thinking, repeat: r.repeat ?? 1 });
}

export function useRecipe(r: Recipe) {
  labelled(r.pushes.length ? "Put that recipe in the mix" : "Went back to that prompt and seed", () => {
    applyRecipe(r);
    set({ tab: "steer" });
  });
}

/** Asks why a reply has a word: the answer up to it, it as the target, against what the model writes without the mix. */
export function traceWord(r: Recipe, pick: WordPick) {
  const steered = r.pushes.length > 0;
  labelled("Went to Trace with that answer", () => {
    if (steered) set({ mix: r.pushes.map((p) => ({ ...p })), scale: 1 });
    set({ tab: "trace", attrPrompt: r.prompt, attrPrefill: pick.prefill, attrTarget: pick.target, attrFoil: pick.foil ?? "", attrFoilFrom: steered && !pick.foil, attrMix: steered, attrRes: null, attrRun: null, attrErr: null });
  });
  void runAttribute();
}

/** Tracing a whole answer asks about the first word steering changed. */
export function traceAnswer(r: Recipe, reply: LabReply, baseline?: LabReply) {
  traceWord(r, firstDivergence(reply.pieces ?? [], baseline?.pieces));
}

export function seedsFor(r: Recipe) {
  labelled("Went to Test across seeds with that recipe", () => {
    applyRecipe(r);
    set({ tab: "steer", steerView: "seeds", lockSeed: false });
  });
  void runSeeds();
}

/** What a strain keeps from what ran. generate always uses top_p 0.95. */
export const settingsOf = (r: { temperature: number; repeat?: number }): LabStrainSettings => ({ temperature: r.temperature, topP: 0.95, repeat: r.repeat && r.repeat > 1 ? r.repeat : null });

export function saveAsStrain(pushes: LabMixItem[], from?: string, settings: LabStrainSettings = settingsOf(get())) {
  set({ strainDialog: { pushes, from, settings } });
}

/** One neuron alone, written out next to the unsteered reply. */
export function compareNeuron(ref: NeuronRef, dose = tryDose()) {
  labelled(`Put ${nid(ref)} alone in the mix at ${signed(dose)}`, () => set({ mix: [{ layer: ref.layer, neuron: ref.neuron, mode: "dose", value: dose }], scale: 1, tab: "steer", steerView: "compare" }));
  void runCompare();
}

export function sweepNeuron(ref: NeuronRef, dose = tryDose()) {
  const has = inMix(ref);
  labelled(`Went to Sweep with ${nid(ref)}`, () => {
    if (!has) set({ mix: [{ layer: ref.layer, neuron: ref.neuron, mode: "dose", value: dose }], scale: 1 });
    set({ sweepTarget: nid(ref), tab: "steer", steerView: "sweep" });
  });
  void runSweep();
}

export function seedsNeuron(ref: NeuronRef, dose = tryDose()) {
  labelled(`Went to Test across seeds with ${nid(ref)}`, () => set({ mix: [{ layer: ref.layer, neuron: ref.neuron, mode: "dose", value: dose }], scale: 1, tab: "steer", steerView: "seeds" }));
  void runSeeds();
}

// ---------- history ----------

export async function loadHistory() {
  const id = get().lab?.status === "ready" ? get().lab?.model?.modelId : undefined;
  const r = await call((l) => l.history(id));
  if (r.ok) set({ history: r.v });
}

/** Saved in the background: the result on screen stands either way. */
function saveHistory(e: Omit<LabHistoryEntry, "data"> & { data: unknown }) {
  if (!e.modelId) return;
  set((s) => ({ history: [e as LabHistoryEntry, ...(s.history ?? []).filter((x) => x.id !== e.id)] }));
  void call((l) => l.saveHistory(e)).then((r) => {
    if (!r.ok) toast(`Couldn't keep that result in History: ${r.err.error}`);
  });
}

export async function deleteHistory(e: LabHistoryEntry) {
  const r = await call((l) => l.deleteHistory(e.id));
  if (!r.ok) {
    toast(`Delete from history: ${r.err.error}`);
    return;
  }
  const drop = () => set((s) => ({ history: (s.history ?? []).filter((x) => x.id !== e.id) }));
  drop();
  undoable({
    label: "Deleted that result",
    undo: async () => {
      const back = await must((l) => l.saveHistory(e));
      set((s) => ({ history: [back, ...(s.history ?? [])].sort((a, b) => b.at - a.at) }));
    },
    redo: async () => {
      await must((l) => l.deleteHistory(e.id));
      drop();
    },
  });
}

/** A result back on screen, with the mix, doses, seed and prompt it ran with. Older than this tab's own results? They
 * stay reachable through undo. */
export function restoreHistory(e: LabHistoryEntry) {
  labelled("Restored from history", () => {
    if (e.kind === "compare") {
      const run = e.data as SteerRun;
      applyRecipe(run.recipe);
      set((s) => ({ runs: [run, ...s.runs.filter((x) => x.id !== run.id)].slice(0, 12), runPick: null, tab: "steer", steerView: "compare" }));
    } else if (e.kind === "sweep" || e.kind === "seeds") {
      const run = e.data as GridRun;
      // a run that never got to finish can't come back as running
      const still: GridRun = run.state === "running" ? { ...run, state: "stopped" } : run;
      applyRecipe({ modelId: run.modelId, prompt: run.prompts[0] ?? "", pushes: run.mix, seed: run.seeds[0] ?? 0, temperature: run.temperature, maxTokens: get().maxTokens, thinking: run.thinking, repeat: run.repeat });
      if (e.kind === "sweep") {
        const lo = Math.min(...run.doses);
        const hi = Math.max(...run.doses);
        set({ sweep: still, sweepTarget: !run.target ? "mix" : "vectorId" in run.target ? `vector:${run.target.vectorId}` : nid(run.target), sweepRange: "custom", sweepLow: lo, sweepHigh: hi, sweepCount: Math.max(1, run.doses.length - (lo < 0 && hi > 0 ? 1 : 0)), sweepSeeds: run.seeds.length, sweepTokens: run.maxTokens, tab: "steer", steerView: "sweep" });
      } else set({ seeds: still, seedsN: run.seeds.length, seedsTokens: run.maxTokens, seedsPrompts: run.prompts.slice(1).join("\n"), seedsWords: run.words.join(", "), tab: "steer", steerView: "seeds" });
    } else if (e.kind === "grow") {
      const g = e.data as LabGrow;
      set({ growShown: g, growText: g.description, tab: "find" });
    } else if (e.kind === "trace") {
      const run = e.data as TraceRun;
      if (run.pushes.length) set({ mix: run.pushes.map((p) => ({ ...p })), scale: 1 });
      set({ attrRun: run, attrRes: run.res, attrPrompt: run.prompt, attrPrefill: run.res.prefill ?? "", attrTarget: run.res.target, attrFoil: run.res.foil, attrFoilFrom: false, attrMix: run.pushes.length > 0, tab: "trace" });
    } else {
      const { findRes, ...flow } = e.data as FindFlow & { findRes: LabFindResult | null };
      set({ flow: { ...flow, since: null }, findRes: findRes ?? null, tab: "find" });
      if (flow.kind === "trait") set({ trait: flow.title });
      if (findRes) noteCandidates(findRes);
    }
  });
}

// ---------- grow ----------

/** What a grown vector runs with: the search's settings, thinking off, its model's repeat control and the Field Guide's cap. */
function grownSettings(modelId: string): LabStrainSettings {
  return { temperature: 0.7, topP: 0.95, repeat: vectorRepeat(modelId), maxTokens: 300 };
}

export async function startGrow() {
  const description = get().growText.trim();
  if (!description) return;
  set({ growShown: null });
  const r = await call((l) => l.grow(description));
  if (r.ok) set({ lab: r.v });
  else toast(r.err.error);
}

export async function cancelGrow() {
  await call((l) => l.cancelGrow());
}

export async function dismissGrow() {
  const shown = get().growShown;
  set({ growShown: null });
  if (shown) return;
  const r = await call((l) => l.dismissGrow());
  if (r.ok) set({ lab: r.v });
}

function growOnBench(g: LabGrow, prompt: string) {
  const v = g.result!.vector;
  labelled(`Added ${v.name} to the mix`, () => set({ mix: [{ ...v }], scale: 1, prompt, tab: "steer", temperature: grownSettings(g.modelId).temperature, repeat: vectorRepeat(g.modelId) ?? 1, thinking: false, sweepTarget: "mix", sweepRange: v.strength > 2 ? 4 : 2 }));
}

export async function growToMix(g: LabGrow) {
  if (!(await benchHas(g.modelId, () => {}))) return;
  growOnBench(g, g.result!.replies[0]?.prompt ?? get().prompt);
  set({ steerView: "compare" });
}

/** Test across seeds: a fresh look at the same character, on prompts the grow didn't pick its strength with. */
export async function growSeeds(g: LabGrow) {
  if (!(await benchHas(g.modelId, () => {}))) return;
  growOnBench(g, "Introduce yourself.");
  set({ seedsPrompts: "How do I get better at running?\nWhy do leaves change color in autumn?\nWrite a short story about a lost dog.", seedsWords: g.result!.words.join(", ") });
  await runSeeds();
}

export async function keepGrown(g: LabGrow) {
  const r = g.result!;
  const st = await callToast("Keep as strain", (l) => l.saveStrain({ name: r.name, baseModelId: g.modelId, pushes: [r.vector], settings: grownSettings(g.modelId), notes: `Grown from "${r.description}". ${r.verdict.text}` }));
  if (!st) return;
  putStrain(st);
  undoable({
    label: `Kept "${st.name}" as a strain`,
    undo: async () => {
      await must((l) => l.deleteStrain(st.id));
      dropStrain(st.id);
    },
    redo: () => must((l) => l.saveStrain(strainBody(st))).then(putStrain),
  });
}

export async function lensLookup(modelId: Id, q: string): Promise<LabLensHit[]> {
  const r = await call((l) => l.lens(modelId, q));
  return r.ok ? r.v : [];
}

export async function screenHit(h: LabLensHit, word: string): Promise<LabScreenResult | undefined> {
  const r = await call((l) => l.screen({ layer: h.layer, neuron: h.neuron, sign: h.sign, word }));
  if (r.ok) return r.v;
  if (!/stopped|cancel/i.test(r.err.error)) toast(r.err.error);
  return undefined;
}

export function stopScreen() {
  void call((l) => l.cancel());
}

export function screenToMix(r: LabScreenResult) {
  labelled(`Added L${r.layer}N${r.neuron} to the mix`, () => set((s) => ({ mix: [...s.mix.filter((p) => !(isNeuron(p) && p.layer === r.layer && p.neuron === r.neuron)), { layer: r.layer, neuron: r.neuron, mode: "dose", value: r.pick!.dose }], repeat: 1.1, thinking: false, tab: "steer", steerView: "compare" })));
}

// ---------- strains ----------

/** Saves a recipe as a strain on the bench's model. */
export async function saveStrain(name: string, notes: string, pushes: LabMixItem[], settings?: LabStrainSettings): Promise<LabStrain | undefined> {
  const base = get().lab?.model?.modelId;
  if (!base) return undefined;
  const st = await callToast("Save strain", (l) => l.saveStrain({ name, baseModelId: base, pushes, notes, settings }));
  if (st) {
    putStrain(st);
    undoable({
      label: `Saved strain "${st.name}"`,
      undo: async () => {
        await must((l) => l.deleteStrain(st.id));
        dropStrain(st.id);
      },
      redo: () => must((l) => l.saveStrain(strainBody(st))).then(putStrain),
    });
  }
  return st;
}

const putStrain = (st: LabStrain) => set((x) => ({ strains: [st, ...(x.strains ?? []).filter((y) => y.id !== st.id)].sort((a, b) => b.createdAt - a.createdAt) }));
const dropStrain = (id: Id) => set((x) => ({ strains: (x.strains ?? []).filter((y) => y.id !== id) }));
const strainBody = (st: LabStrain) => ({ id: st.id, name: st.name, baseModelId: st.baseModelId, pushes: st.pushes, settings: st.settings, notes: st.notes, createdAt: st.createdAt });

export function loadStrainIntoMix(st: LabStrain) {
  // the mix now belongs to the strain's base: loading that base keeps it, and results from another model go
  labelled(`Loaded "${st.name}" into the mix`, () => {
    if (get().benchModel !== st.baseModelId) set({ probeRes: null, findRes: null, flow: null, card: null, runs: [], runPick: null, sweep: null, seeds: null, attrRes: null, attrRun: null, watch: [] });
    set({ mix: st.pushes.map((p) => ({ ...p })), scale: 1, tab: "steer", benchModel: st.baseModelId, temperature: st.settings.temperature, repeat: st.settings.repeat ?? 1 });
  });
}

export async function updateStrain(id: Id, p: { name?: string; notes?: string; pushes?: LabMixItem[] }) {
  const before = get().strains?.find((x) => x.id === id);
  const st = await callToast("Update strain", (l) => l.updateStrain(id, p));
  if (!st) return st;
  const swap = (x: LabStrain) => set((s) => ({ strains: (s.strains ?? []).map((y) => (y.id === x.id ? x : y)) }));
  swap(st);
  if (before) undoable({ label: `Edited "${before.name}"`, undo: () => must((l) => l.updateStrain(id, { name: before.name, notes: before.notes, pushes: before.pushes, settings: before.settings })).then(swap), redo: () => must((l) => l.updateStrain(id, p)).then(swap) }, { toast: false });
  return st;
}

export async function deleteStrain(id: Id) {
  const st = get().strains?.find((x) => x.id === id);
  const r = await call((l) => l.deleteStrain(id));
  if (!r.ok) {
    toast(`Delete strain: ${r.err.error}${r.err.detail ? ` (${r.err.detail})` : ""}`);
    return;
  }
  dropStrain(id);
  if (st)
    undoable({
      label: `Deleted strain "${st.name}"`,
      undo: () => must((l) => l.saveStrain(strainBody(st))).then(putStrain),
      redo: async () => {
        await must((l) => l.deleteStrain(id));
        dropStrain(id);
      },
    });
}

export async function importStrain(name: string, baseModelId: Id, pushes: LabMixItem[], notes: string) {
  const st = await callToast("Import strain", (l) => l.saveStrain({ name, baseModelId, pushes, notes }));
  if (st) {
    putStrain(st);
    undoable({
      label: `Imported strain "${st.name}"`,
      undo: async () => {
        await must((l) => l.deleteStrain(st.id));
        dropStrain(st.id);
      },
      redo: () => must((l) => l.saveStrain(strainBody(st))).then(putStrain),
    });
  }
  return st;
}

/** A chat whose model is the strain, served by the Lab. */
export async function chatWithStrain(st: LabStrain) {
  const b = useStore.getState().backend;
  if (!b) return;
  try {
    const s = await b.createSession({ envId: null, modelId: `strain:${st.id}`, harness: "chat", thinking: false, title: `${st.name} (strain)` });
    useStore.setState((x) => ({ sessions: { ...x.sessions, [s.id]: s } }));
    openSession(s.id);
    window.setTimeout(() => document.querySelector<HTMLTextAreaElement>(".composer textarea")?.focus(), 50);
  } catch (e) {
    const x = errOf(e);
    toast(`Open a chat: ${x.error}${x.detail ? ` (${x.detail})` : ""}`);
  }
}

export function strainsInEvals() {
  openView({ kind: "evals" });
}

// ---------- trace an answer ----------

export async function runAttribute() {
  const s = get();
  if (!s.attrPrompt.trim() || !s.attrTarget) return;
  set({ attrBusy: Date.now(), attrErr: null });
  const pushes = s.attrMix && s.mix.length ? scaled(s.mix, s.scale) : [];
  const r = await call((l) =>
    l.attribute({
      prompt: s.attrPrompt,
      prefill: s.attrPrefill || undefined,
      target: s.attrTarget,
      foil: s.attrFoilFrom ? undefined : s.attrFoil || undefined,
      foilFrom: s.attrFoilFrom ? "unsteered" : undefined,
      mix: pushes.length ? pushes : undefined,
    }),
  );
  if (!r.ok) {
    set({ attrErr: r.err, attrBusy: null });
    return;
  }
  const run: TraceRun = { id: newRunId(), at: Date.now(), modelId: benchId(), prompt: s.attrPrompt, pushes, res: r.v };
  set({ attrRes: r.v, attrRun: run, attrBusy: null });
  for (const n of r.v.nodes) noteWords(n, n.promotes);
  saveHistory({ id: run.id, kind: "trace", modelId: run.modelId, title: `${r.v.prefill}${r.v.target}`, at: run.at, data: run });
}

// ---------- the Field Guide ----------

export async function ensureGuide() {
  if (get().guide) return;
  const r = await call((l) => l.fieldGuide());
  set(r.ok ? { guide: r.v, guideErr: null } : { guideErr: r.err });
}

/** Loads a model unless the bench has it. False: refused or failed, and the bench says why. */
async function benchHas(modelId: Id, step: (x: string) => void): Promise<boolean> {
  const lab = get().lab;
  if (lab?.status === "ready" && lab.model?.modelId === modelId) return true;
  step(`Loading ${lab?.support.find((x) => x.modelId === modelId)?.name ?? modelId}`);
  set({ target: modelId });
  if (!(await loadSpecimen(modelId))) {
    if (get().loadErr) toast(get().loadErr!.error);
    return false;
  }
  return waitReady(modelId);
}

/** A specimen on the bench with the settings its numbers were measured with, then a reply next to the unsteered one. */
function benchSpecimen(s: LabSpecimen, prompt: string, nextUp: LabStore["nextUp"] = null) {
  const strongest = Math.max(0, ...s.mix.filter(isVector).map((v) => Math.abs(v.strength)));
  labelled(`Tried ${s.name}`, () =>
    set({ mix: s.mix.map((p) => ({ ...p })), scale: 1, prompt, tab: "steer", steerView: "compare", temperature: s.settings.temperature, repeat: s.settings.repeat ?? 1, thinking: false, sweepTarget: "mix", nextUp, ...(strongest ? { sweepRange: strongest > 2 ? 4 : 2 } : {}) }),
  );
}

export async function trySpecimen(s: LabSpecimen) {
  if (get().guideTrying) return;
  const step = (x: string) => set({ guideTrying: { id: s.id, step: x, since: Date.now() } });
  try {
    if (!(await benchHas(s.modelId, step))) return;
    step("Writing both replies");
    benchSpecimen(s, s.prompt);
    await runCompare();
  } finally {
    set({ guideTrying: null });
  }
}

/** Keeps a specimen as a strain, with what it was measured with. Needs no model loaded. */
export async function keepSpecimen(s: LabSpecimen) {
  const st = await callToast("Keep as strain", (l) => l.saveStrain({ name: s.name, baseModelId: s.modelId, pushes: s.mix, settings: s.settings, notes: `${s.line}\n${s.rate}` }));
  if (!st) return;
  putStrain(st);
  undoable({
    label: `Kept "${st.name}" as a strain`,
    undo: async () => {
      await must((l) => l.deleteStrain(st.id));
      dropStrain(st.id);
    },
    redo: () => must((l) => l.saveStrain(strainBody(st))).then(putStrain),
  });
}

// ---------- the ready example ----------

/** The first specimen to try: one neuron, because it shows what a neuron is. */
export function exampleSpecimen(): LabSpecimen | undefined {
  const g = get().guide;
  return g?.specimens.find((s) => s.id === g.example.specimenId);
}

/** One click from an empty bench to a steered reply, which then points on to a character. */
export async function runExample() {
  const step = (x: string) => set({ example: { step: x, since: Date.now() } });
  try {
    await ensureGuide();
    const g = get().guide;
    const s = exampleSpecimen();
    if (!g || !s) {
      toast("This build has no Field Guide, so there is no example");
      return;
    }
    if (!(await benchHas(s.modelId, step))) return;
    step(`Comparing replies with ${s.name}`);
    benchSpecimen(s, g.example.prompt, { from: s.name, id: g.example.next });
    await runCompare();
  } finally {
    set({ example: null });
  }
}

/** The character the example leads to. */
export async function runNextUp() {
  const g = get().guide;
  const next = g?.specimens.find((s) => s.id === get().nextUp?.id);
  if (next) await trySpecimen(next);
}
