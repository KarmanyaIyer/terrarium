// The undo stack. Run: node --test --experimental-strip-types apps/ui/test/*.test.ts

import assert from "node:assert/strict";
import { test } from "node:test";
import { createUndoStack, diffKeys } from "../src/lib/undo.ts";

function counter() {
  const state = { v: 0 };
  return {
    state,
    set: (n: number, label = `set ${n}`, key?: string) => {
      const prev = state.v;
      state.v = n;
      return { label, key, undo: () => void (state.v = prev), redo: () => void (state.v = n) };
    },
  };
}

test("undo and redo walk back and forth, a new edit clears redo", async () => {
  const c = counter();
  const u = createUndoStack();
  u.push(c.set(1));
  u.push(c.set(2));
  assert.equal((await u.undo())?.label, "set 2");
  assert.equal(c.state.v, 1);
  assert.equal((await u.undo())?.label, "set 1");
  assert.equal(c.state.v, 0);
  assert.equal(await u.undo(), null, "nothing left");
  assert.equal(c.state.v, 0);
  await u.redo();
  assert.equal(c.state.v, 1);
  u.push(c.set(5));
  assert.equal(u.peekRedo(), null);
  assert.equal(await u.redo(), null);
  await u.undo();
  assert.equal(c.state.v, 1);
});

test("edits with one key close together are one entry, apart they aren't", async () => {
  let t = 1000;
  const c = counter();
  const u = createUndoStack({ now: () => t, coalesceMs: 800 });
  u.push(c.set(1, "drag", "dose"));
  t += 100;
  u.push(c.set(2, "drag", "dose"));
  t += 100;
  u.push(c.set(3, "drag", "dose"));
  await u.undo();
  assert.equal(c.state.v, 0, "the whole drag");
  await u.redo();
  assert.equal(c.state.v, 3, "and all of it again");
  t += 100;
  u.push(c.set(4, "drag", "dose"));
  await u.undo();
  assert.equal(c.state.v, 3, "an undo ends the group");
  t += 5000;
  u.push(c.set(7, "drag", "dose"));
  t += 2000;
  u.push(c.set(8, "drag", "dose"));
  await u.undo();
  assert.equal(c.state.v, 7, "too far apart to merge");
  u.push(c.set(9, "a", "x"));
  u.push(c.set(10, "b", "y"));
  await u.undo();
  assert.equal(c.state.v, 9, "other keys don't merge");
});

test("what an entry does while it's applied isn't a new edit", async () => {
  const u = createUndoStack();
  let during = false;
  u.push({
    label: "x",
    undo: () => {
      during = u.applying();
      u.push({ label: "echo", undo() {}, redo() {} });
    },
    redo() {},
  });
  await u.undo();
  assert.equal(during, true);
  assert.equal(u.peekUndo(), null);
  assert.equal(u.peekRedo()?.label, "x", "redo survives");
});

test("async entries finish first, a failing one is gone and the error is the caller's", async () => {
  const u = createUndoStack();
  let v = 0;
  u.push({
    label: "slow",
    undo: async () => {
      await new Promise((r) => setTimeout(r, 5));
      v = 1;
    },
    redo() {},
  });
  await u.undo();
  assert.equal(v, 1);
  u.push({
    label: "bad",
    undo: async () => {
      throw new Error("server said no");
    },
    redo() {},
  });
  await assert.rejects(u.undo(), /server said no/);
  assert.equal(u.peekUndo(), null);
  assert.equal(u.applying(), false);
});

test("limit, dropping a scope, and subscribers", async () => {
  const u = createUndoStack({ limit: 3 });
  let calls = 0;
  const off = u.subscribe(() => calls++);
  for (const label of ["a", "b", "c", "d"]) u.push({ label, undo() {}, redo() {}, scope: label === "c" ? "lab" : undefined });
  assert.equal(calls, 4);
  off();
  await u.undo();
  assert.equal(u.peekUndo()?.label, "c");
  u.drop("lab");
  assert.equal(u.peekUndo()?.label, "b");
  assert.equal(calls, 4, "unsubscribed");
  await u.undo();
  assert.equal(u.peekUndo(), null, "a fell off the limit");
});

test("diffKeys names only what changed", () => {
  const a = { x: 1, y: [1], z: "q" };
  const b = { ...a, x: 2 };
  assert.deepEqual(diffKeys(a, b, ["x", "y"]), { before: { x: 1 }, after: { x: 2 }, keys: ["x"] });
  assert.equal(diffKeys(a, { ...a }, ["x", "y", "z"]), null);
  assert.equal(diffKeys(a, { ...a, z: "other" }, ["x", "y"]), null, "untracked keys don't count");
});
