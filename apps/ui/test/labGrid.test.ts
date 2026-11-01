// The dose scale and result grids. Run: node --test --experimental-strip-types apps/ui/test/*.test.ts

import assert from "node:assert/strict";
import { test } from "node:test";
import type { LabPush } from "@terrarium/shared";
import { dedupe, doseScale, etaMs, firstDivergence, gridSlots, hasWord, nearestZeroFirst, pickPiece, pushesAt, scaled, suggestWords, summarize, zoomBetween } from "../src/lib/labGrid.ts";

test("a symmetric range is centred on zero with the same steps both ways", () => {
  const d = doseScale(-1, 1, 12);
  assert.equal(d.length, 13, "12 steps and zero");
  assert.ok(d.includes(0));
  assert.deepEqual(
    d
      .filter((x) => x < 0)
      .map((x) => -x)
      .reverse(),
    d.filter((x) => x > 0),
  );
  assert.equal(d[0], -1);
  assert.equal(d[12], 1);
  assert.deepEqual(doseScale(-0.5, 0.5, 4), [-0.5, -0.25, 0, 0.25, 0.5]);
});

test("densities hold what was asked for, in small steps", () => {
  for (const n of [24, 48, 96, 192]) assert.equal(doseScale(-2, 2, n).length, n + 1);
  const fine = doseScale(-1, 1, 192);
  assert.ok(Math.abs(fine[1] - fine[0] - 2 / 192) < 1e-3);
  assert.equal(new Set(fine).size, fine.length);
});

test("custom ranges: lopsided across zero, or all on one side", () => {
  const lop = doseScale(-0.5, 1.5, 8);
  assert.ok(lop.includes(0));
  assert.equal(lop[0], -0.5);
  assert.equal(lop[lop.length - 1], 1.5);
  assert.equal(lop.filter((x) => x < 0).length, 2, "a quarter of the range");
  assert.deepEqual(doseScale(0.5, 1, 3), [0.5, 0.75, 1]);
  assert.deepEqual(doseScale(1, 0.5, 3), [0.5, 0.75, 1], "either order");
  assert.deepEqual(doseScale(0.8, 0.8, 5), [0.8]);
});

test("zoom between two doses keeps both ends", () => {
  assert.deepEqual(zoomBetween(0.98, 0.66, 5), [0.66, 0.74, 0.82, 0.9, 0.98]);
});

test("runs start at zero and work outward, a stopped grid stays even across seeds", () => {
  assert.deepEqual(nearestZeroFirst([-1, 2, 0, 0.5, -0.5]), [0, 0.5, -0.5, -1, 2]);
  const slots = gridSlots({ doses: [-1, 0, 1], seeds: [7, 8], prompts: ["a"] });
  assert.deepEqual(
    slots.slice(0, 2).map((s) => [s.dose, s.seed]),
    [
      [0, 7],
      [0, 8],
    ],
  );
  assert.equal(slots.length, 6);
  assert.deepEqual(dedupe([0.12341, 0.12344, -0, 0]), [0.1234, 0]);
});

test("the pushes a dose stands for", () => {
  const mix: LabPush[] = [
    { layer: 1, neuron: 2, mode: "dose", value: 0.5 },
    { layer: 3, neuron: 4, mode: "clamp", value: 9 },
  ];
  assert.deepEqual(
    pushesAt(mix, null, -2).map((p) => p.value),
    [-1, 9],
    "a scale leaves clamps alone",
  );
  assert.deepEqual(
    pushesAt(mix, { layer: 1, neuron: 2 }, -0.66).map((p) => p.value),
    [-0.66, 9],
  );
  const added = pushesAt(mix, { layer: 5, neuron: 6 }, 0.25);
  assert.equal(added.length, 3);
  assert.deepEqual(added[2], { layer: 5, neuron: 6, mode: "dose", value: 0.25 });
  assert.deepEqual(
    scaled(mix, 1).map((p) => p.value),
    [0.5, 9],
  );
  assert.deepEqual(
    scaled(mix, 0).map((p) => p.value),
    [0, 9],
    "scale zero really is zero",
  );
});

test("counting replies", () => {
  const replies = [
    { quality: "ok" as const, text: "I am an Alien from afar." },
    { quality: "ok" as const, text: "Salient points." },
    { quality: "loop" as const, text: "aliens aliens aliens" },
    { quality: "broken" as const, text: "x y z" },
    { quality: "empty" as const, text: "" },
    { quality: "odd" as const, text: "An odd line." },
  ];
  const s = summarize(replies, [" alien"]);
  assert.deepEqual(s, { n: 6, ok: 2, odd: 1, loop: 1, broken: 2, hits: 2 }, "at a word's start: Salient doesn't count");
  assert.equal(summarize(replies).hits, null);
  assert.equal(summarize(replies, ["a"]).hits, null, "too short to mean anything");
  assert.ok(hasWord("Bonjour, ça va?", ["ça", "xyz"]));
  assert.deepEqual(suggestWords([" alien", " Alien", " aliens", "**", " UFO", "é"], 3), ["alien", "UFO"]);
});

test("picking a word from a reply", () => {
  const s = ["I", " am", " an", " alien", "."];
  assert.deepEqual(pickPiece(s, 3), { prefill: "I am an", target: " alien" });
  assert.deepEqual(pickPiece(s, 0), { prefill: "", target: "I" });
  const b = ["I", " am", " a", " large", " model"];
  assert.deepEqual(firstDivergence(s, b), { prefill: "I am", target: " an", foil: " a" });
  assert.deepEqual(firstDivergence(s, undefined), { prefill: "", target: "I" });
  assert.deepEqual(firstDivergence(s, s), { prefill: "", target: "I" }, "the same reply: the start");
  assert.deepEqual(firstDivergence(s, ["I"]), { prefill: "I", target: " am" }, "the baseline ended first: no foil");
});

test("the wait", () => {
  assert.equal(etaMs([], 5), null);
  assert.equal(etaMs([1000, 3000], 4), 8000);
});
