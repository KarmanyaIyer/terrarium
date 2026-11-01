import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { TraceEvent } from "@terrarium/shared";
import type { EnvManager } from "../envs/manager.ts";
import type { EnvRuntime, Manifest } from "../envs/types.ts";
import { ResourceBudgets } from "../resource-budgets.ts";
import { Store } from "../store/db.ts";
import type { EventInput, Tracer } from "../trace.ts";
import { BudgetExceededError } from "../resource-budgets.ts";
import { FsObserver, TOOL_CAPTURE_BYTES } from "./observer.ts";

test("one tool call captures at most 64 MiB, records omissions, and ends on giant file churn", async () => {
  const dir = mkdtempSync(join(tmpdir(), "terrarium-observer-budget-"));
  const store = new Store(join(dir, "db.sqlite"), join(dir, "blobs"));
  try {
    const bytes = new Uint8Array(2 * 1024 * 1024); // NUL makes it binary, avoiding large text diffs.
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const before: Manifest = { root: "/workspace", takenAt: 1, entries: [], truncated: false };
    const after: Manifest = {
      root: "/workspace",
      takenAt: 2,
      truncated: false,
      entries: Array.from({ length: 33 }, (_, i) => ({
        path: `/workspace/churn-${i}.bin`,
        type: "file" as const,
        size: bytes.byteLength,
        mode: 0o600,
        mtimeNs: "2",
        ino: i + 1,
        nlink: 1,
        sha256,
      })),
    };
    const runtime = {
      manifest: async () => after,
      readFiles: async (paths: string[]) => paths.map(() => ({ data: bytes, size: bytes.byteLength, truncated: false })),
    } as unknown as EnvRuntime;
    const envs = {
      cachedManifest: () => null,
      setCachedManifest: () => {},
      version: () => 0,
    } as unknown as EnvManager;
    let seq = 0;
    const emitted: EventInput[] = [];
    const tracer: Tracer = {
      sessionId: "ses-churn",
      emit: (event) => {
        emitted.push(event);
        return { ...event, sessionId: "ses-churn", seq: ++seq, ts: Date.now() } as TraceEvent;
      },
      stream: () => {},
      lastSeq: () => seq,
    };
    const budgets = new ResourceBudgets({ store, dataDir: dir });
    const trips: string[] = [];
    budgets.onTrip = (trip) => trips.push(trip.budget);
    const observer = new FsObserver({ store, envs, envId: "sim-churn", sessionId: tracer.sessionId, runtime, tracer, budgets });

    await assert.rejects(observer.after("tool-1", before), (err) => {
      assert.ok(err instanceof BudgetExceededError);
      assert.equal(err.trip.budget, "capture_bytes");
      assert.equal(err.trip.limit, TOOL_CAPTURE_BYTES);
      assert.equal(err.trip.observed, 66 * 1024 * 1024);
      return true;
    });
    await Promise.resolve();
    const event = emitted.find((item) => item.type === "fs_change");
    assert.ok(event?.type === "fs_change");
    assert.deepEqual(event.capture, {
      capturedFiles: 32,
      capturedBytes: TOOL_CAPTURE_BYTES,
      omittedFiles: 1,
      omittedBytes: 2 * 1024 * 1024,
    });
    assert.deepEqual(trips, ["capture_bytes"]);
    assert.equal(budgets.usage(tracer.sessionId).captureBytes, TOOL_CAPTURE_BYTES);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
