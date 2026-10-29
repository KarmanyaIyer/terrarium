// Dataset records -> EvalCases. Each item may carry a reference solution, used only by the
// verification script; materializeSuite strips it so it never reaches an env.

import { gunzipSync } from "node:zlib";
import type { EvalCase } from "@terrarium/shared";
import { parseCsv } from "./datasets.ts";

export interface DatasetItem {
  case: EvalCase;
  group?: string; // MMLU subject, for stratified sampling
  reference?: { path: string; content: string };
}

const HIDDEN_TEST = "/grader/test_hidden.py";
// The VM's test grader runs solution.py in its own process; the tests below see it through a proxy.
const CODE_CHECK = { type: "tests", file: HIDDEN_TEST, timeoutSec: 60 } as const;

function clip(text: string, max: number): string {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length <= max ? one : `${one.slice(0, max - 1).trimEnd()}…`;
}

// JSON string literals are valid Python string literals for everything JSON.stringify emits.
const py = (s: string) => JSON.stringify(s);

// Hidden test module for the grader (guest grade_runner.py). `import solution` resolves to the candidate's
// module in another process. Dataset test code runs here, in the test process, in a namespace where a name the
// test doesn't define falls back to the candidate's module (MBPP tests use helpers and data from the
// reference code), except built-ins and standard-library modules, which always resolve locally.
function harness(tests: string[], body: string): string {
  return [
    "import builtins",
    "import sys",
    "import unittest",
    "",
    "import solution",
    "import terrarium_grading",
    "",
    "",
    "class CandidateNames(dict):",
    "    def __missing__(self, name):",
    "        if hasattr(builtins, name):",
    "            raise KeyError(name)",
    "        if name in getattr(sys, 'stdlib_module_names', ()) or name in sys.builtin_module_names:",
    "            self[name] = terrarium_grading.stdlib(name)",
    "            return self[name]",
    "        try:",
    "            return getattr(solution, name)",
    "        except AttributeError:",
    "            raise KeyError(name)",
    "",
    "",
    `TESTS = ${py(JSON.stringify(tests))}`,
    "",
    "",
    "class Hidden(unittest.TestCase):",
    "    pass",
    "",
    "",
    "def _case(i, code):",
    "    def test(self):",
    body,
    "    test.__name__ = 'test_%02d' % i",
    "    return test",
    "",
    "",
    "import json  # noqa: E402",
    "",
    "for _i, _code in enumerate(json.loads(TESTS)):",
    "    setattr(Hidden, 'test_%02d' % _i, _case(_i, _code))",
    "",
    'if __name__ == "__main__":',
    "    unittest.main()",
    "",
  ].join("\n");
}

export function convertGsm8k(buf: Buffer): DatasetItem[] {
  const lines = buf.toString("utf8").split("\n").filter((l) => l.trim());
  return lines.map((line, i) => {
    const rec = JSON.parse(line) as { question: string; answer: string };
    const expected = rec.answer.split("####").pop()!.trim().replace(/,/g, "");
    if (!/^-?\d+(\.\d+)?$/.test(expected)) throw new Error(`gsm8k ${i}: unparsable answer ${expected}`);
    return {
      case: {
        id: `gsm8k-${i}`,
        title: `GSM8K ${i}: ${clip(rec.question, 44)}`,
        prompt: `${rec.question}\n\nSolve the problem. Keep the working short, then give the final answer as a plain number on the last line, in the form:\nAnswer: <number>`,
        envType: "none",
        check: { type: "answer", mode: "number", expected },
        maxTurns: 1,
        timeoutSec: 300,
      },
    };
  });
}

export function convertMmlu(files: Map<string, Buffer>, subjects: string[]): DatasetItem[] {
  const items: DatasetItem[] = [];
  for (const subject of subjects) {
    const buf = files.get(`${subject}_test.csv`);
    if (!buf) throw new Error(`mmlu: missing subject ${subject}`);
    const label = subject.replace(/_/g, " ");
    parseCsv(buf.toString("utf8")).forEach((row, i) => {
      if (row.length !== 6 || !/^[ABCD]$/.test(row[5])) throw new Error(`mmlu ${subject} ${i}: bad row`);
      const [question, a, b, c, d, answer] = row;
      items.push({
        group: subject,
        case: {
          id: `mmlu-${subject}-${i}`,
          title: `${label} ${i}: ${clip(question, 40)}`,
          prompt: `Answer this multiple-choice question about ${label}. Reply with only the letter of the correct choice (A, B, C or D).\n\n${question.trim()}\n\nA. ${a}\nB. ${b}\nC. ${c}\nD. ${d}`,
          envType: "none",
          check: { type: "answer", mode: "choice", expected: answer },
          maxTurns: 1,
          timeoutSec: 180,
        },
      });
    });
  }
  return items;
}

export function convertHumanEval(buf: Buffer): DatasetItem[] {
  const lines = gunzipSync(buf).toString("utf8").split("\n").filter((l) => l.trim());
  return lines.map((line) => {
    const rec = JSON.parse(line) as { task_id: string; prompt: string; entry_point: string; canonical_solution: string; test: string };
    const n = rec.task_id.split("/")[1];
    const starter = `${rec.prompt.replace(/\s*$/, "\n")}    raise NotImplementedError\n`;
    return {
      reference: { path: "/workspace/solution.py", content: rec.prompt + rec.canonical_solution },
      case: {
        id: `humaneval-${n}`,
        title: `HumanEval ${n}: ${rec.entry_point}`,
        prompt: `Complete the function \`${rec.entry_point}\` in /workspace/solution.py so it does what its docstring says. Replace the \`raise NotImplementedError\` line with a working implementation, keep the function's name and signature, and keep the rest of the file. Use only the Python standard library. You can run your own checks with python3.`,
        envType: "vm",
        setupFiles: [{ path: "/workspace/solution.py", content: starter }],
        hiddenFiles: [
          {
            path: HIDDEN_TEST,
            // The prompt (dataset code: imports and helpers such as encode_cyclic) runs locally, so the test's
            // helpers are the dataset's, not the candidate's; only the entry point comes from solution.py.
            content: harness(
              [rec.test],
              [
                "        ns = {}",
                `        exec(compile(${py(rec.prompt)}, "prompt.py", "exec"), ns)`,
                `        ns[${py(rec.entry_point)}] = getattr(solution, ${py(rec.entry_point)})`,
                '        exec(compile(code, "hidden_test.py", "exec"), ns)',
                `        ns["check"](ns[${py(rec.entry_point)}])`,
              ].join("\n"),
            ),
          },
        ],
        check: CODE_CHECK,
        maxTurns: 15,
        timeoutSec: 600,
      },
    };
  });
}

interface MbppRecord {
  task_id: number;
  prompt: string;
  code: string;
  test_imports: string[];
  test_list: string[];
}

export function mbppEntryPoint(rec: MbppRecord): string {
  const defs = [...rec.code.matchAll(/^def\s+(\w+)\s*\(/gm)].map((m) => m[1]);
  const hit = defs.find((d) => new RegExp(`\\b${d}\\s*\\(`).test(rec.test_list[0]));
  if (!hit) throw new Error(`mbpp ${rec.task_id}: no entry point`);
  return hit;
}

export function convertMbpp(buf: Buffer): DatasetItem[] {
  const recs = JSON.parse(buf.toString("utf8")) as MbppRecord[];
  return recs.map((rec) => {
    const name = mbppEntryPoint(rec);
    return {
      reference: { path: "/workspace/solution.py", content: `${rec.code}\n` },
      case: {
        id: `mbpp-${rec.task_id}`,
        title: `MBPP ${rec.task_id}: ${name}`,
        prompt: `${rec.prompt.trim()}\n\nWrite it as a Python function named \`${name}\` in /workspace/solution.py. It must pass checks like this one:\n\n    ${rec.test_list[0]}\n\nUse only the Python standard library. You can run your own checks with python3.`,
        envType: "vm",
        setupFiles: [{ path: "/workspace/solution.py", content: `# Write ${name} here.\n` }],
        hiddenFiles: [
          {
            path: HIDDEN_TEST,
            content: harness(
              rec.test_list,
              [
                "        ns = CandidateNames()",
                `        for imp in json.loads(${py(JSON.stringify(rec.test_imports))}):`,
                '            exec(compile(imp, "hidden_test.py", "exec"), {}, ns)',
                `        ns[${py(name)}] = getattr(solution, ${py(name)})`,
                '        exec(compile(code, "hidden_test.py", "exec"), {"__builtins__": __builtins__}, ns)',
              ].join("\n"),
            ),
          },
        ],
        check: CODE_CHECK,
        maxTurns: 15,
        timeoutSec: 600,
      },
    };
  });
}
