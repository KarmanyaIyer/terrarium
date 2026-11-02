// A vector in a mix: its recipe text never holds its numbers, and reading the text back needs a vector of that name.

import assert from "node:assert/strict";
import { test } from "node:test";
import type { LabMixItem, LabPush, LabVector } from "@terrarium/shared";
import { pushesAt, scaled, targetName } from "../src/lib/labGrid.ts";
import { findPush, format, formatPush, outOfRange, parse, pushKey, pushName, vectorLength } from "../src/lib/recipe.ts";

const u = Buffer.from(new Float32Array(8).fill(0.5).buffer).toString("base64");
const bard: LabVector = { kind: "vector", id: "bard", name: "The Bard", layer: 8, strength: 1.2, u };
const neuron: LabPush = { layer: 22, neuron: 4296, mode: "dose", value: 0.6 };
const clamp: LabPush = { layer: 3, neuron: 1, mode: "clamp", value: 9 };

test("a vector's text is its name, layer and strength", () => {
  assert.equal(formatPush(bard), "[The Bard L8 x1.2]");
  assert.equal(format([bard, neuron]), "[The Bard L8 x1.2] L22N4296+0.6");
  assert.ok(!format([bard]).includes(u));
  assert.equal(pushKey(bard), "vector:bard");
  assert.equal(pushName(bard), "The Bard");
});

test("reading a vector back", () => {
  const known = parse("[The Bard L8 x0.9] L22N4296+0.6", [bard]);
  assert.deepEqual(known.errors, []);
  assert.deepEqual(known.pushes, [{ ...bard, strength: 0.9 }, neuron]);
  assert.equal(parse("[the bard L8 ×2]", [bard]).pushes.length, 1, "any case, either x");
  assert.equal((parse("[The Bard L8 x-1]", [bard]).pushes[0] as LabVector).strength, -1);

  const lost = parse("[The Bard L8 x0.9] L22N4296+0.6");
  assert.equal(lost.pushes.length, 1, "what it can read still comes through");
  assert.match(lost.errors[0], /"The Bard" is a vector/);
  assert.match(parse("[The Bard L9 x1]", [bard]).errors[0], /is a vector/, "another layer is another vector");
  assert.equal(parse("[The Bard L8 x1] [The Bard L8 x2]", [bard]).pushes.length, 1);
  assert.equal(parse("[nonsense]", [bard]).errors.length, 1, "a bracket that isn't a vector is still reported");
});

test("sizes and ranges", () => {
  assert.equal(vectorLength(u), 8);
  assert.equal(vectorLength(Buffer.from(new Float32Array(2560).buffer).toString("base64")), 2560);
  assert.deepEqual(outOfRange([bard], 32, [], 8), []);
  assert.match(outOfRange([bard], 32, [], 16)[0], /another model/);
  assert.match(outOfRange([bard], 4, [], 8)[0], /layers 0 to 3/);
  assert.equal(findPush([bard, neuron], neuron), neuron);
  assert.equal(findPush([bard], { layer: 8, neuron: 0 }), undefined, "a vector is never mistaken for a neuron");
});

test("scale and sweep move a vector's strength", () => {
  const mix: LabMixItem[] = [bard, neuron, clamp];
  const twice = scaled(mix, 2);
  assert.equal((twice[0] as LabVector).strength, 2.4);
  assert.equal((twice[1] as LabPush).value, 1.2);
  assert.equal((twice[2] as LabPush).value, 9, "clamps stay");

  const at = pushesAt(mix, { vectorId: "bard" }, 0.5);
  assert.equal((at[0] as LabVector).strength, 0.5, "set, not multiplied");
  assert.equal((at[1] as LabPush).value, 0.6, "the rest stay");
  assert.equal((pushesAt(mix, { vectorId: "other" }, 0.5)[0] as LabVector).strength, 1.2);

  const onNeuron = pushesAt([bard, neuron], neuron, 0.9);
  assert.equal((onNeuron[1] as LabPush).value, 0.9);
  assert.equal((onNeuron[0] as LabVector).strength, 1.2, "a vector on the same layer is not the target");

  assert.equal(targetName(mix, { vectorId: "bard" }), "The Bard");
  assert.equal(targetName(mix, neuron), "L22N4296");
  assert.equal(targetName(mix, null), "whole mix");
});
