// Eval suites: hand-written JSON in evals/suites/*.json plus dataset-backed suites described
// in evals/datasets.json (downloaded to data/datasets/ on first materializeSuite).

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { EvalCase, EvalSuite } from "@terrarium/shared";
import { convertGsm8k, convertHumanEval, convertMbpp, convertMmlu, type DatasetItem } from "./convert.ts";
import { type DatasetMeta, ensureDataset, readCachedDataset, readDatasetMetas } from "./datasets.ts";
import { sample, stratifiedSample } from "./sample.ts";

export type { DatasetItem } from "./convert.ts";
export type { DatasetMeta } from "./datasets.ts";
export { validateCase, validateSuite } from "./validate.ts";

export const DEFAULT_SEED = 1;

export interface SuiteOptions {
  rootDir?: string; // repo root (contains evals/); default: resolved from this file
  dataDir?: string; // dataset cache; default <rootDir>/data/datasets
  fetch?: typeof fetch;
}

export interface MaterializeOptions extends SuiteOptions {
  sampleSize?: number; // dataset suites only; default the dataset's defaultSampleSize
  seed?: number; // default DEFAULT_SEED
}

const DEFAULT_ROOT = fileURLToPath(new URL("../../../../../", import.meta.url));

function paths(opts: SuiteOptions) {
  const root = opts.rootDir ?? DEFAULT_ROOT;
  return { evals: join(root, "evals"), data: opts.dataDir ?? join(root, "data", "datasets") };
}

export async function loadJsonSuites(opts: SuiteOptions = {}): Promise<EvalSuite[]> {
  const dir = join(paths(opts).evals, "suites");
  const names = (await readdir(dir)).filter((n) => n.endsWith(".json")).sort();
  const suites: EvalSuite[] = [];
  for (const n of names) {
    const suite = JSON.parse(await readFile(join(dir, n), "utf8")) as EvalSuite;
    if (!suite.id || !Array.isArray(suite.cases)) throw new Error(`evals/suites/${n}: not a suite`);
    suites.push(suite);
  }
  return suites;
}

function convert(meta: DatasetMeta, files: Map<string, Buffer>): DatasetItem[] {
  const one = (name: string) => {
    const b = files.get(name);
    if (!b) throw new Error(`${meta.id}: ${name} missing from cache`);
    return b;
  };
  switch (meta.id) {
    case "gsm8k":
      return convertGsm8k(one("test.jsonl"));
    case "mmlu":
      return convertMmlu(files, meta.subjects ?? []);
    case "humaneval":
      return convertHumanEval(one("HumanEval.jsonl.gz"));
    case "mbpp":
      return convertMbpp(one("sanitized-mbpp.json"));
    default:
      throw new Error(`no converter for dataset ${meta.id}`);
  }
}

// All items of a dataset, references included (for verification scripts). Downloads if needed.
export async function datasetItems(id: string, opts: SuiteOptions = {}): Promise<DatasetItem[]> {
  const meta = (await readDatasetMetas(paths(opts).evals)).find((m) => m.id === id);
  if (!meta) throw new Error(`unknown dataset ${id}`);
  return convert(meta, await ensureDataset(meta, paths(opts).data, opts.fetch));
}

function pick(meta: DatasetMeta, items: DatasetItem[], size: number, seed: number): EvalCase[] {
  let chosen: DatasetItem[];
  if (meta.subjects) {
    const groups = meta.subjects.map((s) => items.filter((it) => it.group === s));
    chosen = stratifiedSample(groups, size, seed);
  } else {
    chosen = sample(items, size, seed);
  }
  return chosen.map((it) => it.case);
}

function datasetSuite(meta: DatasetMeta, cases: EvalCase[]): EvalSuite {
  return {
    id: meta.id,
    title: meta.title,
    description: meta.description,
    envType: meta.envType,
    source: { dataset: meta.dataset, url: meta.url, license: meta.license, sampleable: true, total: meta.total },
    cases,
  };
}

// Every suite. Never downloads: a dataset suite carries its default sample when the dataset
// is already cached, and no cases otherwise (source.total still gives the size).
export async function loadSuites(opts: SuiteOptions = {}): Promise<EvalSuite[]> {
  const { evals, data } = paths(opts);
  const suites = await loadJsonSuites(opts);
  for (const meta of await readDatasetMetas(evals)) {
    const files = await readCachedDataset(meta, data);
    const cases = files ? pick(meta, convert(meta, files), meta.defaultSampleSize, DEFAULT_SEED) : [];
    suites.push(datasetSuite(meta, cases));
  }
  const seen = new Set<string>();
  for (const s of suites) {
    if (seen.has(s.id)) throw new Error(`duplicate suite id ${s.id}`);
    seen.add(s.id);
  }
  return suites;
}

// One suite with its cases ready to run. Dataset suites are downloaded on first use and
// sampled deterministically from (sampleSize, seed); hand-written suites return all cases.
export async function materializeSuite(id: string, opts: MaterializeOptions = {}): Promise<EvalSuite> {
  const { evals, data } = paths(opts);
  const meta = (await readDatasetMetas(evals)).find((m) => m.id === id);
  if (meta) {
    const items = convert(meta, await ensureDataset(meta, data, opts.fetch));
    const size = Math.min(opts.sampleSize ?? meta.defaultSampleSize, items.length);
    return datasetSuite(meta, pick(meta, items, size, opts.seed ?? DEFAULT_SEED));
  }
  const suite = (await loadJsonSuites(opts)).find((s) => s.id === id);
  if (!suite) throw new Error(`unknown suite ${id}`);
  return suite;
}
