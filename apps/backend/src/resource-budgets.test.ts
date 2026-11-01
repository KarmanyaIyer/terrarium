import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { BudgetExceededError, ResourceBudgets, clampSimConfig, clampVmConfig } from "./resource-budgets.ts";
import { Store } from "./store/db.ts";

const MiB = 1024 * 1024;
let dir: string;
let store: Store;
let budgets: ResourceBudgets;

before(() => {
  dir = mkdtempSync(join(tmpdir(), "terrarium-budgets-"));
  store = new Store(join(dir, "db.sqlite"), join(dir, "blobs"));
  budgets = new ResourceBudgets({ store, dataDir: dir });
  budgets.update({
    sessionTraceBytes: 32 * MiB,
    sessionCaptureBytes: 16 * MiB,
    sessionSnapshotCount: 10,
    sessionNetworkRows: 100,
    sessionRequestCount: 10,
    sessionNetworkBytes: 16 * MiB,
  });
});

after(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test("manager clamps hostile VM and sim configuration before a driver sees it", () => {
  assert.deepEqual(clampVmConfig({ cpus: 999, memoryMiB: -1, diskMiB: Number.MAX_SAFE_INTEGER, backend: "krun" }, { cpus: 2, memoryMiB: 1024, diskMiB: 4096, backend: "krun" }), {
    cpus: 4,
    memoryMiB: 512,
    diskMiB: 16_384,
    backend: "krun",
  });
  assert.deepEqual(clampSimConfig({ python: false, javascript: true, maxTotalBytes: Number.MAX_SAFE_INTEGER }, { python: true, javascript: true, maxTotalBytes: 48 * MiB }), {
    python: false,
    javascript: true,
    maxTotalBytes: 256 * MiB,
  });
});

const cases = [
  ["traceBytes", 32 * MiB, "trace_bytes"],
  ["captureBytes", 16 * MiB, "capture_bytes"],
  ["snapshotCount", 10, "snapshot_count"],
  ["networkRows", 100, "network_rows"],
  ["requestCount", 10, "request_count"],
  ["networkBytes", 16 * MiB, "network_bytes"],
] as const;

for (const [counter, limit, eventBudget] of cases) {
  test(`${counter} is persisted and produces one typed trip at its session limit`, async () => {
    const id = `ses-${counter}`;
    const trips: string[] = [];
    budgets.onTrip = (trip) => trips.push(trip.budget);
    budgets.consume(id, counter, limit, "sim-a");
    const reopened = new ResourceBudgets({ store, dataDir: dir });
    assert.equal(reopened.usage(id)[counter], limit, "a backend restart keeps the usage counter");
    assert.throws(() => budgets.consume(id, counter, 1, "sim-a"), (err) => {
      assert.ok(err instanceof BudgetExceededError);
      assert.equal(err.trip.budget, eventBudget);
      assert.equal(err.trip.scope, "session");
      assert.equal(err.trip.limit, limit);
      assert.equal(err.trip.observed, limit + 1);
      return true;
    });
    await Promise.resolve();
    assert.deepEqual(trips, [eventBudget]);
  });
}

test("captured bytes count against both capture and trace allowances", () => {
  budgets.consumeCapture("ses-capture-combined", 1024, "sim-b");
  const used = budgets.usage("ses-capture-combined");
  assert.equal(used.captureBytes, 1024);
  assert.equal(used.traceBytes, 1024);
});

test("host disk reserve rejects new writes before the reserve is consumed", () => {
  const original = budgets.freeDiskBytes;
  budgets.freeDiskBytes = () => 2 * MiB;
  assert.throws(() => budgets.consumeTrace("ses-disk", 1), (err) => {
    assert.ok(err instanceof BudgetExceededError);
    assert.equal(err.trip.budget, "host_disk");
    assert.equal(err.trip.scope, "host");
    return true;
  });
  budgets.freeDiskBytes = original;
});
