// Review 5 cases (qa/review5-cases), shared by the node and VM grading tests and qa/review5-cases/run.py.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_DIR } from "../config.ts";
import type { GradeSummary } from "./graders.ts";

export const REVIEW5_DIR = join(REPO_DIR, "qa/review5-cases");

/** The isolated run's own verdict: "inexact" is a grader error (it couldn't reproduce Python), never a pass. */
export type Iso = "pass" | "fail" | "inexact";

/** Item -> case -> [plain unittest passes, the isolated run's verdict]. */
export const REVIEW5: Record<string, Record<string, [boolean, Iso]>> = JSON.parse(readFileSync(join(REVIEW5_DIR, "expect.json"), "utf8"));

const GRADER_ERROR = /\b(Inexact|CandidateGone|Unsendable|GraderError|_Poisoned)\b/;

export function isoVerdict(s: GradeSummary): Iso {
  const expected = s.expected ?? 0;
  if (expected > 0 && s.passed === expected && !s.error) return "pass";
  if (s.error || s.candidate || (s.failures ?? []).some((f) => GRADER_ERROR.test(f.message ?? ""))) return "inexact";
  return "fail";
}

/** Review-case verdict. A sound isolated pass plus a failing protected plain run is inexact: the two
 * executions disagree, so the grader must not decide the candidate's behavior. An isolated ordinary
 * failure stays a failure even when the plain run differs, preserving the established case taxonomy. */
export function reviewVerdict(s: GradeSummary): Iso {
  const isolated = isoVerdict(s);
  return isolated === "pass" && s.verdict !== "pass" ? "inexact" : isolated;
}
