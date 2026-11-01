// EnvManager: the single state machine for env lifecycle (create/start/stop/reset/snapshot/fork/delete),
// the 2-running-VM limit, net log persistence, facts, and the user shell.

import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import type {
  CreateEnvRequest,
  EnvFacts,
  EnvStatus,
  EnvSummary,
  EnvType,
  EnvUse,
  ExecRequest,
  ExecResult,
  FileChange,
  NetEntry,
  NetworkMode,
  SimConfig,
  Snapshot,
  VmConfig,
} from "@terrarium/shared";
import type { Hub } from "../hub.ts";
import type { Store } from "../store/db.ts";
import { BudgetExceededError, ResourceBudgets, clampSimConfig, clampVmConfig } from "../resource-budgets.ts";
import { HttpError, errorMessage } from "../util/errors.ts";
import { newId } from "../util/ids.ts";
import { logger } from "../util/log.ts";
import { KeyedMutex } from "../util/mutex.ts";
import { diffManifests } from "./manifest-diff.ts";
import { DEFAULT_SIM } from "./sim/driver.ts";
import type { EnvDriver, EnvRuntime, Manifest, NetAttempt } from "./types.ts";

const log = logger("envs");
export const MAX_RUNNING_VMS = 2;
/** Most net rows one request returns: the UI shows up to 5,000 and asks for one more to know whether older rows exist. */
export const NET_LOG_MAX = 5001;
/** Identical net attempts (same session, request, decision, reason and status) this close together share a row. */
export const NET_REPEAT_WINDOW_MS = 60_000;
/** A collapsed row is written and broadcast at most this often while repeats keep coming. */
const NET_FLUSH_MS = 1000;
export const DEFAULT_VM: VmConfig = { cpus: 2, memoryMiB: 1024, diskMiB: 4096, backend: "krun" };
const NETWORK_MODES = new Set<NetworkMode>(["off", "registries", "web"]);

interface EnvRow {
  id: string;
  name: string;
  type: EnvType;
  status: EnvStatus;
  status_detail: string | null;
  network: NetworkMode;
  parent_env_id: string | null;
  base_snapshot_id: string | null;
  factory_snapshot_id: string | null;
  config_json: string;
  facts_json: string | null;
  ephemeral: number;
  released: number;
  created_at: number;
  last_used_at: number | null;
}

interface SnapshotRow {
  id: string;
  env_id: string;
  label: string;
  kind: Snapshot["kind"];
  bytes: number;
  path: string;
  created_at: number;
}

function dirSize(dir: string, depth = 0): number {
  if (!existsSync(dir)) return 0;
  let total = 0;
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, ent.name);
    try {
      if (ent.isFile()) total += statSync(p).size;
      else if (ent.isDirectory() && depth < 4) total += dirSize(p, depth + 1);
    } catch {}
  }
  return total;
}

export interface EnvHooks {
  /** A net attempt happened while `sessionId` was using the env. */
  onSessionNet?: (sessionId: string, entry: NetEntry) => void;
  /** The env's storage is being released while a session still uses it: abort that session's run. */
  onEnvInterrupted?: (envId: string, sessionId: string) => Promise<void>;
  /** An env was deleted: blobs only it referenced may be garbage now. */
  onDeleted?: (envId: string) => void;
}

/** How often a queued simulated env looks again if nothing woke it. */
const SIM_QUEUE_POLL_MS = 1000;

export class EnvManager {
  private store: Store;
  private hub: Hub;
  private dataDir: string;
  private drivers: Record<EnvType, EnvDriver | null>;
  private budgets: ResourceBudgets;
  private runtimes = new Map<string, EnvRuntime>();
  /** Opens in flight, so overlapping first uses of an env (e.g. right after a restart) share one runtime. */
  private opening = new Map<string, Promise<EnvRuntime>>();
  private unsubNet = new Map<string, () => void>();
  private mutex = new KeyedMutex();
  private netRepeats = new Map<string, { entry: NetEntry; timer: NodeJS.Timeout | null }>();
  /** One lock across the running-VM count and the boot, so concurrent starts can't exceed MAX_RUNNING_VMS. */
  private vmBoot = new KeyedMutex();
  /** One lock across the running-sim count and worker spawn. */
  private simBoot = new KeyedMutex();
  /** Envs waiting for a simulated worker slot, first come first served. */
  private simQueue: string[] = [];
  private simWakers = new Set<() => void>();
  private simCancels = new Map<string, (why: string) => void>();
  /** A session's env went into that queue: its trace says so. */
  private queuedNotes = new Map<string, (detail: string) => void>();
  private active = new Map<string, string>(); // envId -> sessionId using it
  private shells = new Map<string, number>(); // envId -> user shell commands in flight
  private manifests = new Map<string, Manifest>(); // last known /workspace manifest per env
  private versions = new Map<string, number>(); // bumps when something other than the harness changes the env
  private sizes = new Map<string, number>();
  private networkBuckets = new Map<string, { tokens: number; at: number }>();
  private budgetDetails = new Map<string, string>();
  private diskReserveTripped = false;
  hooks: EnvHooks = {};

  constructor(opts: { store: Store; hub: Hub; dataDir: string; drivers: Record<EnvType, EnvDriver | null>; budgets?: ResourceBudgets }) {
    this.store = opts.store;
    this.hub = opts.hub;
    this.dataDir = opts.dataDir;
    this.drivers = opts.drivers;
    this.budgets = opts.budgets ?? new ResourceBudgets({ store: opts.store, dataDir: opts.dataDir });
    // Nothing survives a backend restart: VMs and sim children die with the process.
    this.store.run("UPDATE envs SET status = 'stopped', status_detail = NULL WHERE status IN ('starting', 'running', 'stopping', 'busy')");
  }

  resourceBudgets(): ResourceBudgets {
    return this.budgets;
  }

  // ---------- reads ----------

  private row(id: string): EnvRow {
    const row = this.store.get<EnvRow>("SELECT * FROM envs WHERE id = ?", id);
    if (!row) throw new HttpError(404, `environment not found: ${id}`);
    return row;
  }

  private toSummary(row: EnvRow, evals?: Map<string, EnvUse>): EnvSummary {
    const config = JSON.parse(row.config_json) as { vm?: VmConfig; sim?: SimConfig };
    if (!this.sizes.has(row.id)) this.sizes.set(row.id, dirSize(this.envDir(row.id)));
    const inUse = this.uses(row.id, evals);
    return {
      id: row.id,
      name: row.name,
      type: row.type,
      status: row.status,
      statusDetail: row.status_detail ?? (row.released ? "storage released after eval; trace and files remain viewable" : undefined),
      network: row.network,
      parentEnvId: row.parent_env_id ?? undefined,
      baseSnapshotId: row.base_snapshot_id ?? undefined,
      vm: config.vm,
      sim: config.sim,
      facts: row.facts_json ? (JSON.parse(row.facts_json) as EnvFacts) : undefined,
      diskBytes: this.sizes.get(row.id),
      createdAt: row.created_at,
      ephemeral: !!row.ephemeral,
      ...(row.released ? { released: true } : {}),
      ...(inUse.length ? { inUse } : {}),
    };
  }

  list(): EnvSummary[] {
    const evals = this.evalUses();
    return this.store.all<EnvRow>("SELECT * FROM envs WHERE id NOT LIKE 'evalbase_%' ORDER BY created_at").map((r) => this.toSummary(r, evals));
  }

  /** Eval cases running (agent or grader) in their envs, by env id. */
  private evalUses(envId?: string): Map<string, EnvUse> {
    const rows = this.store.all<{ env_id: string; run_id: string; case_id: string; session_id: string | null; suite_title: string }>(
      `SELECT r.env_id, r.run_id, r.case_id, r.session_id, u.suite_title FROM eval_results r JOIN eval_runs u ON u.id = r.run_id
       WHERE r.status = 'running' AND r.env_id IS NOT NULL${envId ? " AND r.env_id = ?" : ""}`,
      ...(envId ? [envId] : []),
    );
    return new Map(
      rows.map((r) => [r.env_id, { kind: "eval", reason: `eval "${r.suite_title}" case ${r.case_id} running`, evalRunId: r.run_id, ...(r.session_id ? { sessionId: r.session_id } : {}) }]),
    );
  }

  /** What is using an env right now, most binding first. */
  private uses(id: string, evals?: Map<string, EnvUse>): EnvUse[] {
    const out: EnvUse[] = [];
    const ev = (evals ?? this.evalUses(id)).get(id);
    if (ev) out.push(ev);
    const sessionId = this.active.get(id);
    if (sessionId && sessionId !== ev?.sessionId) {
      const title = this.store.get<{ title: string }>("SELECT title FROM sessions WHERE id = ?", sessionId)?.title ?? sessionId;
      out.push({ kind: "session", reason: `session "${title}" running`, sessionId });
    }
    const shells = this.shells.get(id) ?? 0;
    if (shells) out.push({ kind: "shell", reason: shells === 1 ? "shell command running" : `${shells} shell commands running` });
    return out;
  }

  /**
   * Stop, reset, restore, snapshot (so fork of the live env) and delete take the env down or away, so they are
   * refused while anything uses it instead of shutting it down under the running command.
   */
  private assertIdle(id: string): void {
    const uses = this.uses(id);
    if (uses.length) throw new HttpError(409, `env busy: ${uses.map((u) => u.reason).join("; ")}`);
  }

  /** An env a running eval case owns is read-only to everyone else (shell, network, other sessions). */
  private assertNotEvalOwned(id: string, sessionId?: string): void {
    const ev = this.evalUses(id).get(id);
    if (ev && (!sessionId || sessionId !== ev.sessionId)) throw new HttpError(409, `env read-only: ${ev.reason}`);
  }

  get(id: string): EnvSummary {
    return this.toSummary(this.row(id));
  }

  exists(id: string): boolean {
    return !!this.store.get("SELECT id FROM envs WHERE id = ?", id);
  }

  snapshots(id: string): Snapshot[] {
    this.row(id);
    return this.store
      .all<SnapshotRow>("SELECT * FROM snapshots WHERE env_id = ? ORDER BY created_at", id)
      .map((s) => ({ id: s.id, envId: s.env_id, label: s.label, kind: s.kind, bytes: s.bytes, createdAt: s.created_at }));
  }

  /** Newest `limit` rows by their latest attempt, so a collapsed loop that started long ago stays in the window. */
  netLog(id: string, limit = 500): NetEntry[] {
    return this.store
      .all<any>("SELECT * FROM net_log WHERE env_id = ? ORDER BY COALESCE(last_ts, ts) DESC, ts DESC LIMIT ?", id, Math.min(Math.max(limit, 1), NET_LOG_MAX))
      .map((r) => ({
        id: r.id,
        envId: r.env_id,
        sessionId: r.session_id ?? undefined,
        ts: r.ts,
        method: r.method,
        url: r.url,
        host: r.host,
        ip: r.ip ?? undefined,
        decision: r.decision,
        reason: r.reason,
        status: r.status ?? undefined,
        bytesIn: r.bytes_in ?? undefined,
        bytesOut: r.bytes_out ?? undefined,
        ...(r.repeats > 1 ? { repeats: r.repeats, lastTs: r.last_ts ?? undefined } : {}),
      }));
  }

  envDir(id: string): string {
    return join(this.dataDir, "envs", id);
  }

  private snapshotDir(snapId: string): string {
    return join(this.dataDir, "snapshots", snapId);
  }

  private driver(type: EnvType): EnvDriver {
    const d = this.drivers[type];
    if (!d) throw new HttpError(503, type === "vm" ? "VM driver not available" : "sim driver not available", type === "vm" ? "src/envs/vm/driver.ts is not installed yet" : undefined);
    return d;
  }

  private broadcast(id: string): void {
    if (!this.exists(id)) return;
    this.hub.broadcast({ type: "env", env: this.get(id) });
  }

  private setStatus(id: string, status: EnvStatus, detail: string | null = null): void {
    if (status !== "starting") queueMicrotask(() => this.wakeSimQueue());
    this.store.run("UPDATE envs SET status = ?, status_detail = ? WHERE id = ?", status, detail, id);
    this.broadcast(id);
  }

  private touch(id: string): void {
    this.store.run("UPDATE envs SET last_used_at = ? WHERE id = ?", Date.now(), id);
  }

  private config(row: EnvRow): { vm?: VmConfig; sim?: SimConfig } {
    const raw = JSON.parse(row.config_json) as { vm?: Partial<VmConfig>; sim?: Partial<SimConfig> };
    const config = row.type === "vm" ? { vm: clampVmConfig(raw.vm, DEFAULT_VM) } : { sim: clampSimConfig(raw.sim, DEFAULT_SIM) };
    const encoded = JSON.stringify(config);
    if (encoded !== row.config_json) {
      row.config_json = encoded;
      this.store.run("UPDATE envs SET config_json = ? WHERE id = ?", encoded, row.id);
    }
    return config;
  }

  /**
   * Runtime object for an env (opened lazily; not necessarily running). Opened once even when calls overlap: a second
   * runtime for the same env would replace the first in the map, and a VM the first one booted would go untracked.
   */
  private async runtimeFor(row: EnvRow): Promise<EnvRuntime> {
    const rt = this.runtimes.get(row.id);
    if (rt) return rt;
    if (row.released) throw new HttpError(409, "environment storage was released after its eval run");
    let open = this.opening.get(row.id);
    if (!open) {
      const cfg = this.config(row);
      open = this.driver(row.type)
        .open({ id: row.id, dir: this.envDir(row.id), network: row.network, vm: cfg.vm, sim: cfg.sim })
        .then((opened) => {
          this.attach(row.id, opened);
          return opened;
        })
        .finally(() => this.opening.delete(row.id));
      this.opening.set(row.id, open);
    }
    return open;
  }

  private attach(id: string, rt: EnvRuntime): void {
    this.runtimes.set(id, rt);
    rt.setNetworkGate?.((method, url) => this.networkGate(id, method, url));
    this.unsubNet.get(id)?.();
    this.unsubNet.set(
      id,
      rt.onNet((attempt) => {
        const sessionId = this.active.get(id);
        let normalized = attempt;
        let overflow = attempt.reason === "network request rate limit reached";
        if (sessionId) {
          const bytes = (attempt.bytesIn ?? 0) + (attempt.bytesOut ?? 0);
          if (bytes) {
            try {
              this.budgets.consume(sessionId, "networkBytes", bytes, id);
            } catch (err) {
              if (!(err instanceof BudgetExceededError)) throw err;
              overflow = true;
              normalized = { ts: attempt.ts, method: "HTTP", url: "", host: "", decision: "deny", reason: "network byte limit reached; further attempts omitted" };
            }
          }
        }
        if (overflow) normalized = { ts: attempt.ts, method: "HTTP", url: "", host: "", decision: "deny", reason: normalized.reason };
        if (this.collapseRepeat(id, sessionId, normalized)) return;
        if (sessionId && !overflow) {
          try {
            this.budgets.consume(sessionId, "networkRows", 1, id);
          } catch (err) {
            if (!(err instanceof BudgetExceededError)) throw err;
            normalized = { ts: attempt.ts, method: "HTTP", url: "", host: "", decision: "deny", reason: "network row limit reached; further attempts omitted" };
            if (this.collapseRepeat(id, sessionId, normalized)) return;
          }
        }
        const entry: NetEntry = { ...normalized, id: newId("net"), envId: id, sessionId };
        this.rememberNet(entry);
        this.store.run(
          "INSERT INTO net_log (id, env_id, session_id, ts, method, url, host, ip, decision, reason, status, bytes_in, bytes_out) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          entry.id,
          id,
          entry.sessionId ?? null,
          entry.ts,
          entry.method,
          entry.url,
          entry.host,
          entry.ip ?? null,
          entry.decision,
          entry.reason,
          entry.status ?? null,
          entry.bytesIn ?? null,
          entry.bytesOut ?? null,
        );
        this.hub.broadcast({ type: "env_net", entry });
        if (entry.sessionId) this.hooks.onSessionNet?.(entry.sessionId, entry);
      }),
    );
  }

  /** Per-session (or per-env user shell) token bucket, checked before DNS and egress. */
  private networkGate(envId: string, _method: string, _url: string): string | null {
    const sessionId = this.active.get(envId);
    const key = sessionId ?? `env:${envId}`;
    const cfg = this.budgets.get();
    const now = Date.now();
    const b = this.networkBuckets.get(key) ?? { tokens: cfg.networkBurst, at: now };
    b.tokens = Math.min(cfg.networkBurst, b.tokens + ((now - b.at) / 1000) * cfg.networkRefillPerSecond);
    b.at = now;
    if (b.tokens >= 1) {
      b.tokens -= 1;
      this.networkBuckets.set(key, b);
      return null;
    }
    this.networkBuckets.set(key, b);
    if (sessionId) {
      this.budgets.externalTrip({
        sessionId,
        envId,
        scope: "session",
        budget: "network_rate",
        reason: "Session stopped because it sent network requests too quickly.",
        limit: cfg.networkBurst,
        observed: cfg.networkBurst + 1,
        unit: "count",
      });
    }
    return "network request rate limit reached";
  }

  private netKey(envId: string, sessionId: string | undefined, a: NetAttempt): string {
    return JSON.stringify([envId, sessionId ?? null, a.method, a.url, a.host, a.ip ?? null, a.decision, a.reason, a.status ?? null]);
  }

  private rememberNet(entry: NetEntry): void {
    const now = entry.ts;
    for (const [k, v] of this.netRepeats) {
      if (now - (v.entry.lastTs ?? v.entry.ts) <= NET_REPEAT_WINDOW_MS && this.netRepeats.size < 2000) break; // oldest first
      if (v.timer) {
        clearTimeout(v.timer);
        this.flushNet(v.entry);
      }
      this.netRepeats.delete(k);
    }
    this.netRepeats.set(this.netKey(entry.envId, entry.sessionId, entry), { entry, timer: null });
  }

  /**
   * Fold an attempt into the row of an identical one seen within the window: count, last time and bytes are
   * updated in the DB and broadcast at most once a second; the trace keeps the first event only.
   */
  private collapseRepeat(envId: string, sessionId: string | undefined, a: NetAttempt): boolean {
    const key = this.netKey(envId, sessionId, a);
    const hit = this.netRepeats.get(key);
    if (!hit || a.ts - (hit.entry.lastTs ?? hit.entry.ts) > NET_REPEAT_WINDOW_MS) return false;
    const e = hit.entry;
    e.repeats = (e.repeats ?? 1) + 1;
    e.lastTs = a.ts;
    if (a.bytesIn !== undefined) e.bytesIn = (e.bytesIn ?? 0) + a.bytesIn;
    if (a.bytesOut !== undefined) e.bytesOut = (e.bytesOut ?? 0) + a.bytesOut;
    // Most recently used last, so rememberNet's scan from the front meets stale keys first.
    this.netRepeats.delete(key);
    this.netRepeats.set(key, hit);
    hit.timer ??= setTimeout(() => {
      hit.timer = null;
      this.flushNet(e);
    }, NET_FLUSH_MS);
    hit.timer.unref?.();
    return true;
  }

  private flushNet(e: NetEntry): void {
    try {
      this.store.run("UPDATE net_log SET repeats = ?, last_ts = ?, bytes_in = ?, bytes_out = ? WHERE id = ?", e.repeats ?? 1, e.lastTs ?? null, e.bytesIn ?? null, e.bytesOut ?? null, e.id);
    } catch (err) {
      log.warn(`net log update for ${e.id} failed`, err);
      return;
    }
    this.hub.broadcast({ type: "env_net", entry: { ...e } });
  }

  /** Write out pending repeat counts (shutdown, tests). */
  flushNetRepeats(): void {
    for (const v of this.netRepeats.values()) {
      if (!v.timer) continue;
      clearTimeout(v.timer);
      v.timer = null;
      this.flushNet(v.entry);
    }
  }

  // ---------- lifecycle ----------

  private assertDisk(extraBytes = 0): void {
    try {
      this.budgets.assertDiskReserve(extraBytes);
    } catch (err) {
      throw new HttpError(507, err instanceof Error ? err.message : String(err));
    }
  }

  async create(req: CreateEnvRequest, opts: { ephemeral?: boolean; id?: string } = {}): Promise<EnvSummary> {
    if (!req.name?.trim()) throw new HttpError(400, "name is required");
    if (req.type !== "vm" && req.type !== "sim") throw new HttpError(400, "type must be vm or sim");
    const network = req.network ?? "off";
    if (!NETWORK_MODES.has(network)) throw new HttpError(400, "invalid network mode");
    if (req.from) return this.fork("envId" in req.from ? req.from.envId : this.snapshotRow(req.from.snapshotId).env_id, { name: req.name, snapshotId: "snapshotId" in req.from ? req.from.snapshotId : undefined, network, seedFiles: req.seedFiles }, opts);
    const driver = this.driver(req.type);
    const id = opts.id ?? newId(req.type === "vm" ? "vm" : "sim");
    const config = req.type === "vm" ? { vm: clampVmConfig(req.vm, DEFAULT_VM) } : { sim: clampSimConfig(req.sim, DEFAULT_SIM) };
    // Keep enough room for the environment at its configured maximum, not merely for its initially sparse files.
    this.assertDisk(req.type === "vm" ? config.vm!.diskMiB * 1024 * 1024 : config.sim!.maxTotalBytes);
    const now = Date.now();
    this.store.run(
      "INSERT INTO envs (id, name, type, status, network, config_json, ephemeral, created_at, last_used_at) VALUES (?, ?, ?, 'starting', ?, ?, ?, ?, ?)",
      id,
      req.name.trim(),
      req.type,
      network,
      JSON.stringify(config),
      opts.ephemeral ? 1 : 0,
      now,
      now,
    );
    this.store.run("UPDATE envs SET status_detail = 'creating' WHERE id = ?", id);
    this.broadcast(id);
    try {
      const rt = await driver.create({ id, dir: this.envDir(id), network, ...config, seedFiles: req.type === "sim" ? req.seedFiles : undefined });
      this.attach(id, rt);
      if (req.type === "vm" && req.seedFiles?.length) await this.seed(id, rt, req.seedFiles);
      // Factory snapshot: reset returns here.
      const snap = await this.snapshot(id, "factory", "factory");
      this.store.run("UPDATE envs SET factory_snapshot_id = ? WHERE id = ?", snap.id, id);
      this.setStatus(id, "stopped");
    } catch (err) {
      this.setStatus(id, "error", `create failed: ${errorMessage(err)}`);
      throw err;
    }
    return this.get(id);
  }

  private snapshotRow(snapId: string): SnapshotRow {
    const s = this.store.get<SnapshotRow>("SELECT * FROM snapshots WHERE id = ?", snapId);
    if (!s) throw new HttpError(404, `snapshot not found: ${snapId}`);
    return s;
  }

  private async takeSnapshot(envId: string, rt: EnvRuntime, kind: Snapshot["kind"], label: string): Promise<Snapshot> {
    this.assertDisk(this.sizes.get(envId) ?? dirSize(this.envDir(envId)));
    const snapId = newId("snap");
    const dir = this.snapshotDir(snapId);
    const { bytes } = await rt.snapshot(dir);
    const createdAt = Date.now();
    this.store.run("INSERT INTO snapshots (id, env_id, label, kind, bytes, path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)", snapId, envId, label, kind, bytes, dir, createdAt);
    return { id: snapId, envId, label, kind, bytes, createdAt };
  }

  async start(id: string): Promise<EnvSummary> {
    await this.mutex.run(id, () => this.startUnlocked(id));
    return this.get(id);
  }

  private async startUnlocked(id: string): Promise<void> {
    const row = this.row(id);
    const rt = await this.runtimeFor(row);
    if (rt.isRunning()) {
      if (row.status !== "running" && row.status !== "busy") this.setStatus(id, this.active.has(id) ? "busy" : "running");
      return;
    }
    this.assertDisk();
    this.setStatus(id, "starting");
    try {
      await this.boot(row, rt);
    } catch (err) {
      if (err instanceof HttpError) {
        this.setStatus(id, row.status, row.status_detail); // no VM slot (409): nothing happened
        throw err;
      }
      this.setStatus(id, "error", `start failed: ${errorMessage(err)}`);
      throw new HttpError(500, `start failed: ${errorMessage(err)}`);
    }
    this.touch(id);
    this.setStatus(id, this.active.has(id) ? "busy" : "running");
    // Facts change with the env (installed tools, disk use, a reset), so they are gathered on every start.
    await this.refreshFacts(id, rt);
  }

  /**
   * Boot a runtime. Callers hold the env's mutex. A VM boots under the global boot lock, which covers the running-VM
   * count and the boot. With no slot free, the least recently used idle VM is stopped outside that lock, under its
   * own mutex, and the count is taken again. Nothing waits for an env mutex while holding the boot lock, so a
   * lifecycle op that holds its env's mutex and waits for the boot lock (start, snapshot, reset) can't deadlock it.
   */
  private async boot(row: EnvRow, rt: EnvRuntime): Promise<void> {
    if (row.type === "sim") return this.bootSim(row, rt);
    for (let attempt = 0; ; attempt++) {
      const victim = await this.vmBoot.run("vm", async () => {
        const others = await this.vmSlots(row.id);
        if (others.length < MAX_RUNNING_VMS) {
          await rt.start();
          return null;
        }
        const idle = others.find((r) => this.idleVm(r));
        if (!idle || attempt > MAX_RUNNING_VMS + 2) {
          const why = others.map((r) => `${r.name}: ${this.uses(r.id).map((u) => u.reason).join(", ") || r.status}`).join("; ");
          throw new HttpError(409, `${MAX_RUNNING_VMS} VMs are in use (${why}); stop one first`);
        }
        return idle.id;
      });
      if (!victim) return;
      await this.mutex
        .run(victim, async () => {
          // Checked again under its lock: a session may have taken it, or it stopped meanwhile.
          const cur = this.store.get<EnvRow>("SELECT * FROM envs WHERE id = ?", victim);
          if (!cur || !this.runtimes.get(victim)?.isRunning() || !this.idleVm(cur)) return;
          log.info(`stopping idle VM ${victim} to make room for ${row.id}`);
          await this.stopUnlocked(victim, "stopped to make room for another VM");
        })
        .catch((err) => log.warn(`stopping ${victim} to make room failed`, err));
    }
  }

  /**
   * With every slot busy the boot waits its turn instead of failing, so an eval case isn't an error just because other
   * sims are in use. The waiter holds only its own env's mutex, and Stop or Delete on that env cancels the wait.
   */
  private async bootSim(row: EnvRow, rt: EnvRuntime): Promise<void> {
    let queued = false;
    try {
      for (;;) {
        const next = await this.simBoot.run("sim", async () => {
          const max = this.budgets.get().maxSimWorkers;
          const others = this.store
            .all<EnvRow>("SELECT * FROM envs WHERE type = 'sim' AND id != ? ORDER BY COALESCE(last_used_at, created_at)", row.id)
            .filter((r) => this.runtimes.get(r.id)?.isRunning());
          const turn = queued ? this.simQueue[0] === row.id : this.simQueue.length === 0;
          if (turn && others.length < max) {
            await rt.start();
            return { done: true as const };
          }
          const idle = turn ? others.find((r) => r.status === "running" && this.uses(r.id).length === 0) : undefined;
          if (idle) return { done: false as const, victim: idle.id };
          return { done: false as const, waitingFor: others.map((r) => this.uses(r.id).map((u) => u.reason).join(", ") || r.status).join("; ") };
        });
        if (next.done) return;
        if (next.victim) {
          await this.mutex.run(next.victim, async () => {
            const cur = this.store.get<EnvRow>("SELECT * FROM envs WHERE id = ?", next.victim);
            if (!cur || !this.runtimes.get(next.victim!)?.isRunning() || cur.status !== "running" || this.uses(next.victim!).length) return;
            log.info(`stopping idle simulated worker ${next.victim} to make room for ${row.id}`);
            await this.stopUnlocked(next.victim!, "stopped to make room for another simulated worker");
          });
          continue;
        }
        if (!queued) {
          queued = true;
          this.simQueue.push(row.id);
          const detail = `Waiting for a free simulated worker (${next.waitingFor || "all in use"})`;
          this.setStatus(row.id, "starting", detail);
          this.queuedNotes.get(row.id)?.(detail);
          log.info(`${row.id} queued for a simulated worker`);
        }
        await this.simSlotChange(row.id);
      }
    } finally {
      if (queued) {
        this.simQueue = this.simQueue.filter((id) => id !== row.id);
        this.wakeSimQueue();
      }
    }
  }

  /** Resolves when a slot may have freed: a status change wakes it, the timer covers uses that end without one. */
  private simSlotChange(id: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const clear = () => {
        clearTimeout(timer);
        this.simWakers.delete(wake);
        this.simCancels.delete(id);
      };
      const wake = () => {
        clear();
        resolve();
      };
      const timer = setTimeout(wake, SIM_QUEUE_POLL_MS);
      timer.unref();
      this.simWakers.add(wake);
      this.simCancels.set(id, (why) => {
        clear();
        reject(new HttpError(409, why));
      });
    });
  }

  private wakeSimQueue(): void {
    for (const wake of [...this.simWakers]) wake();
  }

  /** Ends this env's wait for a simulated worker, if it has one: its boot fails with `why` and nothing else changes. */
  cancelQueued(id: string, why = "stopped while waiting for a free simulated worker"): void {
    this.simCancels.get(id)?.(why);
  }

  /** Other VMs whose VMM is up (running, or still shutting down), least recently used first. */
  private runningVms(exceptId: string): EnvRow[] {
    return this.store
      .all<EnvRow>("SELECT * FROM envs WHERE type = 'vm' AND id != ? ORDER BY COALESCE(last_used_at, created_at)", exceptId)
      .filter((r) => {
        const rt = this.runtimes.get(r.id);
        return !!rt && (rt.holdsVmm?.() ?? rt.isRunning());
      });
  }

  /**
   * Under the boot lock: the other VMs that take a slot. A VM being stopped keeps its slot until its VMM has closed
   * (the guest sync alone can take 10 s); with every slot taken and some closing, wait for the first of them to free
   * its slot, then count again. Closing a VM never needs the boot lock, so this wait can't deadlock.
   */
  private async vmSlots(exceptId: string): Promise<EnvRow[]> {
    for (;;) {
      const up = this.runningVms(exceptId);
      const closing = up.map((r) => this.runtimes.get(r.id)!).filter((rt) => !rt.isRunning());
      if (up.length < MAX_RUNNING_VMS || !closing.length) return up;
      await Promise.race(closing.map((rt) => rt.vmmClosed?.() ?? Promise.resolve()));
    }
  }

  /** Up and used by nothing (no session run, shell command or eval case), so it may be stopped to make room. */
  private idleVm(r: EnvRow): boolean {
    return r.status === "running" && this.uses(r.id).length === 0;
  }

  /**
   * Run `fn` (a snapshot or a restore; a VM is stopped for either) and start the env again afterwards if it was
   * running. A VM holds the boot lock from before it goes down until it is back, so no other VM can take its slot
   * meanwhile, and the restart counts running VMs like any boot. Callers hold the env's mutex. The caller gets fn's
   * result or error; a failed restart leaves the env in error.
   */
  private async keepRunning<T>(row: EnvRow, rt: EnvRuntime, fn: () => Promise<T>): Promise<T> {
    if (!rt.isRunning()) return fn();
    const restart = async () => {
      if (!rt.isRunning()) {
        try {
          if (row.type === "vm" && (await this.vmSlots(row.id)).length >= MAX_RUNNING_VMS) throw new Error(`${MAX_RUNNING_VMS} other VMs are running`);
          await rt.start();
        } catch (err) {
          log.warn(`restart of ${row.id} failed`, err);
          this.setStatus(row.id, "error", `restart failed: ${errorMessage(err)}`);
          return;
        }
      }
      this.setStatus(row.id, this.active.has(row.id) ? "busy" : "running");
    };
    const run = async () => {
      try {
        return await fn();
      } finally {
        await restart();
      }
    };
    return row.type === "vm" ? this.vmBoot.run("vm", run) : run();
  }

  /**
   * Write files as the agent into a fresh env through the managed start/stop (VM cap). The env's mutex is held
   * throughout, so making room for another VM can't stop it halfway through.
   */
  private async seed(id: string, rt: EnvRuntime, files: { path: string; content: string }[]): Promise<void> {
    await this.mutex.run(id, async () => {
      await this.startUnlocked(id);
      try {
        for (const f of files) await rt.writeFile(f.path, f.content, { as: "agent" });
      } finally {
        await this.stopUnlocked(id);
      }
    });
  }

  private async refreshFacts(id: string, rt: EnvRuntime): Promise<void> {
    try {
      const facts = await rt.facts();
      this.store.run("UPDATE envs SET facts_json = ? WHERE id = ?", JSON.stringify(facts), id);
      this.broadcast(id);
    } catch (err) {
      log.warn(`facts for ${id} failed`, err);
    }
  }

  async stop(id: string): Promise<EnvSummary> {
    this.cancelQueued(id);
    await this.mutex.run(id, () => {
      this.assertIdle(id);
      return this.stopUnlocked(id);
    });
    return this.get(id);
  }

  /** Callers that may meet a session still using the env wind it down first (releaseStorage). */
  private async stopUnlocked(id: string, detail?: string): Promise<void> {
    const row = this.row(id);
    const rt = this.runtimes.get(id);
    if (!rt || !rt.isRunning()) {
      if (row.status !== "stopped") this.setStatus(id, "stopped", detail ?? null);
      return;
    }
    this.setStatus(id, "stopping");
    try {
      await rt.stop();
      this.sizes.delete(id);
      this.setStatus(id, "stopped", detail ?? null);
    } catch (err) {
      this.setStatus(id, "error", `stop failed: ${errorMessage(err)}`);
      throw err;
    }
  }

  async reset(id: string, snapshotId?: string): Promise<EnvSummary> {
    await this.mutex.run(id, async () => {
      const row = this.row(id);
      const target = snapshotId ?? row.factory_snapshot_id ?? row.base_snapshot_id;
      if (!target) throw new HttpError(409, "environment has no base snapshot to reset to");
      const snap = this.snapshotRow(target);
      this.assertIdle(id);
      const rt = await this.runtimeFor(row);
      const wasRunning = rt.isRunning();
      await this.keepRunning(row, rt, async () => {
        await this.stopUnlocked(id);
        await rt.restore(snap.path);
        if (wasRunning) this.setStatus(id, "starting");
      });
      this.bump(id);
      this.manifests.delete(id);
      this.sizes.delete(id);
      if (wasRunning) {
        if (rt.isRunning()) await this.refreshFacts(id, rt);
      } else {
        this.store.run("UPDATE envs SET facts_json = NULL WHERE id = ?", id);
        this.broadcast(id);
      }
    });
    return this.get(id);
  }

  async snapshot(id: string, label?: string, kind: Snapshot["kind"] = "manual"): Promise<Snapshot> {
    return this.mutex.run(id, async () => {
      const row = this.row(id);
      this.assertIdle(id);
      const rt = await this.runtimeFor(row);
      // A running VM is stopped for the copy; keepRunning boots it again under the VM cap.
      const snap = await this.keepRunning(row, rt, () => this.takeSnapshot(id, rt, kind, label?.trim() || new Date().toISOString().replace("T", " ").slice(0, 19)));
      this.broadcast(id);
      return snap;
    });
  }

  async fork(
    sourceId: string,
    opts: { name?: string; snapshotId?: string; network?: NetworkMode; seedFiles?: { path: string; content: string }[] },
    createOpts: { ephemeral?: boolean; id?: string } = {},
  ): Promise<EnvSummary> {
    this.assertDisk();
    const src = this.row(sourceId);
    const driver = this.driver(src.type);
    const snap = opts.snapshotId ? this.snapshotRow(opts.snapshotId) : await this.snapshot(sourceId, `fork ${new Date().toISOString().slice(0, 19)}`, "auto").then((s) => this.snapshotRow(s.id));
    this.assertDisk(snap.bytes);
    if (snap.env_id !== sourceId) throw new HttpError(400, "snapshot belongs to another environment");
    const id = createOpts.id ?? newId(src.type === "vm" ? "vm" : "sim");
    const network = opts.network ?? src.network;
    const now = Date.now();
    this.store.run(
      "INSERT INTO envs (id, name, type, status, status_detail, network, parent_env_id, base_snapshot_id, factory_snapshot_id, config_json, ephemeral, created_at, last_used_at) VALUES (?, ?, ?, 'starting', 'forking', ?, ?, ?, ?, ?, ?, ?, ?)",
      id,
      opts.name?.trim() || `${src.name} (fork)`,
      src.type,
      network,
      sourceId,
      snap.id,
      snap.id,
      src.config_json,
      createOpts.ephemeral ? 1 : 0,
      now,
      now,
    );
    this.broadcast(id);
    try {
      const cfg = this.config(src);
      const rt = await driver.create({ id, dir: this.envDir(id), network, ...cfg, fromSnapshotDir: snap.path });
      this.attach(id, rt);
      if (opts.seedFiles?.length) await this.seed(id, rt, opts.seedFiles);
      this.setStatus(id, "stopped");
    } catch (err) {
      this.setStatus(id, "error", `fork failed: ${errorMessage(err)}`);
      throw err;
    }
    return this.get(id);
  }

  async update(id: string, patch: { name?: string; network?: NetworkMode }): Promise<EnvSummary> {
    const row = this.row(id);
    if (patch.name !== undefined) {
      if (!patch.name.trim()) throw new HttpError(400, "name cannot be empty");
      this.store.run("UPDATE envs SET name = ? WHERE id = ?", patch.name.trim(), id);
    }
    if (patch.network !== undefined) {
      if (!NETWORK_MODES.has(patch.network)) throw new HttpError(400, "invalid network mode");
      this.assertNotEvalOwned(id);
      this.store.run("UPDATE envs SET network = ? WHERE id = ?", patch.network, id);
      if (!row.released) await (await this.runtimeFor(row)).setNetwork(patch.network);
    }
    this.broadcast(id);
    return this.get(id);
  }

  async delete(id: string): Promise<void> {
    this.cancelQueued(id);
    await this.mutex.run(id, async () => {
      const row = this.row(id);
      this.assertIdle(id);
      await this.stopUnlocked(id).catch((err) => log.warn(`stop before delete failed for ${id}`, err));
      if (!row.released) {
        const rt = await this.runtimeFor(row).catch(() => null);
        await rt?.destroy();
      }
      rmSync(this.envDir(id), { recursive: true, force: true });
      this.unsubNet.get(id)?.();
      this.unsubNet.delete(id);
      this.runtimes.delete(id);
      // Keep snapshots another env was forked from (its reset target).
      for (const s of this.store.all<SnapshotRow>("SELECT * FROM snapshots WHERE env_id = ?", id)) {
        const used = this.store.get("SELECT id FROM envs WHERE id != ? AND (base_snapshot_id = ? OR factory_snapshot_id = ?)", id, s.id, s.id);
        if (used) continue;
        rmSync(s.path, { recursive: true, force: true });
        this.store.run("DELETE FROM snapshots WHERE id = ?", s.id);
      }
      this.store.run("DELETE FROM envs WHERE id = ?", id);
      this.manifests.delete(id);
      this.hub.broadcast({ type: "env_deleted", envId: id });
    });
    this.hooks.onDeleted?.(id);
  }

  /** Ephemeral eval forks: destroy storage after the case; trace, manifests and blobs stay. */
  async releaseStorage(id: string): Promise<void> {
    this.cancelQueued(id);
    await this.mutex.run(id, async () => {
      const row = this.row(id);
      if (row.released) return;
      const sessionId = this.active.get(id);
      if (sessionId) await this.hooks.onEnvInterrupted?.(id, sessionId);
      await this.stopUnlocked(id).catch(() => {});
      const rt = this.runtimes.get(id) ?? (await this.runtimeFor(row).catch(() => null));
      await rt?.destroy().catch((err) => log.warn(`destroy ${id} failed`, err));
      this.unsubNet.get(id)?.();
      this.unsubNet.delete(id);
      this.runtimes.delete(id);
      this.manifests.delete(id);
      this.store.run("UPDATE envs SET released = 1, status = 'stopped', status_detail = NULL WHERE id = ?", id);
      this.sizes.set(id, 0);
      this.broadcast(id);
    });
  }

  async stopAll(): Promise<void> {
    for (const id of [...this.simCancels.keys()]) this.cancelQueued(id, "the app is shutting down");
    await Promise.all(
      [...this.runtimes.entries()].map(async ([id, rt]) => {
        if (!rt.isRunning()) return;
        try {
          await rt.stop();
          this.store.run("UPDATE envs SET status = 'stopped', status_detail = NULL WHERE id = ?", id);
        } catch (err) {
          log.warn(`stop ${id} on shutdown failed`, err);
        }
      }),
    );
    this.flushNetRepeats();
  }

  // ---------- use by sessions / user shell ----------

  /** Running runtime for a session; marks the env busy until release(). */
  async acquire(id: string, sessionId: string, onQueued?: (detail: string) => void): Promise<EnvRuntime> {
    const holder = this.active.get(id);
    if (holder && holder !== sessionId) throw new HttpError(409, `environment is busy with session ${holder}`);
    this.assertNotEvalOwned(id, sessionId);
    this.active.set(id, sessionId);
    if (onQueued) this.queuedNotes.set(id, onQueued);
    try {
      await this.start(id);
    } catch (err) {
      this.active.delete(id);
      throw err;
    } finally {
      this.queuedNotes.delete(id);
    }
    this.touch(id);
    const rt = this.runtimes.get(id)!;
    this.setStatus(id, "busy", null);
    return rt;
  }

  release(id: string, sessionId: string): void {
    if (this.active.get(id) !== sessionId) return;
    this.active.delete(id);
    this.networkBuckets.delete(sessionId);
    this.touch(id);
    this.sizes.delete(id);
    if (!this.exists(id)) return;
    const rt = this.runtimes.get(id);
    const detail = this.budgetDetails.get(id) ?? null;
    this.setStatus(id, rt?.isRunning() ? "running" : "stopped", detail);
  }

  activeSession(id: string): string | undefined {
    return this.active.get(id);
  }

  /** Throws the 409 acquire() would, so a run that can't get the env is refused before it starts. */
  assertUsableBy(id: string, sessionId: string): void {
    const holder = this.active.get(id);
    if (holder && holder !== sessionId) throw new HttpError(409, `environment is busy with session ${holder}`);
    this.assertNotEvalOwned(id, sessionId);
  }

  /** Running runtimes, for the resource sampler. */
  running(): { id: string; runtime: EnvRuntime }[] {
    return [...this.runtimes.entries()].filter(([, rt]) => rt.isRunning()).map(([id, runtime]) => ({ id, runtime }));
  }

  /**
   * Host-side guard, called every second even with no UI connected. RSS includes WASM and external allocations;
   * cumulative CPU comes from ps, so a busy-loop worker cannot hide behind V8's heap limit.
   */
  async enforceBudgets(stats?: Map<string, { rssBytes: number; cpuPct: number; cpuTimeMs?: number }>): Promise<void> {
    const cfg = this.budgets.get();
    let free = Number.MAX_SAFE_INTEGER;
    try {
      free = this.budgets.freeDiskBytes();
    } catch (err) {
      log.warn("checking host disk reserve failed", err);
    }
    if (free < cfg.hostFreeDiskReserveBytes) {
      if (!this.diskReserveTripped) {
        this.diskReserveTripped = true;
        const reason = `Host disk reserve reached. Terrarium stopped environment work to keep ${Math.round(cfg.hostFreeDiskReserveBytes / 1073741824)} GiB free.`;
        await Promise.all(this.running().map(({ id, runtime }) => this.terminateForBudget(id, runtime, "host_disk", reason, cfg.hostFreeDiskReserveBytes, free, "bytes")));
      }
      return;
    }
    if (free > cfg.hostFreeDiskReserveBytes + 512 * 1024 * 1024) this.diskReserveTripped = false;

    for (const { id, runtime } of this.running()) {
      if (runtime.type !== "sim") continue;
      const r = stats?.get(id) ?? (await runtime.resources().catch(() => null));
      if (!r) continue;
      if (r.rssBytes > cfg.simWorkerRssBytes) {
        const reason = `Simulated environment stopped after using more than ${Math.round(cfg.simWorkerRssBytes / 1048576)} MiB of memory.`;
        await this.terminateForBudget(id, runtime, "sim_rss", reason, cfg.simWorkerRssBytes, r.rssBytes, "bytes");
      } else if ((r.cpuTimeMs ?? 0) > cfg.simWorkerCpuMs) {
        const reason = `Simulated environment stopped after using more than ${Math.round(cfg.simWorkerCpuMs / 60000)} minutes of CPU time.`;
        await this.terminateForBudget(id, runtime, "sim_cpu", reason, cfg.simWorkerCpuMs, r.cpuTimeMs ?? 0, "milliseconds");
      }
    }
  }

  private async terminateForBudget(
    envId: string,
    runtime: EnvRuntime,
    budget: "host_disk" | "sim_rss" | "sim_cpu",
    reason: string,
    limit: number,
    observed: number,
    unit: "bytes" | "milliseconds",
  ): Promise<void> {
    if (!runtime.isRunning()) return;
    this.budgetDetails.set(envId, reason);
    const sessionId = this.active.get(envId);
    if (sessionId) this.budgets.externalTrip({ sessionId, envId, scope: budget === "host_disk" ? "host" : "environment", budget, reason, limit, observed, unit });
    try {
      if (runtime.terminate) await runtime.terminate(reason);
      else await runtime.stop();
    } catch (err) {
      log.warn(`terminating ${envId} after ${budget} limit failed`, err);
    }
    this.setStatus(envId, "stopped", reason);
  }

  cachedManifest(id: string): { manifest: Manifest; version: number } | null {
    const m = this.manifests.get(id);
    return m ? { manifest: m, version: this.versions.get(id) ?? 0 } : null;
  }

  setCachedManifest(id: string, manifest: Manifest): void {
    this.manifests.set(id, manifest);
  }

  version(id: string): number {
    return this.versions.get(id) ?? 0;
  }

  private bump(id: string): void {
    this.versions.set(id, (this.versions.get(id) ?? 0) + 1);
  }

  /** Runtime for read-only inspection (file viewer, live tree); starts the env if needed. */
  async inspect(id: string): Promise<EnvRuntime | null> {
    const row = this.row(id);
    if (row.released) return null;
    const rt = await this.runtimeFor(row);
    return rt.isRunning() ? rt : null;
  }

  /**
   * User shell command. The env counts as in use from before its start until the command is done, so making room for
   * another VM skips it and lifecycle ops are refused; no lock is held meanwhile, so short operations aren't queued
   * behind a long command.
   */
  async exec(id: string, req: ExecRequest): Promise<ExecResult> {
    if (typeof req.command !== "string" || !req.command.trim()) throw new HttpError(400, "command is required");
    this.row(id);
    this.assertNotEvalOwned(id);
    this.shells.set(id, (this.shells.get(id) ?? 0) + 1);
    this.broadcast(id);
    try {
      return await this.execUnmarked(id, req);
    } finally {
      const n = (this.shells.get(id) ?? 1) - 1;
      if (n > 0) this.shells.set(id, n);
      else this.shells.delete(id);
      this.broadcast(id);
    }
  }

  private async execUnmarked(id: string, req: ExecRequest): Promise<ExecResult> {
    this.assertDisk();
    const as = req.as === "root" ? "root" : "agent";
    await this.start(id);
    const rt = this.runtimes.get(id)!;
    const before = this.manifests.get(id) ?? (await rt.manifest("/workspace").catch(() => null));
    const ts = Date.now();
    const r = await rt.exec(req.command, { as, timeoutMs: Math.min(Math.max(req.timeoutMs ?? 120_000, 1000), 600_000) });
    this.touch(id);
    this.bump(id);
    this.store.run(
      "INSERT INTO user_exec (id, env_id, ts, as_user, command, exit_code, duration_ms, stdout_blob, stderr_blob) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      newId("uexec"),
      id,
      ts,
      as,
      req.command,
      r.exitCode,
      r.durationMs,
      this.store.blobs.put(r.stdout),
      this.store.blobs.put(r.stderr),
    );
    try {
      const after = await rt.manifest("/workspace", before ? { previous: before } : undefined);
      this.manifests.set(id, after);
      if (before) {
        const changes: FileChange[] = diffManifests(before, after);
        if (changes.length) this.hub.broadcast({ type: "env_fs", envId: id, changes });
      }
    } catch (err) {
      log.warn(`manifest after user exec failed for ${id}`, err);
    }
    return { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr, durationMs: r.durationMs, truncated: r.truncated };
  }
}
