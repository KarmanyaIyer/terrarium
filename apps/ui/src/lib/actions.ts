import type { Id, ModelInfo } from "@terrarium/shared";
import { act, openSession, useStore } from "../state/store";

/** Model a new session starts with: the most recently used loaded model, else any loaded, else the first. */
export function defaultModel(): ModelInfo | undefined {
  const s = useStore.getState();
  const recent = Object.values(s.sessions)
    .filter((x) => !x.evalRunId)
    .sort((a, b) => b.updatedAt - a.updatedAt);
  for (const r of recent) {
    const m = s.models.find((x) => x.id === r.modelId && x.loaded);
    if (m) return m;
  }
  return s.models.find((m) => m.loaded) ?? s.models[0];
}

export async function newSession(envId: Id | null) {
  const m = defaultModel();
  if (!m) {
    useStore.setState({ view: { kind: "models" } });
    return;
  }
  const s = await act("New session", (b) =>
    b.createSession({
      envId,
      modelId: m.id,
      harness: envId ? "terrarium" : "chat",
      thinking: m.thinking === "default-on",
      contextWindow: m.defaultContext,
      maxOutputTokens: m.defaultMaxOutput,
    }),
  );
  if (s) {
    useStore.setState((st) => ({ sessions: { ...st.sessions, [s.id]: s } }));
    openSession(s.id);
    window.setTimeout(() => document.querySelector<HTMLTextAreaElement>(".composer textarea")?.focus(), 50);
  }
}
