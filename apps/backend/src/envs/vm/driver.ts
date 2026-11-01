// Gondolin micro-VM env driver. Each env owns one qcow2 overlay (<dir>/disk.qcow2) backed by its guest
// image's rootfs.ext4; /workspace lives on that disk. Snapshot, restore and fork are APFS clones of the
// overlay taken while the VM is stopped (disk-only, like Gondolin checkpoints, with no backing chains).
// Agent commands run as uid 1000 through a root launcher in the guest; the observer and its state are
// root-only. No host folders are mounted.

import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import { promisify } from "node:util";
import type { EnvFacts, NetworkMode, VmConfig } from "@terrarium/shared";
import type { MemoryProvider, VM, VMOptions } from "@earendil-works/gondolin";
import type {
  EnvCreateSpec,
  EnvDriver,
  EnvRuntime,
  ExecOptions,
  ExecOutcome,
  Manifest,
  ManifestEntry,
  NetAttempt,
  NetworkGate,
  ReadResult,
} from "../types.ts";
import {
  GONDOLIN_VERSION,
  type ImageInfo,
  dataDir,
  ensurePrivateDir,
  gondolin,
  krunRunnerPresent,
  qemuImgPath,
  qemuPath,
  resolveImage,
  rootfsPath,
} from "./gondolin.ts";
import { REPO_DIR } from "../../config.ts";
import type { LookupAll } from "../../policy/index.ts";
import { SYNTHETIC_DNS_IPV4, VmNetwork } from "./net.ts";
import { type VmmGuard, guardWhenSpawned, reapOrphanVmms as reapIn } from "./reaper.ts";

const execFileP = promisify(execFile);
const vmmRunDir = (): string => path.join(dataDir(), "run", "vmm");

/** At backend startup: stop VMMs a backend that died without stopping its VMs left running. */
export const reapOrphanVmms = (): Promise<number> => reapIn(vmmRunDir());

const LIBEXEC = "/usr/local/libexec/terrarium";
const RUN = `${LIBEXEC}/run`;
const KILL = `${LIBEXEC}/kill`;
const KILL_USER = `${LIBEXEC}/kill-user`;
const PUT = `${LIBEXEC}/put`;
const OBSERVER = `${LIBEXEC}/observer.py`;
const READ = `${LIBEXEC}/read.py`;
const XFER = "/run/terrarium/xfer";
/** Host copy of the guest helpers. Envs made from older images get these pushed in at boot. */
export const HOST_HELPERS_DIR = path.join(REPO_DIR, "guest", "files", "usr", "local", "libexec", "terrarium");
const READ_TIMEOUT_MS = 30_000;
const READ_BATCH_BYTES = 64 << 20;

export const DEFAULT_VM_CONFIG: VmConfig = { cpus: 2, memoryMiB: 1024, diskMiB: 4096, backend: "krun" };

const META_FILE = "env.json";
const DISK_FILE = "disk.qcow2";
const SNAPSHOT_META = "snapshot.json";
const DEFAULT_READ_MAX = 32 << 20;

const BASE_ENV = {
  LANG: "C.UTF-8",
  TERM: "dumb",
  PYTHONUNBUFFERED: "1",
  PIP_DISABLE_PIP_VERSION_CHECK: "1",
  PIP_NO_INPUT: "1",
  GIT_TERMINAL_PROMPT: "0",
  NPM_CONFIG_UPDATE_NOTIFIER: "false",
  NPM_CONFIG_FUND: "false",
};
const AGENT_ENV: Record<string, string> = {
  ...BASE_ENV,
  HOME: "/home/agent",
  USER: "agent",
  LOGNAME: "agent",
  SHELL: "/bin/bash",
  PATH: "/home/agent/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
  NPM_CONFIG_PREFIX: "/home/agent/.local",
};
const ROOT_ENV: Record<string, string> = {
  ...BASE_ENV,
  HOME: "/root",
  USER: "root",
  LOGNAME: "root",
  SHELL: "/bin/bash",
  PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
};

interface EnvMeta {
  version: 1;
  id: string;
  imageId: string;
  vm: VmConfig;
  createdAt: number;
  facts?: EnvFacts;
}

interface SnapshotMeta {
  format: "terrarium-vm-snapshot/1";
  imageId: string;
  sourceEnvId: string;
  createdAt: number;
  diskBytes: number;
  vm: VmConfig;
}

export interface VmDriverOptions {
  /** Mount host-owned in-memory exchange dirs: /inbox (read-only) and /outbox. Default false. */
  exchange?: boolean;
  /** Resolver for policy checks and upstream connects (tests). Default: the system resolver. */
  lookup?: LookupAll;
}

/** Last boot measurements, for the UI and tests. */
export interface BootInfo {
  backend: "krun" | "qemu";
  bootMs: number;
  fellBackFrom?: "krun";
  fallbackError?: string;
}

function readJson<T>(file: string): T {
  return JSON.parse(fs.readFileSync(file, "utf8")) as T;
}

function writeJson(file: string, value: unknown): void {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

let helperCache: { hash: string; files: { name: string; data: Buffer }[] } | null = null;

/** The helper set this backend expects in the guest: every file in the helpers dir, and their sha256 in name order. */
function hostHelpers(): { hash: string; files: { name: string; data: Buffer }[] } {
  if (!helperCache) {
    const names = fs.readdirSync(HOST_HELPERS_DIR).filter((n) => /^[A-Za-z0-9_.-]+$/.test(n) && !n.startsWith(".")).sort();
    const files = names.filter((n) => fs.statSync(path.join(HOST_HELPERS_DIR, n)).isFile()).map((name) => ({ name, data: fs.readFileSync(path.join(HOST_HELPERS_DIR, name)) }));
    if (!files.some((f) => f.name === "setup")) throw new Error(`no setup helper in ${HOST_HELPERS_DIR}`);
    const h = createHash("sha256");
    for (const f of files) h.update(f.data);
    helperCache = { hash: h.digest("hex"), files };
  }
  return helperCache;
}

/** Parses read.py output: per path "ok <size> <n>\n<n bytes>" or "err <json>\n". */
export function parseReadOutput(buf: Buffer, paths: string[]): (ReadResult | Error)[] {
  const out: (ReadResult | Error)[] = [];
  let at = 0;
  for (const p of paths) {
    const nl = buf.indexOf(10, at);
    if (nl < 0) {
      out.push(new Error(`read ${p}: no reply from the guest reader`));
      continue;
    }
    const head = buf.subarray(at, nl).toString("utf8");
    at = nl + 1;
    const ok = /^ok (\d+) (\d+)$/.exec(head);
    if (ok) {
      const size = Number(ok[1]);
      const n = Number(ok[2]);
      const data = new Uint8Array(buf.subarray(at, at + n));
      at += n;
      out.push({ data, size, truncated: size > data.length });
      continue;
    }
    let msg = head.replace(/^err /, "");
    try {
      msg = String(JSON.parse(msg));
    } catch {}
    out.push(new Error(`read ${p}: ${msg}`));
  }
  return out;
}

function cloneFile(src: string, dst: string): void {
  fs.rmSync(dst, { force: true });
  fs.copyFileSync(src, dst, fs.constants.COPYFILE_FICLONE | fs.constants.COPYFILE_EXCL);
}

/** Keeps the first and last half of a stream's bytes; streams decoded text to a callback up to the cap. */
class OutputCapture {
  private readonly headCap: number;
  private readonly tailCap: number;
  private readonly head: Buffer[] = [];
  private headLen = 0;
  private readonly tail: Buffer[] = [];
  private tailLen = 0;
  total = 0;
  private readonly decoder = new StringDecoder("utf8");
  private readonly cap: number;
  private readonly onText?: (chunk: string) => void;
  private streamed = 0;

  constructor(cap: number, onText?: (chunk: string) => void) {
    this.cap = cap;
    this.headCap = Math.ceil(cap / 2);
    this.tailCap = Math.floor(cap / 2);
    this.onText = onText;
  }

  push(chunk: Buffer): void {
    this.total += chunk.length;
    if (this.onText && this.streamed <= this.cap) {
      this.streamed += chunk.length;
      const text = this.decoder.write(chunk);
      if (text) this.onText(text);
      if (this.streamed > this.cap) this.onText(`\n[live output stopped at ${this.cap} bytes; the result keeps head and tail]\n`);
    }
    let rest = chunk;
    if (this.headLen < this.headCap) {
      const take = Math.min(rest.length, this.headCap - this.headLen);
      this.head.push(rest.subarray(0, take));
      this.headLen += take;
      rest = rest.subarray(take);
    }
    if (rest.length > 0) {
      this.tail.push(rest);
      this.tailLen += rest.length;
      while (this.tail.length > 1 && this.tailLen - this.tail[0]!.length >= this.tailCap) this.tailLen -= this.tail.shift()!.length;
    }
  }

  result(): { text: string; truncated: boolean } {
    const head = Buffer.concat(this.head);
    let tail = Buffer.concat(this.tail);
    if (this.total <= this.cap) return { text: Buffer.concat([head, tail]).toString("utf8"), truncated: false };
    tail = tail.subarray(tail.length - this.tailCap);
    const omitted = this.total - head.length - tail.length;
    return { text: `${head.toString("utf8")}\n[... ${omitted} bytes omitted ...]\n${tail.toString("utf8")}`, truncated: true };
  }
}

function parseCpuTime(s: string): number {
  // ps `time`: [[dd-]hh:]mm:ss.cc
  let days = 0;
  let rest = s.trim();
  const dash = rest.indexOf("-");
  if (dash !== -1) {
    days = Number(rest.slice(0, dash));
    rest = rest.slice(dash + 1);
  }
  return rest.split(":").reduce((acc, part) => acc * 60 + Number(part), 0) + days * 86400;
}

export class VmRuntime implements EnvRuntime {
  readonly id: string;
  readonly type = "vm" as const;
  readonly dir: string;
  config: VmConfig;
  /** Set by start(): which backend actually booted and how long it took. */
  lastBoot: BootInfo | null = null;
  readonly inbox: MemoryProvider | null = null;
  readonly outbox: MemoryProvider | null = null;

  private vm: VM | null = null;
  /** Set while shutdown() syncs the guest and closes the VMM; the VM is no longer usable but its VMM still runs. */
  private closing: Promise<void> | null = null;
  /** Stops the VMM if this backend dies without stopping it (reaper.ts). */
  private guard: Promise<VmmGuard | null> | null = null;
  private readonly net: VmNetwork;
  private meta: EnvMeta;
  private chain: Promise<unknown> = Promise.resolve();
  private lastCpu: { cpu: number; at: number } | null = null;
  private readonly exchange: boolean;

  constructor(
    meta: EnvMeta,
    dir: string,
    network: NetworkMode,
    exchange: boolean,
    providers: { inbox: MemoryProvider; outbox: MemoryProvider } | null,
    lookup?: LookupAll,
  ) {
    this.id = meta.id;
    this.dir = dir;
    this.meta = meta;
    this.config = meta.vm;
    this.net = new VmNetwork(network, lookup);
    this.exchange = exchange;
    if (providers) {
      this.inbox = providers.inbox;
      this.outbox = providers.outbox;
    }
  }

  private get diskPath(): string {
    return path.join(this.dir, DISK_FILE);
  }

  private image(): ImageInfo {
    const image = resolveImage(this.meta.imageId);
    if (!image) throw new Error(`guest image ${this.meta.imageId} not found under data/images/objects (run guest/build.sh)`);
    return image;
  }

  /** Lifecycle operations run one at a time. */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => {});
    return run;
  }

  private requireVm(): VM {
    if (!this.vm || this.vm.getHostPid() === null) throw new Error(`env ${this.id} is not running`);
    return this.vm;
  }

  isRunning(): boolean {
    return this.vm !== null && this.vm.getHostPid() !== null;
  }

  holdsVmm(): boolean {
    return this.isRunning() || this.closing !== null;
  }

  async vmmClosed(): Promise<void> {
    await this.closing;
  }

  start(): Promise<void> {
    return this.serial(() => this.boot());
  }

  stop(): Promise<void> {
    return this.serial(() => this.shutdown());
  }

  private async vmOptions(backend: "krun" | "qemu", image: ImageInfo): Promise<VMOptions> {
    const g = await gondolin();
    const mitmDir = path.join(this.dir, "mitm");
    ensurePrivateDir(mitmDir);
    const mounts: NonNullable<NonNullable<VMOptions["vfs"]>["mounts"]> = {};
    if (this.exchange && this.inbox && this.outbox) {
      mounts["/inbox"] = new g.ReadonlyProvider(this.inbox);
      mounts["/outbox"] = this.outbox;
    }
    const qemu = qemuPath();
    if (backend === "qemu" && !qemu) throw new Error("QEMU not found (brew install qemu)");
    return {
      sandbox: {
        vmm: backend,
        imagePath: image.dir,
        ...(backend === "qemu" ? { qemuPath: qemu! } : {}),
        rootDiskPath: this.diskPath,
        rootDiskFormat: "qcow2",
        rootDiskReadOnly: false,
        rootDiskDeleteOnClose: false,
        mitmCertDir: mitmDir,
        debug: ["net"],
      },
      rootfs: { size: `${this.config.diskMiB}M` },
      memory: `${this.config.memoryMiB}M`,
      cpus: this.config.cpus,
      dns: { mode: "synthetic", syntheticIPv4: SYNTHETIC_DNS_IPV4 },
      httpHooks: this.net.httpHooks,
      fetch: this.net.fetch as never,
      allowWebSockets: false,
      maxHttpBodyBytes: 32 << 20,
      // Scratch tmpfs paths use guest RAM; cap them so they can't take the whole VM.
      tmpfs: {
        "/tmp": { size: "25%" },
        "/root": { mode: "0700", size: "5%" },
        "/var/tmp": { size: "10%" },
        "/var/cache": { size: "10%" },
        "/var/log": { size: "5%" },
      },
      vfs: { mounts },
      sessionLabel: `terrarium ${this.id}`,
      startTimeoutMs: 60_000,
      debugLog: (component, message) => {
        if (component === "net") this.net.onDebug(message);
      },
    };
  }

  private async disarmGuard(): Promise<void> {
    const guard = this.guard;
    this.guard = null;
    (await guard?.catch(() => null))?.disarm();
  }

  private async boot(): Promise<void> {
    if (this.isRunning()) return;
    this.vm = null;
    await this.disarmGuard(); // a VMM that exited by itself
    if (!fs.existsSync(this.diskPath)) throw new Error(`env ${this.id} has no disk (${this.diskPath})`);
    const image = this.image();
    const g = await gondolin();
    const order: ("krun" | "qemu")[] = this.config.backend === "krun" ? ["krun", "qemu"] : ["qemu"];
    let fallbackError: string | undefined;
    for (const backend of order) {
      if (backend === "krun" && (!krunRunnerPresent() || !image.hasKrun)) {
        fallbackError = "krun runner or krun kernel missing";
        continue;
      }
      const t0 = performance.now();
      let vm: VM | null = null;
      try {
        vm = await g.VM.create(await this.vmOptions(backend, image));
        this.net.watchStack(vm);
        const created = vm;
        const since = Date.now();
        const starting = vm.start();
        this.guard = guardWhenSpawned(() => created.getHostPid(), starting, { envId: this.id, dir: vmmRunDir(), since, vmm: backend, disk: this.diskPath });
        await starting;
        await this.ensureHelpers(vm);
        this.vm = vm;
        this.lastCpu = null;
        this.lastBoot = {
          backend,
          bootMs: Math.round(performance.now() - t0),
          ...(backend === "qemu" && fallbackError && this.config.backend === "krun" ? { fellBackFrom: "krun" as const, fallbackError } : {}),
        };
        return;
      } catch (err) {
        fallbackError = err instanceof Error ? err.message : String(err);
        if (vm) await vm.close().catch(() => {});
        await this.disarmGuard();
      }
    }
    throw new Error(`env ${this.id} failed to boot: ${fallbackError}`);
  }

  /**
   * Envs keep booting the image they were made from, so an older image can lack helpers, the grader user
   * or the exec cgroups. Push the host's helper set when the guest's copy hashes differently, then rerun
   * the guest setup.
   */
  private async ensureHelpers(vm: VM): Promise<void> {
    const want = hostHelpers();
    const names = want.files.map((f) => f.name).join(" ");
    const probeScript = `id -u agent; id -u grader; (cd ${LIBEXEC} && cat ${names}) | sha256sum | cut -d" " -f1; [ -d /sys/fs/cgroup/terrarium ] && echo cgroups`;
    const probe = async () => {
      const r = await vm.exec(["/bin/sh", "-c", `{ ${probeScript}; } 2>/dev/null; true`], { env: ROOT_ENV, signal: AbortSignal.timeout(15_000) });
      const lines = r.stdout.split("\n").map((l) => l.trim());
      return { agent: lines[0] ?? "", grader: lines[1] ?? "", hash: lines[2] ?? "", cgroups: lines.includes("cgroups") };
    };
    let got = await probe();
    if (got.hash !== want.hash) {
      for (const f of want.files) await vm.fs.writeFile(`${XFER}/helper-${f.name}`, f.data);
      const install = want.files.map((f) => `mv -f ${XFER}/helper-${f.name} ${LIBEXEC}/${f.name}`).join(" && ");
      const r = await vm.exec(["/bin/sh", "-c", `mkdir -p ${LIBEXEC} && ${install} && /bin/sh ${LIBEXEC}/setup`], { env: ROOT_ENV, signal: AbortSignal.timeout(30_000) });
      if (r.exitCode !== 0) throw new Error(`updating guest helpers failed: ${r.stderr.trim() || `exit ${r.exitCode}`}`);
      got = await probe();
    } else if (got.grader !== "1001" || !got.cgroups) {
      await vm.exec(["/bin/sh", `${LIBEXEC}/setup`], { env: ROOT_ENV, signal: AbortSignal.timeout(30_000) });
      got = await probe();
    }
    if (got.agent !== "1000") throw new Error("guest image has no agent user (uid 1000); rebuild with guest/build.sh");
    if (got.grader !== "1001" || got.hash !== want.hash || !got.cgroups) throw new Error("guest helpers could not be updated (grader user, helpers or exec cgroups missing)");
  }

  private async shutdown(): Promise<void> {
    const vm = this.vm;
    this.vm = null; // no new work from here on; holdsVmm() stays true until the VMM is closed
    if (!vm) return;
    let closed!: () => void;
    this.closing = new Promise((r) => (closed = r));
    try {
      if (vm.getHostPid() !== null) {
        // Flush and freeze the root fs so the overlay on disk is consistent before the VMM is stopped.
        try {
          await vm.exec(["/bin/sh", "-c", "sync; mount -o remount,ro / 2>/dev/null; sync"], { env: ROOT_ENV, signal: AbortSignal.timeout(10_000) });
        } catch {
          // best effort
        }
      }
      try {
        await vm.close();
      } finally {
        await this.disarmGuard();
      }
    } finally {
      this.closing = null;
      closed();
    }
  }

  // ---------- exec ----------

  async exec(command: string, opts: ExecOptions = {}): Promise<ExecOutcome> {
    const vm = this.requireVm();
    const id = randomBytes(8).toString("hex");
    const as = opts.as ?? "agent";
    const cap = opts.maxOutputBytes ?? 1 << 20;
    const timeoutMs = opts.timeoutMs ?? 120_000;
    const cwd = opts.cwd ?? "/workspace";
    const out = new OutputCapture(cap, opts.onStdout);
    const err = new OutputCapture(cap, opts.onStderr);
    const local = new AbortController();
    let timedOut = false;
    let aborted = false;
    let killed = false;
    let hardStop: NodeJS.Timeout | undefined;
    const stopExec = (why: "timeout" | "abort") => {
      if (killed) return;
      killed = true;
      if (why === "timeout") timedOut = true;
      else aborted = true;
      void this.killExec(vm, id);
      // If the guest can't end it (it ignores the kill or the VM is wedged), stop waiting.
      hardStop = setTimeout(() => local.abort(), 5_000);
    };

    const t0 = performance.now();
    const proc = vm.exec([RUN, id, as, cwd, "/bin/bash", "-c", command], {
      env: as === "agent" ? AGENT_ENV : ROOT_ENV,
      stdin: opts.stdin,
      stdout: "pipe",
      stderr: "pipe",
      signal: local.signal,
    });
    const timer = setTimeout(() => stopExec("timeout"), timeoutMs);
    const onAbort = () => stopExec("abort");
    if (opts.signal?.aborted) onAbort();
    else opts.signal?.addEventListener("abort", onAbort, { once: true });

    const pump = (async () => {
      for await (const chunk of proc.output()) (chunk.stream === "stdout" ? out : err).push(chunk.data);
    })();

    let exitCode = -1;
    let failure: unknown = null;
    try {
      const r = await proc;
      exitCode = r.signal ? 128 + r.signal : r.exitCode;
    } catch (e) {
      failure = e;
    } finally {
      clearTimeout(timer);
      clearTimeout(hardStop);
      opts.signal?.removeEventListener("abort", onAbort);
    }
    await Promise.race([pump.catch(() => {}), new Promise((r) => setTimeout(r, 1_000))]);
    if (failure && !timedOut && !aborted) throw failure;
    if (timedOut) exitCode = 124;
    else if (aborted) exitCode = 130;
    const o = out.result();
    const e = err.result();
    return {
      exitCode,
      stdout: o.text,
      stderr: e.text,
      durationMs: Math.round(performance.now() - t0),
      truncated: o.truncated || e.truncated,
      timedOut,
    };
  }

  private async killExec(vm: VM, id: string): Promise<void> {
    try {
      await vm.exec([KILL, id], { env: ROOT_ENV, signal: AbortSignal.timeout(5_000) });
    } catch {
      // VM gone or wedged; the caller's hard stop covers it
    }
  }

  // ---------- files ----------

  async readFile(p: string, opts: { maxBytes?: number; as?: "agent" | "root" } = {}): Promise<ReadResult> {
    const [r] = await this.readFiles([p], { ...opts, totalBytes: opts.maxBytes ?? DEFAULT_READ_MAX });
    if (r instanceof Error) throw r;
    return r!;
  }

  /**
   * Reads through the guest's read.py: as root no symlink in the path is followed, and as either user the
   * final open is non-blocking and must be a regular file, so a FIFO or device can't stall or flood the host.
   * Output is capped per file and per batch, and the exec has a deadline.
   */
  async readFiles(paths: string[], opts: { maxBytes?: number; as?: "agent" | "root"; totalBytes?: number } = {}): Promise<(ReadResult | Error)[]> {
    const vm = this.requireVm();
    if (!paths.length) return [];
    const abs = paths.map((p) => (path.posix.isAbsolute(p) ? p : path.posix.join("/workspace", p)));
    const max = opts.maxBytes ?? DEFAULT_READ_MAX;
    const req = JSON.stringify({ max, total: opts.totalBytes ?? READ_BATCH_BYTES, paths: abs });
    const agent = (opts.as ?? "root") === "agent";
    const argv = agent
      ? [RUN, randomBytes(8).toString("hex"), "agent", "/", "/usr/bin/python3", "-I", "-S", READ, "--follow"]
      : ["/usr/bin/python3", "-I", "-S", READ];
    const r = await vm.exec(argv, { env: agent ? AGENT_ENV : ROOT_ENV, stdin: req, signal: AbortSignal.timeout(READ_TIMEOUT_MS) });
    if (r.exitCode !== 0) throw new Error(`read ${abs.length === 1 ? abs[0] : `${abs.length} files`}: ${r.stderr.trim().split("\n").pop() || `exit ${r.exitCode}`}`);
    return parseReadOutput(r.stdoutBuffer, abs);
  }

  /** SIGKILLs every agent (uid 1000) process: the exec cgroups first, then anything left with that uid. */
  async killAgentProcesses(): Promise<void> {
    if (!this.isRunning()) return;
    const r = await this.requireVm().exec([KILL_USER, "agent"], { env: ROOT_ENV, signal: AbortSignal.timeout(20_000) });
    if (r.exitCode !== 0) throw new Error(`killing agent processes failed: ${r.stderr.trim() || `exit ${r.exitCode}`}`);
  }

  async writeFile(p: string, data: string | Uint8Array, opts: { as?: "agent" | "root"; mode?: number } = {}): Promise<void> {
    const vm = this.requireVm();
    if (!path.posix.isAbsolute(p)) p = path.posix.join("/workspace", p);
    const buf = typeof data === "string" ? Buffer.from(data) : Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    const mode = opts.mode === undefined ? "" : (opts.mode & 0o7777).toString(8);
    if ((opts.as ?? "agent") === "root") {
      await vm.fs.mkdir(path.posix.dirname(p), { recursive: true });
      await vm.fs.writeFile(p, buf);
      if (mode) await this.checked(vm.exec(["/bin/chmod", mode, "--", p], { env: ROOT_ENV }), `chmod ${p}`);
      return;
    }
    // Staged as root in a root-only dir, then copied by a uid-1000 process: the write follows the
    // agent's permissions and symlinks exactly as if the agent had written it.
    const id = randomBytes(8).toString("hex");
    const stage = `${XFER}/${id}`;
    await vm.fs.writeFile(stage, buf);
    await this.checked(vm.exec([PUT, id, stage, p, mode], { env: AGENT_ENV }), `write ${p}`);
  }

  private async checked(proc: PromiseLike<{ exitCode: number; stderr: string }>, what: string): Promise<void> {
    const r = await proc;
    if (r.exitCode !== 0) throw new Error(`${what}: ${r.stderr.trim() || `exit ${r.exitCode}`}`);
  }

  async manifest(root = "/workspace", opts: { previous?: Manifest } = {}): Promise<Manifest> {
    const vm = this.requireVm();
    const args = ["/usr/bin/python3", "-I", "-S", OBSERVER, "--root", root];
    let stage: string | null = null;
    if (opts.previous) {
      const rows = opts.previous.entries
        .filter((e) => e.type === "file" && e.sha256)
        .map((e) => [e.path, e.size, e.mtimeNs, e.ctimeNs ?? "", e.ino, e.sha256]);
      stage = `${XFER}/prev-${randomBytes(8).toString("hex")}.json`;
      await vm.fs.writeFile(stage, JSON.stringify(rows));
      args.push("--prev", stage);
    } else {
      args.push("--all");
    }
    let r: Awaited<ReturnType<typeof vm.exec>>;
    try {
      r = await vm.exec(args, { env: ROOT_ENV });
    } finally {
      // Incremental manifests can be several MiB. They live in the guest's root-only transfer
      // directory, so remove them even when observer.py fails instead of accumulating one per turn.
      if (stage) await vm.exec(["/bin/rm", "-f", "--", stage], { env: ROOT_ENV });
    }
    if (r.exitCode !== 0) throw new Error(`observer failed: ${r.stderr.trim() || `exit ${r.exitCode}`}`);
    const parsed = JSON.parse(r.stdout) as Manifest & { stats: Record<string, number> };
    return {
      root: parsed.root,
      takenAt: parsed.takenAt,
      entries: parsed.entries as ManifestEntry[],
      truncated: parsed.truncated,
      ...({ observer: parsed.stats } as object),
    };
  }

  // ---------- snapshots ----------

  // A running VM is shut down for snapshot and restore and left stopped: booting is the manager's job (VM cap and
  // boot lock), and it starts the VM again.

  snapshot(destDir: string): Promise<{ bytes: number }> {
    return this.serial(async () => {
      await this.shutdown();
      fs.mkdirSync(destDir, { recursive: true, mode: 0o700 });
      const dst = path.join(destDir, DISK_FILE);
      cloneFile(this.diskPath, dst);
      const bytes = fs.statSync(dst).size;
      const meta: SnapshotMeta = {
        format: "terrarium-vm-snapshot/1",
        imageId: this.meta.imageId,
        sourceEnvId: this.id,
        createdAt: Date.now(),
        diskBytes: bytes,
        vm: this.config,
      };
      writeJson(path.join(destDir, SNAPSHOT_META), meta);
      return { bytes };
    });
  }

  restore(snapshotDir: string): Promise<void> {
    return this.serial(async () => {
      const snap = readSnapshotMeta(snapshotDir);
      await this.shutdown();
      const tmp = `${this.diskPath}.restore`;
      cloneFile(path.join(snapshotDir, DISK_FILE), tmp);
      fs.renameSync(tmp, this.diskPath);
      this.meta = { ...this.meta, imageId: snap.imageId };
      writeJson(path.join(this.dir, META_FILE), this.meta);
    });
  }

  destroy(): Promise<void> {
    return this.serial(async () => {
      await this.shutdown();
      this.net.close();
      const meta = path.join(this.dir, META_FILE);
      if (!fs.existsSync(meta) || readJson<EnvMeta>(meta).id !== this.id) {
        throw new Error(`refusing to delete ${this.dir}: not this env's storage`);
      }
      fs.rmSync(this.dir, { recursive: true, force: true });
    });
  }

  // ---------- network ----------

  async setNetwork(mode: NetworkMode): Promise<void> {
    this.net.mode = mode;
  }

  setNetworkGate(gate: NetworkGate | null): void {
    this.net.setGate(gate);
  }

  onNet(listener: (attempt: NetAttempt) => void): () => void {
    return this.net.onAttempt(listener);
  }

  get network(): NetworkMode {
    return this.net.mode;
  }

  // ---------- facts and resources ----------

  async facts(): Promise<EnvFacts> {
    const image = resolveImage(this.meta.imageId);
    const backend = this.lastBoot?.backend ?? this.config.backend;
    const base: EnvFacts = {
      kind: "vm",
      isolation:
        backend === "krun"
          ? `Linux micro-VM (Gondolin ${GONDOLIN_VERSION}, krun, Apple Hypervisor.framework)`
          : `Linux micro-VM (Gondolin ${GONDOLIN_VERSION}, QEMU with HVF)`,
      user: "agent (uid 1000)",
      workdir: "/workspace",
      mounts: this.exchange
        ? [
            { path: "/inbox", kind: "inbox", access: "ro" },
            { path: "/outbox", kind: "outbox", access: "rw" },
          ]
        : [],
      hostFoldersMounted: false,
      ...(image ? { image: { name: `terrarium-guest (Alpine ${image.alpineVersion ?? "?"})`, digest: image.id, bytes: image.rootfsBytes } } : {}),
      gatheredAt: Date.now(),
    };
    if (!this.isRunning()) return this.meta.facts ? { ...this.meta.facts, ...base, gatheredAt: this.meta.facts.gatheredAt } : base;
    const script = [
      ". /etc/os-release; echo \"os=$PRETTY_NAME\"",
      'echo "kernel=$(uname -r)"; echo "arch=$(uname -m)"; echo "cpus=$(nproc)"',
      "awk '/^MemTotal:/{print \"memkb=\"$2}' /proc/meminfo",
      "df -Pk / | awk 'NR==2{print \"diskkb=\"$2; print \"usedkb=\"$3}'",
      'echo "agent=$(id -u agent)"',
      'for t in bash python3 pip3 node npm git gcc make curl jq rg inotifywait file less ps; do command -v "$t" >/dev/null 2>&1 && echo "tool=$t"; done',
      'echo "v_python3=$(python3 -c "import platform;print(platform.python_version())" 2>/dev/null)"',
      'echo "v_node=$(node --version 2>/dev/null | tr -d v)"',
      "echo \"v_git=$(git --version 2>/dev/null | awk '{print $3}')\"",
      "echo \"v_gcc=$(gcc -dumpfullversion 2>/dev/null)\"",
    ].join("\n");
    const r = await this.requireVm().exec(["/bin/sh", "-c", script], { env: ROOT_ENV });
    const kv = new Map<string, string>();
    const tools: string[] = [];
    for (const line of r.stdout.split("\n")) {
      const i = line.indexOf("=");
      if (i <= 0) continue;
      const k = line.slice(0, i);
      const v = line.slice(i + 1);
      if (k === "tool") tools.push(v);
      else kv.set(k, v);
    }
    const versioned = tools.map((t) => {
      const v = kv.get(`v_${t}`);
      return v ? `${t} ${v}` : t;
    });
    const num = (k: string) => (kv.has(k) ? Number(kv.get(k)) : undefined);
    const facts: EnvFacts = {
      ...base,
      os: kv.get("os"),
      kernel: kv.get("kernel"),
      arch: kv.get("arch"),
      cpus: num("cpus"),
      memoryMiB: num("memkb") === undefined ? undefined : Math.round(num("memkb")! / 1024),
      diskMiB: num("diskkb") === undefined ? undefined : Math.round(num("diskkb")! / 1024),
      diskUsedMiB: num("usedkb") === undefined ? undefined : Math.round(num("usedkb")! / 1024),
      user: kv.get("agent") === "1000" ? "agent (uid 1000)" : "agent (missing)",
      tools: versioned,
    };
    this.meta = { ...this.meta, facts };
    writeJson(path.join(this.dir, META_FILE), this.meta);
    return facts;
  }

  async resources(): Promise<{ rssBytes: number; cpuPct: number } | null> {
    const pid = this.vm?.getHostPid();
    if (!pid) return null;
    try {
      const { stdout } = await execFileP("/bin/ps", ["-o", "rss=,%cpu=,time=", "-p", String(pid)]);
      const [rss, pct, time] = stdout.trim().split(/\s+/);
      const cpu = parseCpuTime(time ?? "0");
      const at = performance.now();
      let cpuPct = Number(pct);
      if (this.lastCpu && at > this.lastCpu.at) cpuPct = ((cpu - this.lastCpu.cpu) / ((at - this.lastCpu.at) / 1000)) * 100;
      this.lastCpu = { cpu, at };
      return { rssBytes: Number(rss) * 1024, cpuPct: Math.max(0, Math.round(cpuPct * 10) / 10) };
    } catch {
      return null;
    }
  }

  /** Host PID of the VMM process (krun runner or qemu), for diagnostics. */
  hostPid(): number | null {
    return this.vm?.getHostPid() ?? null;
  }
}

function readSnapshotMeta(dir: string): SnapshotMeta {
  const meta = readJson<SnapshotMeta>(path.join(dir, SNAPSHOT_META));
  if (meta.format !== "terrarium-vm-snapshot/1") throw new Error(`${dir} is not a Terrarium VM snapshot`);
  if (!fs.existsSync(path.join(dir, DISK_FILE))) throw new Error(`${dir} has no ${DISK_FILE}`);
  if (!resolveImage(meta.imageId)) throw new Error(`snapshot needs guest image ${meta.imageId}, which is not in data/images/objects`);
  return meta;
}

async function createOverlay(image: ImageInfo, disk: string): Promise<void> {
  const qemuImg = qemuImgPath();
  if (!qemuImg) throw new Error("qemu-img not found (brew install qemu)");
  await execFileP(qemuImg, ["create", "-q", "-f", "qcow2", "-F", "raw", "-b", rootfsPath(image), disk]);
}

export function createVmDriver(options: VmDriverOptions = {}): EnvDriver {
  const exchange = options.exchange ?? false;

  async function runtime(meta: EnvMeta, dir: string, network: NetworkMode): Promise<VmRuntime> {
    let providers = null;
    if (exchange) {
      const g = await gondolin();
      providers = { inbox: new g.MemoryProvider(), outbox: new g.MemoryProvider() };
    }
    return new VmRuntime(meta, dir, network, exchange, providers, options.lookup);
  }

  return {
    type: "vm",

    async create(spec: EnvCreateSpec): Promise<EnvRuntime> {
      ensurePrivateDir(spec.dir);
      const disk = path.join(spec.dir, DISK_FILE);
      if (fs.existsSync(path.join(spec.dir, META_FILE))) throw new Error(`env storage already exists: ${spec.dir}`);
      let imageId: string;
      let vm: VmConfig = { ...DEFAULT_VM_CONFIG, ...spec.vm };
      if (spec.fromSnapshotDir) {
        const snap = readSnapshotMeta(spec.fromSnapshotDir);
        imageId = snap.imageId;
        vm = { ...snap.vm, ...spec.vm };
        cloneFile(path.join(spec.fromSnapshotDir, DISK_FILE), disk);
      } else {
        const image = resolveImage();
        if (!image) throw new Error("no guest image built (run guest/build.sh)");
        imageId = image.id;
        await createOverlay(image, disk);
      }
      const meta: EnvMeta = { version: 1, id: spec.id, imageId, vm, createdAt: Date.now() };
      writeJson(path.join(spec.dir, META_FILE), meta);
      // No seeding here: booting is the manager's job (VM cap and boot lock); it seeds through its own start.
      return runtime(meta, spec.dir, spec.network);
    },

    async open(spec): Promise<EnvRuntime> {
      const metaPath = path.join(spec.dir, META_FILE);
      if (!fs.existsSync(metaPath)) throw new Error(`no VM env storage at ${spec.dir}`);
      const meta = readJson<EnvMeta>(metaPath);
      if (meta.id !== spec.id) throw new Error(`env storage at ${spec.dir} belongs to ${meta.id}`);
      if (spec.vm) meta.vm = { ...meta.vm, ...spec.vm };
      return runtime(meta, spec.dir, spec.network);
    },

    async check() {
      const image = resolveImage();
      const problems: string[] = [];
      if (!image) problems.push("guest image not built (run guest/build.sh)");
      if (!qemuImgPath()) problems.push("qemu-img missing (brew install qemu)");
      const krun = krunRunnerPresent() && Boolean(image?.hasKrun);
      const qemu = Boolean(qemuPath());
      if (!krun && !qemu) problems.push("no VM backend (krun runner or QEMU)");
      if (problems.length) return { ok: false, detail: problems.join("; ") };
      const mib = Math.round(image!.rootfsBytes / 1048576);
      return {
        ok: true,
        detail: `image ${image!.id} (Alpine ${image!.alpineVersion}, rootfs ${mib} MiB); backends: ${[krun && "krun", qemu && "qemu"].filter(Boolean).join(", ")}`,
      };
    },
  };
}

export const vmDriver: EnvDriver = createVmDriver();
