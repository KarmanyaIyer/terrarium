// Host disk growth (review 1, #9): manifests stored as deltas, unreferenced blobs collected, repeated net
// decisions collapsed into one row.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { NetEntry } from "@terrarium/shared";
import { EnvManager } from "../envs/manager.ts";
import type { EnvDriver, EnvRuntime, Manifest, ManifestEntry, NetAttempt } from "../envs/types.ts";
import { Hub } from "../hub.ts";
import { Store } from "./db.ts";
import { BlobGc } from "./gc.ts";
import { FULL_EVERY, ManifestStore } from "./manifests.ts";

let dir: string;
let store: Store;

before(() => {
  dir = mkdtempSync(join(tmpdir(), "terrarium-gc-"));
  store = new Store(join(dir, "db.sqlite"), join(dir, "blobs"));
});

after(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

function entry(i: number, sha?: string): ManifestEntry {
  return { path: `/workspace/f${String(i).padStart(5, "0")}.txt`, type: "file", size: 10, mode: 0o644, mtimeNs: "1", ino: i, nlink: 1, sha256: sha ?? "0".repeat(63) + "1" };
}

function manifest(entries: ManifestEntry[], takenAt: number): Manifest {
  return { root: "/workspace", takenAt, truncated: false, entries };
}

const blobBytes = (sha: string) => statSync(join(store.blobs.dir, sha.slice(0, 2), sha)).size;

test("manifests are stored as deltas with a full copy every 16, and resolve exactly", () => {
  let entries = Array.from({ length: 2000 }, (_, i) => entry(i));
  const saved: { blob: string; m: Manifest }[] = [];
  let prev = null;
  for (let step = 0; step < 40; step++) {
    entries = entries.map((e, i) => (i === step ? { ...e, size: e.size + 1, mtimeNs: String(step + 2) } : e));
    if (step % 7 === 3) entries = entries.filter((_, i) => i !== 1000 + step);
    if (step % 5 === 1) entries = [...entries, entry(5000 + step)].sort((a, b) => (a.path < b.path ? -1 : 1));
    const m = manifest(entries, 1000 + step);
    prev = store.manifests.save(m, prev);
    saved.push({ blob: prev.blob, m });
  }
  const full = blobBytes(saved[0].blob);
  const delta = blobBytes(saved[1].blob);
  assert.ok(delta * 50 < full, `delta ${delta} B vs full ${full} B`);
  assert.equal(blobBytes(saved[FULL_EVERY].blob) > full / 2, true, "a full copy every 16 saves");
  // A fresh reader (no cache, as after a restart) resolves every stored manifest to what was saved.
  const reader = new ManifestStore(store.blobs);
  for (const s of saved) assert.deepEqual(reader.load(s.blob), s.m);
  const last = reader.loadSaved(saved.at(-1)!.blob)!;
  assert.equal(last.depth, (saved.length - 1) % FULL_EVERY);
  // Identical consecutive manifests cost a few hundred bytes, not another full copy.
  const same = store.manifests.save(manifest(entries, 9999), last);
  assert.ok(blobBytes(same.blob) < 400);
});

test("blob GC keeps what rows name (directly, in payloads, through manifests) and removes the rest", async () => {
  const old = new Date(Date.now() - 3600_000);
  const put = (s: string) => store.blobs.put(s);
  const age = (sha: string) => utimesSync(join(store.blobs.dir, sha.slice(0, 2), sha), old, old);
  const transcript = put("transcript");
  const request = put("request");
  const stdout = put("stdout");
  const diff = put("diff text");
  const fileContent = put("captured file");
  const garbage = put("nobody names me");
  const recent = put("written a moment ago, row not inserted yet");
  const now = Date.now();
  store.run("INSERT INTO sessions (id, title, model_id, harness, context_window, max_output_tokens, status, transcript_blob, created_at, updated_at) VALUES ('s1', 't', 'm', 'h', 1, 1, 'idle', ?, ?, ?)", transcript, now, now);
  store.run("INSERT INTO model_calls (id, session_id, seq, model_id, request_blob, created_at) VALUES ('c1', 's1', 1, 'm', ?, ?)", request, now);
  store.run("INSERT INTO user_exec (id, env_id, ts, as_user, command, stdout_blob) VALUES ('u1', 'e1', ?, 'agent', 'ls', ?)", now, stdout);
  store.run("INSERT INTO events (session_id, seq, ts, type, payload_json) VALUES ('s1', 2, ?, 'fs_change', ?)", now, JSON.stringify({ changes: [{ path: "/workspace/a", diffBlob: diff }] }));
  const base = store.manifests.save(manifest([entry(1, fileContent)], 1), null);
  const head = store.manifests.save(manifest([entry(1, fileContent), entry(2)], 2), base);
  store.run("INSERT INTO manifests (env_id, session_id, seq, blob, created_at) VALUES ('e1', 's2', 3, ?, ?)", head.blob, now);
  const tmp = join(store.blobs.dir, "ab", `${"ab".repeat(32)}.1234.tmp`);
  mkdirSync(join(store.blobs.dir, "ab"), { recursive: true });
  writeFileSync(tmp, "half written");
  utimesSync(tmp, old, old);
  for (const sha of [transcript, request, stdout, diff, fileContent, garbage, base.blob, head.blob]) age(sha);

  const gc = new BlobGc(store);
  const r = await gc.run({ graceMs: 60_000 });
  assert.equal(r.removed, 2, "the unnamed old blob and the stale tmp file");
  assert.equal(store.blobs.has(garbage), false);
  assert.equal(readdirSync(join(store.blobs.dir, "ab")).length, 0);
  for (const sha of [transcript, request, stdout, diff, fileContent, base.blob, head.blob, recent]) assert.ok(store.blobs.has(sha), sha);

  // Re-storing existing content refreshes it, so a sweep can't delete a blob a writer just reused.
  age(request);
  store.run("DELETE FROM model_calls");
  put("request");
  await gc.run({ graceMs: 60_000 });
  assert.ok(store.blobs.has(request));

  // Once the session's manifests go, the whole chain and the file contents only it named go too.
  store.run("DELETE FROM manifests WHERE session_id = 's2'");
  age(request);
  const r2 = await gc.run({ graceMs: 60_000 });
  assert.equal(store.blobs.has(head.blob) || store.blobs.has(base.blob) || store.blobs.has(fileContent), false);
  assert.equal(r2.removed, 4);
});

test("identical net decisions collapse into one row with a count", async () => {
  const hub = new Hub();
  const broadcasts: NetEntry[] = [];
  hub.listen((m) => {
    if (m.type === "env_net") broadcasts.push(m.entry);
  });
  let emit: (a: NetAttempt) => void = () => {};
  const rt = {
    id: "vm1",
    type: "vm",
    dir,
    isRunning: () => false,
    onNet: (l: (a: NetAttempt) => void) => ((emit = l), () => {}),
    async snapshot(d: string) {
      mkdirSync(d, { recursive: true });
      return { bytes: 0 };
    },
  } as unknown as EnvRuntime;
  const driver = { type: "vm", create: async () => rt, open: async () => rt, check: async () => ({ ok: true, detail: "" }) } satisfies EnvDriver;
  const envs = new EnvManager({ store, hub, dataDir: dir, drivers: { vm: driver, sim: null } });
  const env = await envs.create({ name: "net", type: "vm" });
  const t0 = Date.now();
  const deny = (ts: number, url = "http://10.0.0.1/") => emit({ ts, method: "GET", url, host: "10.0.0.1", ip: "10.0.0.1", decision: "deny", reason: "private range 10.0.0.1" });
  for (let i = 0; i < 5000; i++) deny(t0 + i);
  deny(t0 + 10, "http://10.0.0.2/");
  deny(t0 + 5000 + 61_000); // after a quiet minute: a new row
  envs.flushNetRepeats();
  const rows = store.all<{ url: string; repeats: number; last_ts: number | null }>("SELECT url, repeats, last_ts FROM net_log WHERE env_id = ? ORDER BY ts", env.id);
  assert.deepEqual(
    rows.map((r) => [r.url, r.repeats]),
    [
      ["http://10.0.0.1/", 5000],
      ["http://10.0.0.2/", 1],
      ["http://10.0.0.1/", 1],
    ],
  );
  assert.equal(rows[0].last_ts, t0 + 4999);
  assert.ok(broadcasts.length <= 5, `${broadcasts.length} broadcasts for 5002 attempts`);
  const listed = envs.netLog(env.id).find((e) => e.repeats);
  assert.equal(listed?.repeats, 5000);
});
