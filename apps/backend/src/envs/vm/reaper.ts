// VMM processes (the krun runner, or QEMU) must not outlive the backend that started them. A VMM is a plain child
// process, so when the backend is SIGKILLed (and the app shell with it, so nobody reaps its process group) the VMM is
// reparented to launchd and keeps the VM running until reboot. Two layers:
// - A guard per running VM: /bin/sh blocked reading a pipe only the backend holds. EOF (the backend died, however it
//   died) makes it stop the VMM: SIGTERM, then SIGKILL after 3 s. The backend kills the guard when it stops the VM.
// - A record per VMM in <data>/run/vmm: at startup the backend stops VMMs whose backend is gone, which covers a guard
//   that was killed too and a backend that died mid-boot before the guard was armed.
// A pid is only signalled while its start time and full command line still match what was recorded, so a reused pid
// is never hit. A record whose backend is still alive (another instance on the same data dir) is left alone.

import { execFile, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { logger } from "../../util/log.ts";

const log = logger("vmm");
const execFileP = promisify(execFile);
const TERM_GRACE_MS = 3000;

/** `ps` line naming a process: start time and full command line. Null when no such process. */
export async function procIdentity(pid: number): Promise<string | null> {
  if (!Number.isInteger(pid) || pid <= 1) return null;
  try {
    const { stdout } = await execFileP("/bin/ps", ["-ww", "-o", "lstart=", "-o", "command=", "-p", String(pid)], { env: { LC_ALL: "C" } });
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
  identity: string;
  envId: string;
  owner: { pid: number; identity: string | null };
  armedAt: number;
}

const GUARD_SCRIPT = `# terrarium VMM guard
same() { [ "$(/bin/ps -ww -o lstart= -o command= -p "$1" 2>/dev/null)" = "$TERRARIUM_VMM_IDENTITY" ]; }
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

  /** Watch VMM `pid` (spawned by this process) and record it in `dir`. */
  static async arm(pid: number, envId: string, dir: string): Promise<VmmGuard | null> {
    const self = await selfIdentity();
    let identity: string | null = null;
    // Right after the spawn the child can still be a fork of this process that hasn't exec'd yet.
    for (let i = 0; i < 50; i++) {
      identity = await procIdentity(pid);
      if (!identity || !self || identity.slice(24).trim() !== self.slice(24).trim()) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    if (!identity) return null; // already gone
    const child = spawn("/bin/sh", ["-c", GUARD_SCRIPT, "terrarium-vmm-guard", String(pid)], {
      stdio: ["pipe", "ignore", "ignore"], // never the backend's stdout: the app shell reads EOF there as our exit
      env: { PATH: "/usr/bin:/bin", LC_ALL: "C", TERRARIUM_VMM_IDENTITY: identity },
    });
    child.on("error", (err) => log.warn(`guard for VMM ${pid} failed`, err));
    child.stdin?.on("error", () => {});
    child.unref();
    (child.stdin as unknown as { unref?: () => void } | null)?.unref?.();
    let file: string | null = path.join(dir, `${pid}.json`);
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const rec: VmmRecord = { pid, identity, envId, owner: { pid: process.pid, identity: self }, armedAt: Date.now() };
      fs.writeFileSync(file, JSON.stringify(rec), { mode: 0o600 });
    } catch (err) {
      log.warn(`recording VMM ${pid} failed`, err);
      file = null;
    }
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

/**
 * Arm a guard as soon as the VMM process exists. `getPid` is polled until it returns a pid or `until` (the VM's start)
 * settles, so a backend that dies mid-boot still takes its VMM down.
 */
export async function guardWhenSpawned(getPid: () => number | null, until: Promise<unknown>, envId: string, dir: string): Promise<VmmGuard | null> {
  let settled = false;
  const done = until.then(
    () => (settled = true),
    () => (settled = true),
  );
  for (;;) {
    const pid = getPid();
    if (pid !== null) return VmmGuard.arm(pid, envId, dir);
    if (settled) return null;
    await Promise.race([done, new Promise((r) => setTimeout(r, 20))]);
  }
}

async function terminate(pid: number, identity: string): Promise<boolean> {
  const same = async () => (await procIdentity(pid)) === identity;
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
        if (!Number.isInteger(rec.pid) || typeof rec.identity !== "string" || !rec.owner) throw new Error("malformed");
      } catch {
        fs.rmSync(file, { force: true });
        return false;
      }
      // Its backend is alive. Without a recorded identity, any process on that pid counts as alive.
      if (rec.owner.identity ? (await procIdentity(rec.owner.pid)) === rec.owner.identity : (await procIdentity(rec.owner.pid)) !== null) return false;
      let hit = false;
      if ((await procIdentity(rec.pid)) === rec.identity) {
        log.warn(`stopping VM ${rec.envId}: its VMM (pid ${rec.pid}) outlived backend pid ${rec.owner.pid}`);
        hit = await terminate(rec.pid, rec.identity);
      }
      // Stopped now or by its guard: either way that VMM is gone and nobody else uses its uniquely named config.
      const cfg = leftoverRunnerConfig(rec.identity);
      if (cfg) fs.rmSync(cfg, { force: true });
      fs.rmSync(file, { force: true });
      return hit;
    }),
  );
  return stopped.filter(Boolean).length;
}
