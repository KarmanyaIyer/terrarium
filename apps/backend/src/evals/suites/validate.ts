// Structural checks for suites and cases. Returns problems as strings; empty means valid.

import type { EvalCase, EvalCheck, EvalSuite } from "@terrarium/shared";

const ENV_TYPES = new Set(["vm", "sim", "none"]);
const NETWORK = new Set(["off", "registries", "web"]);

// Which check types make sense in each env type.
const CHECKS_FOR: Record<string, Set<EvalCheck["type"]>> = {
  none: new Set(["answer", "speed"]),
  sim: new Set(["answer", "file", "command", "isolation"]),
  vm: new Set(["answer", "file", "command", "isolation"]),
};

function filePathProblems(files: { path: string; content: string }[] | undefined, root: string, label: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const f of files ?? []) {
    if (typeof f.path !== "string" || !f.path.startsWith(root) || f.path.length <= root.length || f.path.split("/").includes("..")) {
      out.push(`${label} path ${f.path} must be under ${root}`);
    }
    if (typeof f.content !== "string") out.push(`${label} ${f.path} content must be a string`);
    if (seen.has(f.path)) out.push(`${label} ${f.path} listed twice`);
    seen.add(f.path);
  }
  return out;
}

function checkProblems(c: EvalCase): string[] {
  const out: string[] = [];
  const check = c.check;
  if (!check || typeof check !== "object") return ["missing check"];
  const allowed = CHECKS_FOR[c.envType];
  if (allowed && !allowed.has(check.type)) out.push(`check ${check.type} does not suit envType ${c.envType}`);
  switch (check.type) {
    case "answer":
      if (typeof check.expected !== "string" || !check.expected) out.push("answer.expected must be a non-empty string");
      else if (check.mode === "regex") {
        try {
          new RegExp(check.expected);
        } catch {
          out.push(`answer regex does not compile: ${check.expected}`);
        }
      } else if (check.mode === "number") {
        if (!Number.isFinite(Number(check.expected))) out.push(`answer number not numeric: ${check.expected}`);
      } else if (check.mode === "choice") {
        if (!/^[A-Z]$/.test(check.expected)) out.push(`answer choice must be one letter: ${check.expected}`);
      } else if (check.mode !== "exact") out.push(`unknown answer mode ${String((check as { mode: unknown }).mode)}`);
      if (check.tolerance !== undefined && !(check.tolerance >= 0)) out.push("tolerance must be >= 0");
      break;
    case "command": {
      if (typeof check.command !== "string" || !check.command.trim()) out.push("command must be non-empty");
      const hidden = new Set((c.hiddenFiles ?? []).map((f) => f.path));
      for (const m of check.command.matchAll(/\/grader\/[\w./-]+/g)) {
        if (!hidden.has(m[0])) out.push(`command uses ${m[0]} but no hiddenFile provides it`);
      }
      break;
    }
    case "file":
      if (!check.path?.startsWith("/workspace/")) out.push("file check path must be under /workspace/");
      if (check.equals === undefined && check.contains === undefined) out.push("file check needs equals or contains");
      break;
    case "isolation":
      if (!check.probe) out.push("isolation check needs a probe");
      break;
    case "speed":
      break;
    default:
      out.push(`unknown check type ${String((check as { type: unknown }).type)}`);
  }
  return out;
}

export function validateCase(c: EvalCase): string[] {
  const out: string[] = [];
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(c.id ?? "")) out.push(`bad id ${c.id}`);
  if (typeof c.title !== "string" || !c.title.trim()) out.push("missing title");
  if (typeof c.prompt !== "string" || !c.prompt.trim()) out.push("missing prompt");
  if (!ENV_TYPES.has(c.envType)) out.push(`bad envType ${c.envType}`);
  if (c.network !== undefined && !NETWORK.has(c.network)) out.push(`bad network ${c.network}`);
  if (c.envType === "none" && (c.setupFiles?.length || c.hiddenFiles?.length || c.network)) out.push("envType none takes no files or network");
  if (c.envType === "sim" && c.hiddenFiles?.length) out.push("sim envs cannot hide files from the agent; use vm");
  if (!Number.isInteger(c.maxTurns) || c.maxTurns < 1 || c.maxTurns > 40) out.push(`maxTurns out of range: ${c.maxTurns}`);
  if (!Number.isFinite(c.timeoutSec) || c.timeoutSec < 30 || c.timeoutSec > 3600) out.push(`timeoutSec out of range: ${c.timeoutSec}`);
  out.push(...filePathProblems(c.setupFiles, "/workspace/", "setupFile"));
  out.push(...filePathProblems(c.hiddenFiles, "/grader/", "hiddenFile"));
  out.push(...checkProblems(c));
  return out.map((p) => `${c.id}: ${p}`);
}

export function validateSuite(s: EvalSuite): string[] {
  const out: string[] = [];
  if (!/^[a-z0-9][a-z0-9-]*$/.test(s.id ?? "")) out.push(`bad suite id ${s.id}`);
  if (!s.title?.trim()) out.push(`${s.id}: missing title`);
  if (!s.description?.trim()) out.push(`${s.id}: missing description`);
  if (!Array.isArray(s.cases)) return [...out, `${s.id}: cases must be an array`];
  const ids = new Set<string>();
  for (const c of s.cases) {
    if (ids.has(c.id)) out.push(`${s.id}: duplicate case id ${c.id}`);
    ids.add(c.id);
    if (s.envType !== "mixed" && c.envType !== s.envType) out.push(`${s.id}/${c.id}: envType ${c.envType} differs from suite ${s.envType}`);
    out.push(...validateCase(c).map((p) => `${s.id}/${p}`));
  }
  return out;
}
