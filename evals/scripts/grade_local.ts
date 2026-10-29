// Host-side run of the VM test grader (guest/files/usr/local/libexec/terrarium/grade.py --local): the same
// split as in the guest (candidate code and hidden tests in separate processes), without the uid switch.
// Python: $TERRARIUM_PY, else python3.12 (the guest's version) when on PATH, else python3.

import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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
}

export function gradeLocal(workspace: string, testsFile: string, timeoutSec = 120): LocalGrade {
  const r = spawnSync(hostPython(), ["-I", "-S", GRADE_PY, "--local", "--tests", testsFile, "--workspace", workspace, "--timeout", String(timeoutSec)], {
    encoding: "utf8",
    timeout: (timeoutSec + 30) * 1000,
  });
  const last = (r.stdout ?? "").trim().split("\n").pop() ?? "";
  try {
    const j = JSON.parse(last) as { pass?: boolean; passed?: number; expected?: number; error?: string | null; failures?: { test?: string; message?: string }[] };
    const passed = j.passed ?? 0;
    const expected = j.expected ?? 0;
    const fails = (j.failures ?? []).map((f) => `${f.test}: ${f.message}`).join("; ");
    return { pass: r.status === 0 && j.pass === true && expected > 0 && passed === expected, passed, expected, detail: `${passed}/${expected}${j.error ? ` ${j.error}` : ""}${fails ? ` ${fails}` : ""}` };
  } catch {
    return { pass: false, passed: 0, expected: 0, detail: `grader output unreadable: ${(r.stdout + r.stderr).slice(-400)}` };
  }
}
