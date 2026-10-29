// Sim env isolation: the worker's sandbox-exec profile (host reads under $HOME, writes, network, exec) and the
// fetch proxy's policy (private ranges, loopback, mode off), with every attempt logged.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { EnvRuntime, NetAttempt } from "../types.ts";
import { simDriver } from "./driver.ts";
import { buildProfile, nodeExecutable, SANDBOX_EXEC } from "./sandbox.ts";

const HOME = homedir();
const hostFile = [join(HOME, ".zshrc"), join(HOME, "Library/Preferences/.GlobalPreferences.plist"), join(HOME, ".gitconfig")].find(existsSync);

function sandboxed(code: string) {
  return spawnSync(SANDBOX_EXEC, ["-p", buildProfile(), nodeExecutable(), "-e", code], { encoding: "utf8", timeout: 30_000, cwd: "/" });
}

test("sandbox profile denies reading host files under $HOME", { skip: !hostFile && "no readable host file to probe" }, () => {
  const plain = spawnSync(nodeExecutable(), ["-e", `require("fs").readFileSync(${JSON.stringify(hostFile)}); console.log("read")`], { encoding: "utf8" });
  assert.match(plain.stdout, /read/, "file is readable outside the sandbox");
  const r = sandboxed(`try { require("fs").readFileSync(${JSON.stringify(hostFile)}); console.log("READ") } catch (e) { console.log(e.code) }`);
  assert.match(r.stdout, /EPERM|EACCES/, `stdout=${r.stdout} stderr=${r.stderr.slice(0, 200)}`);
});

test("sandbox profile denies network, file writes and exec of other binaries", () => {
  const net = sandboxed(`const s = require("net").connect(80, "1.1.1.1"); s.on("connect", () => { console.log("CONNECTED"); process.exit(0) }); s.on("error", (e) => { console.log(e.code); process.exit(0) }); setTimeout(() => { console.log("TIMEOUT"); process.exit(0) }, 5000)`);
  assert.match(net.stdout, /EPERM|EACCES/, `net: ${net.stdout}`);
  const target = join(tmpdir(), `terrarium-sbx-${process.pid}`);
  const write = sandboxed(`try { require("fs").writeFileSync(${JSON.stringify(target)}, "x"); console.log("WROTE") } catch (e) { console.log(e.code) }`);
  assert.match(write.stdout, /EPERM|EACCES/, `write: ${write.stdout}`);
  assert.equal(existsSync(target), false);
  const exec = sandboxed(`try { console.log(require("child_process").execFileSync("/bin/ls", ["/"]).length ? "RAN" : "") } catch (e) { console.log(e.code ?? e.message) }`);
  assert.doesNotMatch(exec.stdout, /RAN/, `exec: ${exec.stdout}`);
});

test("deny-default profile: no reads outside the code it runs, no Mach services, no other processes (review 1, #11)", () => {
  const probe = (code: string) => sandboxed(`try { ${code}; console.log("ALLOWED") } catch (e) { console.log(e.code ?? e.message) }`).stdout.trim();
  // Readable without a sandbox, denied inside it.
  for (const p of ["/etc/passwd", "/Library/Preferences", "/Applications", "/Users", "/private/var/log", "/opt", "/tmp"]) {
    if (!existsSync(p)) continue;
    const op = p.endsWith("passwd") ? `require("fs").readFileSync(${JSON.stringify(p)})` : `require("fs").readdirSync(${JSON.stringify(p)})`;
    assert.match(probe(op), /EPERM|EACCES/, p);
  }
  // A process outside the sandbox (this test) can't be signalled; the worker can still signal itself.
  assert.match(probe(`process.kill(${process.pid}, 0)`), /EPERM/);
  assert.equal(probe("process.kill(process.pid, 0)"), "ALLOWED");
  // Mach/XPC lookups fail: DNS through mDNSResponder is the easy one to observe from node.
  const dns = sandboxed(`require("dns").lookup("apple.com", (e) => console.log(e ? e.code : "RESOLVED"))`);
  assert.doesNotMatch(dns.stdout, /RESOLVED/, dns.stdout);
  assert.match(buildProfile(), /^\(deny default\)$/m);
  assert.doesNotMatch(buildProfile(), /allow default|mach-lookup|iokit|network/);
});

let dir: string;
let rt: EnvRuntime;
const attempts: NetAttempt[] = [];

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "terrarium-sim-"));
  rt = await simDriver.create({ id: "simtest", dir, network: "web", sim: { python: true, javascript: false, maxTotalBytes: 8 * 1024 * 1024 } });
  rt.onNet((a) => attempts.push(a));
  await rt.start();
});

after(async () => {
  await rt.destroy();
  rmSync(dir, { recursive: true, force: true });
});

test("inside the sim env, host paths do not exist", { skip: !hostFile && "no host file" }, async () => {
  const r = await rt.exec(`cat ${hostFile}; ls ${HOME}`, { timeoutMs: 30_000 });
  assert.notEqual(r.exitCode, 0);
  assert.doesNotMatch(r.stdout, /\S/, `stdout: ${r.stdout.slice(0, 200)}`);
});

test("private, loopback and link-local addresses are denied by policy and logged, even with network web", async () => {
  attempts.length = 0;
  for (const url of ["http://192.168.1.1/", "http://127.0.0.1:8010/v1/models", "http://169.254.169.254/latest/meta-data/", "http://localhost:8010/"]) {
    const r = await rt.exec(`curl -s -m 5 ${url}`, { timeoutMs: 30_000 });
    assert.notEqual(r.exitCode, 0, `${url} should fail: ${r.stdout.slice(0, 100)}`);
  }
  assert.equal(attempts.length, 4, JSON.stringify(attempts));
  for (const a of attempts) assert.equal(a.decision, "deny", `${a.url}: ${a.reason}`);
});

test("network off denies everything without DNS", async () => {
  attempts.length = 0;
  await rt.setNetwork("off");
  const r = await rt.exec("curl -s -m 5 https://example.com/", { timeoutMs: 30_000 });
  assert.notEqual(r.exitCode, 0);
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0].decision, "deny");
  assert.match(attempts[0].reason, /off/);
});

test("python runs in the sim and files round-trip through the runtime", async () => {
  await rt.writeFile("/workspace/x.py", "print(sum(range(10)))\n");
  const r = await rt.exec("python3 x.py", { timeoutMs: 60_000 });
  assert.equal(r.stdout.trim(), "45", r.stderr);
  const m = await rt.manifest("/workspace");
  assert.ok(m.entries.some((e) => e.path === "/workspace/x.py" && e.sha256));
});
