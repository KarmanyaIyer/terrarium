// Recipe text (neuronary.org format plus Terrarium's clamp). Run: node --test apps/ui/test/*.test.ts

import assert from "node:assert/strict";
import { test } from "node:test";
import { format, outOfRange, parse, parseRef, pushText, recipeLabel, signedDose } from "../src/lib/recipe.ts";

test("neuronary recipe: doses with + and -, any separator, any case", () => {
  const r = parse("L15N4041+0.8, l8n344-0.5;L3N7 +1\nL20N1187 + .25");
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.pushes, [
    { layer: 15, neuron: 4041, mode: "dose", value: 0.8 },
    { layer: 8, neuron: 344, mode: "dose", value: -0.5 },
    { layer: 3, neuron: 7, mode: "dose", value: 1 },
    { layer: 20, neuron: 1187, mode: "dose", value: 0.25 },
  ]);
});

test("clamp sets the raw activation, and may be negative", () => {
  assert.deepEqual(parse("L8N344=25 L8N345 = -3.5").pushes, [
    { layer: 8, neuron: 344, mode: "clamp", value: 25 },
    { layer: 8, neuron: 345, mode: "clamp", value: -3.5 },
  ]);
});

test("unicode minus copied from a web page reads as a minus", () => {
  assert.deepEqual(parse("L15N4041−0.5").pushes, [{ layer: 15, neuron: 4041, mode: "dose", value: -0.5 }]);
});

test("unreadable pieces and pushes without a dose are reported, the rest still parse", () => {
  const r = parse("L15N4041+0.8 owls L9N12 L2N3=x, L4N5+1");
  assert.deepEqual(
    r.pushes.map((p) => [p.layer, p.neuron, p.value]),
    [
      [15, 4041, 0.8],
      [4, 5, 1],
    ],
  );
  assert.equal(r.errors.length, 4, r.errors.join("\n"));
  assert.match(r.errors[0], /owls/);
  assert.match(r.errors[1], /L9N12 has no dose/);
  assert.match(r.errors[2], /L2N3 has no dose/);
  assert.match(r.errors[3], /=x/);
});

test("a neuron listed twice keeps the last value and says so", () => {
  const r = parse("L15N4041+0.8 L15N4041+0.5");
  assert.deepEqual(r.pushes, [{ layer: 15, neuron: 4041, mode: "dose", value: 0.5 }]);
  assert.match(r.errors[0], /listed twice; kept L15N4041\+0.5/);
});

test("empty and separator-only text is no pushes and no errors", () => {
  assert.deepEqual(parse(""), { pushes: [], errors: [] });
  assert.deepEqual(parse(" ,\n; "), { pushes: [], errors: [] });
});

test("format round-trips and writes signs the way neuronary does", () => {
  const text = "L15N4041+0.8 L8N344-0.5 L8N344=25 L1N2+0";
  const r = parse(text.replace("L8N344=25", "L9N344=25"));
  assert.equal(format(r.pushes), "L15N4041+0.8 L8N344-0.5 L9N344=25 L1N2+0");
  assert.equal(format([{ layer: 1, neuron: 2, mode: "dose", value: 0.1 + 0.2 }]), "L1N2+0.3");
  assert.equal(format([{ layer: 1, neuron: 2, mode: "dose", value: -1.23456 }]), "L1N2-1.235");
  assert.equal(format([]), "");
});

test("parseRef reads one neuron id", () => {
  assert.deepEqual(parseRef(" l15n4041 "), { layer: 15, neuron: 4041 });
  assert.deepEqual(parseRef("L15/N4041"), { layer: 15, neuron: 4041 });
  assert.equal(parseRef("L15N4041+0.8"), null);
  assert.equal(parseRef("4041"), null);
});

test("outOfRange checks against the loaded model's shape", () => {
  const per = Array(32).fill(9216);
  assert.deepEqual(outOfRange([{ layer: 15, neuron: 4041 }], 32, per), []);
  assert.match(outOfRange([{ layer: 32, neuron: 1 }], 32, per)[0], /layers 0 to 31/);
  assert.match(outOfRange([{ layer: 3, neuron: 9216 }], 32, per)[0], /neurons 0 to 9215/);
});

test("on screen: a space after the id and a true minus; copy text stays pasteable", () => {
  const dose = { layer: 22, neuron: 4296, mode: "dose" as const, value: -0.6 };
  const vector = { kind: "vector" as const, id: "v", name: "Gnome", layer: 8, strength: 1, u: "" };
  assert.equal(pushText(dose), "L22N4296 −0.6");
  assert.equal(pushText({ ...dose, value: 0.6 }), "L22N4296 +0.6");
  assert.equal(pushText({ ...dose, mode: "clamp", value: 25 }), "L22N4296 =25");
  assert.equal(pushText(vector), "Gnome, L8 vector ×1");
  assert.equal(pushText({ ...vector, strength: -1.5 }), "Gnome, L8 vector ×−1.5");
  assert.equal(signedDose(0), "0");
  assert.equal(format([dose]), "L22N4296-0.6");
  assert.equal(recipeLabel("[Gnome L8 x1] L22N4296+0.6 L8N344-0.5 L3N7=25"), "Gnome, L8 vector ×1, L22N4296 +0.6, L8N344 −0.5, L3N7 =25");
  assert.equal(recipeLabel("[Ancient Turtle L8 x1.2]"), "Ancient Turtle, L8 vector ×1.2");
  assert.equal(recipeLabel("nothing readable"), "nothing readable");
  for (const p of [dose, vector]) assert.deepEqual(parse(format([p]), [vector]).errors, []);
});
