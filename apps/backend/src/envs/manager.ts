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
import { HttpError, errorMessage } from "../util/errors.ts";
import { newId } from "../util/ids.ts";
import { logger } from "../util/log.ts";
import { KeyedMutex } from "../util/mutex.ts";
import { diffManifests } from "./manifest-diff.ts";
import { DEFAULT_SIM } from "./sim/driver.ts";
import type { EnvDriver, EnvRuntime, Manifest } from "./types.ts";

const log = logger("envs");
export const MAX_RUNNING_VMS = 2;
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
  /** The env is being stopped/reset/deleted while a session uses it: abort that session's run. */
  onEnvInterrupted?: (envId: string, sessionId: string) => Promise<void>;
}

export class EnvManager {
  private store: Store;
  private hub: Hub;
  private dataDir: string;
  private drivers: Record<EnvType, EnvDriver | null>;
  private runtimes = new Map<string, EnvRuntime>();
  private unsubNet = new Map<string, () => void>();
  private mutex = new KeyedMutex();
  /** One lock across the running-VM count and the boot, so concurrent starts can't exceed MAX_RUNNING_VMS. */
  private vmBoot = new KeyedMutex();
  private active = new Map<string, string>(); // envId -> sessionId using it
  private manifests = new Map<string, Manifest>(); // last known /workspace manifest per env
  private versions = new Map<string, number>(); // bumps when something other than the harness changes the env
  private sizes = new Map<string, number>();
  hooks: EnvHooks = {};

  constructor(opts: { store: Store; hub: Hub; dataDir: string; drivers: Record<EnvType, EnvDriver | null> }) {
    this.store = opts.store;
    this.hub = opts.hub;
    this.dataDir = opts.dataDir;
    this.drivers = opts.drivers;
    // Nothing survives a backend restart: VMs and sim children die with the process.
    this.store.run("UPDATE envs SET status = 'stopped', status_detail = NULL WHERE status IN ('starting', 'running', 'stopping', 'busy')");
  }

  // ---------- reads ----------

  private row(id: string): EnvRow {
    const row = this.store.get<EnvRow>("SELECT * FROM envs WHERE id = ?", id);
    if (!row) throw new HttpError(404, `environment not found: ${id}`);
    return row;
  }

  private toSummary(row: EnvRow): EnvSummary {
    const config = JSON.parse(row.config_json) as { vm?: VmConfig; sim?: SimConfig };
    if (!this.sizes.has(row.id)) this.sizes.set(row.id, dirSize(this.envDir(row.id)));
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
    };
  }

  list(): EnvSummary[] {
    return this.store.all<EnvRow>("SELECT * FROM envs WHERE id NOT LIKE 'evalbase_%' ORDER BY created_at").map((r) => this.toSummary(r));
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

  netLog(id: string, limit = 500): NetEntry[] {
    return this.store
      .all<any>("SELECT * FROM net_log WHERE env_id = ? ORDER BY ts DESC LIMIT ?", id, Math.min(Math.max(limit, 1), 5000))
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
    this.store.run("UPDATE envs SET status = ?, status_detail = ? WHERE id = ?", status, detail, id);
    this.broadcast(id);
  }

  private touch(id: string): void {
    this.store.run("UPDATE envs SET last_used_at = ? WHERE id = ?", Date.now(), id);
  }

  private config(row: EnvRow): { vm?: VmConfig; sim?: SimConfig } {
    return JSON.parse(row.config_json);
  }

  /** Runtime object for an env (opened lazily; not necessarily running). */
  private async runtimeFor(row: EnvRow): Promise<EnvRuntime> {
    let rt = this.runtimes.get(row.id);
    if (rt) return rt;
    if (row.released) throw new HttpError(409, "environment storage was released after its eval run");
    const cfg = this.config(row);
    rt = await this.driver(row.type).open({ id: row.id, dir: this.envDir(row.id), network: row.network, vm: cfg.vm, sim: cfg.sim });
    this.attach(row.id, rt);
    return rt;
  }

  private attach(id: string, rt: EnvRuntime): void {
    this.runtimes.set(id, rt);
    this.unsubNet.get(id)?.();
    this.unsubNet.set(
      id,
      rt.onNet((attempt) => {
        const entry: NetEntry = { ...attempt, id: newId("net"), envId: id, sessionId: this.active.get(id) };
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

  // ---------- lifecycle ----------

  async create(req: CreateEnvRequest, opts: { ephemeral?: boolean; id?: string } = {}): Promise<EnvSummary> {
    if (!req.name?.trim()) throw new HttpError(400, "name is required");
    if (req.type !== "vm" && req.type !== "sim") throw new HttpError(400, "type must be vm or sim");
    const network = req.network ?? "off";
    if (!NETWORK_MODES.has(network)) throw new HttpError(400, "invalid network mode");
    if (req.from) return this.fork("envId" in req.from ? req.from.envId : this.snapshotRow(req.from.snapshotId).env_id, { name: req.name, snapshotId: "snapshotId" in req.from ? req.from.snapshotId : undefined, network, seedFiles: req.seedFiles }, opts);
    const driver = this.driver(req.type);
    const id = opts.id ?? newId(req.type === "vm" ? "vm" : "sim");
    const config = req.type === "vm" ? { vm: { ...DEFAULT_VM, ...req.vm } } : { sim: { ...DEFAULT_SIM, ...req.sim } };
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
      const snap = await this.takeSnapshot(id, rt, "factory", "factory");
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
    const snapId = newId("snap");
    const dir = this.snapshotDir(snapId);
    const { bytes } = await rt.snapshot(dir);
    const createdAt = Date.now();
    this.store.run("INSERT INTO snapshots (id, env_id, label, kind, bytes, path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)", snapId, envId, label, kind, bytes, dir, createdAt);
    return { id: snapId, envId, label, kind, bytes, createdAt };
  }

  async start(id: string): Promise<EnvSummary> {
    await this.mutex.run(id, async () => {
      const row = this.row(id);
      const rt = await this.runtimeFor(row);
      if (rt.isRunning()) {
        if (row.status !== "running" && row.status !== "busy") this.setStatus(id, this.active.has(id) ? "busy" : "running");
        return;
      }
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
    });
    return this.get(id);
  }

  /** Boot a runtime; VMs take the global boot lock and make room first. Callers hold the env's mutex. */
  private async boot(row: EnvRow, rt: EnvRuntime): Promise<void> {
    if (row.type !== "vm") return rt.start();
    await this.vmBoot.run("vm", async () => {
      await this.makeRoomForVm(row.id);
      await rt.start();
    });
  }

  /** Write files as the agent into a fresh env through the managed start/stop (VM cap and env mutex). */
  private async seed(id: string, rt: EnvRuntime, files: { path: string; content: string }[]): Promise<void> {
    await this.start(id);
    try {
      for (const f of files) await rt.writeFile(f.path, f.content, { as: "agent" });
    } finally {
      await this.mutex.run(id, () => this.stopUnlocked(id));
    }
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

  /** At most MAX_RUNNING_VMS VMs run; starting another stops the least recently used idle one. */
  private async makeRoomForVm(startingId: string): Promise<void> {
    const running = this.store
      .all<EnvRow>("SELECT * FROM envs WHERE type = 'vm' AND id != ? ORDER BY COALESCE(last_used_at, created_at)", startingId)
      .filter((r) => this.runtimes.get(r.id)?.isRunning());
    if (running.length < MAX_RUNNING_VMS) return;
    const idle = running.filter((r) => r.status === "running" && !this.active.has(r.id));
    const excess = running.length - MAX_RUNNING_VMS + 1;
    if (idle.length < excess) throw new HttpError(409, `${MAX_RUNNING_VMS} VMs are already running sessions; stop one first`);
    for (const r of idle.slice(0, excess)) {
      log.info(`stopping idle VM ${r.id} to make room for ${startingId}`);
      await this.stopUnlocked(r.id, "stopped to make room for another VM");
    }
  }

  async stop(id: string): Promise<EnvSummary> {
    await this.mutex.run(id, () => this.stopUnlocked(id));
    return this.get(id);
  }

  private async stopUnlocked(id: string, detail?: string): Promise<void> {
    const row = this.row(id);
    const sessionId = this.active.get(id);
    if (sessionId) await this.hooks.onEnvInterrupted?.(id, sessionId);
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
      const rt = await this.runtimeFor(row);
      const wasRunning = rt.isRunning();
      await this.stopUnlocked(id);
      await rt.restore(snap.path);
      this.bump(id);
      this.manifests.delete(id);
      this.sizes.delete(id);
      if (wasRunning) {
        this.setStatus(id, "starting");
        await this.boot(row, rt);
        this.setStatus(id, "running");
        await this.refreshFacts(id, rt);
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
      const rt = await this.runtimeFor(row);
      const snap = await this.takeSnapshot(id, rt, kind, label?.trim() || new Date().toISOString().replace("T", " ").slice(0, 19));
      this.broadcast(id);
      return snap;
    });
  }

  async fork(
    sourceId: string,
    opts: { name?: string; snapshotId?: string; network?: NetworkMode; seedFiles?: { path: string; content: string }[] },
    createOpts: { ephemeral?: boolean; id?: string } = {},
  ): Promise<EnvSummary> {
    const src = this.row(sourceId);
    const driver = this.driver(src.type);
    const snap = opts.snapshotId ? this.snapshotRow(opts.snapshotId) : await this.snapshot(sourceId, `fork ${new Date().toISOString().slice(0, 19)}`, "auto").then((s) => this.snapshotRow(s.id));
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
      this.store.run("UPDATE envs SET network = ? WHERE id = ?", patch.network, id);
      if (!row.released) await (await this.runtimeFor(row)).setNetwork(patch.network);
    }
    this.broadcast(id);
    return this.get(id);
  }

  async delete(id: string): Promise<void> {
    await this.mutex.run(id, async () => {
      const row = this.row(id);
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
  }

  /** Ephemeral eval forks: destroy storage after the case; trace, manifests and blobs stay. */
  async releaseStorage(id: string): Promise<void> {
    await this.mutex.run(id, async () => {
      const row = this.row(id);
      if (row.released) return;
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
  }

  // ---------- use by sessions / user shell ----------

  /** Running runtime for a session; marks the env busy until release(). */
  async acquire(id: string, sessionId: string): Promise<EnvRuntime> {
    const holder = this.active.get(id);
    if (holder && holder !== sessionId) throw new HttpError(409, `environment is busy with session ${holder}`);
    this.active.set(id, sessionId);
    try {
      await this.start(id);
    } catch (err) {
      this.active.delete(id);
      throw err;
    }
    this.touch(id);
    const rt = this.runtimes.get(id)!;
    this.setStatus(id, "busy", null);
    return rt;
  }

  release(id: string, sessionId: string): void {
    if (this.active.get(id) !== sessionId) return;
    this.active.delete(id);
    this.touch(id);
    this.sizes.delete(id);
    if (!this.exists(id)) return;
    const rt = this.runtimes.get(id);
    this.setStatus(id, rt?.isRunning() ? "running" : "stopped");
  }

  activeSession(id: string): string | undefined {
    return this.active.get(id);
  }

  /** Running runtimes, for the resource sampler. */
  running(): { id: string; runtime: EnvRuntime }[] {
    return [...this.runtimes.entries()].filter(([, rt]) => rt.isRunning()).map(([id, runtime]) => ({ id, runtime }));
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

  async exec(id: string, req: ExecRequest): Promise<ExecResult> {
    if (typeof req.command !== "string" || !req.command.trim()) throw new HttpError(400, "command is required");
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
