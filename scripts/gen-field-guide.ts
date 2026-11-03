// Writes what the Lab ships from the persona search: apps/backend/scripts/field_guide.json (the Field Guide) and
// apps/backend/scripts/lens/<model>.json (word families to search). Re-run after research/personas/suite.json changes:
//   node scripts/gen-field-guide.ts
// Chat rates come from the judged `session-` runs in research/personas/results/judged, so finished runs show up on a re-run.
// Prints what it dropped and why. package.sh copies apps/backend/scripts into the app, so nothing else is needed.

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildGuide, buildLens, LENS_LAYERS, readSafetensor, type JudgedRow, type LensRow, type Suite } from "../apps/backend/src/lab/guide-build.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SEARCH = join(ROOT, "research", "personas");
const OUT = join(ROOT, "apps", "backend", "scripts");

const suite = JSON.parse(readFileSync(join(SEARCH, "suite.json"), "utf8")) as Suite;
// Batches in the order they were judged: ho47 before ho100.
const JUDGED = join(SEARCH, "results", "judged");
const judged = readdirSync(JUDGED)
  .filter((f) => /^ho\d+\.judged\.jsonl$/.test(f))
  .sort((a, b) => Number.parseInt(a.slice(2), 10) - Number.parseInt(b.slice(2), 10))
  .flatMap((f) =>
    readFileSync(join(JUDGED, f), "utf8")
      .split("\n")
      .filter((l) => l.includes('"session-'))
      .map((l) => JSON.parse(l) as JudgedRow),
  );
const LENS_FILES: Record<string, string> = {
  "Qwen3.5-4B-MLX-4bit": "lens_topical.jsonl",
  "LFM3-1.7B-MLX-8bit": "lens_topical_LFM3-1.7B-MLX-8bit.jsonl",
  "Qwen3.5-9B-MLX-4bit": "lens_topical_Qwen3.5-9B-MLX-4bit.jsonl",
};
// Every model's rows: a neuron's words for the entries that push one. Refs are per model, so read per model below; the first model's table wins a clash, and these only label.
const lensTokens = new Map<string, string[]>();
for (const file of Object.values(LENS_FILES)) {
  const path = join(SEARCH, "results", file);
  if (!existsSync(path)) continue;
  for (const l of readFileSync(path, "utf8").split("\n").filter(Boolean)) {
    const r = JSON.parse(l) as LensRow;
    if (!lensTokens.has(r.ref)) lensTokens.set(r.ref, r.tokens);
  }
}
const { guide, dropped } = buildGuide(suite, (file, key) => readSafetensor(join(ROOT, file), key), judged, lensTokens);
writeFileSync(join(OUT, "field_guide.json"), `${JSON.stringify(guide)}\n`);

mkdirSync(join(OUT, "lens"), { recursive: true });
for (const [modelId, file] of Object.entries(LENS_FILES)) {
  const path = join(SEARCH, "results", file);
  if (!existsSync(path)) {
    console.log(`lens: no ${file}, keeping what's there`);
    continue;
  }
  const rows = readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as LensRow);
  const lens = buildLens(rows, LENS_LAYERS[modelId] ?? []);
  const text = JSON.stringify(lens);
  writeFileSync(join(OUT, "lens", `${modelId}.json`), `${text}\n`);
  console.log(`lens ${modelId}: ${lens.length} of ${rows.length} rows, ${Math.round(text.length / 1024)} KB`);
}

const featured = guide.specimens.filter((s) => s.featured);
console.log(`field_guide.json: ${guide.specimens.length} specimens (${featured.length} featured), ${Math.round(JSON.stringify(guide).length / 1024)} KB, suite dated ${guide.date}`);
console.log(`featured: ${featured.map((s) => s.name).join(", ")}`);
console.log(`rest: ${guide.specimens.filter((s) => !s.featured).map((s) => `${s.name}${s.unconfirmed ? " (unconfirmed)" : ""}`).join(", ")}`);
console.log("in a chat, in Compare:");
for (const s of guide.specimens) {
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  console.log(`  ${s.featured ? "*" : " "} ${s.modelId.split("-")[0]} ${s.name}: ${s.measured.chat ? pct(s.measured.chat.joint) : "not measured"}, ${pct(s.measured.joint)}, repeat ${s.settings.repeat ?? "off"}`);
}
console.log("dropped:");
for (const d of dropped.filter((x) => x.why !== "not a keeper")) console.log(`  ${d.name} [${d.model}]: ${d.why}`);
console.log(`  and ${dropped.filter((x) => x.why === "not a keeper").length} that aren't keepers`);
