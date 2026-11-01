// The app's changes that can really go back, outside the Lab: settings, renames and session options, model defaults, and
// deleting a session (hidden first, deleted for real once its undo window is over). Deleting an environment or anything
// else that can't come back keeps its confirm.

import type { EnvSummary, Id, ModelInfo, SessionSummary, UpdateModelRequest, UpdateSessionRequest, UpdateSettingsRequest } from "@terrarium/shared";
import { act, hiddenSessions, useStore } from "./store";
import { undoStack, undoable } from "./undo";

const get = useStore.getState;
const set = useStore.setState;

type Backend = NonNullable<ReturnType<typeof get>["backend"]>;

/** Runs a change that has an inverse; a failure throws, so runUndo says why. */
async function must<T>(fn: (b: Backend) => Promise<T>): Promise<T> {
  const b = get().backend;
  if (!b) throw new Error("Not connected");
  return fn(b);
}

// ---------- settings ----------

const WORDS: Partial<Record<keyof UpdateSettingsRequest, string>> = { prompts: "Edited a system prompt", newSession: "Changed the new session defaults", newEnv: "Changed the new environment defaults", resourceBudgets: "Changed a resource budget", memoryBudgetBytes: "Changed the memory ceiling" };

/** What the settings hold now for the keys a change names; a nested key with no value yet goes back to null, its default. */
function settingsBefore(req: UpdateSettingsRequest): UpdateSettingsRequest {
  const cur = get().settings as unknown as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(req)) {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const now = (cur[k] ?? {}) as Record<string, unknown>;
      out[k] = Object.fromEntries(Object.keys(v).map((x) => [x, now[x] ?? null]));
    } else out[k] = cur[k];
  }
  return out as UpdateSettingsRequest;
}

export async function updateSettings(req: UpdateSettingsRequest) {
  const before = settingsBefore(req);
  const s = await act("Save setting", (b) => b.updateSettings(req));
  if (!s) return;
  set({ settings: s });
  const keys = Object.keys(req) as (keyof UpdateSettingsRequest)[];
  const put = (x: UpdateSettingsRequest) => must((b) => b.updateSettings(x)).then((v) => set({ settings: v }));
  undoStack.push({ label: WORDS[keys[0]] ?? "Changed a setting", key: `settings:${keys.join()}`, undo: () => put(before), redo: () => put(req) });
}

// ---------- sessions and environments ----------

const putSession = (s: SessionSummary) => set((st) => ({ sessions: { ...st.sessions, [s.id]: s } }));
const putEnv = (e: EnvSummary) => set((st) => ({ envs: { ...st.envs, [e.id]: e } }));

export async function patchSession(id: Id, p: UpdateSessionRequest, label = "Update session") {
  const cur = get().sessions[id] as unknown as Record<string, unknown> | undefined;
  const s = await act(label, (b) => b.updateSession(id, p));
  if (!s) return;
  putSession(s);
  if (!cur) return;
  // systemPrompt reads null when the session uses the profile's
  const before = Object.fromEntries(Object.keys(p).map((k) => [k, cur[k] ?? (k === "systemPrompt" ? null : undefined)])) as UpdateSessionRequest;
  undoStack.push({ label: p.title != null ? "Renamed the session" : "Changed the session's setup", key: `session:${id}:${Object.keys(p).join()}`, undo: () => must((b) => b.updateSession(id, before)).then(putSession), redo: () => must((b) => b.updateSession(id, p)).then(putSession) });
}

export async function patchEnv(env: EnvSummary, p: { name?: string; network?: EnvSummary["network"] }, label = "Update environment") {
  const e = await act(label, (b) => b.updateEnv(env.id, p));
  if (!e) return;
  putEnv(e);
  const before = { ...(p.name != null ? { name: env.name } : {}), ...(p.network != null ? { network: env.network } : {}) };
  undoStack.push({ label: p.name != null ? "Renamed the environment" : "Changed the network mode", undo: () => must((b) => b.updateEnv(env.id, before)).then(putEnv), redo: () => must((b) => b.updateEnv(env.id, p)).then(putEnv) });
}

/** How long a deleted session can still come back. */
const SESSION_UNDO_MS = 30_000;
const pending = new Map<Id, number>();

function hide(s: SessionSummary) {
  hiddenSessions.add(s.id);
  set((st) => {
    const sessions = { ...st.sessions };
    delete sessions[s.id];
    return { sessions, view: st.view.kind === "session" && st.view.id === s.id ? { kind: "home" as const } : st.view };
  });
  pending.set(
    s.id,
    window.setTimeout(() => {
      pending.delete(s.id);
      void act("Delete session", (b) => b.deleteSession(s.id));
    }, SESSION_UNDO_MS),
  );
}

export function deleteSession(s: SessionSummary) {
  // a run in progress stops for good: nothing to bring back
  if (s.status === "running") return act("Delete session", (b) => b.deleteSession(s.id));
  hide(s);
  undoable({
    label: `Deleted "${s.title || "session"}"`,
    undo: () => {
      const t = pending.get(s.id);
      if (t == null) throw new Error(`it was deleted for good after ${SESSION_UNDO_MS / 1000} s`);
      window.clearTimeout(t);
      pending.delete(s.id);
      hiddenSessions.delete(s.id);
      putSession(s);
    },
    redo: () => hide(s),
  });
  return undefined;
}

// ---------- model defaults ----------

export async function saveModelDefaults(m: ModelInfo, req: UpdateModelRequest): Promise<ModelInfo | undefined> {
  const r = await act("Save model defaults", (b) => b.updateModel(m.id, req));
  if (!r) return r;
  const put = (x: ModelInfo) => set((s) => ({ models: s.models.map((y) => (y.id === x.id ? x : y)) }));
  put(r);
  const before: UpdateModelRequest = { defaultContext: m.defaultContext, defaultMaxOutput: m.defaultMaxOutput, sampling: { ...m.sampling } };
  undoable({ label: `Saved defaults for ${m.name}`, undo: () => must((b) => b.updateModel(m.id, before)).then(put), redo: () => must((b) => b.updateModel(m.id, req)).then(put) }, { toast: false });
  return r;
}
