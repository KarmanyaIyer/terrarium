import type { MemoryBudget, ModelInfo, ResourceSample } from "@terrarium/shared";

export const OVERHEAD_BYTES = 1024 ** 3; // DESIGN.md: weights + ctx*kv + fixed + ~1 GB

export interface Estimate {
  bytes: number;
  weights: number;
  kv: number;
  fixed: number;
  overhead: number;
  /** Bytes that loading would add now (0 extra if already loaded at a context >= ctx). */
  added: number;
  /** Resident bytes of the other loaded models; this model shares the budget with them. */
  otherLoaded: number;
  fitsFree: boolean;
  fitsBudget: boolean;
}

/** Client-side mirror of the backend estimate: weights + ctx * kvBytesPerToken + fixed + 1 GiB. */
export function estimate(
  m: ModelInfo,
  ctx: number,
  sample: ResourceSample | undefined,
  budget: MemoryBudget,
  loadedModels: ModelInfo[],
): Estimate {
  const weights = m.weightsBytes;
  const kv = ctx * m.kvBytesPerToken;
  const fixed = m.fixedBytes;
  const bytes = weights + kv + fixed + OVERHEAD_BYTES;
  const already = m.loaded ? (m.residentBytes ?? estBytes(m, m.loadedContext ?? m.defaultContext)) : 0;
  const added = Math.max(0, bytes - already);
  const free = sample?.system.freeBytes ?? Infinity;
  const otherLoaded = loadedModels
    .filter((x) => x.loaded && x.id !== m.id)
    .reduce((a, x) => a + (x.residentBytes ?? estBytes(x, x.loadedContext ?? x.defaultContext)), 0);
  return {
    bytes,
    weights,
    kv,
    fixed,
    overhead: OVERHEAD_BYTES,
    added,
    otherLoaded,
    fitsFree: added <= free,
    fitsBudget: budget.budgetBytes <= 0 || otherLoaded + bytes <= budget.budgetBytes,
  };
}

export function estBytes(m: ModelInfo, ctx: number): number {
  return m.weightsBytes + ctx * m.kvBytesPerToken + m.fixedBytes + OVERHEAD_BYTES;
}

export const CONTEXT_CHOICES = [4096, 8192, 16384, 32768, 65536, 131072];
