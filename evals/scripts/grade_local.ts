// Host-side run of the VM test grader (guest/files/usr/local/libexec/terrarium/grade.py --local): the same
// two runs as in the guest (isolated: candidate code and hidden tests in separate processes; then plain
// in-process unittest), without the uid switch. Graded by the backend's own rules (testsGrade).
// Python: $TERRARIUM_PY, else python3.12 (the guest's version) when on PATH, else python3.

import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { testsGrade, type GradeSummary } from "../../apps/backend/src/evals/graders.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const GRADE_PY = join(ROOT, "guest/files/usr/local/libexec/terrarium/grade.py");

let python: string | null = null;
export function hostPython(): string {
  if (!python) {
    const has = (p: string) => spawnSync(p, ["-c", "pass"], { stdio: "ignore" }).status === 0;
    python = process.env.TERRARIUM_PY || (has("python3.12") ? "python3.12" : "python3");
  }
  return python;
}

export interface LocalGrade {
  pass: boolean;
  passed: number;
  expected: number;
  detail: string;
  /** The two runs disagreed (or the summary lacked one): a grader error. */
  error?: boolean;
}

export function gradeLocal(workspace: string, testsFile: string, timeoutSec = 120): LocalGrade {
  const r = spawnSync(hostPython(), ["-I", "-S", GRADE_PY, "--local", "--tests", testsFile, "--workspace", workspace, "--timeout", String(timeoutSec)], {
    encoding: "utf8",
    timeout: (2 * timeoutSec + 30) * 1000,
  });
  const last = (r.stdout ?? "").trim().split("\n").pop() ?? "";
  let g: GradeSummary;
  try {
    g = JSON.parse(last) as GradeSummary;
  } catch {
    return { pass: false, passed: 0, expected: 0, detail: `grader output unreadable: ${(r.stdout + r.stderr).slice(-400)}` };
  }
  const t = testsGrade(g, r.status);
  return { pass: t.pass, passed: t.passed, expected: t.expected, detail: t.detail.replaceAll("\n", " | "), ...(t.error ? { error: true } : {}) };
}
