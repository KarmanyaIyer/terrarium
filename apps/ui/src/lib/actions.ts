import type { EnvSummary, EnvType, Id, ModelInfo } from "@terrarium/shared";
import { act, openSession, useStore } from "../state/store";

/** Model a new session starts with: the most recently used loaded model, else any loaded, else the most recently used, else the first. */
export function defaultModel(): ModelInfo | undefined {
  const s = useStore.getState();
  const pinned = s.settings.newSession.modelId;
  if (pinned) {
    const m = s.models.find((x) => x.id === pinned);
    if (m) return m;
  }
  const recent = Object.values(s.sessions)
    .filter((x) => !x.evalRunId)
    .sort((a, b) => b.updatedAt - a.updatedAt);
  for (const r of recent) {
    const m = s.models.find((x) => x.id === r.modelId && x.loaded);
    if (m) return m;
  }
  const used = recent.map((r) => s.models.find((x) => x.id === r.modelId && !x.strain)).find(Boolean);
  return s.models.find((m) => m.loaded && !m.strain) ?? used ?? s.models.find((m) => !m.strain) ?? s.models[0];
}

/** Most recently used environment of a type: the one with the newest session, else the newest env. */
export function recentEnv(type: EnvType): EnvSummary | undefined {
  const s = useStore.getState();
  const envs = Object.values(s.envs).filter((e) => e.type === type && !e.ephemeral);
  const last = (e: EnvSummary) => Math.max(e.createdAt, ...Object.values(s.sessions).filter((x) => x.envId === e.id).map((x) => x.updatedAt));
  return envs.sort((a, b) => last(b) - last(a))[0];
}

/** Start an agent: a new session in the most recent env of that type, or the New environment sheet set to it. */
export function startAgent(type: EnvType | null) {
  if (!type) return void newSession(null);
  const env = recentEnv(type);
  if (env) return void newSession(env.id);
  useStore.setState({ newEnvOpen: true, newEnvType: type });
}

export async function newSession(envId: Id | null, modelId?: Id) {
  const m = (modelId ? useStore.getState().models.find((x) => x.id === modelId) : undefined) ?? defaultModel();
  if (!m) {
    useStore.setState({ view: { kind: "models" } });
    return;
  }
  const d = useStore.getState().settings.newSession;
  const ctx = d.contextWindow != null ? Math.min(d.contextWindow, m.nativeContext) : m.defaultContext;
  const thinking = m.thinking !== "none" && (d.thinking === "model" ? m.thinking === "default-on" : d.thinking === "on");
  const s = await act("New session", (b) =>
    b.createSession({
      envId,
      modelId: m.id,
      harness: envId ? d.harness : "chat",
      thinking,
      contextWindow: ctx,
      // the backend picks the output cap for a window other than the model default
      ...(ctx === m.defaultContext ? { maxOutputTokens: m.defaultMaxOutput } : {}),
    }),
  );
  if (s) {
    useStore.setState((st) => ({ sessions: { ...st.sessions, [s.id]: s } }));
    openSession(s.id);
    window.setTimeout(() => document.querySelector<HTMLTextAreaElement>(".composer textarea")?.focus(), 50);
  }
}
