// Blob garbage collection: mark every blob a DB row still names (directly, inside event payloads, or through a
// stored manifest's chain and file entries), then delete the rest. Runs at startup and again a little after
// sessions or envs are deleted. Outside startup, blobs used in the last GRACE_MS
// are spared: a writer may have stored one and not yet inserted the row naming it (BlobStore.put and touch
// refresh the mtime of a blob that already existed for the same reason). At startup the grace is short, not
// zero, in case another backend shares the data dir.

import { readdir, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { logger } from "../util/log.ts";
import type { Store } from "./db.ts";

const log = logger("gc");
const SHA_RE = /^[0-9a-f]{64}$/;
const SHA_IN_TEXT = /\b[0-9a-f]{64}\b/g;
export const GRACE_MS = 10 * 60_000;

export interface GcResult {
  kept: number;
  removed: number;
  removedBytes: number;
  ms: number;
}

export class BlobGc {
  private store: Store;
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<GcResult> | null = null;

  constructor(store: Store) {
    this.store = store;
  }

  /** Blobs some row still names. */
  marked(): Set<string> {
    const keep = new Set<string>();
    const add = (v: unknown) => {
      if (typeof v === "string" && SHA_RE.test(v)) keep.add(v);
    };
    for (const r of this.store.all<{ transcript_blob: string | null }>("SELECT transcript_blob FROM sessions")) add(r.transcript_blob);
    for (const r of this.store.all<Record<string, string | null>>("SELECT request_blob, response_blob, raw_blob FROM model_calls")) Object.values(r).forEach(add);
    for (const r of this.store.all<Record<string, string | null>>("SELECT stdout_blob, stderr_blob FROM user_exec")) Object.values(r).forEach(add);
    // Event payloads name blobs in several shapes (diffBlob, before/after sha256, raw responses): any 64-hex token
    // counts. Keeping an unrelated blob that happens to match is harmless.
    for (const r of this.store.all<{ payload_json: string }>("SELECT payload_json FROM events")) {
      for (const m of r.payload_json.matchAll(SHA_IN_TEXT)) keep.add(m[0]);
    }
    const seen = new Set<string>();
    for (const r of this.store.all<{ blob: string }>("SELECT DISTINCT blob FROM manifests")) this.store.manifests.refs(r.blob, keep, seen);
    return keep;
  }

  /** Mark and sweep now. Blobs used within `graceMs` are kept whatever the mark says. */
  run(opts: { graceMs?: number } = {}): Promise<GcResult> {
    this.running ??= this.sweep(opts.graceMs ?? GRACE_MS).finally(() => {
      this.running = null;
    });
    return this.running;
  }

  /** Run once things settle (after a deletion); repeated calls within the delay collapse into one run. */
  schedule(delayMs = 30_000): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.run().then(
        (r) => r.removed && log.info(`removed ${r.removed} unreferenced blobs (${Math.round(r.removedBytes / 1024)} KiB) in ${r.ms} ms`),
        (err) => log.warn("blob gc failed", err),
      );
    }, delayMs);
    this.timer.unref();
  }

  cancel(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private async sweep(graceMs: number): Promise<GcResult> {
    const t0 = performance.now();
    const keep = this.marked();
    const cutoff = Date.now() - graceMs;
    let kept = 0;
    let removed = 0;
    let removedBytes = 0;
    const root = this.store.blobs.dir;
    for (const shard of await readdir(root).catch(() => [] as string[])) {
      if (!/^[0-9a-f]{2}$/.test(shard)) continue;
      const dir = join(root, shard);
      for (const name of await readdir(dir).catch(() => [] as string[])) {
        const isTmp = name.endsWith(".tmp");
        if (!isTmp && (!SHA_RE.test(name) || keep.has(name))) {
          kept++;
          continue;
        }
        const p = join(dir, name);
        const st = await stat(p).catch(() => null);
        if (!st || !st.isFile() || st.mtimeMs > cutoff) {
          kept++;
          continue;
        }
        await unlink(p).then(
          () => {
            removed++;
            removedBytes += st.size;
          },
          () => {},
        );
      }
    }
    return { kept, removed, removedBytes, ms: Math.round(performance.now() - t0) };
  }
}
