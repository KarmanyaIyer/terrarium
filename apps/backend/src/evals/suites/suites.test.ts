import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { gzipSync } from "node:zlib";
import type { EvalSuite } from "@terrarium/shared";
import { convertGsm8k, convertHumanEval, convertMbpp, convertMmlu, mbppEntryPoint } from "./convert.ts";
import { parseCsv, readCachedDataset, readDatasetMetas, TarExtractor } from "./datasets.ts";
import { datasetItems, loadJsonSuites, loadSuites, materializeSuite, validateSuite } from "./index.ts";
import { sample, stratifiedSample } from "./sample.ts";

const ROOT = new URL("../../../../../", import.meta.url).pathname;
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

describe("hand-written suites", async () => {
  const suites = await loadJsonSuites();
  const OURS: Record<string, { env: string; turns: [number, number]; min: number }> = {
    "tool-basics": { env: "sim", turns: [8, 15], min: 9 },
    "shell-data": { env: "sim", turns: [8, 15], min: 7 },
    coding: { env: "vm", turns: [15, 25], min: 7 },
    reasoning: { env: "none", turns: [1, 1], min: 10 },
    speed: { env: "none", turns: [1, 1], min: 3 },
  };

  test("all expected suites exist", () => {
    for (const id of Object.keys(OURS)) assert.ok(suites.some((s) => s.id === id), id);
  });

  for (const s of suites) {
    test(`${s.id}: schema and checks suit envType`, () => {
      assert.deepEqual(validateSuite(s), []);
    });
  }

  test("case ids are unique across all suites", () => {
    const seen = new Map<string, string>();
    for (const s of suites) {
      for (const c of s.cases) {
        assert.ok(!seen.has(c.id), `${c.id} in ${s.id} and ${seen.get(c.id)}`);
        seen.set(c.id, s.id);
      }
    }
  });

  for (const [id, rule] of Object.entries(OURS)) {
    test(`${id}: case count, turns, titles`, () => {
      const s = suites.find((x) => x.id === id)!;
      assert.equal(s.envType, rule.env);
      assert.ok(s.cases.length >= rule.min, `${s.cases.length} cases`);
      for (const c of s.cases) {
        assert.ok(c.maxTurns >= rule.turns[0] && c.maxTurns <= rule.turns[1], `${c.id} maxTurns ${c.maxTurns}`);
        assert.ok(c.title.length <= 40, `${c.id} title too long for a matrix row`);
        if (id === "speed") assert.equal(c.check.type, "speed");
        if (id === "coding") {
          assert.deepEqual(c.check, { type: "tests", file: "/grader/test_hidden.py", timeoutSec: 120 });
          assert.ok(c.hiddenFiles?.length, `${c.id} needs hidden tests`);
          assert.ok(c.setupFiles?.some((f) => f.path.startsWith("/workspace/tests/")), `${c.id} needs visible tests`);
        }
      }
    });
  }

  test("prompts never mention grader paths", () => {
    for (const s of suites) for (const c of s.cases) assert.ok(!c.prompt.includes("/grader"), c.id);
  });
});

describe("validator", () => {
  const base = { id: "x", title: "X", prompt: "p", maxTurns: 5, timeoutSec: 60 };
  const suite = (cases: unknown[]) => ({ id: "t", title: "T", description: "d", envType: "mixed", cases }) as EvalSuite;

  test("rejects checks that do not suit the env", () => {
    assert.notDeepEqual(validateSuite(suite([{ ...base, envType: "none", check: { type: "command", command: "true" } }])), []);
    assert.notDeepEqual(validateSuite(suite([{ ...base, envType: "sim", check: { type: "speed" } }])), []);
    assert.notDeepEqual(
      validateSuite(suite([{ ...base, envType: "sim", hiddenFiles: [{ path: "/grader/a", content: "" }], check: { type: "answer", mode: "exact", expected: "a" } }])),
      [],
    );
  });

  test("rejects command checks that reference missing hidden files", () => {
    const c = { ...base, envType: "vm", check: { type: "command", command: "python3 /grader/t.py" } };
    assert.notDeepEqual(validateSuite(suite([c])), []);
    assert.deepEqual(validateSuite(suite([{ ...c, hiddenFiles: [{ path: "/grader/t.py", content: "" }] }])), []);
  });

  test("rejects bad answers, paths and duplicate ids", () => {
    assert.notDeepEqual(validateSuite(suite([{ ...base, envType: "none", check: { type: "answer", mode: "regex", expected: "(" } }])), []);
    assert.notDeepEqual(validateSuite(suite([{ ...base, envType: "none", check: { type: "answer", mode: "number", expected: "abc" } }])), []);
    assert.notDeepEqual(
      validateSuite(suite([{ ...base, envType: "sim", setupFiles: [{ path: "/etc/x", content: "" }], check: { type: "file", path: "/workspace/a", equals: "" } }])),
      [],
    );
    const ok = { ...base, envType: "none", check: { type: "answer", mode: "exact", expected: "a" } };
    assert.notDeepEqual(validateSuite(suite([ok, ok])), []);
  });
});

describe("sampling", () => {
  const items = Array.from({ length: 100 }, (_, i) => i);
  test("deterministic per seed", () => {
    assert.deepEqual(sample(items, 10, 3), sample(items, 10, 3));
    assert.notDeepEqual(sample(items, 10, 3), sample(items, 10, 4));
    assert.equal(new Set(sample(items, 100, 9)).size, 100);
  });
  test("stratified sample is balanced", () => {
    const groups = [items.slice(0, 50), items.slice(50, 60), items.slice(60)];
    const got = stratifiedSample(groups, 9, 1);
    assert.equal(got.length, 9);
    assert.deepEqual(groups.map((g) => got.filter((x) => g.includes(x)).length), [3, 3, 3]);
    assert.equal(stratifiedSample([[1], [2]], 5, 1).length, 2);
  });
});

describe("parsers", () => {
  test("csv handles quotes, commas, newlines, CRLF", () => {
    assert.deepEqual(parseCsv('a,"b, c","d ""q"""\r\n"line\nbreak",,x\n'), [
      ["a", "b, c", 'd "q"'],
      ["line\nbreak", "", "x"],
    ]);
  });

  test("tar extractor keeps files under the prefix, across chunk boundaries", () => {
    const entry = (name: string, body: string, type = "0") => {
      const h = Buffer.alloc(512);
      h.write(name, 0);
      h.write("0000644\0", 100);
      h.write(`${Buffer.byteLength(body).toString(8).padStart(11, "0")}\0`, 124);
      h.write(type, 156);
      h.write("ustar\0", 257);
      h.fill(" ", 148, 156);
      const data = Buffer.alloc(Math.ceil(Buffer.byteLength(body) / 512) * 512);
      data.write(body);
      return Buffer.concat([h, data]);
    };
    const tar = Buffer.concat([entry("data/test/", "", "5"), entry("data/test/a.csv", "x".repeat(700)), entry("data/val/b.csv", "no"), entry("data/test/c.csv", "1,2\n"), Buffer.alloc(1024)]);
    const t = new TarExtractor("data/test/");
    for (let i = 0; i < tar.length; i += 97) t.push(tar.subarray(i, i + 97));
    const out = t.finish();
    assert.deepEqual([...out.keys()].sort(), ["a.csv", "c.csv"]);
    assert.equal(out.get("a.csv")!.toString(), "x".repeat(700));
  });
});

describe("dataset converters", () => {
  test("gsm8k", () => {
    const [it] = convertGsm8k(Buffer.from(`${JSON.stringify({ question: "How many?", answer: "2 + 2 = 4\n#### 1,204" })}\n`));
    assert.equal(it.case.check.type === "answer" && it.case.check.expected, "1204");
    assert.equal(it.case.envType, "none");
  });

  test("mmlu", () => {
    const files = new Map([["philosophy_test.csv", Buffer.from('"Who, said it?",Kant,Hume,Mill,Locke,C\n')]]);
    const [it] = convertMmlu(files, ["philosophy"]);
    assert.equal(it.case.check.type === "answer" && it.case.check.mode, "choice");
    assert.match(it.case.prompt, /Who, said it\?\n\nA\. Kant\nB\. Hume\nC\. Mill\nD\. Locke$/);
  });

  test("humaneval and mbpp produce vm cases with hidden harnesses", () => {
    const he = convertHumanEval(
      gzipSync(
        Buffer.from(
          `${JSON.stringify({ task_id: "HumanEval/3", prompt: 'def f(x):\n    """Double x."""\n', entry_point: "f", canonical_solution: "    return 2 * x\n", test: "def check(c):\n    assert c(2) == 4\n" })}\n`,
        ),
      ),
    )[0];
    const rec = { task_id: 9, prompt: "Double a number.", code: "def helper():\n  pass\ndef dbl(x):\n  return 2*x", test_imports: [], test_list: ["assert dbl(2) == 4"] };
    const mb = convertMbpp(Buffer.from(JSON.stringify([rec])))[0];
    assert.equal(mbppEntryPoint(rec), "dbl");
    for (const it of [he, mb]) {
      assert.deepEqual(validateSuite({ id: "t", title: "T", description: "d", envType: "vm", cases: [it.case] }), []);
      assert.ok(it.reference && !JSON.stringify(it.case).includes(it.reference.content));
      assert.equal(it.case.hiddenFiles?.[0].path, "/grader/test_hidden.py");
    }
  });
});

describe("loading and download (offline, mocked fetch)", () => {
  const tmp = mkdtempSync(join(tmpdir(), "terr-suites-"));
  after(() => rmSync(tmp, { recursive: true, force: true }));
  mkdirSync(join(tmp, "evals", "suites"), { recursive: true });
  writeFileSync(join(tmp, "evals", "suites", "mini.json"), readFileSync(join(ROOT, "evals", "suites", "reasoning.json")));
  const body = Buffer.from(
    Array.from({ length: 30 }, (_, i) => JSON.stringify({ question: `q${i}`, answer: `#### ${i}` })).join("\n") + "\n",
  );
  const meta = {
    id: "gsm8k", title: "GSM8K", description: "d", dataset: "GSM8K", url: "https://example.invalid", license: "MIT",
    revision: "r1", envType: "none", total: 30, defaultSampleSize: 5,
    files: [{ name: "test.jsonl", url: "https://example.invalid/test.jsonl", sha256: sha(body), bytes: body.length }],
  };
  writeFileSync(join(tmp, "evals", "datasets.json"), JSON.stringify({ datasets: [meta] }));
  let calls = 0;
  const fakeFetch = (async () => {
    calls++;
    return new Response(body);
  }) as typeof fetch;
  const opts = { rootDir: tmp, fetch: fakeFetch };

  test("loadSuites never downloads; dataset suite is empty until cached", async () => {
    const suites = await loadSuites(opts);
    assert.equal(calls, 0);
    const ds = suites.find((s) => s.id === "gsm8k")!;
    assert.equal(ds.cases.length, 0);
    assert.equal(ds.source?.total, 30);
    assert.equal(ds.source?.sampleable, true);
  });

  test("materializeSuite downloads once, verifies, caches and samples", async () => {
    const a = await materializeSuite("gsm8k", { ...opts, sampleSize: 7, seed: 2 });
    const b = await materializeSuite("gsm8k", { ...opts, sampleSize: 7, seed: 2 });
    assert.equal(calls, 1);
    assert.equal(a.cases.length, 7);
    assert.deepEqual(a.cases.map((c) => c.id), b.cases.map((c) => c.id));
    assert.equal((await materializeSuite("gsm8k", { ...opts, sampleSize: 999 })).cases.length, 30);
    assert.equal((await loadSuites(opts)).find((s) => s.id === "gsm8k")!.cases.length, 5);
    assert.equal((await materializeSuite("reasoning", opts)).cases.length, 12);
  });

  test("sha256 mismatch is rejected and nothing is cached", async () => {
    const dataDir = join(tmp, "other-cache");
    const bad = (async () => new Response(Buffer.from("tampered"))) as typeof fetch;
    await assert.rejects(materializeSuite("gsm8k", { rootDir: tmp, dataDir, fetch: bad }), /sha256/);
    const [m] = await readDatasetMetas(join(tmp, "evals"));
    assert.equal(await readCachedDataset(m, dataDir), null);
  });
});

describe("real dataset cache (skipped when not downloaded)", async () => {
  const metas = await readDatasetMetas(join(ROOT, "evals"));
  for (const meta of metas) {
    const cached = await readCachedDataset(meta, join(ROOT, "data", "datasets"));
    test(`${meta.id}: every converted case is valid`, { skip: cached ? false : "not cached" }, async () => {
      const items = await datasetItems(meta.id);
      assert.equal(items.length, meta.total);
      const s: EvalSuite = { id: meta.id, title: meta.title, description: meta.description, envType: meta.envType, cases: items.map((i) => i.case) };
      assert.deepEqual(validateSuite(s), []);
    });
  }
});
