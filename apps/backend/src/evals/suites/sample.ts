// Deterministic seeded sampling (same seed + size -> same cases on every machine).

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffled<T>(items: readonly T[], seed: number): T[] {
  const out = items.slice();
  const rand = mulberry32(seed);
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export function sample<T>(items: readonly T[], size: number, seed: number): T[] {
  return shuffled(items, seed).slice(0, Math.max(0, size));
}

// Even split across groups: shuffle each group, then take round-robin until `size`.
export function stratifiedSample<T>(groups: readonly (readonly T[])[], size: number, seed: number): T[] {
  const queues = groups.map((g, i) => shuffled(g, (seed + Math.imul(i + 1, 0x9e3779b1)) >>> 0));
  const out: T[] = [];
  for (let round = 0; out.length < size; round++) {
    let took = false;
    for (const q of queues) {
      if (round < q.length && out.length < size) {
        out.push(q[round]);
        took = true;
      }
    }
    if (!took) break;
  }
  return out;
}
