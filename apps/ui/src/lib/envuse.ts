import type { EnvSummary, EnvUse, SessionSummary } from "@terrarium/shared";

/**
 * Why a run of `session` (Send, Continue, Retry) would be refused right now: its env was deleted, another session or a
 * running eval case holds it (the backend answers 409), or its storage is gone. Chat sessions never use their env.
 * `env` is the session's env from the store, undefined when the store has no such env.
 */
export const runBlocked = (env: EnvSummary | undefined, session: SessionSummary): string | undefined => {
  if (session.harness === "chat" || !session.envId) return undefined;
  if (!env) return "enclosure deleted";
  if (env.released) return "env storage released";
  const holder = env.inUse?.find((u) => (u.kind === "session" || u.kind === "eval") && u.sessionId !== session.id);
  return holder ? `env busy: ${holder.reason}` : undefined;
};

/** Why stop, reset, restore, snapshot, fork of the live env and delete are refused right now (the backend answers 409). */
export const busyReason = (env: EnvSummary): string | undefined => (env.inUse?.length ? env.inUse.map((u) => u.reason).join("; ") : undefined);

/** A running eval case owns the env: its shell and network mode are read-only until the case is graded. */
export const evalOwner = (env: EnvSummary): EnvUse | undefined => env.inUse?.find((u) => u.kind === "eval");
