// UI catch-up logic (review 3, #8): the net log after a reconnect is never gappy under its "latest N" chip, and a live
// buffer is marked partial only when chunks were actually missed. Run: node --test apps/ui/test/*.test.ts
// (outside src/ so the app's tsc and vite builds don't see node:test).

import assert from "node:assert/strict";
import { test } from "node:test";
import type { NetEntry } from "@terrarium/shared";
import { afterChunk, mergeNetPage } from "../src/lib/catchup.ts";

const row = (i: number, extra: Partial<NetEntry> = {}): NetEntry =>
  ({ id: `n${i}`, envId: "e", ts: i * 1000, method: "GET", url: `http://h/${i}`, host: "h", decision: "deny", reason: "off", ...extra }) as NetEntry;
const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, k) => row(a + k));
const ids = (rows: NetEntry[]) => rows.map((r) => r.id);

test("net log: more than the limit arrived while disconnected, so the old rows give way to the fetched latest N", () => {
  const shown = range(1, 10); // before the disconnect
  const page = range(100, 150).reverse(); // newest 50 + 1 extra (the backend sends newest first); rows 11..99 aren't fetched
  const { rows, capped } = mergeNetPage(shown, page, 50);
  assert.equal(capped, true);
  assert.deepEqual(ids(rows), ids(range(101, 150)), "no rows 1-10 left above a missing 11-100 band");
});

test("net log: exactly `limit` rows back means that is every row, at 5,000 too (the backend answers limit + 1; review 4 nit)", () => {
  const all = range(1, 50).reverse();
  assert.equal(mergeNetPage([], all, 50).capped, false);
  assert.equal(mergeNetPage([], range(1, 5000).reverse(), 5000).capped, false, "all 5,000 rows: no 'latest 5,000' chip");
  assert.equal(mergeNetPage([], range(1, 5001).reverse(), 5000).capped, true);
});

test("net log: a live row in the same millisecond as the oldest fetched row stays (review 4 nit)", () => {
  const page = range(100, 150).reverse(); // capped: oldest shown is row 101 at 101,000 ms
  const tied = row(999, { ts: 101_000 });
  const { rows, capped } = mergeNetPage([tied], page, 50);
  assert.equal(capped, true);
  assert.ok(ids(rows).includes("n999"), "the tied live row is kept");
  assert.ok(!ids(mergeNetPage([row(998, { ts: 100_999 })], page, 50).rows).includes("n998"), "one a millisecond older is still dropped");
});

test("net log: a row that arrived during the fetch stays, and an uncapped page keeps everything", () => {
  const page = range(100, 150).reverse();
  const during = row(151);
  assert.deepEqual(ids(mergeNetPage([...range(1, 10), during], page, 50).rows), ids([...range(101, 150), during]));
  const all = range(1, 20).reverse();
  const { rows, capped } = mergeNetPage([...range(1, 10), row(21)], all, 50);
  assert.equal(capped, false);
  assert.deepEqual(ids(rows), ids(range(1, 21)));
});

test("net log: a shown row with a later attempt than its fetched copy wins", () => {
  const page = [row(3), row(2), row(1)];
  const live = row(2, { repeats: 5, lastTs: 9000 });
  const { rows } = mergeNetPage([row(1), live], page, 3);
  assert.deepEqual(rows.map((r) => [r.id, r.repeats ?? 1]), [["n1", 1], ["n3", 1], ["n2", 5]]);
});

test("chunks: a call opened during prefill gets chunk 0 and is whole", () => {
  let s = afterChunk({}, 0);
  assert.equal(s.whole, true);
  s = afterChunk(s, 1);
  assert.equal(s.whole, true);
});

test("chunks: opened mid-stream, or a chunk dropped for a slow socket, is partial and stays partial", () => {
  let s = afterChunk({}, 7);
  assert.equal(s.whole, false, "opened mid-stream");
  s = afterChunk(s, 8);
  assert.equal(s.whole, false, "still missing 0-6");
  let t = afterChunk({ whole: true }, 0);
  t = afterChunk(t, 1);
  t = afterChunk(t, 3);
  assert.equal(t.whole, false, "chunk 2 never arrived");
  t = afterChunk(t, 4);
  assert.equal(t.whole, false);
});

test("chunks without an index keep the start-seen rule", () => {
  assert.equal(afterChunk({ whole: true }, undefined).whole, true);
  assert.equal(afterChunk({}, undefined).whole, false);
});
