import type { EnvSummary, EnvUse } from "@terrarium/shared";

/** Why stop, reset, restore, snapshot, fork of the live env and delete are refused right now (the backend answers 409). */
export const busyReason = (env: EnvSummary): string | undefined => (env.inUse?.length ? env.inUse.map((u) => u.reason).join("; ") : undefined);

/** A running eval case owns the env: its shell and network mode are read-only until the case is graded. */
export const evalOwner = (env: EnvSummary): EnvUse | undefined => env.inUse?.find((u) => u.kind === "eval");
