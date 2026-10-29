import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { simDriver } from "../envs/sim/driver.ts";
import type { EnvRuntime } from "../envs/types.ts";
import { clipForModel, piStockTools, terrariumTools, type ToolHost } from "./tools.ts";

let dir: string;
let rt: EnvRuntime;
let host: ToolHost;
const streamed: string[] = [];

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "terrarium-tools-"));
  rt = await simDriver.create({ id: "tools", dir, network: "off", sim: { python: false, javascript: false, maxTotalBytes: 8 * 1024 * 1024 } });
  await rt.start();
  host = { runtime: rt, outputChars: 400, onOutput: (_id, stream, chunk) => streamed.push(`${stream}:${chunk}`) };
});

after(async () => {
  await rt.destroy();
  rmSync(dir, { recursive: true, force: true });
});

const tool = (set: ReturnType<typeof terrariumTools>, name: string) => set.find((t) => t.name === name)!;
const text = (r: { content: { type: string; text?: string }[] }) => r.content.map((c) => c.text ?? "").join("");

test("bash: plain stdout on success, exit code and streams on failure, live output", async () => {
  const t = terrariumTools(host);
  const ok = await tool(t, "bash").execute("b1", { command: "echo hello" });
  assert.equal(text(ok), "hello");
  assert.ok(streamed.some((s) => s.includes("hello")));
  const bad = await tool(t, "bash").execute("b2", { command: "echo out; echo err >&2; exit 3" });
  assert.equal(text(bad), "exit code: 3\nstdout:\nout\nstderr:\nerr");
  assert.equal(bad.details.exitCode, 3);
});

test("bash: long output is clipped head + tail for the model, kept in details", async () => {
  const r = await tool(terrariumTools(host), "bash").execute("b3", { command: "for i in $(seq 1 200); do echo line$i; done" });
  assert.match(text(r), /^line1\n/);
  assert.match(text(r), /characters of output removed by the harness/);
  assert.match(text(r), /line200$/);
  assert.equal(r.details.stdout?.split("\n").length, 201);
  assert.equal(clipForModel("short", 100), "short");
});

test("write, read with offset/limit, edit with uniqueness checks", async () => {
  const t = terrariumTools(host);
  await tool(t, "write").execute("w", { path: "a.txt", content: "one\ntwo\nthree\ntwo\n" });
  assert.equal(text(await tool(t, "read").execute("r", { path: "/workspace/a.txt", offset: 2, limit: 2 })), "two\nthree\n[lines 2-3 of 5; use offset to read more]");
  await assert.rejects(tool(t, "edit").execute("e1", { path: "a.txt", old_text: "two", new_text: "2" }), /matches 2 places/);
  await assert.rejects(tool(t, "edit").execute("e2", { path: "a.txt", old_text: "four", new_text: "4" }), /not found/);
  await tool(t, "edit").execute("e3", { path: "a.txt", old_text: "three", new_text: "3" });
  assert.equal(Buffer.from((await rt.readFile("/workspace/a.txt")).data).toString(), "one\ntwo\n3\ntwo\n");
  await assert.rejects(tool(t, "read").execute("r2", { path: "missing.txt" }));
});

test("pi-stock edit applies several disjoint edits against the original text", async () => {
  const p = piStockTools(host);
  await tool(p, "write").execute("w", { path: "b.py", content: "a = 1\nb = 2\nc = 3\n" });
  await tool(p, "edit").execute("e", { path: "b.py", edits: [{ oldText: "a = 1", newText: "a = 10" }, { oldText: "c = 3", newText: "c = 30" }] });
  assert.equal(Buffer.from((await rt.readFile("/workspace/b.py")).data).toString(), "a = 10\nb = 2\nc = 30\n");
  await assert.rejects(tool(p, "edit").execute("e2", { path: "b.py", edits: [{ oldText: "a = 10\nb", newText: "x" }, { oldText: "b = 2", newText: "y" }] }), /overlap/);
});

test("read refuses binary files", async () => {
  await rt.writeFile("/workspace/bin.dat", new Uint8Array([0, 1, 2, 255, 0]));
  await assert.rejects(tool(terrariumTools(host), "read").execute("r", { path: "bin.dat" }), /binary/);
});
