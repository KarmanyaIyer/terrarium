import { create } from "zustand";
import type {
  AppState,
  EnvSummary,
  EvalRunDetail,
  EvalRunSummary,
  EvalSuite,
  Id,
  InferenceState,
  MemoryBudget,
  ModelInfo,
  NetEntry,
  ResourceSample,
  SessionSummary,
  TraceEvent,
  WsMessage,
} from "@terrarium/shared";
import type { Backend, ConnStatus } from "../api/backend";

export type View =
  | { kind: "home" }
  | { kind: "session"; id: Id }
  | { kind: "evals"; suiteId?: string; runId?: Id }
  | { kind: "models" };

export type Selection =
  | { kind: "call"; callId: Id; seq: number }
  | { kind: "tool"; toolCallId: string; callId?: Id; seq: number }
  | { kind: "net"; entryId: Id; seq: number }
  | { kind: "event"; seq: number };

export type InspectorTab = "files" | "request" | "network" | "env" | "shell";

export interface LiveCall {
  text: string;
  thinking: string;
  toolcall: string;
  firstAt: number; // client time of the first delta (end of prefill)
  textAt?: number; // client time of the first non-thinking delta
}

export interface OutChunk {
  stream: "stdout" | "stderr";
  text: string;
}

export interface Trace {
  events: TraceEvent[]; // persisted only, sorted by seq, unique
  contiguous: number; // highest seq with no gaps before it
  loaded: boolean;
  error?: string;
  live: Record<string, LiveCall>; // by callId, until assistant_message arrives
  liveOut: Record<string, OutChunk[]>; // by toolCallId, until tool_end arrives
}

export interface Toast {
  id: number;
  text: string;
  tone: "error" | "info";
}

const STREAMED = new Set(["model_delta", "tool_output"]);
const MAX_SAMPLES = 180;

interface Prefs {
  inspectorOpen: boolean;
  inspectorWidth: number;
  sidebarWidth: number;
  timelineOpen: boolean;
}

function loadPrefs(): Prefs {
  const d: Prefs = { inspectorOpen: true, inspectorWidth: 440, sidebarWidth: 232, timelineOpen: true };
  try {
    return { ...d, ...(JSON.parse(localStorage.getItem("terrarium.prefs") ?? "{}") as Partial<Prefs>) };
  } catch {
    return d;
  }
}

export interface Store extends Prefs {
  backend: Backend | null;
  conn: ConnStatus;
  connDetail?: string;
  ready: boolean;

  envs: Record<Id, EnvSummary>;
  sessions: Record<Id, SessionSummary>;
  models: ModelInfo[];
  inference: InferenceState;
  budget: MemoryBudget;
  evalRuns: EvalRunSummary[];
  versions: AppState["versions"] | null;

  traces: Record<Id, Trace>;
  samples: ResourceSample[];
  net: Record<Id, NetEntry[]>; // by env
  evalDetails: Record<Id, EvalRunDetail>;
  suites: EvalSuite[] | null;

  view: View;
  selection: Selection | null;
  inspectorTab: InspectorTab;
  inspectorEnvId: Id | null; // env shown when no session is open
  filesFocus: { path?: string; toolCallId?: string; at?: number } | null;
  paletteOpen: boolean;
  newEnvOpen: boolean;
  expandedEnvs: Record<Id, boolean>;
  showEphemeral: boolean;
  toasts: Toast[];
}

export const useStore = create<Store>()(() => ({
  ...loadPrefs(),
  backend: null,
  conn: "connecting",
  ready: false,
  envs: {},
  sessions: {},
  models: [],
  inference: { status: "stopped" },
  budget: { totalBytes: 0, budgetBytes: 0 },
  evalRuns: [],
  versions: null,
  traces: {},
  samples: [],
  net: {},
  evalDetails: {},
  suites: null,
  view: { kind: "home" },
  selection: null,
  inspectorTab: "files",
  inspectorEnvId: null,
  filesFocus: null,
  paletteOpen: false,
  newEnvOpen: false,
  expandedEnvs: {},
  showEphemeral: false,
  toasts: [],
}));

const set = useStore.setState;
const get = useStore.getState;

export function savePrefs() {
  const s = get();
  const p: Prefs = {
    inspectorOpen: s.inspectorOpen,
    inspectorWidth: s.inspectorWidth,
    sidebarWidth: s.sidebarWidth,
    timelineOpen: s.timelineOpen,
  };
  localStorage.setItem("terrarium.prefs", JSON.stringify(p));
}

export function setPref<K extends keyof Prefs>(k: K, v: Prefs[K]) {
  set({ [k]: v } as Pick<Prefs, K>);
  savePrefs();
}

// ---------- toasts ----------

let toastId = 0;
export function toast(text: string, tone: Toast["tone"] = "error") {
  const id = ++toastId;
  set((s) => ({ toasts: [...s.toasts, { id, text, tone }].slice(-4) }));
  window.setTimeout(() => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), tone === "error" ? 8000 : 3500);
}

export function dismissToast(id: number) {
  set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
}

/** Runs a backend call; failures become a toast with the server's message. */
export async function act<T>(label: string, fn: (b: Backend) => Promise<T>): Promise<T | undefined> {
  const b = get().backend;
  if (!b) return undefined;
  try {
    return await fn(b);
  } catch (err) {
    const e = err as { message?: string; detail?: string };
    toast(`${label}: ${e.message ?? String(err)}${e.detail ? ` (${e.detail})` : ""}`);
    return undefined;
  }
}

// ---------- hydrate + live updates ----------

function hydrate(state: AppState) {
  set({
    envs: Object.fromEntries(state.envs.map((x) => [x.id, x])),
    sessions: Object.fromEntries(state.sessions.map((x) => [x.id, x])),
    models: state.models,
    inference: state.inference,
    budget: state.budget,
    evalRuns: state.evalRuns,
    versions: state.versions,
    ready: true,
  });
}

let disconnect: (() => void) | null = null;

export async function startBackend(backend: Backend) {
  disconnect?.();
  set({ backend, conn: "connecting", ready: false, traces: {}, samples: [], net: {}, evalDetails: {}, suites: null });
  disconnect = backend.connect({
    onMessage: handleMessage,
    onStatus: (conn, detail) => {
      const was = get().conn;
      set({ conn, connDetail: detail });
      if (conn === "open" && was !== "open") void resync();
    },
  });
}

/** After (re)connect: refresh state and fill gaps in every loaded trace. */
async function resync() {
  const b = get().backend;
  if (!b) return;
  try {
    hydrate(await b.getState());
  } catch (err) {
    set({ connDetail: `GET /api/state failed: ${String(err)}` });
  }
  for (const id of Object.keys(get().traces)) void fillGap(id);
  syncSubscriptions();
}

function handleMessage(msg: WsMessage) {
  switch (msg.type) {
    case "hello":
      hydrate(msg.state);
      break;
    case "trace":
      onTrace(msg.event);
      break;
    case "session":
      set((s) => ({ sessions: { ...s.sessions, [msg.session.id]: msg.session } }));
      break;
    case "session_deleted":
      set((s) => {
        const sessions = { ...s.sessions };
        delete sessions[msg.sessionId];
        const view = s.view.kind === "session" && s.view.id === msg.sessionId ? { kind: "home" as const } : s.view;
        return { sessions, view };
      });
      break;
    case "env":
      set((s) => ({ envs: { ...s.envs, [msg.env.id]: msg.env } }));
      break;
    case "env_deleted":
      set((s) => {
        const envs = { ...s.envs };
        delete envs[msg.envId];
        return { envs, inspectorEnvId: s.inspectorEnvId === msg.envId ? null : s.inspectorEnvId };
      });
      break;
    case "env_net":
      set((s) => {
        const cur = s.net[msg.entry.envId];
        if (!cur || cur.some((x) => x.id === msg.entry.id)) return {};
        return { net: { ...s.net, [msg.entry.envId]: [...cur, msg.entry] } };
      });
      break;
    case "env_fs":
      fsHints.forEach((fn) => fn(msg.envId));
      break;
    case "models":
      set({ models: msg.models });
      break;
    case "inference":
      set({ inference: msg.inference });
      break;
    case "resources":
      set((s) => {
        const samples = s.samples.length >= MAX_SAMPLES ? s.samples.slice(1) : s.samples.slice();
        samples.push(msg.sample);
        return { samples };
      });
      break;
    case "eval_run":
      set((s) => {
        const runs = s.evalRuns.filter((r) => r.id !== msg.run.id);
        runs.unshift(msg.run);
        runs.sort((a, b) => b.startedAt - a.startedAt);
        const d = s.evalDetails[msg.run.id];
        return {
          evalRuns: runs,
          evalDetails: d ? { ...s.evalDetails, [msg.run.id]: { ...d, ...msg.run } } : s.evalDetails,
        };
      });
      break;
    case "eval_result":
      set((s) => {
        const d = s.evalDetails[msg.runId];
        if (!d) return {};
        const r = msg.result;
        const results = d.results.filter((x) => !(x.caseId === r.caseId && x.modelId === r.modelId));
        results.push(r);
        return { evalDetails: { ...s.evalDetails, [msg.runId]: { ...d, results } } };
      });
      break;
  }
}

const fsHints = new Set<(envId: Id) => void>();
export function onEnvFs(fn: (envId: Id) => void) {
  fsHints.add(fn);
  return () => fsHints.delete(fn);
}

function emptyTrace(): Trace {
  return { events: [], contiguous: 0, loaded: false, live: {}, liveOut: {} };
}

function onTrace(ev: TraceEvent) {
  const t = get().traces[ev.sessionId];
  if (!t) return; // not loaded; ignore stray events

  if (STREAMED.has(ev.type)) {
    if (ev.type === "model_delta") {
      const now = Date.now();
      const cur = t.live[ev.callId] ?? { text: "", thinking: "", toolcall: "", firstAt: now };
      const next = { ...cur, [ev.kind]: cur[ev.kind] + ev.delta };
      if (ev.kind !== "thinking" && cur.textAt == null) next.textAt = now;
      putTrace(ev.sessionId, { ...t, live: { ...t.live, [ev.callId]: next } });
    } else if (ev.type === "tool_output") {
      const cur = t.liveOut[ev.toolCallId] ?? [];
      const last = cur[cur.length - 1];
      const next =
        last && last.stream === ev.stream
          ? [...cur.slice(0, -1), { stream: ev.stream, text: last.text + ev.chunk }]
          : [...cur, { stream: ev.stream, text: ev.chunk }];
      putTrace(ev.sessionId, { ...t, liveOut: { ...t.liveOut, [ev.toolCallId]: next } });
    }
    return;
  }
  mergeEvents(ev.sessionId, [ev]);
  if (ev.seq > get().traces[ev.sessionId].contiguous + 1) void fillGap(ev.sessionId);
}

function putTrace(id: Id, t: Trace) {
  set((s) => ({ traces: { ...s.traces, [id]: t } }));
}

function mergeEvents(id: Id, incoming: TraceEvent[]) {
  const t = get().traces[id] ?? emptyTrace();
  let events = t.events;
  let changed = false;
  for (const ev of incoming) {
    if (STREAMED.has(ev.type)) continue;
    const last = events[events.length - 1];
    if (!last || ev.seq > last.seq) {
      if (!changed) events = events.slice();
      events.push(ev);
      changed = true;
      continue;
    }
    // out of order: binary search for slot, drop duplicates
    let lo = 0;
    let hi = events.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (events[mid].seq < ev.seq) lo = mid + 1;
      else hi = mid;
    }
    if (events[lo] && events[lo].seq === ev.seq) continue;
    if (!changed) events = events.slice();
    events.splice(lo, 0, ev);
    changed = true;
  }
  if (!changed) return;

  let contiguous = t.contiguous;
  // seqs may start at 0 or 1; treat the first event as the base
  if (contiguous === 0 && events.length && events[0].seq <= 1) contiguous = events[0].seq;
  for (const ev of events) {
    if (ev.seq <= contiguous) continue;
    if (ev.seq === contiguous + 1) contiguous = ev.seq;
    else break;
  }

  // drop live buffers that now have a persisted final
  let live = t.live;
  let liveOut = t.liveOut;
  for (const ev of incoming) {
    if (ev.type === "assistant_message" && live[ev.callId]) {
      live = { ...live };
      delete live[ev.callId];
    } else if (ev.type === "tool_end" && liveOut[ev.toolCallId]) {
      liveOut = { ...liveOut };
      delete liveOut[ev.toolCallId];
    }
  }
  putTrace(id, { ...t, events, contiguous, live, liveOut });
}

const gapInflight = new Set<Id>();
async function fillGap(id: Id) {
  const b = get().backend;
  const t = get().traces[id];
  if (!b || !t || gapInflight.has(id)) return;
  gapInflight.add(id);
  try {
    const evs = await b.getEvents(id, t.contiguous || undefined);
    mergeEvents(id, evs);
  } catch {
    /* next reconnect retries */
  } finally {
    gapInflight.delete(id);
  }
}

export async function loadTrace(id: Id, force = false) {
  const b = get().backend;
  if (!b) return;
  const cur = get().traces[id];
  if (cur?.loaded && !force) return;
  if (!cur) putTrace(id, emptyTrace());
  syncSubscriptions();
  try {
    const evs = await b.getEvents(id);
    mergeEvents(id, evs);
    const t = get().traces[id];
    putTrace(id, { ...t, loaded: true, error: undefined });
  } catch (err) {
    const t = get().traces[id] ?? emptyTrace();
    putTrace(id, { ...t, loaded: true, error: String(err) });
  }
}

/** The open session gets trace events; others only get `session` summaries. */
export function syncSubscriptions() {
  const s = get();
  const ids = new Set<Id>();
  if (s.view.kind === "session") ids.add(s.view.id);
  s.backend?.subscribe([...ids]);
}

// ---------- navigation ----------

export function openSession(id: Id, sel?: Selection) {
  const s = get();
  const sess = s.sessions[id];
  set({
    view: { kind: "session", id },
    selection: sel ?? null,
    filesFocus: null,
    inspectorEnvId: sess ? sess.envId : s.inspectorEnvId,
    expandedEnvs: sess?.envId ? { ...s.expandedEnvs, [sess.envId]: true } : s.expandedEnvs,
  });
  if (!sess?.envId && (s.inspectorTab === "files" || s.inspectorTab === "network" || s.inspectorTab === "shell"))
    set({ inspectorTab: "request" });
  void loadTrace(id);
  syncSubscriptions();
}

export function openView(view: View) {
  set({ view, selection: null });
  syncSubscriptions();
}

export function openEnv(envId: Id, tab: InspectorTab = "env") {
  const s = get();
  set({
    inspectorEnvId: envId,
    inspectorTab: tab,
    inspectorOpen: true,
    expandedEnvs: { ...s.expandedEnvs, [envId]: true },
  });
  savePrefs();
}

export function select(sel: Selection | null, opts: { follow?: boolean } = {}) {
  const patch: Partial<Store> = { selection: sel };
  if (sel && opts.follow !== false) {
    if (sel.kind === "call") patch.inspectorTab = "request";
    if (sel.kind === "net") patch.inspectorTab = "network";
    if (sel.kind === "tool") {
      patch.filesFocus = { toolCallId: sel.toolCallId };
    }
  }
  set(patch);
}

export function showFilesFor(toolCallId: string) {
  set({ inspectorTab: "files", inspectorOpen: true, filesFocus: { toolCallId } });
}

export function currentSession(): SessionSummary | undefined {
  const s = get();
  return s.view.kind === "session" ? s.sessions[s.view.id] : undefined;
}

export async function loadNet(envId: Id) {
  const b = get().backend;
  if (!b) return;
  try {
    const entries = await b.getNet(envId, 1000);
    set((s) => {
      const live = s.net[envId] ?? [];
      const ids = new Set(entries.map((x) => x.id));
      const merged = [...entries, ...live.filter((x) => !ids.has(x.id))].sort((a, b) => a.ts - b.ts);
      return { net: { ...s.net, [envId]: merged } };
    });
  } catch (err) {
    toast(`Network log: ${String(err)}`);
  }
}

export async function loadEvalRun(id: Id) {
  const d = await act("Eval run", (b) => b.getEvalRun(id));
  if (d) set((s) => ({ evalDetails: { ...s.evalDetails, [id]: d } }));
}

export async function loadSuites() {
  const suites = await act("Eval suites", (b) => b.listSuites());
  if (suites) set({ suites });
}
