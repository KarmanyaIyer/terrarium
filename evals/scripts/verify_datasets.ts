// Download every dataset through the backend loader (sha256-checked), then check each
// converted case: answer cases have a well-formed expected value; code cases fail with the
// starter file and on an os._exit(0) cheat, and pass with the dataset's reference solution (the VM's test
// grader in --local mode, /workspace and /grader rewritten to a scratch dir). Also checks that sampling is
// deterministic.
//
// Run: node evals/scripts/verify_datasets.ts [datasetId...]

import { spawn } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { EvalCase } from "../../packages/shared/src/index.ts";
import { datasetItems, materializeSuite, type DatasetItem } from "../../apps/backend/src/evals/suites/index.ts";
import { GRADE_PY, hostPython } from "./grade_local.ts";

const EVALS = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCRATCH = join(EVALS, ".scratch", "datasets");

// grade.py's --timeout per run; a tests check runs twice (isolated, then plain), plus setup and kills.
const TIMEOUT = 50;

function run(ws: string, tests: string): Promise<number> {
  return new Promise((done) => {
    const p = spawn(hostPython(), ["-I", "-S", GRADE_PY, "--local", "--tests", tests, "--workspace", ws, "--timeout", String(TIMEOUT)], { stdio: "ignore" });
    const t = setTimeout(() => p.kill("SIGKILL"), (2 * TIMEOUT + 30) * 1000);
    p.on("exit", (code) => {
      clearTimeout(t);
      done(code ?? 1);
    });
  });
}

async function checkCode(it: DatasetItem): Promise<string | null> {
  const c = it.case;
  if (c.check.type !== "tests" || !it.reference) return "not a tests case with a reference";
  const base = join(SCRATCH, c.id);
  rmSync(base, { recursive: true, force: true });
  const ws = join(base, "workspace");
  const gr = join(base, "grader");
  const put = (files: { path: string; content: string }[]) => {
    for (const f of files) {
      const p = f.path.replace(/^\/workspace\//, `${ws}/`).replace(/^\/grader\//, `${gr}/`);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, f.content);
    }
  };
  put([...(c.setupFiles ?? []), ...(c.hiddenFiles ?? [])]);
  const tests = c.check.file.replace(/^\/grader\//, `${gr}/`);
  if ((await run(ws, tests)) === 0) return "passes with the starter file";
  put([{ path: it.reference.path, content: `import os\nos._exit(0)\n${it.reference.content}` }]);
  if ((await run(ws, tests)) === 0) return "passes with the os._exit(0) cheat";
  put([it.reference]);
  if ((await run(ws, tests)) !== 0) return "reference solution fails";
  rmSync(base, { recursive: true, force: true });
  return null;
}

function checkAnswer(c: EvalCase): string | null {
  if (c.check.type !== "answer") return "not an answer case";
  if (c.check.mode === "number" && !Number.isFinite(Number(c.check.expected))) return `bad number ${c.check.expected}`;
  if (c.check.mode === "choice" && !/^[ABCD]$/.test(c.check.expected)) return `bad choice ${c.check.expected}`;
  return null;
}

const ids = process.argv.slice(2).length ? process.argv.slice(2) : ["gsm8k", "mmlu", "humaneval", "mbpp"];
let bad = 0;
for (const id of ids) {
  const items = await datasetItems(id);
  const failures: string[] = [];
  const queue = items.slice();
  await Promise.all(
    Array.from({ length: 8 }, async () => {
      for (let it = queue.shift(); it; it = queue.shift()) {
        const err = it.case.envType === "vm" ? await checkCode(it) : checkAnswer(it.case);
        if (err) failures.push(`${it.case.id}: ${err}`);
      }
    }),
  );
  const a = await materializeSuite(id, { sampleSize: 12, seed: 7 });
  const b = await materializeSuite(id, { sampleSize: 12, seed: 7 });
  const c = await materializeSuite(id, { sampleSize: 12, seed: 8 });
  const key = (s: typeof a) => s.cases.map((x) => x.id).join();
  if (key(a) !== key(b)) failures.push("sampling not deterministic");
  if (key(a) === key(c)) failures.push("seed has no effect");
  if (a.cases.some((x) => "reference" in x)) failures.push("reference leaked into a case");
  bad += failures.length;
  console.log(`${id}: ${items.length} items, ${failures.length} failures`);
  for (const f of failures.sort()) console.log(`  ${f}`);
}
process.exitCode = bad ? 1 : 0;
