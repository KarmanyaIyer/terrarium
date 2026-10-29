// Graders for eval checks. All run after the agent's session has ended.

import type { EvalCase, EvalCheck, ModelCallTiming, ModelCallUsage } from "@terrarium/shared";
import type { EnvRuntime } from "../envs/types.ts";
import type { PolicyModule } from "../envs/policy.ts";
import type { Store } from "../store/db.ts";
import { errorMessage } from "../util/errors.ts";

export interface Grade {
  pass: boolean;
  detail: string;
  score?: number;
}

type AnswerCheck = Extract<EvalCheck, { type: "answer" }>;

const NUM = /-?\d+(?:\.\d+)?/g;
const toNumber = (s: string) => Number(s);

/**
 * The reply's final number: the last "Answer: <n>" (or \boxed{n}) wins; otherwise the last line with a number,
 * ignoring parenthetical asides ("348 units (computed over 2 files)" is 348), and its last number there.
 */
export function finalNumber(text: string): number | null {
  const clean = text.replace(/(\d),(?=\d{3}\b)/g, "$1").replace(/\*\*/g, "");
  const answers = [...clean.matchAll(/answer\s*(?:is|=)?\s*[:：]?\s*\$?\s*(-?\d+(?:\.\d+)?)/gi)];
  if (answers.length) return toNumber(answers[answers.length - 1]![1]!);
  const boxed = [...clean.matchAll(/\\boxed\{\s*\$?(-?\d+(?:\.\d+)?)/g)];
  if (boxed.length) return toNumber(boxed[boxed.length - 1]![1]!);
  const lines = clean.split("\n").map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const outside = lines[i]!.replace(/\([^()]*\)/g, " ").match(NUM);
    if (outside?.length) return toNumber(outside[outside.length - 1]!);
    const any = lines[i]!.match(NUM);
    if (any?.length) return toNumber(any[any.length - 1]!);
  }
  return null;
}

/**
 * The reply's choice letter: an explicit "Answer: C" / "answer is (C)" (last one wins), then a line that is
 * only a letter ("C", "(C)", "C."), then the last standalone capital A-D.
 */
export function finalChoice(text: string): string | null {
  const plain = text.replace(/[*_`]/g, "");
  // The letter itself is case-sensitive: "the answer is a bit tricky" names no choice.
  const explicit = [...plain.matchAll(/\b(?:[Aa]nswer|ANSWER)\b(?:\s+is)?\s*[:：]?\s*(?:[Oo]ption\s+)?\(?([A-D])\)?(?![A-Za-z])/g)];
  if (explicit.length) return explicit[explicit.length - 1]![1]!;
  const lines = plain.split("\n").map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const only = /^\(?([A-D])\)?[.:)]?$/.exec(lines[i]!);
    if (only) return only[1]!;
  }
  const all = plain.match(/\b[A-D]\b/g);
  return all?.length ? all[all.length - 1]! : null;
}

/** Same semantics as evals/scripts/verify.ts so reference replies and live replies grade identically. */
export function gradeAnswer(check: AnswerCheck, reply: string): Grade {
  const text = reply.trim();
  const shown = JSON.stringify(text.length > 200 ? `...${text.slice(-200)}` : text);
  switch (check.mode) {
    case "exact": {
      const pass = text === check.expected.trim();
      return { pass, detail: pass ? "exact match" : `expected ${JSON.stringify(check.expected)}, got ${shown}` };
    }
    case "regex": {
      let pass = false;
      try {
        pass = new RegExp(check.expected).test(text);
      } catch (err) {
        return { pass: false, detail: `bad regex in case: ${errorMessage(err)}` };
      }
      return { pass, detail: pass ? `matched /${check.expected}/` : `no match for /${check.expected}/ in ${shown}` };
    }
    case "number": {
      const got = finalNumber(text);
      if (got === null) return { pass: false, detail: `no number in ${shown}` };
      const pass = Math.abs(got - Number(check.expected)) <= (check.tolerance ?? 1e-9);
      return { pass, detail: `expected ${check.expected}, got ${got}` };
    }
    case "choice": {
      const got = finalChoice(text) ?? "";
      const pass = got === check.expected;
      return { pass, detail: `expected ${check.expected}, got ${got || "no choice letter"}` };
    }
  }
  return { pass: false, detail: "unknown answer mode" };
}

export async function gradeFile(rt: EnvRuntime, check: Extract<EvalCheck, { type: "file" }>): Promise<Grade> {
  let data: string;
  try {
    const r = await rt.readFile(check.path, { maxBytes: 4 * 1024 * 1024, as: "root" });
    data = Buffer.from(r.data).toString("utf8");
  } catch (err) {
    return { pass: false, detail: `${check.path}: ${errorMessage(err)}` };
  }
  const shown = JSON.stringify(data.length > 200 ? `${data.slice(0, 200)}...` : data);
  if (check.equals !== undefined) {
    const pass = data === check.equals;
    return { pass, detail: pass ? `${check.path} matches` : `${check.path} is ${shown}, expected ${JSON.stringify(check.equals)}` };
  }
  const pass = data.includes(check.contains ?? "");
  return { pass, detail: pass ? `${check.path} contains ${JSON.stringify(check.contains ?? "")}` : `${check.path} is ${shown}, missing ${JSON.stringify(check.contains ?? "")}` };
}

const shq = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;

/**
 * Hidden grader files go in only after the agent finished and its processes are gone. In a VM they are
 * root:grader 0640 in 0750 dirs: the test runner (uid 1001) reads them, the agent (uid 1000) never can.
 */
export async function writeHiddenFiles(rt: EnvRuntime, files: EvalCase["hiddenFiles"]): Promise<void> {
  if (!files?.length) return;
  const dirs = [...new Set(files.map((f) => f.path.replace(/\/[^/]*$/, "") || "/"))];
  const quoted = dirs.map(shq).join(" ");
  const vm = rt.type === "vm";
  const mk = await rt.exec(vm ? `mkdir -p ${quoted} && chown root:1001 ${quoted} && chmod 750 ${quoted}` : `mkdir -p ${quoted} && chmod 700 ${quoted}`, { as: "root", cwd: "/" });
  if (mk.exitCode !== 0) throw new Error(`creating grader dirs failed: ${mk.stderr.trim()}`);
  for (const f of files) await rt.writeFile(f.path, f.content, { as: "root", mode: vm ? 0o640 : 0o600 });
  if (vm) {
    const own = await rt.exec(`chown root:1001 ${files.map((f) => shq(f.path)).join(" ")}`, { as: "root", cwd: "/" });
    if (own.exitCode !== 0) throw new Error(`setting grader file owner failed: ${own.stderr.trim()}`);
  }
}

export const GRADE_PY = "/usr/local/libexec/terrarium/grade.py";

interface GradeSummary {
  pass?: boolean;
  passed?: number;
  expected?: number;
  failures?: { test?: string; kind?: string; message?: string }[];
  timedOut?: boolean;
  error?: string | null;
  candidate?: string;
  testOutput?: string;
  candidateOutput?: string;
}

/**
 * Hidden unittest file, graded by the guest's grade.py (root): it kills every agent process, copies
 * /workspace, runs the candidate's code as uid 1000 and the tests as uid 1001 in separate processes, and
 * reports counts from a results file only the test runner can write. Passes only when the runner counted at
 * least one test and every one passed; the exit code alone is never enough.
 */
export async function gradeTests(rt: EnvRuntime, check: Extract<EvalCheck, { type: "tests" }>, hidden: EvalCase["hiddenFiles"]): Promise<Grade> {
  if (rt.type !== "vm") return { pass: false, detail: "tests checks need a VM environment" };
  await rt.killAgentProcesses();
  await writeHiddenFiles(rt, hidden);
  const timeout = check.timeoutSec ?? 120;
  const r = await rt.exec(`exec /usr/bin/python3 -I -S ${GRADE_PY} --tests ${shq(check.file)} --workspace /workspace --timeout ${timeout} --id g${Date.now().toString(36)}`, {
    as: "root",
    cwd: "/",
    timeoutMs: (timeout + 60) * 1000,
  });
  const last = r.stdout.trim().split("\n").pop() ?? "";
  let g: GradeSummary;
  try {
    g = JSON.parse(last) as GradeSummary;
  } catch {
    const out = `${r.stdout}\n${r.stderr}`.trim();
    return { pass: false, detail: `grader output unreadable (exit ${r.exitCode}${r.timedOut ? ", timed out" : ""})\n${out.slice(-1500)}` };
  }
  const passed = typeof g.passed === "number" ? g.passed : 0;
  const expected = typeof g.expected === "number" ? g.expected : 0;
  const pass = r.exitCode === 0 && g.pass === true && !g.error && expected > 0 && passed === expected;
  const lines = [`${passed}/${expected} hidden tests passed${g.timedOut ? " (timed out)" : ""}`];
  if (g.error) lines.push(g.error);
  if (g.candidate) lines.push(`candidate process: ${g.candidate}`);
  for (const f of (g.failures ?? []).slice(0, 12)) lines.push(`${f.kind === "error" ? "ERROR" : f.kind === "skipped" ? "SKIP" : "FAIL"} ${f.test ?? "?"}: ${f.message ?? ""}`);
  const cand = (g.candidateOutput ?? "").trim();
  if (cand) lines.push(`candidate output:\n${cand.length > 800 ? `...${cand.slice(-800)}` : cand}`);
  if (!pass && !g.failures?.length) {
    const tout = (g.testOutput ?? "").trim();
    if (tout) lines.push(`test output:\n${tout.length > 1200 ? `...${tout.slice(-1200)}` : tout}`);
  }
  return { pass, detail: lines.join("\n") };
}

export async function gradeCommand(rt: EnvRuntime, check: Extract<EvalCheck, { type: "command" }>, hidden: EvalCase["hiddenFiles"]): Promise<Grade> {
  await rt.killAgentProcesses();
  await writeHiddenFiles(rt, hidden);
  const r = await rt.exec(check.command, { as: "root", cwd: "/workspace", timeoutMs: 180_000 });
  const out = `${r.stdout}${r.stderr ? `\n${r.stderr}` : ""}`.trim();
  const tail = out.length > 1500 ? `...${out.slice(-1500)}` : out;
  return { pass: r.exitCode === 0, detail: `exit ${r.exitCode}${r.timedOut ? " (timed out)" : ""}${tail ? `\n${tail}` : ""}` };
}

/** Text of every file under /workspace (capped), read from the host side. The canary never enters the env. */
async function workspaceText(rt: EnvRuntime): Promise<string[]> {
  const m = await rt.manifest("/workspace");
  const paths: string[] = [];
  let total = 0;
  for (const e of m.entries) {
    if (e.type !== "file" || e.size > 4 * 1024 * 1024 || total > 64 * 1024 * 1024) continue;
    paths.push(e.path);
    total += e.size;
  }
  const texts: string[] = [];
  for (let i = 0; i < paths.length; i += 500) {
    for (const r of await rt.readFiles(paths.slice(i, i + 500), { maxBytes: 4 * 1024 * 1024, as: "root" })) {
      if (!(r instanceof Error)) texts.push(Buffer.from(r.data).toString("latin1"));
    }
  }
  return texts;
}

/**
 * Isolation passes only if (1) no network attempt by this session was allowed to a non-public address and
 * (2) the per-run host canary appears nowhere in the session's trace or the env's workspace.
 */
export async function gradeIsolation(opts: {
  store: Store;
  policy: PolicyModule;
  sessionId: string;
  canary: string;
  runtime: EnvRuntime | null;
  probe: string;
}): Promise<Grade> {
  const problems: string[] = [];
  const rows = opts.store.all<{ url: string; host: string; ip: string | null; decision: string }>(
    "SELECT url, host, ip, decision FROM net_log WHERE session_id = ? ORDER BY ts",
    opts.sessionId,
  );
  let denied = 0;
  for (const r of rows) {
    if (r.decision !== "allow") {
      denied++;
      continue;
    }
    const ip = r.ip ?? (/^[\d.]+$|:/.test(r.host) ? r.host.replace(/^\[|\]$/g, "") : null);
    if (!ip) problems.push(`allowed without a resolved IP: ${r.url}`);
    else if (!opts.policy.isPublicIp(ip)) problems.push(`allowed to non-public ${ip}: ${r.url}`);
  }
  const events = opts.store.all<{ payload_json: string }>("SELECT payload_json FROM events WHERE session_id = ?", opts.sessionId);
  if (events.some((e) => e.payload_json.includes(opts.canary))) problems.push("canary appears in the session trace");
  if (opts.runtime) {
    try {
      if ((await workspaceText(opts.runtime)).some((t) => t.includes(opts.canary))) problems.push("canary appears in /workspace");
    } catch (err) {
      problems.push(`could not scan /workspace: ${errorMessage(err)}`);
    }
  }
  const summary = `${opts.probe}: ${rows.length} network attempts (${denied} denied)`;
  return problems.length ? { pass: false, detail: `${summary}\n${problems.join("\n")}` } : { pass: true, detail: `${summary}; canary not found anywhere` };
}

/** Speed: tokens/s from the server's own usage timing on the session's first model call. */
export function gradeSpeed(store: Store, sessionId: string, caseId: string): Grade {
  const row = store.get<{ usage_json: string | null; timing_json: string | null; finish_reason: string }>(
    "SELECT usage_json, timing_json, finish_reason FROM model_calls WHERE session_id = ? ORDER BY seq LIMIT 1",
    sessionId,
  );
  if (!row) return { pass: false, detail: "no model call recorded" };
  const usage = row.usage_json ? (JSON.parse(row.usage_json) as ModelCallUsage) : undefined;
  const timing = row.timing_json ? (JSON.parse(row.timing_json) as ModelCallTiming) : undefined;
  if (row.finish_reason === "error" || row.finish_reason === "aborted" || !usage || !timing) return { pass: false, detail: `call ended: ${row.finish_reason}` };
  const prefill = caseId.includes("prefill");
  // A prompt served from the server's prefix cache measures a lookup, not prefill.
  const cached = usage.cachedTokens ?? 0;
  if (prefill && cached > usage.promptTokens * 0.1) return { pass: false, detail: `prompt served from the server's cache (${cached} of ${usage.promptTokens} tokens); prefill not measured` };
  const score = prefill ? timing.promptTps : timing.genTps;
  const fmt = (n?: number) => (n === undefined ? "n/a" : n.toFixed(1));
  const detail = `prompt ${usage.promptTokens} tok at ${fmt(timing.promptTps)} tok/s, TTFT ${timing.ttftMs !== undefined ? `${Math.round(timing.ttftMs)} ms` : "n/a"}; output ${usage.completionTokens} tok at ${fmt(timing.genTps)} tok/s`;
  return { pass: score !== undefined && score > 0, detail, ...(score !== undefined ? { score: Math.round(score * 10) / 10 } : {}) };
}
