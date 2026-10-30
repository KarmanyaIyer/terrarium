// Sim checkpoints with files larger than one pipe line (review 1, #5): files cross the worker pipe in pieces,
// old state files with whole-file entries still load, and a failed save shows up in the command's stderr.

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { simDriver } from "./driver.ts";
import { MAX_LINE } from "./protocol.ts";
import type { SimRuntime } from "./runtime.ts";

const dirs: string[] = [];
const sim = { python: false, javascript: false, maxTotalBytes: 48 * 1024 * 1024 };
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "terrarium-ckpt-"));
  dirs.push(d);
  return d;
}

test("a file over 12 MiB survives checkpoint, stop and start", async () => {
  const dir = tempDir();
  const big = randomBytes(13 * 1024 * 1024 + 7);
  assert.ok(big.toString("base64").length > MAX_LINE, "one base64 line would not fit");
  const rt = await simDriver.create({ id: "ckpt", dir, network: "off", sim });
  await rt.start();
  await rt.writeFile("/workspace/big.bin", big);
  const r = await rt.exec("cp /workspace/big.bin /workspace/copy.bin && wc -c < /workspace/copy.bin");
  assert.equal(r.exitCode, 0, r.stderr);
  assert.equal(r.stdout.trim(), String(big.length));
  assert.doesNotMatch(r.stderr, /saving the simulated filesystem failed/);
  await rt.stop();

  const again = await simDriver.open({ id: "ckpt", dir, network: "off", sim });
  await again.start();
  for (const p of ["/workspace/big.bin", "/workspace/copy.bin"]) {
    const back = await again.readFile(p, { maxBytes: 32 * 1024 * 1024 });
    assert.equal(back.size, big.length, p);
    assert.equal(back.truncated, false);
    assert.ok(Buffer.from(back.data).equals(big), `${p} round-trips byte for byte`);
  }
  const capped = await again.readFile("/workspace/big.bin", { maxBytes: 5 * 1024 * 1024 });
  assert.equal(capped.data.length, 5 * 1024 * 1024);
  assert.equal(capped.truncated, true);
  await again.destroy();
});

test("an old state file with one whole-file entry over 12 MiB loads", async () => {
  const dir = tempDir();
  const big = randomBytes(14 * 1024 * 1024);
  const rt = await simDriver.create({ id: "old", dir, network: "off", sim });
  const now = Date.now();
  const state = { version: 1, entries: [{ p: "/workspace", t: "d", m: 0o755, mt: now }, { p: "/workspace/old.bin", t: "f", m: 0o600, mt: now, d: big.toString("base64") }] };
  writeFileSync(join(dir, "state.json"), JSON.stringify(state));
  await rt.start();
  const r = await rt.exec("wc -c < /workspace/old.bin");
  assert.equal(r.stdout.trim(), String(big.length));
  const back = await rt.readFile("/workspace/old.bin", { maxBytes: 32 * 1024 * 1024 });
  assert.ok(Buffer.from(back.data).equals(big));
  await rt.destroy();
});

test("a failed save is reported in the command's stderr", async () => {
  const dir = tempDir();
  const rt = (await simDriver.create({ id: "fail", dir, network: "off", sim })) as SimRuntime;
  await rt.start();
  const real = rt.checkpoint.bind(rt);
  rt.checkpoint = async () => {
    throw new Error("disk full");
  };
  const seen: string[] = [];
  const r = await rt.exec("echo hi", { onStderr: (s) => seen.push(s) });
  assert.equal(r.exitCode, 0);
  assert.match(r.stderr, /\[terrarium: saving the simulated filesystem failed \(disk full\)/);
  assert.match(seen.join(""), /saving the simulated filesystem failed/);
  rt.checkpoint = real;
  await rt.destroy();
});

test("batch reads enforce the total byte cap", async () => {
  const dir = tempDir();
  const rt = await simDriver.create({ id: "batch-cap", dir, network: "off", sim });
  await rt.start();
  for (const name of ["a", "b", "c"]) await rt.writeFile(`/workspace/${name}`, "123456");
  const rows = await rt.readFiles(["/workspace/a", "/workspace/b", "/workspace/c"], { maxBytes: 8, totalBytes: 10 });
  assert.deepEqual(rows.map((r) => (r instanceof Error ? r.message : [r.data.byteLength, r.size, r.truncated])), [
    [6, 6, false],
    [4, 6, true],
    "read /workspace/c: batch read limit reached",
  ]);
  await rt.destroy();
});
