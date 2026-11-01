// One Cmd+Z runs once, and toasts of one kind replace each other. Run: node --test --experimental-strip-types apps/ui/test/*.test.ts

import assert from "node:assert/strict";
import { test } from "node:test";
import { createEditGate } from "../src/lib/editGate.ts";
import { addToast, toastKind } from "../src/lib/toasts.ts";

test("the menu after the keydown of one press doesn't run a second undo", () => {
  let t = 1000;
  const gate = createEditGate(() => t);
  assert.equal(gate("undo", "key"), true);
  t += 5;
  assert.equal(gate("undo", "menu"), false, "same press, other source");
  t += 400;
  assert.equal(gate("undo", "menu"), true, "a later menu click is its own");
  t += 5;
  assert.equal(gate("undo", "key"), false, "and works in the other order");
});

test("holding the keys steps, and undo then redo both run", () => {
  let t = 0;
  const gate = createEditGate(() => t);
  assert.equal(gate("undo", "key"), true);
  t += 30;
  assert.equal(gate("undo", "key"), true, "a key repeat is a new step");
  t += 1;
  assert.equal(gate("redo", "key"), true);
  t += 1;
  assert.equal(gate("undo", "menu"), true, "a different action is never the same press");
});

const t = (id: number, text: string, action = false) => ({ id, text, kind: toastKind(text, action) });

test("repeated restores leave one toast, offering the newest", () => {
  let list: ReturnType<typeof t>[] = [];
  for (let i = 0; i < 5; i++) list = addToast(list, t(i, `Restored run ${i}`, true));
  assert.deepEqual(list.map((x) => x.text), ["Restored run 4"]);
});

test("undo steps replace each other, the same error doesn't stack, different errors do", () => {
  let list = addToast([], t(1, "Undid: a"));
  list = addToast(list, t(2, "Redid: a"));
  assert.deepEqual(list.map((x) => x.id), [2]);
  list = addToast(list, t(3, "Load: failed"));
  list = addToast(list, t(4, "Load: failed"));
  list = addToast(list, t(5, "Stop: failed"));
  assert.deepEqual(list.map((x) => x.id), [2, 4, 5]);
  for (let i = 10; i < 20; i++) list = addToast(list, t(i, `error ${i}`));
  assert.equal(list.length, 4, "still capped");
});
