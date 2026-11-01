import type { EnvSummary, EnvType, Id, ModelInfo } from "@terrarium/shared";
import { act, openSession, toast, useStore } from "../state/store";

/**
 * Model a new session starts with: the most recently used loaded model, else any loaded, else the most recently used,
 * else the first. `strains: false` skips strains (for pickers that don't list them).
 */
export function defaultModel(opts: { strains?: boolean } = {}): ModelInfo | undefined {
  const s = useStore.getState();
  const allowed = (m: ModelInfo) => opts.strains !== false || !m.strain;
  const pinned = s.settings.newSession.modelId;
  if (pinned) {
    const m = s.models.find((x) => x.id === pinned && allowed(x));
    if (m) return m;
  }
  const recent = Object.values(s.sessions)
    .filter((x) => !x.evalRunId)
    .sort((a, b) => b.updatedAt - a.updatedAt);
  for (const r of recent) {
    const m = s.models.find((x) => x.id === r.modelId && x.loaded && allowed(x));
    if (m) return m;
  }
  const used = recent.map((r) => s.models.find((x) => x.id === r.modelId && !x.strain)).find(Boolean);
  return s.models.find((m) => m.loaded && !m.strain) ?? used ?? s.models.find((m) => !m.strain) ?? s.models[0];
}

/** Most recently used environment of a type that can start: the one with the newest session, else the newest env. */
export function recentEnv(type: EnvType): EnvSummary | undefined {
  const s = useStore.getState();
  const envs = Object.values(s.envs).filter((e) => e.type === type && !e.ephemeral && e.status !== "error");
  const last = (e: EnvSummary) => Math.max(e.createdAt, ...Object.values(s.sessions).filter((x) => x.envId === e.id).map((x) => x.updatedAt));
  return envs.sort((a, b) => last(b) - last(a))[0];
}

/** Start an agent: a new session in the most recent env of that type, or the New environment sheet set to it. */
export function startAgent(type: EnvType | null, modelId?: Id) {
  if (!type) return void newSession(null, modelId);
  const env = recentEnv(type);
  if (env) return void newSession(env.id, modelId);
  useStore.setState({ newEnvOpen: true, newEnvPreset: { type, modelId } });
}

const focusComposer = () => window.setTimeout(() => document.querySelector<HTMLTextAreaElement>(".composer textarea")?.focus(), 50);

/** Opens a session, reusing an untouched one with the same setup. Undefined when it couldn't start. */
export async function newSession(envId: Id | null, modelId?: Id): Promise<Id | undefined> {
  const m = (modelId ? useStore.getState().models.find((x) => x.id === modelId) : undefined) ?? defaultModel();
  if (!m) {
    useStore.setState({ view: { kind: "models" } });
    return;
  }
  const d = useStore.getState().settings.newSession;
  const harness = envId ? d.harness : "chat";
  // an untouched session with the same setup is reused, so the starting points don't pile up empty sessions
  const empty = Object.values(useStore.getState().sessions).find(
    (x) => x.envId === envId && x.modelId === m.id && x.harness === harness && x.lastSeq === 0 && x.status === "idle" && !x.evalRunId,
  );
  if (empty) {
    openSession(empty.id);
    focusComposer();
    return empty.id;
  }
  const ctx = d.contextWindow != null ? Math.min(d.contextWindow, m.nativeContext) : m.defaultContext;
  const thinking = m.thinking !== "none" && (d.thinking === "model" ? m.thinking === "default-on" : d.thinking === "on");
  const s = await act("New session", (b) =>
    b.createSession({
      envId,
      modelId: m.id,
      harness,
      thinking,
      contextWindow: ctx,
      // the backend picks the output cap for a window other than the model default
      ...(ctx === m.defaultContext ? { maxOutputTokens: m.defaultMaxOutput } : {}),
    }),
  );
  if (s) {
    useStore.setState((st) => ({ sessions: { ...st.sessions, [s.id]: s } }));
    openSession(s.id);
    focusComposer();
    return s.id;
  }
}

/** First free name of a kind: vm-1, sim-2. */
export function nextEnvName(envs: EnvSummary[], type: EnvType) {
  const base = type === "vm" ? "vm" : "sim";
  const names = new Set(envs.map((e) => e.name));
  for (let i = 1; ; i++) if (!names.has(`${base}-${i}`)) return `${base}-${i}`;
}

export type Where = { kind: "env"; id: Id } | { kind: "new"; type: EnvType } | { kind: "chat" };

/** Home's Start: make the enclosure if it's a new one, open a session in it, and send the task if there is one. */
export async function startTask(where: Where, modelId: Id | undefined, text: string): Promise<void> {
  let envId: Id | null = null;
  if (where.kind === "env") envId = where.id;
  if (where.kind === "new") {
    const st = useStore.getState();
    const name = nextEnvName(Object.values(st.envs), where.type);
    const env = await act("Create enclosure", (b) => b.createEnv({ name, type: where.type, network: st.settings.newEnv.network }));
    if (!env) return;
    useStore.setState((x) => ({ envs: { ...x.envs, [env.id]: env }, expandedEnvs: { ...x.expandedEnvs, [env.id]: true } }));
    envId = env.id;
  }
  const id = await newSession(envId, modelId);
  const task = text.trim();
  if (!id || !task) return;
  try {
    await useStore.getState().backend!.sendMessage(id, task);
  } catch (err) {
    // refused (say the model doesn't fit): the task waits in the composer, not lost
    useStore.setState((s) => ({ composerFill: { sessionId: id, text: task, n: (s.composerFill?.n ?? 0) + 1 } }));
    toast(`Send: ${(err as Error).message ?? String(err)}`);
  }
}

export async function buildVmImage(): Promise<void> {
  useStore.setState({ vmBuilding: Date.now(), vmBuildError: null });
  try {
    const r = await useStore.getState().backend!.buildVmImage();
    useStore.setState({ vmBuilding: null, vmSetup: r });
  } catch (err) {
    useStore.setState({ vmBuilding: null, vmBuildError: (err as Error).message ?? String(err) });
  }
}
