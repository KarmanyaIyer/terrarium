// VMM processes (the krun runner, or QEMU) must not outlive the backend that started them. A VMM is a plain child
// process, so when the backend is SIGKILLed (and the app shell with it, so nobody reaps its process group) the VMM is
// reparented to launchd and keeps the VM running until reboot. Two layers:
// - A guard per running VM: /bin/sh blocked reading a pipe only the backend holds. EOF (the backend died, however it
//   died) makes it stop the VMM: SIGTERM, then SIGKILL after 3 s. The backend kills the guard when it stops the VM.
// - A record per VMM in <data>/run/vmm: at startup the backend stops VMMs whose backend is gone, which covers a guard
//   that was killed too and a backend that died mid-boot before the guard was armed.
// A pid is only signalled while its start time and full command line still match what was recorded, so a reused pid
// is never hit. Start times are read in UTC, so a change of the Mac's timezone doesn't make a match fail. A record
// whose backend is still alive (another instance on the same data dir) is left alone. The first record is written the
// moment the pid is known, before the `ps` calls that prove its identity (see pidOnlyIsOurs for how it is reaped).

import { execFile, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { logger } from "../../util/log.ts";

const log = logger("vmm");
const execFileP = promisify(execFile);
const TERM_GRACE_MS = 3000;
/** How often a booting VM is checked for its VMM pid: the window in which a dying backend leaves no record. */
const SPAWN_POLL_MS = 5;
const PS_ENV = { LC_ALL: "C", TZ: "UTC0" };

/**
 * `ps` line naming a process: start time (UTC) and full command line. Null when no such process. `localTime` reads
 * the start time in the Mac's timezone, as records written before start times were pinned to UTC have it.
 */
export async function procIdentity(pid: number, opts: { localTime?: boolean } = {}): Promise<string | null> {
  if (!Number.isInteger(pid) || pid <= 1) return null;
  try {
    const { stdout } = await execFileP("/bin/ps", ["-ww", "-o", "lstart=", "-o", "command=", "-p", String(pid)], { env: opts.localTime ? { LC_ALL: "C" } : PS_ENV });
    const line = stdout.replace(/\n+$/, "");
    return line || null;
  } catch {
    return null; // ps exits 1 when the pid is gone
  }
}

let ownIdentity: Promise<string | null> | null = null;
const selfIdentity = () => (ownIdentity ??= procIdentity(process.pid));

interface VmmRecord {
  pid: number;
  /** procIdentity of the VMM. Absent from the first record, written before it was known (pidOnlyIsOurs). */
  identity?: string;
  envId: string;
  owner: { pid: number; identity: string | null };
  armedAt: number;
  /** Start times in identities are UTC; records without it have local time. */
  tz?: "UTC0";
  /** First record: the VMM was spawned after `since` and was running when its pid was seen at `seenAt` (ms). */
  since?: number;
  seenAt?: number;
  vmm?: "krun" | "qemu";
  /** The env's disk image, which a QEMU command line names. */
  disk?: string;
}

/** What the driver knows about a VMM it is about to spawn. */
export interface VmmSpawn {
  envId: string;
  dir: string;
  /** Taken before the VM's start was called. */
  since: number;
  vmm: "krun" | "qemu";
  disk: string;
}

/** Exported for tests. The timezone is pinned in the script itself, whatever the environment it runs in says. */
export const GUARD_SCRIPT = `# terrarium VMM guard
same() { [ "$(TZ=UTC0 LC_ALL=C /bin/ps -ww -o lstart= -o command= -p "$1" 2>/dev/null)" = "$TERRARIUM_VMM_IDENTITY" ]; }
read -r _ || true
same "$1" || exit 0
kill -TERM "$1" 2>/dev/null
i=0
while [ "$i" -lt 30 ] && same "$1"; do sleep 0.1; i=$((i + 1)); done
same "$1" && kill -KILL "$1" 2>/dev/null
exit 0
`;

export class VmmGuard {
  readonly pid: number;
  private child: ChildProcess | null;
  private record: string | null;

  private constructor(pid: number, child: ChildProcess, record: string | null) {
    this.pid = pid;
    this.child = child;
    this.record = record;
  }

  /** Watch VMM `pid` (spawned by this process) and record it in `dir`, replacing a first, pid-only record. */
  static async arm(pid: number, envId: string, dir: string): Promise<VmmGuard | null> {
    const self = await selfIdentity();
    let identity: string | null = null;
    // Right after the spawn the child can still be a fork of this process that hasn't exec'd yet.
    for (let i = 0; i < 50; i++) {
      identity = await procIdentity(pid);
      if (!identity || !self || identity.slice(24).trim() !== self.slice(24).trim()) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    if (!identity) {
      fs.rmSync(path.join(dir, `${pid}.json`), { force: true }); // already gone
      return null;
    }
    const child = spawn("/bin/sh", ["-c", GUARD_SCRIPT, "terrarium-vmm-guard", String(pid)], {
      stdio: ["pipe", "ignore", "ignore"], // never the backend's stdout: the app shell reads EOF there as our exit
      env: { PATH: "/usr/bin:/bin", ...PS_ENV, TERRARIUM_VMM_IDENTITY: identity },
    });
    child.on("error", (err) => log.warn(`guard for VMM ${pid} failed`, err));
    child.stdin?.on("error", () => {});
    child.unref();
    (child.stdin as unknown as { unref?: () => void } | null)?.unref?.();
    const file = writeRecord(dir, { pid, identity, envId, owner: { pid: process.pid, identity: self }, armedAt: Date.now(), tz: "UTC0" });
    return new VmmGuard(pid, child, file);
  }

  /** The VMM was stopped on purpose (or is gone): drop the guard and the record. */
  disarm(): void {
    this.child?.kill("SIGKILL");
    this.child = null;
    if (this.record) fs.rmSync(this.record, { force: true });
    this.record = null;
  }
}

/** Write a record atomically (a torn file would read as malformed and be dropped). Returns its path. */
function writeRecord(dir: string, rec: VmmRecord): string | null {
  const file = path.join(dir, `${rec.pid}.json`);
  const tmp = path.join(dir, `.${rec.pid}.json.tmp`);
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(tmp, JSON.stringify(rec), { mode: 0o600 });
    fs.renameSync(tmp, file);
    return file;
  } catch (err) {
    log.warn(`recording VMM ${rec.pid} failed`, err);
    return null;
  }
}

/**
 * Arm a guard as soon as the VMM process exists. `getPid` is polled until it returns a pid or `until` (the VM's start)
 * settles, so a backend that dies mid-boot still takes its VMM down. The pid is recorded in the tick it is seen, so a
 * backend killed while the guard is being armed still leaves a record for startup reaping.
 */
export async function guardWhenSpawned(getPid: () => number | null, until: Promise<unknown>, vmm: VmmSpawn): Promise<VmmGuard | null> {
  const self = await selfIdentity(); // cached since startup reaping, so the first poll isn't held up
  let settled = false;
  const done = until.then(
    () => (settled = true),
    () => (settled = true),
  );
  for (;;) {
    const pid = getPid();
    if (pid !== null) {
      const now = Date.now();
      writeRecord(vmm.dir, { pid, envId: vmm.envId, owner: { pid: process.pid, identity: self }, armedAt: now, tz: "UTC0", since: vmm.since, seenAt: now, vmm: vmm.vmm, disk: vmm.disk });
      return VmmGuard.arm(pid, vmm.envId, vmm.dir);
    }
    if (settled) return null;
    await Promise.race([done, new Promise((r) => setTimeout(r, SPAWN_POLL_MS))]);
  }
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Split a UTC identity into its start time (ms, whole seconds) and command line. */
export function parseIdentity(identity: string): { startedAt: number; command: string } | null {
  const m = /^\w{3} (\w{3}) +(\d{1,2}) (\d\d):(\d\d):(\d\d) (\d{4})\s+(.+)$/.exec(identity);
  const month = m ? MONTHS.indexOf(m[1]) : -1;
  if (!m || month < 0) return null;
  return { startedAt: Date.UTC(Number(m[6]), month, Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5])), command: m[7] };
}

/**
 * A pid-only record (its backend died while arming the guard) proves nothing about the process now on that pid, so
 * that process counts as ours only when both hold:
 * - its command line is a VMM of the recorded kind: the krun runner with a Gondolin runner config in the temp dir, or
 *   QEMU naming this env's disk;
 * - it started no earlier than `since` (taken before the VM's start was called) and no later than `seenAt` (the pid
 *   was seen, so the VMM had started), compared in whole seconds as `ps` prints them.
 * Two live processes never share a pid. A process on that pid that started by `seenAt` is either the VMM we spawned or
 * one that got the pid after ours exited, within that same second, and is itself a VMM of that kind; macOS hands out
 * pids in order, so a pid only comes round again after tens of thousands of other spawns.
 */
function pidOnlyIsOurs(rec: VmmRecord, identity: string): boolean {
  if (typeof rec.since !== "number" || typeof rec.seenAt !== "number") return false;
  const p = parseIdentity(identity);
  if (!p) return false;
  const sec = (ms: number) => Math.floor(ms / 1000) * 1000;
  if (p.startedAt < sec(rec.since) || p.startedAt > sec(rec.seenAt)) return false;
  if (rec.vmm === "krun") return /^(?:.*\/)?gondolin-krun-runner --config \S+$/.test(p.command) && leftoverRunnerConfig(identity) !== null;
  if (rec.vmm === "qemu") return typeof rec.disk === "string" && path.isAbsolute(rec.disk) && /^(?:\S*\/)?qemu-system-[\w-]+ /.test(p.command) && p.command.includes(` -drive file=${rec.disk},`);
  return false;
}

async function terminate(pid: number, identity: string, opts: { localTime?: boolean }): Promise<boolean> {
  const same = async () => (await procIdentity(pid, opts)) === identity;
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return false;
  }
  for (let waited = 0; waited < TERM_GRACE_MS; waited += 100) {
    await new Promise((r) => setTimeout(r, 100));
    if (!(await same())) return true;
  }
  if (await same()) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }
  return true;
}

/** Gondolin's krun runner config, left in the temp dir when its process didn't exit through Gondolin. */
function leftoverRunnerConfig(identity: string): string | null {
  const m = / --config (\S+)/.exec(identity);
  if (!m) return null;
  const file = path.resolve(m[1]);
  return path.dirname(file) === path.resolve(os.tmpdir()) && /^gondolin-krun-runner-[0-9a-f]{8}\.json$/.test(path.basename(file)) ? file : null;
}

/** Stop VMMs left running by a backend that is gone. Returns how many were stopped. */
export async function reapOrphanVmms(dir: string): Promise<number> {
  void selfIdentity(); // warmed for the first boot's record
  let names: string[];
  try {
    names = fs.readdirSync(dir).filter((n) => /^\d+\.json$/.test(n));
  } catch {
    return 0;
  }
  const stopped = await Promise.all(
    names.map(async (name) => {
      const file = path.join(dir, name);
      let rec: VmmRecord;
      try {
        rec = JSON.parse(fs.readFileSync(file, "utf8")) as VmmRecord;
        if (!Number.isInteger(rec.pid) || !rec.owner || (typeof rec.identity !== "string" && typeof rec.seenAt !== "number")) throw new Error("malformed");
      } catch {
        fs.rmSync(file, { force: true });
        return false;
      }
      const opts = { localTime: rec.tz !== "UTC0" };
      // Its backend is alive. Without a recorded identity, any process on that pid counts as alive.
      const owner = await procIdentity(rec.owner.pid, opts);
      if (rec.owner.identity ? owner === rec.owner.identity : owner !== null) return false;
      let hit = false;
      const now = await procIdentity(rec.pid, opts);
      const ours = now !== null && (typeof rec.identity === "string" ? now === rec.identity : pidOnlyIsOurs(rec, now));
      if (ours) {
        log.warn(`stopping VM ${rec.envId}: its VMM (pid ${rec.pid}) outlived backend pid ${rec.owner.pid}`);
        hit = await terminate(rec.pid, now, opts);
      }
      // Stopped now or by its guard: either way that VMM is gone and nobody else uses its uniquely named config.
      const cfg = rec.identity ? leftoverRunnerConfig(rec.identity) : ours ? leftoverRunnerConfig(now) : null;
      if (cfg) fs.rmSync(cfg, { force: true });
      fs.rmSync(file, { force: true });
      return hit;
    }),
  );
  return stopped.filter(Boolean).length;
}
