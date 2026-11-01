// Stored workspace manifests. A tool call usually changes a handful of entries out of up to 20k, so a session
// stores a full manifest every FULL_EVERY saves and, in between, a delta against its previous save: the
// entries that changed (set) and the paths that went away (del). Blobs stay content-addressed; a delta names
// its base blob, so a chain is at most FULL_EVERY - 1 deltas long.

import type { Manifest, ManifestEntry } from "../envs/types.ts";
import type { BlobStore } from "./blobs.ts";

export const FULL_EVERY = 16;

export interface ManifestDelta {
  v: 2;
  base: string; // blob sha of the previous stored manifest (full or delta)
  depth: number; // deltas between this one and the full manifest it builds on, this one included
  root: string;
  takenAt: number;
  truncated: boolean;
  set: ManifestEntry[];
  del: string[];
}

type Stored = Manifest | ManifestDelta;

export interface SavedManifest {
  blob: string;
  manifest: Manifest;
  depth: number;
}

function isDelta(v: Stored): v is ManifestDelta {
  return (v as ManifestDelta).v === 2 && typeof (v as ManifestDelta).base === "string";
}

function sameEntry(a: ManifestEntry, b: ManifestEntry): boolean {
  return (
    a.type === b.type &&
    a.size === b.size &&
    a.mode === b.mode &&
    a.mtimeNs === b.mtimeNs &&
    a.ctimeNs === b.ctimeNs &&
    a.ino === b.ino &&
    a.nlink === b.nlink &&
    a.linkTarget === b.linkTarget &&
    a.sha256 === b.sha256 &&
    a.heavy === b.heavy
  );
}

export function manifestDelta(before: Manifest, after: Manifest): { set: ManifestEntry[]; del: string[] } {
  const old = new Map(before.entries.map((e) => [e.path, e]));
  const set: ManifestEntry[] = [];
  for (const e of after.entries) {
    const o = old.get(e.path);
    if (!o || !sameEntry(o, e)) set.push(e);
    old.delete(e.path);
  }
  return { set, del: [...old.keys()] };
}

function applyDelta(base: Manifest, d: ManifestDelta): Manifest {
  const byPath = new Map(base.entries.map((e) => [e.path, e]));
  for (const p of d.del) byPath.delete(p);
  for (const e of d.set) byPath.set(e.path, e);
  const entries = [...byPath.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { root: d.root, takenAt: d.takenAt, truncated: d.truncated, entries };
}

export class ManifestStore {
  private blobs: BlobStore;
  private cache = new Map<string, Manifest>();

  constructor(blobs: BlobStore) {
    this.blobs = blobs;
  }

  /** Store `m`, as a delta against `prev` (the session's previous save) unless a full copy is due. */
  save(m: Manifest, prev: SavedManifest | null, beforePut?: (bytes: number) => void): SavedManifest {
    let value: Stored = m;
    let depth = 0;
    if (prev && prev.depth < FULL_EVERY - 1 && prev.manifest.root === m.root) {
      depth = prev.depth + 1;
      value = { v: 2, base: prev.blob, depth, root: m.root, takenAt: m.takenAt, truncated: m.truncated, ...manifestDelta(prev.manifest, m) };
    }
    const encoded = JSON.stringify(value);
    beforePut?.(Buffer.byteLength(encoded));
    const blob = this.blobs.put(encoded);
    this.remember(blob, m);
    return { blob, manifest: m, depth };
  }

  /** The manifest a stored blob stands for (deltas resolved), or null if a blob in its chain is missing. */
  load(blob: string): Manifest | null {
    const hit = this.cache.get(blob);
    if (hit) return hit;
    const head = this.blobs.getJson<Stored>(blob);
    return head ? this.resolve(blob, head) : null;
  }

  /** A stored manifest with its place in the chain, to continue saving deltas after a restart. */
  loadSaved(blob: string): SavedManifest | null {
    const head = this.blobs.getJson<Stored>(blob);
    const manifest = head ? this.resolve(blob, head) : null;
    return manifest ? { blob, manifest, depth: isDelta(head!) ? head.depth : 0 } : null;
  }

  private resolve(blob: string, head: Stored): Manifest | null {
    const hit = this.cache.get(blob);
    if (hit) return hit;
    const chain: ManifestDelta[] = [];
    let v: Stored | null = head;
    let base: Manifest | null = null;
    while (v) {
      if (!isDelta(v)) {
        base = v;
        break;
      }
      chain.push(v);
      if (chain.length > FULL_EVERY * 4) return null; // a loop or a corrupt chain
      base = this.cache.get(v.base) ?? null;
      if (base) break;
      v = this.blobs.getJson<Stored>(v.base);
    }
    if (!base) return null;
    let m = base;
    for (let i = chain.length - 1; i >= 0; i--) m = applyDelta(m, chain[i]);
    this.remember(blob, m);
    return m;
  }

  /** Every blob a stored manifest keeps alive: its chain and the captured file contents its entries name. */
  refs(blob: string, out: Set<string>, seen: Set<string>): void {
    let sha: string | undefined = blob;
    while (sha && !seen.has(sha)) {
      seen.add(sha);
      out.add(sha);
      const v: Stored | null = this.blobs.getJson<Stored>(sha);
      if (!v) return;
      for (const e of isDelta(v) ? v.set : v.entries) if (e.sha256) out.add(e.sha256);
      sha = isDelta(v) ? v.base : undefined;
    }
  }

  private remember(blob: string, m: Manifest): void {
    this.cache.delete(blob);
    this.cache.set(blob, m);
    while (this.cache.size > 8) this.cache.delete(this.cache.keys().next().value!);
  }
}
