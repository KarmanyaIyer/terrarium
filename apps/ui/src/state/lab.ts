// Lab state: the sidecar's LabState (from /api/state and `lab` messages), strains, probe sets, and each step's inputs and
// last result. Kept outside the main store so the Lab can grow without touching it; inputs survive leaving the Lab,
// and the mix, watch list and prompt survive a reload.

import { create } from "zustand";
import type {
  Id,
  LabAttributeResult,
  LabFindResult,
  LabGenerateResult,
  LabMemoryCheck,
  LabNeuronCard,
  LabProbeResult,
  LabProbeSet,
  LabPush,
  LabState,
  LabStrain,
  LabSweepRequest,
  LabSweepResult,
  NeuronRef,
  WsMessage,
} from "@terrarium/shared";
import type { LabApi } from "../api/lab";
import { nid, sameRef } from "../lib/recipe";
import { openSession, openView, toast, useStore } from "./store";

export type LabTab = "probe" | "find" | "steer" | "strains" | "trace";

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

export interface SteerRun {
  id: number;
  at: number;
  prompt: string;
  mix: LabPush[];
  scale: number;
  temperature: number;
  res: LabGenerateResult;
}

export interface SweepRun {
  at: number;
  req: LabSweepRequest;
  label: string; // "whole mix (scale)" or the target's id
  res: LabSweepResult;
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

  setId: Id | null;
  setName: string;
  concept: string;
  control: string;
  testPrompt: string;
  dirty: boolean;
  findRes: LabFindResult | null;
  findErr: LabErr | null;
  findBusy: number | null;
  findSort: FindSort;

  mix: LabPush[];
  scale: number;
  prompt: string;
  seed: number;
  lockSeed: boolean;
  temperature: number;
  maxTokens: number;
  thinking: boolean;
  runs: SteerRun[];
  compareBusy: number | null;
  compareErr: LabErr | null;
  sweepTarget: string; // "mix" or a neuron id
  doses: string;
  sweep: SweepRun | null;
  sweepBusy: number | null;
  sweepErr: LabErr | null;

  attrPrompt: string;
  attrPrefill: string;
  attrTarget: string;
  attrFoil: string;
  attrMix: boolean;
  attrRes: LabAttributeResult | null;
  attrBusy: number | null;
  attrErr: LabErr | null;

  example: { step: string; since: number } | null;
}

export const DEFAULT_DOSES = "0, 0.25, 0.5, 0.75, 1, 1.5, 2, 3";
const PERSIST_KEY = "terrarium.lab";
type Persisted = Pick<LabStore, "mix" | "scale" | "watch" | "prompt" | "tab" | "probeText" | "temperature" | "maxTokens" | "target" | "benchModel">;

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
  tab: "find",
  target: null,
  benchModel: null,
  mem: null,
  memBusy: null,
  freeing: null,
  loadErr: null,
  loadSince: null,
  card: null,
  words: {},
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
  setId: null,
  setName: "",
  concept: "",
  control: "",
  testPrompt: "",
  dirty: false,
  findRes: null,
  findErr: null,
  findBusy: null,
  findSort: "both",
  mix: [],
  scale: 1,
  prompt: "Who are you?",
  seed: randomSeed(),
  lockSeed: false,
  temperature: 0.7,
  maxTokens: 160,
  thinking: false,
  runs: [],
  compareBusy: null,
  compareErr: null,
  sweepTarget: "mix",
  doses: DEFAULT_DOSES,
  sweep: null,
  sweepBusy: null,
  sweepErr: null,
  attrPrompt: "Who are you?",
  attrPrefill: "I am an",
  attrTarget: " alien",
  attrFoil: "",
  attrMix: true,
  attrRes: null,
  attrBusy: null,
  attrErr: null,
  example: null,
  ...loadPersisted(),
}));

const set = useLab.setState;
const get = useLab.getState;

useLab.subscribe((s, prev) => {
  if (s.mix === prev.mix && s.scale === prev.scale && s.watch === prev.watch && s.prompt === prev.prompt && s.tab === prev.tab && s.probeText === prev.probeText && s.temperature === prev.temperature && s.maxTokens === prev.maxTokens && s.target === prev.target && s.benchModel === prev.benchModel) return;
  const p: Persisted = { mix: s.mix, scale: s.scale, watch: s.watch, prompt: s.prompt, tab: s.tab, probeText: s.probeText, temperature: s.temperature, maxTokens: s.maxTokens, target: s.target, benchModel: s.benchModel };
  localStorage.setItem(PERSIST_KEY, JSON.stringify(p));
});

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
    set({ probeRes: null, findRes: null, card: null, runs: [], sweep: null, attrRes: null, watch: [] });
    if (s.mix.length) {
      set({ mix: [], scale: 1 });
      toast(`Mix cleared: its neurons were from ${lab.support.find((x) => x.modelId === s.benchModel)?.name ?? s.benchModel}`);
    }
  }
  set({ benchModel: id });
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

/** First visit: state (if /api/state had none), strains, probe sets, and the bench's default model. */
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
  await ensureSets();
  const lab = get().lab;
  if (lab && !get().target) {
    const sup = lab.support.filter((x) => x.supported);
    const pick = lab.model?.modelId ?? lab.loadingModelId ?? (sup.find((x) => x.modelId === EXAMPLE.modelId) ?? sup[0])?.modelId ?? null;
    set({ target: pick });
  }
  if (get().target && !get().mem && !(get().lab?.status === "ready" && get().lab?.model?.modelId === get().target)) void checkMemory();
}

async function ensureSets() {
  if (get().sets) return;
  const r = await call((l) => l.probeSets());
  if (!r.ok) return;
  set({ sets: r.v });
  if (!get().setId && !get().concept) {
    const first = r.v.find((x) => x.id === EXAMPLE.setId) ?? r.v[0];
    if (first) pickSet(first.id);
  }
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
  return get().mix.find((p) => sameRef(p, ref));
}

export function addToMix(ref: NeuronRef, value = 0.8) {
  if (inMix(ref)) {
    toast(`${nid(ref)} is already in the mix`, "info");
    return;
  }
  set((s) => ({ mix: [...s.mix, { layer: ref.layer, neuron: ref.neuron, mode: "dose", value }] }));
  toast(`Added ${nid(ref)} to the mix at dose ${value}`, "info");
}

export function setPush(i: number, p: Partial<LabPush>) {
  set((s) => ({ mix: s.mix.map((x, j) => (j === i ? { ...x, ...p } : x)) }));
}

export function removePush(i: number) {
  set((s) => ({ mix: s.mix.filter((_, j) => j !== i) }));
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
      mix: s.probeMix && s.mix.length ? scaledMix(s) : undefined,
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
  set({ setId: id, setName: ps.name, concept: toLines(ps.concept), control: toLines(ps.control), testPrompt: ps.testPrompt ?? "", dirty: false, findRes: null, findErr: null });
}

export function editSet(p: Partial<Pick<LabStore, "concept" | "control" | "testPrompt">>) {
  set({ ...p, dirty: true });
}

export async function saveSet(asName?: string) {
  const s = get();
  const body = { name: asName ?? s.setName, concept: fromLines(s.concept), control: fromLines(s.control), testPrompt: s.testPrompt.trim() || undefined };
  const cur = s.sets?.find((x) => x.id === s.setId);
  const saved = asName || !cur || cur.builtin ? await callToast("Save probe set", (l) => l.saveProbeSet(body)) : await callToast("Save probe set", (l) => l.updateProbeSet(cur.id, body));
  if (!saved) return;
  set((st) => ({ sets: [...(st.sets ?? []).filter((x) => x.id !== saved.id), saved], setId: saved.id, setName: saved.name, dirty: false }));
}

export async function deleteSet() {
  const id = get().setId;
  if (!id) return;
  const r = await call((l) => l.deleteProbeSet(id));
  if (!r.ok) {
    toast(`Delete probe set: ${r.err.error}`);
    return;
  }
  const rest = (get().sets ?? []).filter((x) => x.id !== id);
  set({ sets: rest });
  if (rest[0]) pickSet(rest[0].id);
}

export async function runFind(): Promise<LabFindResult | null> {
  const s = get();
  const concept = fromLines(s.concept);
  const control = fromLines(s.control);
  if (!concept.length || !control.length) return null;
  set({ findBusy: Date.now(), findErr: null });
  const r = await call((l) => l.find({ concept, control, prompt: s.testPrompt.trim() || undefined, previews: 6 }));
  if (!r.ok) {
    set({ findErr: r.err, findBusy: null });
    return null;
  }
  set({ findRes: r.v, findBusy: null });
  set((st) => {
    const words = { ...st.words };
    for (const c of r.v.candidates) words[nid(c)] = c.writes.tokens.length ? c.writes.tokens : c.promotes;
    return { words };
  });
  if (s.testPrompt.trim()) set({ prompt: s.testPrompt.trim() });
  return r.v;
}

// ---------- steer ----------

function nextSeed(): number {
  const s = get();
  if (s.lockSeed) return s.seed;
  const seed = randomSeed();
  set({ seed });
  return seed;
}

let runId = 0;
export async function runCompare() {
  const s = get();
  if (!s.prompt.trim() || !s.mix.length) return;
  const seed = nextSeed();
  set({ compareBusy: Date.now(), compareErr: null });
  const req = { prompt: s.prompt, mix: s.mix, scale: s.scale, seed, temperature: s.temperature, maxTokens: s.maxTokens, thinking: s.thinking, baseline: true };
  const r = await call((l) => l.generate(req));
  if (!r.ok) {
    set({ compareErr: r.err, compareBusy: null });
    return;
  }
  const run: SteerRun = { id: ++runId, at: Date.now(), prompt: s.prompt, mix: s.mix, scale: s.scale, temperature: s.temperature, res: r.v };
  set((st) => ({ runs: [run, ...st.runs].slice(0, 12), compareBusy: null, seed: r.v.seed }));
}

/** Distinct doses in the order typed, at most 16 (the sidecar's limit). */
export function parseDoses(text: string): number[] {
  const out = [
    ...new Set(
      text
        .split(/[\s,;]+/)
        .filter(Boolean)
        .map(Number)
        .filter(Number.isFinite),
    ),
  ];
  return out.slice(0, 16);
}

/** The mix with the scale multiplied into its doses (clamps stay as set): what Compare generates with. */
const scaledMix = (s: LabStore): LabPush[] => s.mix.map((p) => ({ ...p, value: p.mode === "dose" ? p.value * s.scale : p.value }));

export async function runSweep() {
  const s = get();
  const doses = parseDoses(s.doses);
  if (!s.prompt.trim() || !s.mix.length || !doses.length) return;
  const target = s.sweepTarget === "mix" ? undefined : s.mix.find((p) => nid(p) === s.sweepTarget);
  const seed = nextSeed();
  const req: LabSweepRequest = {
    prompt: s.prompt,
    // one neuron: the others at their scaled doses; whole mix: the rows are absolute scales
    mix: target ? scaledMix(s) : s.mix,
    doses,
    target: target ? { layer: target.layer, neuron: target.neuron } : undefined,
    seed,
    temperature: s.temperature,
    maxTokens: s.maxTokens,
    thinking: s.thinking,
  };
  set({ sweepBusy: Date.now(), sweepErr: null });
  const r = await call((l) => l.sweep(req));
  if (!r.ok) {
    set({ sweepErr: r.err, sweepBusy: null });
    return;
  }
  set({ sweep: { at: Date.now(), req, label: target ? nid(target) : "whole mix", res: r.v }, sweepBusy: null, seed: r.v.seed });
}

/** Saves the mix as a strain on the bench's model. */
export async function saveStrain(name: string, notes: string): Promise<LabStrain | undefined> {
  const s = get();
  const base = s.lab?.model?.modelId;
  if (!base) return undefined;
  const pushes = s.mix.map((p) => ({ ...p, value: p.mode === "dose" ? Math.round(p.value * s.scale * 1000) / 1000 : p.value }));
  const st = await callToast("Save strain", (l) => l.saveStrain({ name, baseModelId: base, pushes, notes }));
  if (st) {
    set((x) => ({ strains: [st, ...(x.strains ?? []).filter((y) => y.id !== st.id)] }));
    toast(`Saved strain "${st.name}"`, "info");
  }
  return st;
}

// ---------- strains ----------

export function loadStrainIntoMix(st: LabStrain) {
  // the mix now belongs to the strain's base: loading that base keeps it, and results from another model go
  if (get().benchModel !== st.baseModelId) set({ probeRes: null, findRes: null, card: null, runs: [], sweep: null, attrRes: null, watch: [] });
  set({ mix: st.pushes.map((p) => ({ ...p })), scale: 1, tab: "steer", benchModel: st.baseModelId });
}

export async function updateStrain(id: Id, p: { name?: string; notes?: string; pushes?: LabPush[] }) {
  const st = await callToast("Update strain", (l) => l.updateStrain(id, p));
  if (st) set((x) => ({ strains: (x.strains ?? []).map((y) => (y.id === st.id ? st : y)) }));
  return st;
}

export async function deleteStrain(id: Id) {
  const r = await call((l) => l.deleteStrain(id));
  if (!r.ok) {
    toast(`Delete strain: ${r.err.error}${r.err.detail ? ` (${r.err.detail})` : ""}`);
    return;
  }
  set((x) => ({ strains: (x.strains ?? []).filter((y) => y.id !== id) }));
}

export async function importStrain(name: string, baseModelId: Id, pushes: LabPush[], notes: string) {
  const st = await callToast("Import strain", (l) => l.saveStrain({ name, baseModelId, pushes, notes }));
  if (st) set((x) => ({ strains: [st, ...(x.strains ?? []).filter((y) => y.id !== st.id)] }));
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
  const r = await call((l) =>
    l.attribute({ prompt: s.attrPrompt, prefill: s.attrPrefill || undefined, target: s.attrTarget, foil: s.attrFoil || undefined, mix: s.attrMix && s.mix.length ? scaledMix(s) : undefined }),
  );
  set(r.ok ? { attrRes: r.v, attrBusy: null } : { attrErr: r.err, attrBusy: null });
  if (r.ok) for (const n of r.v.nodes) noteWords(n, n.promotes);
}

// ---------- the ready example ----------

/** One click from an empty bench to a steered reply. Retarget after live testing: model, probe set, dose. */
export const EXAMPLE = { modelId: "Qwen3.5-4B-MLX-4bit", setId: "builtin:aliens", dose: 0.8 };

export async function runExample() {
  const step = (s: string) => set({ example: { step: s, since: Date.now() } });
  try {
    const lab = get().lab;
    if (!(lab?.status === "ready" && lab.model?.modelId === EXAMPLE.modelId)) {
      const name = lab?.support.find((x) => x.modelId === EXAMPLE.modelId)?.name ?? EXAMPLE.modelId;
      step(`Loading ${name}`);
      set({ target: EXAMPLE.modelId });
      if (!(await loadSpecimen(EXAMPLE.modelId))) return; // refused: the memory panel says why
      if (!(await waitReady(EXAMPLE.modelId))) return;
    }
    await ensureSets();
    const ps = get().sets?.find((x) => x.id === EXAMPLE.setId);
    if (!ps) {
      toast(`Example: probe set ${EXAMPLE.setId} not found`);
      return;
    }
    pickSet(ps.id);
    set({ tab: "find", findSort: "both" });
    step(`Finding neurons for "${ps.name}"`);
    const res = await runFind();
    const top = res?.candidates[0];
    if (!top) return;
    step(`Comparing replies with ${nid(top)} at +${EXAMPLE.dose}`);
    set({ mix: [{ layer: top.layer, neuron: top.neuron, mode: "dose", value: EXAMPLE.dose }], scale: 1, tab: "steer", prompt: ps.testPrompt ?? get().prompt });
    await runCompare();
  } finally {
    set({ example: null });
  }
}
