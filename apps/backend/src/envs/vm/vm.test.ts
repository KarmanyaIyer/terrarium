// VM driver integration tests: these boot real Gondolin VMs (at most 2 at once, 1 GiB each).
// Opt-in: TERRARIUM_VM_TESTS=1 node --test apps/backend/src/envs/vm/vm.test.ts  (or guest/verify.sh)
// Measurements are printed at the end and written to $TERRARIUM_DATA/vm-verify/latest.json.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import type { NetworkMode } from "@terrarium/shared";
import { isPublicIp } from "../../policy/index.ts";
import type { EnvRuntime, NetAttempt } from "../types.ts";
import { dataDir } from "./gondolin.ts";
import { type VmRuntime, createVmDriver } from "./driver.ts";
import { REPO_DIR } from "../../config.ts";
import { gradeCommand, gradeTests, writeHiddenFiles } from "../../evals/graders.ts";

const enabled = process.env.TERRARIUM_VM_TESTS === "1";
const driver = createVmDriver();
const results: Record<string, unknown> = {};
const record = (k: string, v: unknown) => {
  results[k] = v;
};

let tmp = "";
const envs: EnvRuntime[] = [];
const netLog = new Map<string, NetAttempt[]>();

async function newEnv(name: string, network: NetworkMode, extra: { fromSnapshotDir?: string; backend?: "krun" | "qemu" } = {}): Promise<VmRuntime> {
  const rt = (await driver.create({
    id: name,
    dir: path.join(tmp, "envs", name),
    network,
    fromSnapshotDir: extra.fromSnapshotDir,
    vm: { cpus: 2, memoryMiB: 1024, diskMiB: 4096, backend: extra.backend ?? "krun" },
  })) as VmRuntime;
  envs.push(rt);
  const log: NetAttempt[] = [];
  netLog.set(name, log);
  rt.onNet((a) => log.push(a));
  return rt;
}

async function sh(rt: EnvRuntime, cmd: string, opts: { as?: "agent" | "root"; timeoutMs?: number } = {}) {
  const r = await rt.exec(cmd, { timeoutMs: 60_000, ...opts });
  return { code: r.exitCode, out: r.stdout.trim(), err: r.stderr.trim(), ms: r.durationMs };
}

const mib = (b: number) => Math.round((b / 1048576) * 10) / 10;

function lanIPv4(): string | null {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list ?? []) if (a.family === "IPv4" && !a.internal) return a.address;
  }
  return null;
}

/** HTTP canaries on the Mac: any hit means a guest reached a host service. */
async function canary(host: string): Promise<{ server: http.Server; port: number; hits: string[] }> {
  const hits: string[] = [];
  const server = http.createServer((req, res) => {
    hits.push(`${req.method} ${req.headers.host} ${req.url}`);
    res.end("CANARY_HIT\n");
  });
  await new Promise<void>((resolve, reject) => server.once("error", reject).listen(0, host, () => resolve()));
  return { server, port: (server.address() as { port: number }).port, hits };
}

describe("vm driver", { skip: enabled ? false : "set TERRARIUM_VM_TESTS=1 to boot VMs" }, () => {
  let a: VmRuntime;

  before(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "terr-vmtest-"));
    const check = await driver.check();
    assert.equal(check.ok, true, check.detail);
    record("image", check.detail);
  });

  after(async () => {
    for (const rt of envs) await rt.destroy().catch(() => {});
    fs.rmSync(tmp, { recursive: true, force: true });
    const out = path.join(dataDir(), "vm-verify");
    fs.mkdirSync(out, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(out, "latest.json"), `${JSON.stringify(results, null, 2)}\n`);
    console.log(`\nVM_RESULTS ${JSON.stringify(results, null, 2)}`);
  });

  test("boot time and RSS (krun)", async () => {
    let t = performance.now();
    a = await newEnv("a", "off");
    const createMs = Math.round(performance.now() - t);
    t = performance.now();
    await a.start();
    const startMs = Math.round(performance.now() - t);
    t = performance.now();
    const first = await sh(a, "true");
    const firstExecMs = Math.round(performance.now() - t);
    const idle = await a.resources();
    assert.equal(first.code, 0);
    assert.ok(idle && idle.rssBytes > 0);
    // Guest-freed memory is not returned to macOS: touch 300 MiB, free it, compare host RSS.
    await sh(a, "python3 -c 'b=bytearray(300*1024*1024); b[::4096]=b\"x\"*len(b[::4096]); del b'");
    const afterTouch = await a.resources();
    const t2 = performance.now();
    await a.stop();
    await a.start();
    const restartMs = Math.round(performance.now() - t2);
    const afterRestart = await a.resources();
    record("boot_krun", {
      createMs,
      startMs,
      bootMs: a.lastBoot?.bootMs,
      firstExecMs,
      restartMs,
      rssIdleMiB: mib(idle!.rssBytes),
      rssAfter300MiBTouchFreedMiB: mib(afterTouch!.rssBytes),
      rssAfterRestartMiB: mib(afterRestart!.rssBytes),
      backend: a.lastBoot?.backend,
    });
  });

  test("facts are gathered from the guest", async () => {
    const f = await a.facts();
    assert.match(f.os ?? "", /Alpine Linux/);
    assert.equal(f.user, "agent (uid 1000)");
    assert.equal(f.hostFoldersMounted, false);
    assert.deepEqual(f.mounts, []);
    assert.equal(f.cpus, 2);
    assert.ok((f.memoryMiB ?? 0) > 900);
    for (const tool of ["python3", "node", "git", "gcc", "curl", "jq", "rg", "inotifywait"]) {
      assert.ok(f.tools?.some((t) => t.split(" ")[0] === tool), tool);
    }
    record("facts", f);
  });

  test("exec as agent vs root; agent can't read root state or escalate", async () => {
    assert.equal((await sh(a, "id -u")).out, "1000");
    assert.equal((await sh(a, "id -u", { as: "root" })).out, "0");
    assert.equal((await sh(a, "pwd")).out, "/workspace");
    await sh(a, "echo topsecret > /var/lib/terrarium/secret && chmod 600 /var/lib/terrarium/secret && echo s2 > /etc/terr-secret && chmod 600 /etc/terr-secret", { as: "root" });
    const probes = {
      stateDir: await sh(a, "ls /var/lib/terrarium"),
      stateFile: await sh(a, "cat /var/lib/terrarium/secret"),
      rootFile: await sh(a, "cat /etc/terr-secret"),
      shadow: await sh(a, "cat /etc/shadow"),
      writeEtc: await sh(a, "echo x >> /etc/passwd"),
      su: await sh(a, "su -c id root < /dev/null"),
      execRecords: await sh(a, "ls /run/terrarium/exec"),
    };
    for (const [k, r] of Object.entries(probes)) assert.notEqual(r.code, 0, `${k}: ${r.out}`);
    assert.ok(!probes.stateFile.out.includes("topsecret"));
    const status = await sh(a, "grep -E '^(NoNewPrivs|CapEff|CapBnd)' /proc/self/status");
    assert.match(status.out, /NoNewPrivs:\s+1/);
    assert.match(status.out, /CapBnd:\s+0+\n?/);
    // A root-run harness write through an agent-planted symlink must not land outside agent permissions.
    await sh(a, "ln -sf /etc/passwd /workspace/planted");
    await assert.rejects(a.writeFile("/workspace/planted", "pwned\n"), /Permission denied/);
    assert.doesNotMatch((await sh(a, "cat /etc/passwd")).out, /pwned/);
    const readAsAgent = await a.readFile("/var/lib/terrarium/secret", { as: "agent" }).then(() => "read", (e: Error) => e.message);
    assert.match(readAsAgent, /Permission denied/);
    record("privilege", Object.fromEntries(Object.entries(probes).map(([k, r]) => [k, `${r.code}: ${(r.err || r.out).split("\n")[0]}`])));
  });

  test("exec streams, caps output (head+tail), times out, aborts and kills the process tree", async () => {
    const chunks: string[] = [];
    const big = await a.exec("for i in $(seq 1 2000); do echo line$i; done; echo err >&2", { maxOutputBytes: 4096, onStdout: (c) => chunks.push(c) });
    assert.equal(big.truncated, true);
    assert.match(big.stdout, /^line1\n/);
    assert.match(big.stdout, /line2000$/m);
    assert.match(big.stdout, /bytes omitted/);
    assert.equal(big.stderr.trim(), "err");
    assert.ok(chunks.length > 0);
    const t = await a.exec("sleep 30 & sleep 30; echo never", { timeoutMs: 1000 });
    assert.equal(t.exitCode, 124);
    assert.equal(t.timedOut, true);
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 800);
    const ab = await a.exec("(sleep 40; echo bg) & sleep 40", { signal: ac.signal });
    assert.equal(ab.exitCode, 130);
    await new Promise((r) => setTimeout(r, 300));
    // Killed children of the exec become zombies (sandboxd, PID 1, never reaps orphans); count live ones.
    const live = await sh(a, "ps -eo stat=,comm= | awk '$2 == \"sleep\" && $1 !~ /^Z/' | wc -l", { as: "root" });
    assert.equal(live.out, "0", "no sleep left after timeout/abort");
    assert.equal((await sh(a, "cd /nonexistent-dir")).code, 1);
    assert.equal((await a.exec("pwd", { cwd: "/nope" })).exitCode, 127);
    record("exec", { timeoutMs: t.durationMs, abortMs: ab.durationMs, cappedStdoutBytes: big.stdout.length });
  });

  test("network: curl example.com only in web mode; switching is live", async () => {
    const code = async () => (await sh(a, "curl -s -o /dev/null -m 15 -w '%{http_code}' https://example.com/")).out;
    const seen: Record<string, string> = {};
    for (const mode of ["off", "registries", "web", "off", "web"] as NetworkMode[]) {
      await a.setNetwork(mode);
      seen[`${Object.keys(seen).length}:${mode}`] = await code();
    }
    assert.deepEqual(Object.values(seen), ["403", "403", "200", "403", "200"]);
    // Switch while one command keeps requesting.
    await a.setNetwork("web");
    const run = a.exec("for i in 1 2 3 4 5 6; do curl -s -o /dev/null -m 10 -w '%{http_code} ' https://example.com/; sleep 0.7; done", { timeoutMs: 90_000 });
    await new Promise((r) => setTimeout(r, 1500));
    await a.setNetwork("off");
    const r = await run;
    const codes = r.stdout.trim().split(" ");
    assert.equal(codes[0], "200");
    assert.equal(codes.at(-1), "403");
    const log = netLog.get("a")!;
    const allowed = log.find((e) => e.decision === "allow" && e.url === "https://example.com/");
    assert.ok(allowed && allowed.status === 200 && (allowed.bytesIn ?? 0) > 0 && allowed.ip, JSON.stringify(allowed));
    assert.ok(log.some((e) => e.decision === "deny" && e.reason === "mode off"));
    assert.ok(log.some((e) => e.decision === "deny" && e.reason === "host not in registries list"));
    record("net_modes", { sequence: seen, liveSwitch: codes, sampleAllowed: allowed });
  });

  test("python + pip: install works in registries mode, fails when off", async () => {
    await a.setNetwork("registries");
    const ok = await sh(a, "pip install --user --no-cache-dir six==1.17.0 2>&1 | tail -2 && python3 -c 'import six; print(six.__version__)'", { timeoutMs: 120_000 });
    assert.equal(ok.code, 0, ok.out);
    assert.match(ok.out, /1\.17\.0$/);
    const npm = await sh(a, "npm view left-pad version", { timeoutMs: 60_000 });
    assert.equal(npm.code, 0, npm.out + npm.err);
    await a.setNetwork("off");
    const off = await sh(a, "pip install --user --no-cache-dir --retries 0 --timeout 5 iniconfig 2>&1 | tail -1", { timeoutMs: 60_000 });
    assert.equal((await sh(a, "python3 -c 'import iniconfig' 2>&1; echo rc=$?")).out.endsWith("rc=1"), true);
    const hosts = [...new Set(netLog.get("a")!.filter((e) => e.decision === "allow" && e.reason.startsWith("allowed: registries")).map((e) => e.host))];
    assert.ok(hosts.includes("pypi.org") && hosts.includes("files.pythonhosted.org"), hosts.join(","));
    record("pip", { registries: ok.out.split("\n").slice(-2), npmLeftPad: npm.out, off: off.out, registryHostsUsed: hosts, pipMs: ok.ms });
  });

  test("isolation probes: Mac loopback/LAN, metadata, private, IPv6, rebinding are all denied and logged", async () => {
    const lan = lanIPv4();
    const lo = await canary("127.0.0.1");
    const lo6 = await canary("::1");
    const lanC = lan ? await canary(lan) : null;
    try {
      await a.setNetwork("web");
      const gw = (await sh(a, "ip route | awk '/default/{print $3}'")).out;
      assert.match(gw, /^\d+\.\d+\.\d+\.\d+$/);
      const P = lo.port;
      const probes: { name: string; cmd: string; routed: boolean }[] = [
        { name: "guest 127.0.0.1 (guest's own loopback)", cmd: `http://127.0.0.1:${P}/`, routed: false },
        { name: "guest [::1]", cmd: `http://[::1]:${lo6.port}/`, routed: false },
        { name: `gateway ${gw}`, cmd: `http://${gw}:${P}/`, routed: true },
        { name: "Host: localhost via gateway", cmd: `-H 'Host: localhost:${P}' http://${gw}:${P}/`, routed: true },
        { name: "Host: 127.0.0.1 via gateway", cmd: `-H 'Host: 127.0.0.1:${P}' http://${gw}:${P}/`, routed: true },
        { name: "Host: [::1] via gateway", cmd: `-H 'Host: [::1]:${lo6.port}' http://${gw}:${P}/`, routed: true },
        { name: "Host: [::ffff:127.0.0.1] via gateway", cmd: `-H 'Host: [::ffff:127.0.0.1]:${P}' http://${gw}:${P}/`, routed: true },
        { name: "Host: [fd00::1] (ULA) via gateway", cmd: `-H 'Host: [fd00::1]' http://${gw}/`, routed: true },
        { name: "host.docker.internal", cmd: `http://host.docker.internal:${P}/`, routed: true },
        { name: "gateway.docker.internal", cmd: `http://gateway.docker.internal:${P}/`, routed: true },
        { name: "host.containers.internal", cmd: `http://host.containers.internal:${P}/`, routed: true },
        { name: "host.lima.internal", cmd: `http://host.lima.internal:${P}/`, routed: true },
        { name: "localhost.localdomain", cmd: `http://localhost.localdomain:${P}/`, routed: false },
        { name: "127.0.0.1.nip.io", cmd: `http://127.0.0.1.nip.io:${P}/`, routed: true },
        { name: "nip.io -> LAN IP", cmd: `http://${lan ?? "192.168.1.2"}.nip.io:${lanC?.port ?? 80}/`, routed: true },
        { name: "metadata 169.254.169.254", cmd: "http://169.254.169.254/latest/meta-data/", routed: true },
        { name: "LAN router 192.168.1.1", cmd: "http://192.168.1.1/", routed: true },
        { name: "10.0.0.1 https", cmd: "https://10.0.0.1/", routed: true },
        { name: "decimal 2130706433", cmd: `http://2130706433:${P}/`, routed: false },
      ];
      if (lanC) {
        probes.push({ name: `Mac LAN IP ${lan}`, cmd: `http://${lan}:${lanC.port}/`, routed: true });
        probes.push({ name: `Mac LAN IP ${lan} https`, cmd: `https://${lan}:${lanC.port}/`, routed: true });
      }
      const table: { probe: string; http: string; denyLogged: string | null }[] = [];
      for (const p of probes) {
        const before = netLog.get("a")!.length;
        const r = await sh(a, `curl -s -o /dev/null -m 6 -w '%{http_code}' ${p.cmd}; echo " rc=$?"`);
        // Bare-IP TLS that dies in the handshake is logged after a short grace period (see VmNetwork.onDebug).
        let newEntries = netLog.get("a")!.slice(before);
        for (let i = 0; i < 30 && !newEntries.some((e) => e.decision === "deny"); i++) {
          await new Promise((res) => setTimeout(res, 100));
          newEntries = netLog.get("a")!.slice(before);
        }
        const deny = newEntries.find((e) => e.decision === "deny");
        const allow = newEntries.find((e) => e.decision === "allow");
        table.push({ probe: p.name, http: r.out, denyLogged: deny ? deny.reason : null });
        assert.equal(allow, undefined, `${p.name} was allowed: ${JSON.stringify(allow)}`);
        if (p.routed) assert.ok(deny, `${p.name}: no deny entry (curl ${r.out})`);
      }
      // DNS rebinding: a name that alternates between a public IP and 127.0.0.1.
      const rebind = `make-1.1.1.1-rebind-127.0.0.1-rr.1u.ms`;
      const before = netLog.get("a")!.length;
      const rr = await sh(a, `for i in 1 2 3 4; do curl -s -o /dev/null -m 4 -w '%{http_code} ' http://${rebind}:${P}/; done`, { timeoutMs: 60_000 });
      // An attempt that got the public answer connects upstream to 1.1.1.1:P, which hangs until undici's
      // connect timeout, so its entry lands after curl gave up. Wait for all four.
      let rebindLog = netLog.get("a")!.slice(before);
      for (let i = 0; i < 200 && rebindLog.length < 4; i++) {
        await new Promise((res) => setTimeout(res, 100));
        rebindLog = netLog.get("a")!.slice(before);
      }
      const rebindSummary = rebindLog.map((e) => `${e.decision} ${e.ip ?? "?"}`).join(", ");
      const rebindDeny = rebindLog.find((e) => e.decision === "deny")?.reason ?? "none";
      table.push({ probe: `DNS rebinding ${rebind}`, http: rr.out, denyLogged: `${rebindDeny} [${rebindSummary}]` });
      // Raw TCP (non-HTTP) to the gateway.
      const tcpBefore = netLog.get("a")!.length;
      const raw = await sh(a, `printf 'hello\\r\\n' | nc -w 2 ${gw} ${P}; echo rc=$?`);
      await new Promise((res) => setTimeout(res, 300));
      const rawDeny = netLog.get("a")!.slice(tcpBefore).find((e) => e.decision === "deny");
      table.push({ probe: `raw TCP to ${gw}:${P}`, http: raw.out, denyLogged: rawDeny?.reason ?? null });
      const hits = [...lo.hits, ...lo6.hits, ...(lanC?.hits ?? [])];
      assert.deepEqual(hits, [], "a canary on the Mac was reached");
      assert.ok(rebindLog.length >= 1, "rebinding attempts were logged");
      assert.ok(rebindLog.every((e) => e.decision === "deny" || (e.ip && isPublicIp(e.ip))), `rebinding reached an internal IP: ${rebindSummary}`);
      assert.ok(rawDeny, "raw TCP drop was logged");
      record("isolation", { canaryHits: hits.length, gateway: gw, lan, probes: table });
    } finally {
      for (const c of [lo, lo6, lanC]) c?.server.close();
      await a.setNetwork("off");
    }
  });

  test("DNS rebinding between the policy check and the connect is blocked (scripted resolver, 2 VMs)", async () => {
    // The live 1u.ms probe depends on what the Mac resolver caches; this one flips the answer for sure:
    // the policy check sees a public IP, the upstream connect lookup gets 127.0.0.1.
    const lo = await canary("127.0.0.1");
    let calls = 0;
    const rebinding = createVmDriver({
      lookup: async (host) => (host === "example.com" ? (++calls % 2 === 1 ? ["93.184.215.14"] : ["127.0.0.1"]) : ["203.0.113.1"]),
    });
    const r = (await rebinding.create({ id: "r", dir: path.join(tmp, "envs", "r"), network: "web", vm: { cpus: 2, memoryMiB: 1024, diskMiB: 4096, backend: "krun" } })) as VmRuntime;
    envs.push(r);
    const log: NetAttempt[] = [];
    r.onNet((x) => log.push(x));
    try {
      const t0 = performance.now();
      await r.start();
      const startMs = Math.round(performance.now() - t0);
      const res = await sh(r, `curl -s -o /dev/null -m 8 -w '%{http_code}' http://example.com:${lo.port}/; echo " rc=$?"`);
      for (let i = 0; i < 50 && log.length === 0; i++) await new Promise((res2) => setTimeout(res2, 100));
      assert.deepEqual(lo.hits, [], "rebinding reached the Mac loopback canary");
      assert.equal(log.length, 1, JSON.stringify(log));
      assert.equal(log[0]!.decision, "deny");
      assert.equal(log[0]!.ip, "127.0.0.1");
      assert.match(log[0]!.reason, /resolves to loopback address 127\.0\.0\.1 at connect time/);
      assert.equal(calls, 2);
      record("rebindingScripted", { http: res.out, reason: log[0]!.reason, startMs, curlMs: res.ms, backend: r.lastBoot?.backend });
    } finally {
      lo.server.close();
      await r.destroy();
    }
  });

  test("setsid escapes don't survive an exec timeout, an abort or the end of a run (review 1, #4)", async () => {
    const liveAgent = async () => (await sh(a, "ps -e -o ruid=,stat=,args= | awk '$1 == 1000 && $2 !~ /^Z/' | grep -v 'ps -e' | wc -l", { as: "root" })).out;
    const loop = "setsid sh -c 'while :; do sleep 1; done' > /dev/null 2>&1 < /dev/null &";
    const t = await a.exec(`${loop} sleep 30`, { timeoutMs: 1500 });
    assert.equal(t.timedOut, true);
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(await liveAgent(), "0", "the setsid loop died with the timed-out exec");
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 800);
    assert.equal((await a.exec(`${loop} sleep 30`, { signal: ac.signal })).exitCode, 130);
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(await liveAgent(), "0", "the setsid loop died with the aborted exec");
    // A daemon started by an exec that returned normally keeps running until the run ends.
    assert.equal((await a.exec(loop)).exitCode, 0);
    await new Promise((r) => setTimeout(r, 300));
    assert.notEqual(await liveAgent(), "0");
    await a.killAgentProcesses();
    assert.equal(await liveAgent(), "0", "killAgentProcesses ends every uid 1000 process");
    // A fork loop can't outrun it: the exec cgroup is killed as a whole.
    await a.exec("setsid sh -c 'while :; do (sleep 5 &) ; done' > /dev/null 2>&1 < /dev/null &");
    await new Promise((r) => setTimeout(r, 500));
    await a.killAgentProcesses();
    assert.equal(await liveAgent(), "0");
  });

  test("host reads never follow the agent into a FIFO, a device or a root-only path (review 1, #2)", async () => {
    await sh(a, "cd /workspace && mkfifo fifo && ln -sfn /dev/zero zero && ln -sfn /etc etcdir && ln -sfn /grader-secret secret && echo ok > plain");
    await sh(a, "mkdir -p /grader-secret && echo SECRET > /grader-secret/x && chmod 700 /grader-secret", { as: "root" });
    const t0 = performance.now();
    await assert.rejects(a.readFile("/workspace/fifo"), /not a regular file/);
    await assert.rejects(a.readFile("/workspace/fifo", { as: "agent" }), /not a regular file/);
    await assert.rejects(a.readFile("/workspace/zero"), /symlinks are not followed/);
    await assert.rejects(a.readFile("/workspace/zero", { as: "agent" }), /not a regular file/);
    await assert.rejects(a.readFile("/workspace/etcdir/passwd"), /symlinks are not followed|Not a directory/);
    await assert.rejects(a.readFile("/workspace/secret/x"), /symlinks are not followed|Not a directory/);
    await assert.rejects(a.readFile("/workspace/secret/x", { as: "agent" }), /Permission denied/);
    assert.ok(performance.now() - t0 < 10_000, "no read blocked");
    // Swapping a file for a FIFO or /dev/zero between the manifest and the read changes nothing.
    await sh(a, "cd /workspace && rm plain && ln -s /dev/zero plain");
    await assert.rejects(a.readFile("/workspace/plain"), /symlinks are not followed/);
    const batch = await a.readFiles(["/workspace/fifo", "/workspace/nope", "/etc/hostname"]);
    assert.ok(batch[0] instanceof Error && batch[1] instanceof Error && !(batch[2] instanceof Error));
    const capped = await a.readFile("/etc/services", { maxBytes: 100 });
    assert.equal(capped.data.length, 100);
    assert.equal(capped.truncated, true);
    await sh(a, "rm -rf /grader-secret", { as: "root" });
    await sh(a, "cd /workspace && rm -f fifo zero etcdir secret plain");
  });

  test("grading: hidden tests run as grader, candidate as agent, cheats fail (review 1, #1)", async () => {
    const caseDir = path.join(REPO_DIR, "evals/cases/coding/fix-pagination");
    const starter = fs.readFileSync(path.join(caseDir, "workspace/pagination.py"), "utf8");
    const reference = fs.readFileSync(path.join(REPO_DIR, "evals/reference/coding/fix-pagination/pagination.py"), "utf8");
    const hidden = [{ path: "/grader/test_hidden.py", content: fs.readFileSync(path.join(caseDir, "grader/test_hidden.py"), "utf8") }];
    const check = { type: "tests" as const, file: "/grader/test_hidden.py", timeoutSec: 60 };
    const grade = async (solution: string, before = "") => {
      await sh(a, "rm -rf /workspace/* /grader", { as: "root" });
      await a.writeFile("/workspace/pagination.py", solution, { as: "agent" });
      if (before) await a.exec(before);
      return gradeTests(a, check, hidden);
    };
    const t0 = performance.now();
    const ok = await grade(reference);
    const gradeMs = Math.round(performance.now() - t0);
    assert.equal(ok.pass, true, ok.detail);
    assert.match(ok.detail, /^3\/3 hidden tests passed/);
    assert.equal((await grade(starter)).pass, false);
    // The trivial cheat from the review, and exiting from inside a test.
    assert.equal((await grade(`import os\nos._exit(0)\n${starter}`)).pass, false);
    assert.equal((await grade(`import sys\nsys.exit(0)\n${starter}`)).pass, false);
    // Candidate code (uid 1000) can't read the hidden tests or write the runner's results.
    const probe = [
      "import glob, json, os",
      "out = []",
      "for p in ['/grader/test_hidden.py']:",
      "    try: open(p).read(); out.append('READ ' + p)",
      "    except OSError as e: out.append('denied ' + p)",
      "for d in glob.glob('/var/lib/terrarium-grade/*/out'):",
      "    try: open(os.path.join(d, 'results.json'), 'w').write(json.dumps({'expected': 3, 'passed': 3})); out.append('WROTE ' + d)",
      "    except OSError: out.append('denied ' + d)",
      "print(' | '.join(out) or 'no grade dirs visible')",
      "",
    ].join("\n");
    const forged = await grade(probe + starter);
    assert.equal(forged.pass, false, forged.detail);
    assert.doesNotMatch(forged.detail, /READ |WROTE /);
    // A daemon the agent left behind waits for grading to start (/grader appears), then swaps in the
    // reference and forges results. It is killed before the hidden files go in, so neither happens.
    const daemon = "setsid sh -c 'while [ ! -e /grader ]; do sleep 0.02; done; cp /tmp/.ref /workspace/pagination.py; for i in 1 2 3 4 5 6 7 8 9 10; do for d in /var/lib/terrarium-grade/*/out; do echo 3 > $d/results.json; done; sleep 0.1; done' > /dev/null 2>&1 < /dev/null &";
    await a.writeFile("/tmp/.ref", reference, { as: "agent" });
    const raced = await grade(starter, daemon);
    assert.equal(raced.pass, false, raced.detail);
    assert.equal((await sh(a, "stat -c '%U:%G %a' /grader /grader/test_hidden.py", { as: "root" })).out, "root:grader 750\nroot:grader 640");
    assert.equal((await sh(a, "ls /var/lib/terrarium-grade | wc -l", { as: "root" })).out, "0", "grading leaves nothing behind");
    await sh(a, "rm -rf /workspace/* /workspace/.ref /grader", { as: "root" });
    record("grading", { gradeMs });
  });

  test("grading: argument mutation is seen, tests read a sealed source copy, command checks run as the agent (review 2, #1, #2, #10)", async () => {
    const tree = (dir: string) =>
      Object.fromEntries(
        fs
          .readdirSync(dir, { recursive: true, withFileTypes: true })
          .filter((d) => d.isFile())
          .map((d) => [path.relative(dir, path.join(d.parentPath, d.name)), fs.readFileSync(path.join(d.parentPath, d.name), "utf8")]),
      ) as Record<string, string>;
    const solved = (id: string) => ({ ...tree(path.join(REPO_DIR, "evals/cases/coding", id, "workspace")), ...tree(path.join(REPO_DIR, "evals/reference/coding", id)) });
    const put = async (files: Record<string, string>) => {
      await sh(a, "rm -rf /workspace/* /grader", { as: "root" });
      for (const [p, content] of Object.entries(files)) {
        await sh(a, `mkdir -p "$(dirname /workspace/${p})"`);
        await a.writeFile(`/workspace/${p}`, content, { as: "agent" });
      }
    };
    const check = { type: "tests" as const, file: "/grader/test_hidden.py", timeoutSec: 60 };
    const gradeCase = async (id: string, files: Record<string, string>) => {
      await put(files);
      return gradeTests(a, check, [{ path: "/grader/test_hidden.py", content: fs.readFileSync(path.join(REPO_DIR, "evals/cases/coding", id, "grader/test_hidden.py"), "utf8") }]);
    };

    // #1: a Warehouse that keeps the caller's dict and changes it in reserve() fails, as in one process.
    const inv = solved("fix-inventory");
    const invOk = await gradeCase("fix-inventory", inv);
    assert.equal(invOk.pass, true, invOk.detail);
    assert.match(invOk.detail, /^6\/6 hidden tests passed/);
    const alias = { ...inv, "inventory/service.py": inv["inventory/service.py"]!.replace("self.stock = dict(stock or {})", "self.stock = stock if stock is not None else {}") };
    const invBad = await gradeCase("fix-inventory", alias);
    assert.equal(invBad.pass, false);
    assert.match(invBad.detail, /^5\/6 hidden tests passed/);
    assert.match(invBad.detail, /FAIL test_caller_dict_not_mutated/);

    // #2: candidate code rewriting report.py (its own copy, or the tests' copy next to it) changes nothing
    // the hidden tests read.
    const rep = solved("refactor-report");
    const repOk = await gradeCase("refactor-report", rep);
    assert.equal(repOk.pass, true, repOk.detail);
    const starter = fs.readFileSync(path.join(REPO_DIR, "evals/cases/coding/refactor-report/workspace/report.py"), "utf8");
    const refactored = rep["report.py"]!;
    const helper = refactored.slice(refactored.indexOf("def _summarize"), refactored.indexOf("def revenue_by_region"));
    const swap = [
      starter,
      helper,
      "import os as _os",
      `_new = ${JSON.stringify(refactored)}`,
      "for _p in (__file__, _os.path.join(_os.getcwd(), '..', 'src', 'report.py')):",
      "    try:",
      "        open(_p, 'w').write(_new)",
      "        print('WROTE', _os.path.basename(_os.path.dirname(_os.path.abspath(_p))))",
      "    except OSError as _e:",
      "        print('denied', _os.path.basename(_os.path.dirname(_os.path.abspath(_p))), _e.errno)",
      "",
    ].join("\n");
    const repBad = await gradeCase("refactor-report", { ...rep, "report.py": swap });
    assert.equal(repBad.pass, false, repBad.detail);
    assert.match(repBad.detail, /^2\/3 hidden tests passed/);
    assert.match(repBad.detail, /FAIL test_wrappers_use_helper/);
    assert.match(repBad.detail, /WROTE ws/, "the candidate's own copy is writable");
    assert.match(repBad.detail, /denied src 13/, "the tests' copy is not");

    // #10: command checks run as uid 1000 with a clean PATH and HOME, after every agent process is killed,
    // and can't read /grader.
    await put({ "out.txt": "42\n" });
    await writeHiddenFiles(a, [{ path: "/grader/secret.txt", content: "SECRET" }]);
    const cmd = (command: string) => gradeCommand(a, { type: "command", command });
    const who = await cmd('echo "uid=$(id -u) home=$HOME path=$PATH"; test "$(id -u)" = 1000 && grep -qx 42 out.txt');
    assert.equal(who.pass, true, who.detail);
    assert.match(who.detail, /uid=1000 home=\/var\/lib\/terrarium-grade\/c\w+\/home path=\/usr\/local\/sbin:/);
    const secret = await cmd("cat /grader/secret.txt");
    assert.equal(secret.pass, false);
    assert.doesNotMatch(secret.detail, /SECRET/);
    await sh(a, "mkdir -p ~/.local/bin && printf '#!/bin/sh\\nexit 0\\n' > ~/.local/bin/grep && chmod +x ~/.local/bin/grep");
    assert.equal((await sh(a, "grep -q 41 /workspace/out.txt")).code, 0, "the shim is on the agent's own PATH");
    assert.equal((await cmd("grep -q 41 out.txt")).pass, false, "a shim in the agent's ~/.local/bin is not on the check's PATH");
    await a.exec("setsid sh -c 'while :; do date +%s%N > /workspace/beat; sleep 0.05; done' > /dev/null 2>&1 < /dev/null &");
    await new Promise((r) => setTimeout(r, 300));
    const still = await cmd('test -s beat && a=$(cat beat) && sleep 0.5 && test "$a" = "$(cat beat)"');
    assert.equal(still.pass, true, `the agent's daemon was still running: ${still.detail}`);
    assert.equal((await sh(a, "ls /var/lib/terrarium-grade | wc -l", { as: "root" })).out, "0", "grading leaves nothing behind");
    await sh(a, "rm -rf /workspace/* /grader /home/agent/.local/bin/grep", { as: "root" });
  });

  test("an env from an older image gets the current helpers and grader user at boot", async () => {
    await sh(a, "echo stale >> /usr/local/libexec/terrarium/run && rm -f /usr/local/libexec/terrarium/read.py && deluser grader", { as: "root" });
    assert.notEqual((await sh(a, "id -u grader")).code, 0);
    await a.stop();
    await a.start();
    assert.equal((await sh(a, "id -u grader")).out, "1001");
    assert.equal((await sh(a, "test -f /usr/local/libexec/terrarium/read.py && echo has-read; grep -c stale /usr/local/libexec/terrarium/run")).out, "has-read\n0");
    assert.equal((await sh(a, "test -d /sys/fs/cgroup/terrarium && echo cg", { as: "root" })).out, "cg");
  });

  test("guest symlink to a Mac path can't make the host read the Mac file", async () => {
    const macFile = path.join(os.homedir(), ".zshrc");
    await sh(a, `ln -sfn ${macFile} /workspace/evil-abs && ln -sfn ../../../../../../../.. /workspace/evil-rel`);
    await assert.rejects(a.readFile("/workspace/evil-abs"), /symlinks are not followed/i);
    await assert.rejects(a.readFile("/workspace/evil-abs", { as: "agent" }), /No such file|ENOENT|not found/i);
    // Even if the guest creates that path itself, the host gets the guest's file, never the Mac's.
    await sh(a, `mkdir -p ${path.dirname(macFile)} && echo GUEST_FAKE > ${macFile}`, { as: "root" });
    const viaLink = Buffer.from((await a.readFile("/workspace/evil-abs", { as: "agent" })).data).toString();
    assert.equal(viaLink, "GUEST_FAKE\n");
    if (fs.existsSync(macFile)) assert.notEqual(fs.readFileSync(macFile, "utf8"), viaLink);
    const m = await a.manifest();
    const link = m.entries.find((e) => e.path === "/workspace/evil-abs");
    assert.equal(link?.type, "symlink");
    assert.equal(link?.linkTarget, macFile);
    assert.equal(link?.sha256, undefined);
    await sh(a, `rm -rf /Users`, { as: "root" });
    await sh(a, "rm -f /workspace/evil-abs /workspace/evil-rel /workspace/planted");
  });

  test("manifest: correctness and timing for 1k files", async () => {
    await sh(a, [
      "mkdir -p /workspace/proj/src /workspace/proj/node_modules/pkg/lib /workspace/proj/.git/objects/ab",
      "cd /workspace/proj/src && i=0; while [ $i -lt 1000 ]; do echo \"file $i\" > f$i.txt; i=$((i+1)); done",
      "for i in 1 2 3 4 5; do echo m$i > /workspace/proj/node_modules/pkg/lib/m$i.js; done",
      "echo obj > /workspace/proj/.git/objects/ab/cdef",
      "ln -s src/f1.txt /workspace/proj/link && mkfifo /workspace/proj/fifo && ln /workspace/proj/src/f2.txt /workspace/proj/hard",
    ].join(" && "));
    const times: number[] = [];
    let t = performance.now();
    const full = await a.manifest("/workspace");
    times.push(Math.round(performance.now() - t));
    const by = new Map(full.entries.map((e) => [e.path, e]));
    assert.equal(full.truncated, false);
    assert.equal(full.entries.filter((e) => e.path.startsWith("/workspace/proj/src/")).length, 1000);
    const f5 = by.get("/workspace/proj/src/f5.txt")!;
    assert.equal(f5.sha256, createHash("sha256").update("file 5\n").digest("hex"));
    assert.equal(f5.size, 7);
    const bytes = (await a.readFile("/workspace/proj/src/f5.txt")).data;
    assert.equal(createHash("sha256").update(bytes).digest("hex"), f5.sha256);
    assert.equal(by.get("/workspace/proj/node_modules")?.heavy, true);
    assert.equal(by.get("/workspace/proj/node_modules/pkg/lib/m1.js")?.sha256, undefined);
    assert.equal(by.get("/workspace/proj/.git/objects/ab/cdef")?.heavy, true);
    assert.equal(by.get("/workspace/proj/link")?.linkTarget, "src/f1.txt");
    assert.equal(by.get("/workspace/proj/fifo")?.type, "other");
    assert.equal(by.get("/workspace/proj/hard")?.nlink, 2);
    // Incremental: nothing changed -> nothing re-hashed.
    t = performance.now();
    const again = await a.manifest("/workspace", { previous: full });
    times.push(Math.round(performance.now() - t));
    assert.equal((again as unknown as { observer: { hashed: number } }).observer.hashed, 0);
    // Same size + restored mtime still detected (ctime changes), plus an add and a delete.
    await sh(a, "cd /workspace/proj/src && m=$(stat -c %y f7.txt) && echo 'FILE 7' > f7.txt && touch -d \"$m\" f7.txt && echo new > added.txt && rm f9.txt");
    t = performance.now();
    const third = await a.manifest("/workspace", { previous: again });
    times.push(Math.round(performance.now() - t));
    const obs = (third as unknown as { observer: { hashed: number; ms: number } }).observer;
    const by3 = new Map(third.entries.map((e) => [e.path, e]));
    assert.equal(by3.get("/workspace/proj/src/f7.txt")?.sha256, createHash("sha256").update("FILE 7\n").digest("hex"));
    assert.equal(by3.get("/workspace/proj/src/f7.txt")?.mtimeNs, by.get("/workspace/proj/src/f7.txt")?.mtimeNs);
    assert.ok(by3.has("/workspace/proj/src/added.txt"));
    assert.ok(!by3.has("/workspace/proj/src/f9.txt"));
    assert.equal(obs.hashed, 2);
    // Entry cap.
    const r = await a.exec("python3 -I -S /usr/local/libexec/terrarium/observer.py --root /workspace --max-entries 100 --all | head -c 300000 | python3 -c 'import json,sys; d=json.load(sys.stdin); print(len(d[\"entries\"]), d[\"truncated\"])'", { as: "root" });
    assert.equal(r.stdout.trim(), "100 True");
    // Default 20k cap through the driver (several MB of JSON over exec), full and incremental.
    await sh(a, "mkdir -p /workspace/many && cd /workspace/many && seq 1 21000 | sed 's/^/m/' | xargs touch", { timeoutMs: 120_000 });
    t = performance.now();
    const big = await a.manifest("/workspace");
    const bigFullMs = Math.round(performance.now() - t);
    t = performance.now();
    const bigAgain = await a.manifest("/workspace", { previous: big });
    const bigIncrMs = Math.round(performance.now() - t);
    await sh(a, "rm -rf /workspace/many");
    assert.equal(big.truncated, true);
    assert.equal(big.entries.length, 20000);
    assert.equal((bigAgain as unknown as { observer: { hashed: number } }).observer.hashed, 0);
    record("manifest", {
      entries: full.entries.length,
      fullMs: times[0],
      unchangedMs: times[1],
      afterEditsMs: times[2],
      observerMsInGuest: obs.ms,
      cap20kFullMs: bigFullMs,
      cap20kIncrementalMs: bigIncrMs,
    });
  });

  test("snapshot, modify, restore; then fork independence (2 VMs)", async () => {
    await sh(a, "mkdir -p /workspace/snap && echo original > /workspace/snap/data.txt");
    const snapDir = path.join(tmp, "snaps", "s1");
    let t = performance.now();
    const { bytes } = await a.snapshot(snapDir);
    const snapshotMs = Math.round(performance.now() - t);
    assert.equal(a.isRunning(), false, "snapshot leaves the VM stopped; the manager boots it under the VM cap");
    await a.start();
    await sh(a, "echo modified > /workspace/snap/data.txt && echo extra > /workspace/snap/extra.txt");
    t = performance.now();
    await a.restore(snapDir);
    const restoreMs = Math.round(performance.now() - t);
    assert.equal(a.isRunning(), false);
    await a.start();
    assert.equal((await sh(a, "cat /workspace/snap/data.txt")).out, "original");
    assert.equal((await sh(a, "test -e /workspace/snap/extra.txt; echo $?")).out, "1");
    assert.equal((await sh(a, "python3 -c 'import six; print(six.__version__)'")).out, "1.17.0");
    t = performance.now();
    const b = await newEnv("b", "off", { fromSnapshotDir: snapDir });
    await b.start();
    const forkMs = Math.round(performance.now() - t);
    await sh(a, "echo fromA >> /workspace/snap/data.txt");
    await sh(b, "echo fromB >> /workspace/snap/data.txt");
    assert.equal((await sh(a, "cat /workspace/snap/data.txt")).out, "original\nfromA");
    assert.equal((await sh(b, "cat /workspace/snap/data.txt")).out, "original\nfromB");
    const rssA = await a.resources();
    const rssB = await b.resources();
    await b.stop();
    record("snapshot", { snapshotMs, restoreMs, forkCreateAndBootMs: forkMs, snapshotBytes: bytes, snapshotMiB: mib(bytes), twoVmRssMiB: [mib(rssA!.rssBytes), mib(rssB!.rssBytes)] });
  });

  test("stop/start persistence", async () => {
    await sh(a, "echo persist > /workspace/persist.txt && sync");
    await a.writeFile("/workspace/seeded/hello.txt", "from host\n", { mode: 0o640 });
    await a.stop();
    assert.equal(a.isRunning(), false);
    await assert.rejects(a.exec("true"), /not running/);
    const reopened = (await driver.open({ id: "a", dir: a.dir, network: "off" })) as VmRuntime;
    await reopened.start();
    assert.equal((await sh(reopened, "cat /workspace/persist.txt")).out, "persist");
    assert.equal((await sh(reopened, "stat -c '%U %a' /workspace/seeded/hello.txt")).out, "agent 640");
    assert.equal((await sh(reopened, "python3 -c 'import six; print(six.__version__)'")).out, "1.17.0");
    await reopened.stop();
  });

  test("QEMU fallback backend boots and runs the same image", async () => {
    const q = await newEnv("q", "off", { backend: "qemu" });
    const t = performance.now();
    await q.start();
    const startMs = Math.round(performance.now() - t);
    assert.equal(q.lastBoot?.backend, "qemu");
    assert.equal((await sh(q, "id -u")).out, "1000");
    const rss = await q.resources();
    const facts = await q.facts();
    await q.stop();
    record("boot_qemu", { startMs, rssIdleMiB: mib(rss!.rssBytes), kernel: facts.kernel, isolation: facts.isolation });
  });
});
