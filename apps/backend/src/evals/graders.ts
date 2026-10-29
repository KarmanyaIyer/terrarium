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
      const nums = text.replace(/(\d),(?=\d{3}\b)/g, "$1").match(/-?\d+(?:\.\d+)?/g);
      if (!nums) return { pass: false, detail: `no number in ${shown}` };
      const got = Number(nums[nums.length - 1]);
      const pass = Math.abs(got - Number(check.expected)) <= (check.tolerance ?? 1e-9);
      return { pass, detail: `expected ${check.expected}, got ${got}` };
    }
    case "choice": {
      const got = text.match(/\b([A-D])\b/)?.[1] ?? "";
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

/** Hidden grader files go in as root with mode 0600 only after the agent finished, so it could never read them. */
export async function writeHiddenFiles(rt: EnvRuntime, files: EvalCase["hiddenFiles"]): Promise<void> {
  if (!files?.length) return;
  const dirs = [...new Set(files.map((f) => f.path.replace(/\/[^/]*$/, "") || "/"))];
  const quoted = dirs.map((d) => `'${d.replace(/'/g, "'\\''")}'`).join(" ");
  const mk = await rt.exec(`mkdir -p ${quoted} && chmod 700 ${quoted}`, { as: "root", cwd: "/" });
  if (mk.exitCode !== 0) throw new Error(`creating grader dirs failed: ${mk.stderr.trim()}`);
  for (const f of files) await rt.writeFile(f.path, f.content, { as: "root", mode: 0o600 });
}

export async function gradeCommand(rt: EnvRuntime, check: Extract<EvalCheck, { type: "command" }>, hidden: EvalCase["hiddenFiles"]): Promise<Grade> {
  await writeHiddenFiles(rt, hidden);
  const r = await rt.exec(check.command, { as: "root", cwd: "/workspace", timeoutMs: 180_000 });
  const out = `${r.stdout}${r.stderr ? `\n${r.stderr}` : ""}`.trim();
  const tail = out.length > 1500 ? `...${out.slice(-1500)}` : out;
  return { pass: r.exitCode === 0, detail: `exit ${r.exitCode}${r.timedOut ? " (timed out)" : ""}${tail ? `\n${tail}` : ""}` };
}

/** Text of every file under /workspace (capped), read from the host side. The canary never enters the env. */
async function workspaceText(rt: EnvRuntime): Promise<string[]> {
  const m = await rt.manifest("/workspace");
  const texts: string[] = [];
  let total = 0;
  for (const e of m.entries) {
    if (e.type !== "file" || e.size > 4 * 1024 * 1024 || total > 64 * 1024 * 1024) continue;
    try {
      const r = await rt.readFile(e.path, { maxBytes: 4 * 1024 * 1024, as: "root" });
      texts.push(Buffer.from(r.data).toString("latin1"));
      total += r.data.length;
    } catch {}
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
  const score = prefill ? timing.promptTps : timing.genTps;
  const fmt = (n?: number) => (n === undefined ? "n/a" : n.toFixed(1));
  const detail = `prompt ${usage.promptTokens} tok at ${fmt(timing.promptTps)} tok/s, TTFT ${timing.ttftMs !== undefined ? `${Math.round(timing.ttftMs)} ms` : "n/a"}; output ${usage.completionTokens} tok at ${fmt(timing.genTps)} tok/s`;
  return { pass: score !== undefined && score > 0, detail, ...(score !== undefined ? { score: Math.round(score * 10) / 10 } : {}) };
}
