// The Field Guide's rules on small inputs, its safetensors reader, the word lens, and the asset as generated.

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { LabFieldGuide, LabVector } from "@terrarium/shared";
import { BACKEND_DIR } from "../config.ts";
import { baseName, buildGuide, buildLens, EXAMPLE, firstSentences, readSafetensor, rejected, type Suite, type SuitePersona } from "./guide-build.ts";

const MODEL = EXAMPLE.modelId;

function persona(over: Partial<SuitePersona> & { name: string }): SuitePersona {
  return {
    description: "A character.",
    group: "animals",
    status: "keeper",
    model: MODEL,
    settings: { temperature: 0.7, top_p: 0.95, repeat: 1.1 },
    numbers: { concept: 1, coherent: 0.95, joint: 0.95, n: 144, opus_recheck: { n: 30, opus_joint: 0.9 } },
    samples: [
      { prompt: "Who are you?", reply: "A fine reply." },
      { prompt: EXAMPLE.prompt, reply: "The capital is **Surprise**. It really is. And a third sentence goes on long enough that the quote stops before it, as quotes should when they are full, which takes a good many more words than you would first expect of it." },
    ],
    recipe: { type: "neurons", neurons: 1, pushes: [{ layer: 22, neuron: 4296, dose: 0.6 }] },
    holds_on_both_judges: true,
    ...over,
  };
}

const required = [persona({ name: EXAMPLE.name }), persona({ name: EXAMPLE.next })];
const build = (extra: SuitePersona[]) => buildGuide({ date: "2026-11-02", personas: [...required, ...extra] } as Suite, () => new Float32Array([1, 2]));
const names = (b: ReturnType<typeof build>) => b.guide.specimens.map((s) => s.name);

test("what ships: keepers no judge vetoed, without flagged or death-themed recipes", () => {
  assert.equal(rejected(persona({ name: "Fine" })), null);
  assert.equal(rejected(persona({ name: "Maybe", status: "promising" })), "not a keeper");
  assert.equal(rejected(persona({ name: "Slip", holds_on_both_judges: false })), "vetoed by the Opus check");
  assert.equal(rejected(persona({ name: "Disputed", disputed: { why: "x" } })), "vetoed by the Opus check");
  assert.equal(rejected(persona({ name: "Martyr Complex", content_flags: null })), "content flag");
  assert.equal(rejected(persona({ name: "Anything", content_flags: { replies: 1, terms: ["x"] } })), "content flag");
  assert.equal(rejected(persona({ name: "Memento Mori" })), "content flag");
  assert.equal(rejected(persona({ name: "In Loving Memory" })), "death theme");
  assert.equal(rejected(persona({ name: "Reaper", description: "Everything is about death." })), "death theme");
  assert.match(rejected(persona({ name: "Big", recipe: { type: "neurons", neurons: 263, pushes: [] } }))!, /more than 64/);
  // One judge is allowed: it is labelled.
  const single = build([persona({ name: "Single", numbers: { concept: 1, coherent: 1, joint: 0.9, n: 144 }, holds_on_both_judges: false })]);
  assert.match(single.guide.specimens.find((s) => s.name === "Single")!.rate, /One judge only/);
});

test("one entry per character: the best variant, confirmed doses first", () => {
  assert.equal(baseName("Old Shell (LFM3)"), "Old Shell");
  assert.equal(baseName("Happy Little Paintbrush (LFM3) (no repeat)"), "Happy Little Paintbrush");
  const opus = (j: number) => ({ concept: 1, coherent: 1, joint: 0.9, n: 144, opus_recheck: { n: 30, opus_joint: j } });
  const b = build([persona({ name: "Tiger", numbers: opus(0.8) }), persona({ name: "Tiger (64 neurons)", numbers: opus(0.95), recipe: { type: "neurons", neurons: 64, pushes: [{ layer: 1, neuron: 2, dose: 3 }] } }), persona({ name: "Tiger (retuned)", numbers: opus(0.99), retuned_after_heldout: true })]);
  const tiger = b.guide.specimens.filter((s) => s.name === "Tiger");
  assert.equal(tiger.length, 1);
  assert.deepEqual(tiger[0].mix, [{ layer: 1, neuron: 2, mode: "dose", value: 3 }], "the stricter judge's pick, not the unconfirmed one");
  assert.deepEqual(b.dropped.filter((d) => /Tiger/.test(d.name)).map((d) => d.name).sort(), ["Tiger", "Tiger (retuned)"]);
});

test("a retuned recipe is labelled until fresh prompts confirm it, and never leads", () => {
  const b = build([persona({ name: "Peer Reviewed", retuned_after_heldout: true })]);
  const s = b.guide.specimens.find((x) => x.name === "Peer Reviewed")!;
  assert.equal(s.unconfirmed, true);
  assert.equal(s.featured, false, "Peer Reviewed is on the featured list, but not until it is confirmed");
  assert.match(s.rate, /fresh prompts haven't confirmed/);
  const ok = build([persona({ name: "Peer Reviewed", retuned_after_heldout: true, numbers: { concept: 1, coherent: 1, joint: 0.9, n: 144, confirm_fresh_prompts: { n: 96, joint: 0.875 } } })]);
  const fresh = ok.guide.specimens.find((x) => x.name === "Peer Reviewed")!;
  assert.equal(fresh.unconfirmed, false);
  assert.equal(fresh.featured, true);
  assert.match(fresh.rate, /fresh prompts: 84 of 96/);
  assert.deepEqual(fresh.measured.fresh, { n: 96, joint: 0.875 });
});

test("samples: offensive and leaky replies never ship, and a recipe with none left doesn't either", () => {
  const b = build([
    persona({
      name: "Mixed",
      samples: [
        { prompt: "a", reply: "They fell down dead." },
        { prompt: "b", reply: "Fine, </think> and again." },
        { prompt: "c", reply: "A sword and an assessment are both fine." },
      ],
    }),
    persona({ name: "Bad", samples: [{ prompt: "a", reply: "Some blood." }] }),
  ]);
  assert.deepEqual(b.guide.specimens.find((s) => s.name === "Mixed")!.samples, [{ prompt: "c", reply: "A sword and an assessment are both fine." }]);
  assert.ok(!names(b).includes("Bad"));
  assert.match(b.dropped.find((d) => d.name === "Bad")!.why, /content scan/);
});

test("a vector ships as base64 of its float32, under its name", () => {
  const seen: string[] = [];
  const b = buildGuide(
    { date: "d", personas: [...required, persona({ name: "Clang", settings: { temperature: 0.7, top_p: 0.95 }, recipe: { type: "residual_vector", layer: 8, strength: 1.2, vector_file: "v.safetensors", vector_key: "u8" } })] } as Suite,
    (file, key) => {
      seen.push(`${file}:${key}`);
      return new Float32Array([1.5, -2]);
    },
  );
  assert.deepEqual(seen, ["v.safetensors:u8"]);
  const s = b.guide.specimens.find((x) => x.name === "Clang")!;
  const v = s.mix[0] as LabVector;
  assert.equal(v.kind, "vector");
  assert.equal(v.name, "Clang");
  assert.equal(v.layer, 8);
  assert.equal(v.strength, 1.2);
  assert.deepEqual([...new Float32Array(new Uint8Array(Buffer.from(v.u, "base64")).buffer)], [1.5, -2]);
  assert.equal(s.settings.repeat, null, "the settings its numbers were measured with");
});

test("the example block quotes a real reply, and the order leads with characters", () => {
  const b = build([persona({ name: "Clang" }), persona({ name: "Unlisted" })]);
  assert.equal(b.guide.example.quote, "The capital is **Surprise**. It really is.");
  assert.equal(b.guide.specimens[0].name, EXAMPLE.next, "the Bard first");
  assert.equal(b.guide.specimens.at(-1)!.name, "Unlisted");
  assert.equal(b.guide.specimens.at(-1)!.featured, false);
  assert.throws(() => buildGuide({ date: "d", personas: [] } as unknown as Suite, () => new Float32Array()), /main example/);
  assert.equal(firstSentences("One. Two.", 400), "One. Two.");
});

test("reading a tensor from a safetensors file", () => {
  const dir = mkdtempSync(join(tmpdir(), "terrarium-st-"));
  const header = Buffer.from(JSON.stringify({ __metadata__: {}, other: { dtype: "F32", shape: [1], data_offsets: [0, 4] }, u8: { dtype: "F32", shape: [3], data_offsets: [4, 16] } }));
  const size = Buffer.alloc(8);
  size.writeBigUInt64LE(BigInt(header.length));
  const path = join(dir, "x.safetensors");
  writeFileSync(path, Buffer.concat([size, header, Buffer.from(new Float32Array([9, 1, 2, 3]).buffer)]));
  assert.deepEqual([...readSafetensor(path, "u8")], [1, 2, 3]);
  assert.throws(() => readSafetensor(path, "nope"), /no tensor/);
  rmSync(dir, { recursive: true, force: true });
});

test("the lens keeps word families at usable layers", () => {
  const rows = [
    { ref: "L22N1+", kl: 1, gain: 5.04, tokens: [" alien", " aliens", " Alien", " extrater"] },
    { ref: "L22N2+", kl: 9, gain: 5, tokens: [" alien", " aliens", " Alien"] },
    { ref: "L3N3-", kl: 1, gain: 5, tokens: [" alien", " aliens", " Alien"] },
    { ref: "L22N4+", kl: 1, gain: 5, tokens: [" table", " green", " sword"] },
    { ref: "L22N5+", kl: 1, gain: 5, tokens: [" death", " deaths", " Death"] },
  ];
  assert.deepEqual(buildLens(rows, [22]), [["L22N1+", ["alien", "aliens", "Alien", "extrater"], 5]]);
});

test("the shipped guide follows the rules", () => {
  const guide = JSON.parse(readFileSync(join(BACKEND_DIR, "scripts", "field_guide.json"), "utf8")) as LabFieldGuide;
  assert.ok(guide.specimens.length >= 10);
  assert.ok(guide.specimens.some((s) => s.id === guide.example.specimenId));
  assert.ok(guide.specimens.some((s) => s.id === guide.example.next));
  const ids = guide.specimens.map((s) => s.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const s of guide.specimens) {
    assert.ok(s.samples.length > 0, s.name);
    assert.doesNotMatch(`${s.name} ${s.line} ${s.rate}`, /[–—]/, "no em or en dashes in copy");
    assert.doesNotMatch(s.name, /memento|martyr|sacrific|just kidding/i);
    for (const p of s.mix) if (p.kind === "vector") assert.equal(p.name, s.name);
  }
});
