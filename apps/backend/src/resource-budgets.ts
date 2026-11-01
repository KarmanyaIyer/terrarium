// Host and per-session resource budgets. Session counters are persisted so restarting the backend cannot reset
// a hostile session's allowance. Environment configuration is clamped here before any driver sees it.

import { statfsSync } from "node:fs";
import type { ResourceBudgetSettings, SimConfig, TraceEvent, VmConfig } from "@terrarium/shared";
import type { Store } from "./store/db.ts";

const MiB = 1024 * 1024;
const GiB = 1024 * MiB;

export const DEFAULT_RESOURCE_BUDGETS: ResourceBudgetSettings = {
  maxSimWorkers: 8,
  simWorkerRssBytes: 1024 * MiB,
  simWorkerCpuMs: 30 * 60_000,
  hostFreeDiskReserveBytes: 20 * GiB,
  sessionTraceBytes: 1024 * MiB,
  sessionCaptureBytes: 512 * MiB,
  sessionSnapshotCount: 256,
  sessionNetworkRows: 2000,
  sessionRequestCount: 200,
  sessionNetworkBytes: 256 * MiB,
  networkBurst: 120,
  networkRefillPerSecond: 20,
};

export const VM_CONFIG_LIMITS = {
  cpus: { min: 1, max: 4 },
  memoryMiB: { min: 512, max: 4096 },
  diskMiB: { min: 1024, max: 16_384 },
} as const;
export const SIM_CONFIG_LIMITS = { maxTotalBytes: { min: 8 * MiB, max: 256 * MiB } } as const;

const SETTING_LIMITS: { [K in keyof ResourceBudgetSettings]: { min: number; max: number } } = {
  maxSimWorkers: { min: 1, max: 32 },
  simWorkerRssBytes: { min: 256 * MiB, max: 4 * GiB },
  simWorkerCpuMs: { min: 60_000, max: 24 * 60 * 60_000 },
  hostFreeDiskReserveBytes: { min: GiB, max: 512 * GiB },
  sessionTraceBytes: { min: 32 * MiB, max: 8 * GiB },
  sessionCaptureBytes: { min: 16 * MiB, max: 4 * GiB },
  sessionSnapshotCount: { min: 10, max: 10_000 },
  sessionNetworkRows: { min: 100, max: 100_000 },
  sessionRequestCount: { min: 10, max: 10_000 },
  sessionNetworkBytes: { min: 16 * MiB, max: 8 * GiB },
  networkBurst: { min: 10, max: 10_000 },
  networkRefillPerSecond: { min: 1, max: 1000 },
};

export type SessionCounter = "traceBytes" | "captureBytes" | "snapshotCount" | "networkRows" | "requestCount" | "networkBytes";

interface UsageRow {
  trace_bytes: number;
  capture_bytes: number;
  snapshot_count: number;
  network_rows: number;
  request_count: number;
  network_bytes: number;
}

const COUNTERS: Record<SessionCounter, { column: keyof UsageRow; setting: keyof ResourceBudgetSettings; budget: Extract<TraceEvent, { type: "budget_exceeded" }>["budget"]; unit: "bytes" | "count" }> = {
  traceBytes: { column: "trace_bytes", setting: "sessionTraceBytes", budget: "trace_bytes", unit: "bytes" },
  captureBytes: { column: "capture_bytes", setting: "sessionCaptureBytes", budget: "capture_bytes", unit: "bytes" },
  snapshotCount: { column: "snapshot_count", setting: "sessionSnapshotCount", budget: "snapshot_count", unit: "count" },
  networkRows: { column: "network_rows", setting: "sessionNetworkRows", budget: "network_rows", unit: "count" },
  requestCount: { column: "request_count", setting: "sessionRequestCount", budget: "request_count", unit: "count" },
  networkBytes: { column: "network_bytes", setting: "sessionNetworkBytes", budget: "network_bytes", unit: "bytes" },
};

export type BudgetTrip = Omit<Extract<TraceEvent, { type: "budget_exceeded" }>, "sessionId" | "seq" | "ts" | "type"> & { sessionId: string };

export class BudgetExceededError extends Error {
  readonly trip: BudgetTrip;
  constructor(trip: BudgetTrip) {
    super(trip.reason);
    this.trip = trip;
  }
}

const finiteInt = (value: unknown, fallback: number): number => (typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : fallback);
const clamp = (value: unknown, min: number, max: number, fallback: number): number => Math.min(max, Math.max(min, finiteInt(value, fallback)));

export function clampVmConfig(value: Partial<VmConfig> | undefined, fallback: VmConfig): VmConfig {
  return {
    cpus: clamp(value?.cpus, VM_CONFIG_LIMITS.cpus.min, VM_CONFIG_LIMITS.cpus.max, fallback.cpus),
    memoryMiB: clamp(value?.memoryMiB, VM_CONFIG_LIMITS.memoryMiB.min, VM_CONFIG_LIMITS.memoryMiB.max, fallback.memoryMiB),
    diskMiB: clamp(value?.diskMiB, VM_CONFIG_LIMITS.diskMiB.min, VM_CONFIG_LIMITS.diskMiB.max, fallback.diskMiB),
    backend: value?.backend === "qemu" || value?.backend === "krun" ? value.backend : fallback.backend,
  };
}

export function clampSimConfig(value: Partial<SimConfig> | undefined, fallback: SimConfig): SimConfig {
  return {
    python: typeof value?.python === "boolean" ? value.python : fallback.python,
    javascript: typeof value?.javascript === "boolean" ? value.javascript : fallback.javascript,
    maxTotalBytes: clamp(value?.maxTotalBytes, SIM_CONFIG_LIMITS.maxTotalBytes.min, SIM_CONFIG_LIMITS.maxTotalBytes.max, fallback.maxTotalBytes),
  };
}

function reasonFor(counter: SessionCounter, limit: number): string {
  switch (counter) {
    case "traceBytes":
      return `Session stopped after reaching its ${Math.round(limit / MiB)} MiB trace limit.`;
    case "captureBytes":
      return `Session stopped after reaching its ${Math.round(limit / MiB)} MiB file capture limit.`;
    case "snapshotCount":
      return `Session stopped after reaching its ${limit} saved filesystem history limit.`;
    case "networkRows":
      return `Session stopped after reaching its ${limit} network row limit.`;
    case "requestCount":
      return `Session stopped after reaching its ${limit} model request limit.`;
    case "networkBytes":
      return `Session stopped after reaching its ${Math.round(limit / MiB)} MiB network limit.`;
  }
}

export class ResourceBudgets {
  private readonly store: Store;
  private readonly dataDir: string;
  private readonly defaults: ResourceBudgetSettings;
  private readonly tripped = new Set<string>();
  onTrip?: (trip: BudgetTrip) => void;

  constructor(opts: { store: Store; dataDir: string; defaults?: Partial<ResourceBudgetSettings> }) {
    this.store = opts.store;
    this.dataDir = opts.dataDir;
    this.defaults = { ...DEFAULT_RESOURCE_BUDGETS, ...opts.defaults };
  }

  get(): ResourceBudgetSettings {
    const saved = this.store.getSetting<Partial<ResourceBudgetSettings>>("resourceBudgets", {});
    const out = { ...this.defaults };
    for (const key of Object.keys(out) as (keyof ResourceBudgetSettings)[]) {
      const range = SETTING_LIMITS[key];
      out[key] = clamp(saved[key], range.min, range.max, out[key]) as never;
    }
    return out;
  }

  update(patch: Partial<ResourceBudgetSettings>): ResourceBudgetSettings {
    const next = { ...this.get() };
    for (const [rawKey, rawValue] of Object.entries(patch)) {
      const key = rawKey as keyof ResourceBudgetSettings;
      const range = SETTING_LIMITS[key];
      if (!range) throw new Error(`unknown resource budget ${rawKey}`);
      if (!Number.isInteger(rawValue) || (rawValue as number) < range.min || (rawValue as number) > range.max) {
        throw new Error(`${rawKey} must be an integer from ${range.min} to ${range.max}`);
      }
      next[key] = rawValue as never;
    }
    this.store.setSetting("resourceBudgets", next);
    return next;
  }

  ensureSession(sessionId: string): void {
    this.store.run("INSERT OR IGNORE INTO session_budget_usage (session_id) VALUES (?)", sessionId);
  }

  usage(sessionId: string): Record<SessionCounter, number> {
    this.ensureSession(sessionId);
    const r = this.store.get<UsageRow>("SELECT trace_bytes, capture_bytes, snapshot_count, network_rows, request_count, network_bytes FROM session_budget_usage WHERE session_id = ?", sessionId)!;
    return {
      traceBytes: r.trace_bytes,
      captureBytes: r.capture_bytes,
      snapshotCount: r.snapshot_count,
      networkRows: r.network_rows,
      requestCount: r.request_count,
      networkBytes: r.network_bytes,
    };
  }

  remaining(sessionId: string, counter: SessionCounter): number {
    const c = COUNTERS[counter];
    return Math.max(0, this.get()[c.setting] - this.usage(sessionId)[counter]);
  }

  consume(sessionId: string, counter: SessionCounter, amount: number, envId?: string): number {
    if (!Number.isFinite(amount) || amount < 0) throw new Error(`invalid ${counter} amount`);
    amount = Math.ceil(amount);
    this.ensureSession(sessionId);
    const c = COUNTERS[counter];
    const limit = this.get()[c.setting];
    const used = this.usage(sessionId)[counter];
    const observed = used + amount;
    if (observed > limit) {
      const trip: BudgetTrip = {
        sessionId,
        scope: "session",
        budget: c.budget,
        reason: reasonFor(counter, limit),
        limit,
        observed,
        unit: c.unit,
        ...(envId ? { envId } : {}),
      };
      this.trip(trip);
      throw new BudgetExceededError(trip);
    }
    this.store.run(`UPDATE session_budget_usage SET ${c.column} = ${c.column} + ? WHERE session_id = ?`, amount, sessionId);
    return observed;
  }

  consumeCapture(sessionId: string, amount: number, envId?: string): void {
    const captureLeft = this.remaining(sessionId, "captureBytes");
    const traceLeft = this.remaining(sessionId, "traceBytes");
    if (amount > captureLeft) this.consume(sessionId, "captureBytes", amount, envId);
    if (amount > traceLeft) this.consume(sessionId, "traceBytes", amount, envId);
    this.assertSessionDisk(sessionId, amount, envId);
    this.consume(sessionId, "captureBytes", amount, envId);
    this.consume(sessionId, "traceBytes", amount, envId);
  }

  consumeTrace(sessionId: string, amount: number, envId?: string): void {
    this.assertSessionDisk(sessionId, amount, envId);
    this.consume(sessionId, "traceBytes", amount, envId);
  }

  private assertSessionDisk(sessionId: string, amount: number, envId?: string): void {
    const limit = this.get().hostFreeDiskReserveBytes;
    const observed = this.freeDiskBytes() - Math.max(0, amount);
    if (observed >= limit) return;
    const trip: BudgetTrip = {
      sessionId,
      scope: "host",
      budget: "host_disk",
      reason: `Host disk reserve reached. Terrarium keeps ${Math.round(limit / GiB)} GiB free.`,
      limit,
      observed,
      unit: "bytes",
      ...(envId ? { envId } : {}),
    };
    this.trip(trip);
    throw new BudgetExceededError(trip);
  }

  trip(trip: BudgetTrip): void {
    const key = `${trip.sessionId}:${trip.budget}`;
    if (this.tripped.has(key)) return;
    this.tripped.add(key);
    queueMicrotask(() => this.onTrip?.(trip));
  }

  externalTrip(trip: BudgetTrip): void {
    this.trip(trip);
  }

  clearTrips(sessionId: string): void {
    for (const key of this.tripped) if (key.startsWith(`${sessionId}:`)) this.tripped.delete(key);
  }

  freeDiskBytes(): number {
    const st = statfsSync(this.dataDir);
    return st.bavail * st.bsize;
  }

  assertDiskReserve(extraBytes = 0): void {
    const reserve = this.get().hostFreeDiskReserveBytes;
    const free = this.freeDiskBytes();
    if (free - Math.max(0, extraBytes) < reserve) {
      throw new Error(`Host disk reserve reached. Terrarium keeps ${Math.round(reserve / GiB)} GiB free.`);
    }
  }
}
