// Verify every hand-written suite against its reference solution.
//
// sim:  fresh just-bash env with the case's setupFiles; the check must FAIL before the
//       reference runs (file/command checks), then evals/reference/<suite>/<case>.sh runs and
//       the check must PASS. For answer checks the script's stdout is graded as the reply.
// vm:   setupFiles + hiddenFiles in evals/.scratch/vm/<case>/ on the host (python3), with
//       /workspace and /grader rewritten to those dirs. The check must FAIL on the starter
//       code and PASS after evals/reference/<suite>/<case>/ is copied over the workspace.
// none: answer cases are graded against evals/reference/<suite>.json (reference replies).
//
// Run: node evals/scripts/verify.ts [suiteId...]

import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { EvalCase, EvalCheck, EvalSuite } from "@terrarium/shared";

const EVALS = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ROOT = resolve(EVALS, "..");
const { Bash } = await import(join(ROOT, "apps/backend/node_modules/just-bash/dist/bundle/index.js"));

type Outcome = { ok: boolean; detail: string };

function gradeAnswer(check: Extract<EvalCheck, { type: "answer" }>, reply: string): boolean {
  const text = reply.trim();
  switch (check.mode) {
    case "exact":
      return text === check.expected.trim();
    case "regex":
      return new RegExp(check.expected).test(text);
    case "number": {
      const nums = text.replace(/(\d),(?=\d{3}\b)/g, "$1").match(/-?\d+(?:\.\d+)?/g);
      if (!nums) return false;
      const got = Number(nums[nums.length - 1]);
      return Math.abs(got - Number(check.expected)) <= (check.tolerance ?? 1e-9);
    }
    case "choice":
      return (text.match(/\b([A-D])\b/)?.[1] ?? "") === check.expected;
  }
}

async function runSim(suite: EvalSuite, c: EvalCase): Promise<Outcome> {
  const files: Record<string, string> = {};
  for (const f of c.setupFiles ?? []) files[f.path] = f.content;
  const bash = new Bash({ cwd: "/workspace", python: true, files });
  const check = c.check;
  const grade = async (reply: string): Promise<boolean> => {
    if (check.type === "answer") return gradeAnswer(check, reply);
    if (check.type === "command") return (await bash.exec(check.command)).exitCode === 0;
    if (check.type === "file") {
      const r = await bash.exec(`cat ${check.path}`);
      if (r.exitCode !== 0) return false;
      if (check.equals !== undefined) return r.stdout === check.equals;
      return r.stdout.includes(check.contains ?? "");
    }
    throw new Error(`check ${check.type} unsupported in sim`);
  };
  if (check.type !== "answer" && (await grade(""))) return { ok: false, detail: "check passes before the reference ran" };
  const script = readFileSync(join(EVALS, "reference", suite.id, `${c.id}.sh`), "utf8");
  const r = await bash.exec(script);
  const pass = await grade(r.stdout);
  return { ok: pass, detail: pass ? "" : `reference failed: stdout=${JSON.stringify(r.stdout.slice(0, 200))} stderr=${r.stderr.slice(0, 200)}` };
}

function runVm(suite: EvalSuite, c: EvalCase): Outcome {
  if (c.check.type !== "command") return { ok: false, detail: "vm cases must use command checks" };
  const base = join(EVALS, ".scratch", "vm", c.id);
  rmSync(base, { recursive: true, force: true });
  const ws = join(base, "workspace");
  const gr = join(base, "grader");
  const put = (files: { path: string; content: string }[] | undefined) => {
    for (const f of files ?? []) {
      const p = f.path.replace(/^\/workspace\//, `${ws}/`).replace(/^\/grader\//, `${gr}/`);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, f.content);
    }
  };
  put(c.setupFiles);
  put(c.hiddenFiles);
  mkdirSync(ws, { recursive: true });
  const cmd = c.check.command
    .replaceAll("/workspace", ws)
    .replaceAll("/grader/", `${gr}/`)
    .replace(/\btimeout \d+ /g, "");
  const run = () => spawnSync("sh", ["-c", cmd], { encoding: "utf8", timeout: 120_000 });
  const before = run();
  if (before.status === 0) return { ok: false, detail: "hidden tests pass on the starter code" };
  const ref = join(EVALS, "reference", suite.id, c.id);
  if (!existsSync(ref)) return { ok: false, detail: `missing reference dir ${ref}` };
  cpSync(ref, ws, { recursive: true });
  const after = run();
  if (after.status !== 0) return { ok: false, detail: `reference fails: ${(after.stdout + after.stderr).slice(-600)}` };
  if (existsSync(join(ws, "tests"))) {
    const env = { ...process.env, PYTHONDONTWRITEBYTECODE: "1" };
    const visible = spawnSync("python3", ["-m", "unittest", "discover", "-s", "tests"], { cwd: ws, encoding: "utf8", env, timeout: 120_000 });
    if (visible.status !== 0) return { ok: false, detail: `visible tests fail on reference: ${visible.stderr.slice(-400)}` };
  }
  return { ok: true, detail: "" };
}

function runNone(suite: EvalSuite, c: EvalCase): Outcome {
  if (c.check.type === "speed") return { ok: true, detail: "" };
  if (c.check.type !== "answer") return { ok: false, detail: "none cases must use answer or speed checks" };
  const refs = JSON.parse(readFileSync(join(EVALS, "reference", `${suite.id}.json`), "utf8")) as Record<string, { good: string[]; bad: string[] }>;
  const r = refs[c.id];
  if (!r) return { ok: false, detail: "no reference replies" };
  for (const g of r.good) if (!gradeAnswer(c.check, g)) return { ok: false, detail: `good reply rejected: ${g}` };
  for (const b of r.bad) if (gradeAnswer(c.check, b)) return { ok: false, detail: `bad reply accepted: ${b}` };
  return { ok: true, detail: "" };
}

const only = process.argv.slice(2);
let failed = 0;
for (const name of readdirSync(join(EVALS, "suites")).filter((n) => n.endsWith(".json")).sort()) {
  const suite = JSON.parse(readFileSync(join(EVALS, "suites", name), "utf8")) as EvalSuite;
  if (only.length ? !only.includes(suite.id) : suite.id === "boundary") continue;
  for (const c of suite.cases) {
    const out = c.envType === "sim" ? await runSim(suite, c) : c.envType === "vm" ? runVm(suite, c) : runNone(suite, c);
    if (!out.ok) failed++;
    console.log(`${out.ok ? "ok  " : "FAIL"} ${suite.id}/${c.id}${out.detail ? ` :: ${out.detail}` : ""}`);
  }
}
console.log(failed ? `${failed} failed` : "all passed");
process.exitCode = failed ? 1 : 0;
