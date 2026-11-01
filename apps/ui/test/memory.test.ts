// Fit estimates count the Lab's specimen once against the ceiling. Run: node --test apps/ui/test/*.test.ts

import assert from "node:assert/strict";
import { test } from "node:test";
import type { MemoryBudget, ModelInfo, ResourceSample } from "@terrarium/shared";
import { OVERHEAD_BYTES, estimate } from "../src/lib/memory.ts";

const GB = 1024 ** 3;
const model = (id: string, extra: Partial<ModelInfo> = {}) => ({ id, name: id, weightsBytes: 2 * GB, kvBytesPerToken: 0, fixedBytes: 0, loaded: false, defaultContext: 8192, ...extra }) as ModelInfo;
const budget = { budgetBytes: 10 * GB } as MemoryBudget;
const strain = (id: string) => model(id, { loaded: true, residentBytes: 4.5 * GB, strain: { id, name: id, baseModelId: "base", recipe: "L1N1+1" } });

test("loaded strains of one specimen count the Lab once", () => {
  const e = estimate(model("m"), 8192, undefined, budget, [strain("a"), strain("b")]);
  assert.equal(e.otherLoaded, 4.5 * GB);
  assert.equal(e.bytes, 2 * GB + OVERHEAD_BYTES);
  assert.ok(e.fitsBudget);
  assert.equal(estimate(model("big", { weightsBytes: 5 * GB }), 8192, undefined, budget, [strain("a")]).fitsBudget, false, "5 + 1 + 4.5 GB is over 10 GB");
});

test("a specimen with no strains counts by the sidecar's resident size", () => {
  const sample = { system: { freeBytes: 20 * GB }, lab: { rssBytes: 3 * GB, modelId: "base" } } as ResourceSample;
  assert.equal(estimate(model("m"), 8192, sample, budget, []).otherLoaded, 3 * GB);
});

test("a strain replaces the specimen, so the Lab doesn't count against it", () => {
  assert.equal(estimate(strain("c"), 8192, undefined, budget, [strain("a")]).otherLoaded, 0);
});
