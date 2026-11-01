// Workspace observer: manifest before/after each tool call, diff, capture changed text files as blobs with
// unified diffs, emit fs_change, and store each manifest (keyed by event seq) for `tree?at=seq` time travel.

import type { FileChange } from "@terrarium/shared";
import { createTwoFilesPatch } from "diff";
import type { EnvManager } from "../envs/manager.ts";
import { diffManifests } from "../envs/manifest-diff.ts";
import type { EnvRuntime, Manifest } from "../envs/types.ts";
import type { Store } from "../store/db.ts";
import { BudgetExceededError, type BudgetTrip, type ResourceBudgets } from "../resource-budgets.ts";
import type { SavedManifest } from "../store/manifests.ts";
import type { Tracer } from "../trace.ts";
import { logger } from "../util/log.ts";

const log = logger("observer");

export const MAX_CAPTURE_BYTES = 2 * 1024 * 1024;
export const TOOL_CAPTURE_BYTES = 64 * 1024 * 1024;
const BASELINE_CAPTURE_BYTES = 32 * 1024 * 1024;
const BASELINE_CAPTURE_FILES = 2000;
const MAX_DIFF_CHARS = 1024 * 1024;
const CAPTURE_BATCH = 200;

interface Capture {
  sha: string | null;
  text: string | null;
  binary: boolean;
  tooLarge: boolean;
}

export function isBinary(data: Uint8Array): boolean {
  if (data.subarray(0, 8192).includes(0)) return true;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(data, { stream: true }); // stream: a cut multi-byte tail is not an error
    return false;
  } catch {
    return true;
  }
}

export class FsObserver {
  private store: Store;
  private envs: EnvManager;
  private envId: string;
  private sessionId: string;
  private runtime: EnvRuntime;
  private tracer: Tracer;
  private budgets: ResourceBudgets;
  private current: Manifest | null = null;
  private seenVersion = -1;
  private lastSaved: SavedManifest | null = null;
  /** Paths changed since session start (across runs), for compaction notes. */
  readonly changedPaths: Set<string>;

  constructor(opts: { store: Store; envs: EnvManager; envId: string; sessionId: string; runtime: EnvRuntime; tracer: Tracer; budgets: ResourceBudgets }) {
    this.store = opts.store;
    this.envs = opts.envs;
    this.envId = opts.envId;
    this.sessionId = opts.sessionId;
    this.runtime = opts.runtime;
    this.tracer = opts.tracer;
    this.budgets = opts.budgets;
    this.changedPaths = new Set();
    for (const r of this.store.all<{ payload_json: string }>("SELECT payload_json FROM events WHERE session_id = ? AND type = 'fs_change' ORDER BY seq", this.sessionId)) {
      for (const c of (JSON.parse(r.payload_json) as { changes?: FileChange[] }).changes ?? []) this.changedPaths.add(c.path);
    }
  }

  /** Session baseline: the first manifest stored for this session, with file contents captured. */
  async baseline(): Promise<void> {
    const has = this.store.get("SELECT 1 AS x FROM manifests WHERE session_id = ? LIMIT 1", this.sessionId);
    const m = await this.snapshot();
    if (has) return;
    this.saveManifest(m, this.tracer.lastSeq());
    let bytes = 0;
    const paths: string[] = [];
    for (const e of m.entries) {
      if (e.type !== "file" || e.heavy || !e.sha256 || e.size > MAX_CAPTURE_BYTES) continue;
      if (this.store.blobs.touch(e.sha256)) continue; // already captured; touched so a GC sweep keeps it
      if (bytes + e.size > BASELINE_CAPTURE_BYTES || paths.length >= BASELINE_CAPTURE_FILES) break;
      paths.push(e.path);
      bytes += e.size;
    }
    for (let i = 0; i < paths.length; i += CAPTURE_BATCH) {
      try {
        await this.captureMany(paths.slice(i, i + CAPTURE_BATCH), BASELINE_CAPTURE_BYTES);
      } catch (err) {
        if (err instanceof BudgetExceededError) throw err;
      }
    }
  }

  /** Current manifest; reuses the cached one unless something else (user shell, reset) touched the env. */
  async snapshot(): Promise<Manifest> {
    const cached = this.envs.cachedManifest(this.envId);
    if (this.current && cached && cached.version === this.seenVersion && cached.manifest === this.current) return this.current;
    const previous = cached?.manifest ?? this.current ?? undefined;
    const m = await this.runtime.manifest("/workspace", previous ? { previous } : undefined);
    this.accept(m);
    return m;
  }

  private accept(m: Manifest): void {
    this.current = m;
    this.envs.setCachedManifest(this.envId, m);
    this.seenVersion = this.envs.version(this.envId);
  }

  /**
   * Read files (root view, one guest round trip), store each as a blob. Per path: sha and text, or binary /
   * too large, or null when unreadable (deleted again, or not a regular file any more).
   */
  private async captureMany(paths: string[], totalBytes = TOOL_CAPTURE_BYTES): Promise<(Capture | null)[]> {
    const results = await this.runtime.readFiles(paths, { maxBytes: MAX_CAPTURE_BYTES, totalBytes, as: "root" });
    return results.map((r) => {
      if (r instanceof Error) return null;
      if (r.truncated) return { sha: null, text: null, binary: false, tooLarge: true };
      const binary = isBinary(r.data);
      this.budgets.consumeCapture(this.sessionId, r.data.byteLength, this.envId);
      const sha = this.store.blobs.put(r.data);
      return { sha, text: binary ? null : Buffer.from(r.data).toString("utf8"), binary, tooLarge: false };
    });
  }

  /** Stored as a delta against this session's previous manifest (see store/manifests.ts). */
  private saveManifest(m: Manifest, seq: number): void {
    if (!this.lastSaved) {
      const r = this.store.get<{ blob: string }>("SELECT blob FROM manifests WHERE session_id = ? AND env_id = ? ORDER BY seq DESC LIMIT 1", this.sessionId, this.envId);
      this.lastSaved = r ? this.store.manifests.loadSaved(r.blob) : null;
    }
    this.budgets.consume(this.sessionId, "snapshotCount", 1, this.envId);
    this.lastSaved = this.store.manifests.save(m, this.lastSaved, (bytes) => this.budgets.consumeTrace(this.sessionId, bytes, this.envId));
    this.store.run("INSERT INTO manifests (env_id, session_id, seq, blob, created_at) VALUES (?, ?, ?, ?, ?)", this.envId, this.sessionId, seq, this.lastSaved.blob, Date.now());
  }

  /** Diff against `before`, capture content and diffs, emit fs_change. Returns the changes. */
  async after(toolCallId: string | null, before: Manifest): Promise<FileChange[]> {
    let after: Manifest;
    try {
      after = await this.runtime.manifest("/workspace", { previous: before });
    } catch (err) {
      log.warn(`manifest failed for ${this.envId}`, err);
      return [];
    }
    this.accept(after);
    const changes = diffManifests(before, after);
    if (!changes.length) return [];
    const heavy = new Set(after.entries.filter((e) => e.heavy).map((e) => e.path));
    const candidates = changes.filter((c) => c.after?.type === "file" && !heavy.has(c.path) && (c.after.size ?? 0) <= MAX_CAPTURE_BYTES);
    const wantedBytes = candidates.reduce((n, c) => n + (c.after?.size ?? 0), 0);
    const sessionCaptureLeft = this.budgets.remaining(this.sessionId, "captureBytes");
    const sessionTraceLeft = this.budgets.remaining(this.sessionId, "traceBytes");
    const available = Math.min(TOOL_CAPTURE_BYTES, sessionCaptureLeft, sessionTraceLeft);
    const wanted: string[] = [];
    let plannedBytes = 0;
    let omittedFiles = 0;
    let omittedBytes = 0;
    for (const c of candidates) {
      const size = c.after?.size ?? 0;
      if (plannedBytes + size > available) {
        omittedFiles++;
        omittedBytes += size;
      } else {
        wanted.push(c.path);
        plannedBytes += size;
      }
    }
    const captured = new Map<string, Capture | null>();
    const sizes = new Map(after.entries.map((e) => [e.path, e.size]));
    let capturedBytes = 0;
    let capturedFiles = 0;
    for (let i = 0; i < wanted.length; i += CAPTURE_BATCH) {
      const batch = wanted.slice(i, i + CAPTURE_BATCH);
      let got: (Capture | null)[];
      try {
        got = await this.captureMany(batch, Math.max(0, available - capturedBytes));
      } catch (err) {
        if (err instanceof BudgetExceededError) throw err;
        got = batch.map(() => null);
      }
      batch.forEach((p, j) => {
        const cap = got[j] ?? null;
        captured.set(p, cap);
        if (cap?.sha) {
          capturedFiles++;
          capturedBytes += sizes.get(p) ?? 0;
        }
      });
    }
    for (const c of changes) {
      this.changedPaths.add(c.path);
      if (c.after?.type !== "file" && c.before?.type !== "file") continue;
      if (heavy.has(c.path)) continue;
      let oldText: string | null = "";
      if (c.before?.type === "file") {
        oldText = c.before.sha256 ? this.store.blobs.getText(c.before.sha256) : null;
        if (c.before.sha256 && oldText !== null && isBinary(this.store.blobs.get(c.before.sha256)!)) oldText = null;
      }
      let newText: string | null = "";
      if (c.after?.type === "file") {
        if ((c.after.size ?? 0) > MAX_CAPTURE_BYTES) {
          c.tooLarge = true;
          continue;
        }
        const cap = captured.get(c.path);
        if (!cap) continue; // deleted again or unreadable between manifest and read
        if (cap.tooLarge) {
          c.tooLarge = true;
          continue;
        }
        if (cap.binary) {
          c.binary = true;
          continue;
        }
        newText = cap.text;
      }
      if (oldText === null || newText === null) continue;
      const patch = createTwoFilesPatch(`a${c.path}`, `b${c.path}`, oldText, newText, undefined, undefined, { context: 3 });
      if (patch.length <= MAX_DIFF_CHARS) {
        this.budgets.consumeTrace(this.sessionId, Buffer.byteLength(patch), this.envId);
        c.diffBlob = this.store.blobs.put(patch);
      }
      else c.tooLarge = true;
    }
    const capture = { capturedFiles, capturedBytes, omittedFiles, omittedBytes };
    const ev = this.tracer.emit({ type: "fs_change", toolCallId, changes, capture });
    this.saveManifest(after, ev.seq);
    if (omittedFiles > 0) {
      const callLimited = wantedBytes > TOOL_CAPTURE_BYTES;
      const traceLimited = !callLimited && sessionTraceLeft <= sessionCaptureLeft;
      const cfg = this.budgets.get();
      const trip: BudgetTrip = {
        sessionId: this.sessionId,
        envId: this.envId,
        scope: "session",
        budget: traceLimited ? "trace_bytes" : "capture_bytes",
        reason: callLimited
          ? "Session stopped because one tool call changed more than 64 MiB of capturable files."
          : traceLimited
            ? `Session stopped after reaching its ${Math.round(cfg.sessionTraceBytes / 1048576)} MiB trace limit.`
            : `Session stopped after reaching its ${Math.round(cfg.sessionCaptureBytes / 1048576)} MiB file capture limit.`,
        limit: callLimited ? TOOL_CAPTURE_BYTES : traceLimited ? cfg.sessionTraceBytes : cfg.sessionCaptureBytes,
        observed: callLimited ? wantedBytes : (traceLimited ? cfg.sessionTraceBytes - sessionTraceLeft : cfg.sessionCaptureBytes - sessionCaptureLeft) + wantedBytes,
        unit: "bytes",
      };
      this.budgets.externalTrip(trip);
      throw new BudgetExceededError(trip);
    }
    return changes;
  }
}
