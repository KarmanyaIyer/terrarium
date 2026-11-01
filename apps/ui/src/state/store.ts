import { create } from "zustand";
import type {
  AppSettings,
  AppState,
  EnvSummary,
  EvalRunDetail,
  EvalRunSummary,
  EvalSuite,
  HarnessInfo,
  Id,
  InferenceState,
  MemoryBudget,
  ModelDownload,
  ModelInfo,
  NetEntry,
  ResourceSample,
  SessionSummary,
  TraceEvent,
  WsMessage,
  VmSetup,
} from "@terrarium/shared";
import type { Backend, ConnStatus } from "../api/backend";
import { afterChunk, mergeNetPage } from "../lib/catchup";
import { addToast, toastKind } from "../lib/toasts";
import { labHydrate, labMessage } from "./lab";

export type View =
  | { kind: "home" }
  | { kind: "session"; id: Id }
  | { kind: "evals"; suiteId?: string; runId?: Id; pick?: Id }
  | { kind: "models" }
  | { kind: "settings" }
  | { kind: "lab" };

export type Selection =
  | { kind: "call"; callId: Id; seq: number }
  | { kind: "tool"; toolCallId: string; callId?: Id; seq: number }
  | { kind: "net"; entryId: Id; seq: number }
  | { kind: "event"; seq: number };

export type InspectorTab = "files" | "request" | "prompt" | "network" | "env" | "shell";

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
  // calls and tool calls whose live buffers hold every chunk (afterChunk); `next` is the chunk index expected next
  whole: Record<string, boolean>;
  next: Record<string, number>;
}

export interface Toast {
  id: number;
  text: string;
  kind: string;
  tone: "error" | "info";
  action?: { label: string; run: () => void };
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

/** Below this window width the inspector would take the transcript's room, so it opens only when asked for. */
export const INSPECTOR_MIN_WINDOW = 1180;

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
  settings: AppSettings;
  downloads: Record<Id, ModelDownload>;
  vmSetup: VmSetup;
  vmBuilding: number | null;
  vmBuildError: string | null; // why the last build failed, kept on the note
  harness: HarnessInfo[] | null;

  traces: Record<Id, Trace>;
  samples: ResourceSample[];
  net: Record<Id, NetEntry[]>; // by env, oldest latest-attempt first
  netLimit: Record<Id, number>; // rows asked for; a response that long may have left older rows out
  netCapped: Record<Id, boolean>;
  evalDetails: Record<Id, EvalRunDetail>;
  suites: EvalSuite[] | null;

  view: View;
  selection: Selection | null;
  inspectorTab: InspectorTab;
  inspectorEnvId: Id | null; // env shown when no session is open
  filesFocus: { path?: string; toolCallId?: string; at?: number } | null;
  paletteOpen: boolean;
  newEnvOpen: boolean;
  newEnvPreset: { type: EnvSummary["type"]; modelId?: Id } | null; // what the New environment sheet opens with, and the model its first session uses (null: settings defaults)
  composerFill: { sessionId: Id; text: string; n: number } | null; // a starter task put into that session's composer
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
  settings: {
    memoryBudgetBytes: 0,
    resourceBudgets: {
      maxSimWorkers: 8,
      simWorkerRssBytes: 1024 * 1024 * 1024,
      simWorkerCpuMs: 30 * 60_000,
      hostFreeDiskReserveBytes: 20 * 1024 * 1024 * 1024,
      sessionTraceBytes: 1024 * 1024 * 1024,
      sessionCaptureBytes: 512 * 1024 * 1024,
      sessionSnapshotCount: 256,
      sessionNetworkRows: 2000,
      sessionRequestCount: 2000,
      sessionNetworkBytes: 256 * 1024 * 1024,
      networkBurst: 120,
      networkRefillPerSecond: 20,
    },
    newSession: { modelId: null, contextWindow: null, thinking: "model", harness: "terrarium" },
    newEnv: { type: "vm", network: "off" },
    prompts: {},
  },
  downloads: {},
  vmSetup: { ok: true },
  vmBuilding: null,
  vmBuildError: null,
  harness: null,
  traces: {},
  samples: [],
  net: {},
  netLimit: {},
  netCapped: {},
  evalDetails: {},
  suites: null,
  view: { kind: "home" },
  selection: null,
  inspectorTab: "files",
  inspectorEnvId: null,
  filesFocus: null,
  paletteOpen: false,
  newEnvOpen: false,
  newEnvPreset: null,
  composerFill: null,
  expandedEnvs: {},
  showEphemeral: false,
  toasts: [],
}));

const set = useStore.setState;
const get = useStore.getState;

export function savePrefs() {
  const s = get();
  const p: Prefs = {
    // narrow windows close it for room; that isn't a choice to remember
    inspectorOpen: window.innerWidth < INSPECTOR_MIN_WINDOW ? loadPrefs().inspectorOpen : s.inspectorOpen,
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
/** Sessions deleted but still within their undo window (state/appUndo.ts): the server doesn't know yet. Kept across a
 *  quit or reload, when they are deleted for good. */
const HIDDEN_KEY = "terrarium.deleted-sessions";
function loadHidden(): Id[] {
  try {
    return JSON.parse(localStorage.getItem(HIDDEN_KEY) ?? "[]") as Id[];
  } catch {
    return [];
  }
}
export const hiddenSessions = new Set<Id>(loadHidden());
export function saveHiddenSessions() {
  localStorage.setItem(HIDDEN_KEY, JSON.stringify([...hiddenSessions]));
}

export function toast(text: string, tone: Toast["tone"] = "error", action?: Toast["action"]) {
  const id = ++toastId;
  set((s) => ({ toasts: addToast(s.toasts, { id, text, kind: toastKind(text, !!action), tone, action }) }));
  window.setTimeout(() => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), tone === "error" ? 8000 : action ? 7000 : 3500);
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
  // the state lists no eval case sessions; keep the ones fetched when opened
  const evalSessions = Object.values(get().sessions).filter((x) => x.evalRunId);
  set({
    envs: Object.fromEntries(state.envs.map((x) => [x.id, x])),
    sessions: Object.fromEntries([...evalSessions, ...state.sessions].filter((x) => !hiddenSessions.has(x.id)).map((x) => [x.id, x])),
    models: state.models,
    inference: state.inference,
    budget: state.budget,
    evalRuns: state.evalRuns,
    versions: state.versions,
    settings: state.settings,
    downloads: Object.fromEntries((state.downloads ?? []).map((d) => [d.id, d])),
    vmSetup: state.vmSetup ?? { ok: true },
    ready: true,
  });
  labHydrate(state.lab);
}

let disconnect: (() => void) | null = null;

export async function startBackend(backend: Backend) {
  disconnect?.();
  subscribed = new Set();
  set({ backend, conn: "connecting", ready: false, traces: {}, samples: [], net: {}, netLimit: {}, netCapped: {}, evalDetails: {}, suites: null });
  disconnect = backend.connect({
    onMessage: handleMessage,
    onStatus: (conn, detail) => {
      const was = get().conn;
      set({ conn, connDetail: detail });
      if (conn === "open" && was !== "open") {
        // deltas sent while the socket was down are gone; the persisted events come back through fillGap
        for (const id of subscribed) resetLive(id);
        void resync();
      }
    },
  });
}

/** After (re)connect: refresh state, fill gaps in every loaded trace, reload every loaded network log. */
async function resync() {
  const b = get().backend;
  if (!b) return;
  try {
    hydrate(await b.getState());
  } catch (err) {
    set({ connDetail: `GET /api/state failed: ${String(err)}` });
  }
  for (const id of Object.keys(get().traces)) void fillGap(id);
  for (const envId of Object.keys(get().net)) void loadNet(envId);
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
      if (!hiddenSessions.has(msg.session.id)) set((s) => ({ sessions: { ...s.sessions, [msg.session.id]: msg.session } }));
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
        if (!cur) return {};
        // A known id is a repeat of a collapsed row: it moves to the end, where its latest attempt now sorts.
        return { net: { ...s.net, [msg.entry.envId]: [...cur.filter((x) => x.id !== msg.entry.id), msg.entry] } };
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
    case "settings":
      // saved prompts feed the harness cards; the memory ceiling feeds every budget bar
      set((s) => ({ settings: msg.settings, harness: null, budget: { ...s.budget, budgetBytes: msg.settings.memoryBudgetBytes } }));
      break;
    case "lab":
    case "lab_strains":
      labMessage(msg);
      break;
    case "model_download":
      set((s) => ({ downloads: { ...s.downloads, [msg.download.id]: msg.download } }));
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
  return { events: [], contiguous: 0, loaded: false, live: {}, liveOut: {}, whole: {}, next: {} };
}

/** Live buffers that missed chunks (trace not subscribed, socket down) are dropped rather than shown with a hole. */
function resetLive(id: Id) {
  const t = get().traces[id];
  if (t && (Object.keys(t.live).length || Object.keys(t.liveOut).length || Object.keys(t.whole).length)) putTrace(id, { ...t, live: {}, liveOut: {}, whole: {}, next: {} });
}

function onTrace(ev: TraceEvent) {
  // The backend re-sends the session summary only on status changes; the trace carries usage after every call.
  if (ev.type === "context") {
    const s = get().sessions[ev.sessionId];
    if (s) set((st) => ({ sessions: { ...st.sessions, [s.id]: { ...s, context: ev.usage } } }));
  }
  let t = get().traces[ev.sessionId];
  if (!t) return; // not loaded; ignore stray events
  if (ev.type === "model_call_start" || ev.type === "tool_start") {
    t = { ...t, whole: { ...t.whole, [ev.type === "tool_start" ? ev.toolCallId : ev.callId]: true } };
    putTrace(ev.sessionId, t);
  }

  if (ev.type === "model_delta" || ev.type === "tool_output") {
    const id = ev.type === "model_delta" ? ev.callId : ev.toolCallId;
    const seen = afterChunk({ whole: t.whole[id], next: t.next[id] }, ev.n);
    t = { ...t, whole: { ...t.whole, [id]: seen.whole }, next: seen.next === undefined ? t.next : { ...t.next, [id]: seen.next } };
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
const gapAgain = new Set<Id>();
/** Fetches every persisted event after the last contiguous one; a request made while one is in flight runs after it. */
async function fillGap(id: Id) {
  const b = get().backend;
  const t = get().traces[id];
  if (!b || !t) return;
  if (gapInflight.has(id)) {
    gapAgain.add(id);
    return;
  }
  gapInflight.add(id);
  try {
    const evs = await b.getEvents(id, t.contiguous || undefined);
    mergeEvents(id, evs);
  } catch {
    /* next reconnect retries */
  } finally {
    gapInflight.delete(id);
    if (gapAgain.delete(id)) void fillGap(id);
  }
}

export async function loadTrace(id: Id, force = false) {
  const b = get().backend;
  if (!b) return;
  const cur = get().traces[id];
  // Only the open session is subscribed, so a trace loaded earlier misses whatever happened while another was open.
  if (cur?.loaded && !force) {
    syncSubscriptions();
    return fillGap(id);
  }
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

let subscribed = new Set<Id>();

/** The open session gets trace events; others only get `session` summaries. */
export function syncSubscriptions() {
  const s = get();
  const ids = new Set<Id>();
  if (s.view.kind === "session") ids.add(s.view.id);
  for (const id of ids) if (!subscribed.has(id)) resetLive(id);
  subscribed = ids;
  s.backend?.subscribe([...ids]);
}

// ---------- navigation ----------

/** The inspector shows the open session's env. */
function followEnv(sess: SessionSummary) {
  const s = get();
  set({
    inspectorEnvId: sess.envId,
    expandedEnvs: sess.envId ? { ...s.expandedEnvs, [sess.envId]: true } : s.expandedEnvs,
  });
  if (!sess.envId && (s.inspectorTab === "files" || s.inspectorTab === "network" || s.inspectorTab === "shell")) set({ inspectorTab: "request" });
}

export function openSession(id: Id, sel?: Selection) {
  const sess = get().sessions[id];
  set({ view: { kind: "session", id }, selection: sel ?? null, filesFocus: null });
  if (sess) followEnv(sess);
  void loadTrace(id);
  syncSubscriptions();
  // eval case sessions are not in /api/state: fetch the summary, then follow its env
  if (!sess)
    void act("Session", (b) => b.getSession(id)).then((x) => {
      if (!x) return;
      set((st) => ({ sessions: { ...st.sessions, [x.id]: x } }));
      const v = get().view;
      if (v.kind === "session" && v.id === id) followEnv(x);
    });
}

export function openView(view: View) {
  // Home opens without an inspector; picking an environment there (openEnv) brings it back
  set({ view, selection: null, ...(view.kind === "home" ? { inspectorEnvId: null } : {}) });
  syncSubscriptions();
}

export function openEnv(envId: Id, tab: InspectorTab = "env") {
  const s = get();
  set({
    // Models, Evals, Settings and the Lab have no inspector; an env opened from there shows on Home
    view: s.view.kind === "models" || s.view.kind === "evals" || s.view.kind === "settings" || s.view.kind === "lab" ? { kind: "home" } : s.view,
    inspectorEnvId: envId,
    inspectorTab: tab,
    inspectorOpen: true,
    expandedEnvs: { ...s.expandedEnvs, [envId]: true },
  });
  savePrefs();
}

export function select(sel: Selection | null, opts: { follow?: boolean } = {}) {
  const patch: Partial<Store> = { selection: sel };
  // the Files tab always tracks the selected tool call; tab switches only when following
  if (sel?.kind === "tool") patch.filesFocus = { toolCallId: sel.toolCallId };
  if (sel && opts.follow !== false) {
    if (sel.kind === "call") patch.inspectorTab = "request";
    if (sel.kind === "net") patch.inspectorTab = "network";
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

export const NET_LIMIT = 1000;
export const NET_LIMIT_MAX = 5000; // most rows shown; the backend answers up to one more

/** Newest `limit` rows by latest attempt (the backend's order), plus live rows that arrived meanwhile (mergeNetPage). */
export async function loadNet(envId: Id, limit = get().netLimit[envId] ?? NET_LIMIT) {
  const b = get().backend;
  if (!b) return;
  try {
    const entries = await b.getNet(envId, limit + 1);
    set((s) => {
      const { rows, capped } = mergeNetPage(s.net[envId] ?? [], entries, limit);
      return {
        net: { ...s.net, [envId]: rows },
        netLimit: { ...s.netLimit, [envId]: limit },
        netCapped: { ...s.netCapped, [envId]: capped },
      };
    });
  } catch (err) {
    toast(`Network log: ${String(err)}`);
  }
}

export async function loadEvalRun(id: Id) {
  const d = await act("Eval run", (b) => b.getEvalRun(id));
  if (d) set((s) => ({ evalDetails: { ...s.evalDetails, [id]: d } }));
}

let harnessLoading = false;
export async function loadHarness() {
  if (harnessLoading) return;
  harnessLoading = true;
  const harness = await act("Harness profiles", (b) => b.getHarness());
  harnessLoading = false;
  if (harness) set({ harness });
}

export async function loadSuites() {
  const suites = await act("Eval suites", (b) => b.listSuites());
  if (suites) set({ suites });
}
