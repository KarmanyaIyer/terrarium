import type { EnvFacts, EvalCase, EvalSuite, ModelInfo } from "@terrarium/shared";

const GiB = 1024 ** 3;
const g = (x: number) => Math.round(x * GiB);

export const TOTAL_RAM = 25_769_803_776; // 24 GiB M5
export const BUDGET = 12 * GiB;

function model(p: Partial<ModelInfo> & Pick<ModelInfo, "id" | "name" | "family" | "params" | "quant">): ModelInfo {
  return {
    diskBytes: 0,
    nativeContext: 262_144,
    toolFormat: "qwen3_coder XML",
    thinking: "optional",
    kvBytesPerToken: 33_587,
    fixedBytes: g(0.05),
    weightsBytes: 0,
    loaded: false,
    defaultContext: 32_768,
    defaultMaxOutput: 4096,
    sampling: { temperature: 0.6, topP: 0.95, topK: 20, presencePenalty: 1.5 },
    ...p,
  };
}

export const MODELS: ModelInfo[] = [
  model({
    id: "Qwen3.5-4B-MLX-4bit",
    name: "Qwen3.5 4B",
    family: "qwen3.5",
    params: "4.5B",
    quant: "4bit",
    diskBytes: 3_113_851_290,
    weightsBytes: g(2.58),
  }),
  model({
    id: "Qwen3.5-9B-MLX-4bit",
    name: "Qwen3.5 9B",
    family: "qwen3.5",
    params: "9.4B",
    quant: "4bit",
    diskBytes: 6_388_764_672,
    weightsBytes: g(5.0),
    loaded: true,
    loadedContext: 32_768,
    residentBytes: g(7.02),
  }),
  model({
    id: "gemma-4-12B-it-4bit",
    name: "Gemma 4 12B",
    family: "gemma4",
    params: "12.0B",
    quant: "4bit",
    diskBytes: 7_237_102_387,
    weightsBytes: g(6.74),
    kvBytesPerToken: 16_794,
    fixedBytes: g(0.34),
    toolFormat: "gemma4",
    nativeContext: 262_144,
    sampling: { temperature: 1.0, topP: 0.95, topK: 64 },
  }),
  model({
    id: "Ternary-Bonsai-2-27B-mlx-2bit",
    name: "Bonsai 2 27B",
    family: "bonsai",
    params: "27.4B",
    quant: "2bit ternary",
    diskBytes: 9_234_179_686,
    weightsBytes: g(7.67),
    kvBytesPerToken: 67_072,
    fixedBytes: g(0.08),
    defaultContext: 24_576,
  }),
  model({
    id: "Ternary-Bonsai-2-9B-mlx-2bit",
    name: "Bonsai 2 9B",
    family: "bonsai",
    params: "9.0B",
    quant: "2bit ternary",
    diskBytes: 3_715_146_547,
    weightsBytes: g(2.54),
  }),
  model({
    id: "Ternary-Bonsai-2-2B-mlx-2bit",
    name: "Bonsai 2 2B",
    family: "bonsai",
    params: "2.2B",
    quant: "2bit ternary",
    diskBytes: 1_181_116_006,
    weightsBytes: g(1.1),
    kvBytesPerToken: 12_595,
    defaultContext: 16_384,
    defaultMaxOutput: 2048,
    loaded: true,
    loadedContext: 16_384,
    residentBytes: g(2.31),
  }),
];

export const VM_FACTS = (cpus: number, memoryMiB: number, diskMiB: number, used: number): EnvFacts => ({
  kind: "vm",
  isolation: "Linux micro-VM (Gondolin 0.14, krun, Apple Hypervisor.framework)",
  os: "Alpine Linux v3.22",
  kernel: "6.12.48-0-virt",
  arch: "aarch64",
  cpus,
  memoryMiB,
  diskMiB,
  diskUsedMiB: used,
  user: "agent (uid 1000)",
  workdir: "/workspace",
  mounts: [
    { path: "/inbox", kind: "inbox", access: "ro" },
    { path: "/outbox", kind: "outbox", access: "rw" },
  ],
  hostFoldersMounted: false,
  image: {
    name: "terrarium-base:2026.10.27",
    digest: "sha256:4be1c0a9f3e27d55b8f90e1d6a2c7b3e58d14f0a9c6e2b7d31f85a04c9e6d2b17",
    bytes: 287_309_824,
  },
  tools: [
    "python3 3.12.12",
    "pip 25.2",
    "node 24.11.1",
    "git 2.49.1",
    "gcc 14.2.0",
    "make 4.4.1",
    "curl 8.14.1",
    "jq 1.8.0",
    "rg 14.1.1",
    "sqlite3 3.49.2",
  ],
  gatheredAt: Date.now() - 3_600_000,
});

export const SIM_FACTS = (python: boolean, javascript: boolean): EnvFacts => ({
  kind: "sim",
  isolation: "Simulated shell (just-bash 3.6, child process under sandbox-exec)",
  user: "agent (simulated, no uid)",
  workdir: "/workspace",
  mounts: [],
  hostFoldersMounted: false,
  simCommands: [
    "awk", "base64", "basename", "cat", "cd", "chmod", "cp", "curl", "cut", "date", "diff", "dirname", "du",
    "echo", "env", "export", "find", "grep", "gunzip", "gzip", "head", "jq", "ln", "ls", "mkdir", "mv",
    "od", "paste", "printf", "pwd", "python3", "readlink", "rm", "rmdir", "sed", "seq", "sha256sum",
    "sleep", "sort", "split", "stat", "tac", "tail", "tar", "tee", "test", "touch", "tr", "tree", "true",
    "uniq", "wc", "which", "xargs", "yq",
  ],
  runtimes: { python, javascript },
  gatheredAt: Date.now() - 7_200_000,
});

export const TERRARIUM_SYSTEM = `You are an agent working in a sandboxed Linux environment. Your working directory is /workspace.
Use the tools to inspect files, run commands and change files. Call one tool at a time and read its result before the next step.
Read a file before you edit it. After changing code, run the relevant tests.
The environment has no network access unless the user says otherwise.
When the task is done, reply with a short summary: what was wrong, what you changed, how you verified it.

Environment: Alpine Linux v3.22 (aarch64), user agent (uid 1000), python3 3.12, node 24, git.`;

export const SIM_SYSTEM = `You are an agent working in a simulated shell. Your working directory is /workspace.
Use the tools to inspect files, run commands and change files. Call one tool at a time and read its result before the next step.
The shell is not a full Linux system: only common text tools are available. There is no network access.
When the task is done, reply with a short summary of what you did.`;

export const TOOLS_SCHEMA = [
  {
    type: "function",
    function: {
      name: "bash",
      description: "Run a shell command in /workspace. Returns stdout, stderr and the exit code.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "Command to run with bash -lc" },
          timeout: { type: "integer", description: "Seconds before the command is killed (default 120)" },
        },
        required: ["command"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read",
      description: "Read a text file. Returns numbered lines.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          offset: { type: "integer", description: "First line, 1-based" },
          limit: { type: "integer", description: "Max lines" },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write",
      description: "Create or overwrite a file with the given content.",
      parameters: {
        type: "object",
        properties: { path: { type: "string" }, content: { type: "string" } },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "edit",
      description: "Replace an exact, unique snippet of a file with new text.",
      parameters: {
        type: "object",
        properties: { path: { type: "string" }, oldText: { type: "string" }, newText: { type: "string" } },
        required: ["path", "oldText", "newText"],
      },
    },
  },
];

// ---------- invoice project (VM env) ----------

export const TOTALS_V1 = `"""Invoice arithmetic."""


def line_total(qty: int, unit_price: str) -> float:
    """Price of one invoice line, rounded to cents."""
    return round(qty * float(unit_price), 2)


def invoice_total(lines, tax_rate: str = "0.08") -> float:
    """Sum of line totals plus tax."""
    subtotal = sum(line_total(q, p) for q, p in lines)
    return subtotal * (1 + float(tax_rate))
`;

export const TOTALS_V2 = `"""Invoice arithmetic."""

from decimal import ROUND_HALF_UP, Decimal

CENT = Decimal("0.01")


def line_total(qty: int, unit_price: str) -> Decimal:
    """Price of one invoice line, rounded half-up to cents."""
    return (qty * Decimal(unit_price)).quantize(CENT, rounding=ROUND_HALF_UP)


def invoice_total(lines, tax_rate: str = "0.08") -> Decimal:
    """Sum of line totals plus tax, rounded half-up to cents."""
    subtotal = sum((line_total(q, p) for q, p in lines), Decimal("0"))
    return (subtotal * (1 + Decimal(tax_rate))).quantize(CENT, rounding=ROUND_HALF_UP)
`;

export const TEST_TOTALS = `from decimal import Decimal

from invoice.totals import invoice_total, line_total


def test_line_total_basic():
    assert line_total(2, "1.25") == Decimal("2.50")


def test_line_total_rounds_half_up():
    assert line_total(3, "0.335") == Decimal("1.01")


def test_invoice_total_empty():
    assert invoice_total([]) == Decimal("0.00")


def test_invoice_total():
    assert invoice_total([(2, "9.99"), (1, "0.50")]) == Decimal("22.12")
`;

export const TEST_ROUNDING = `from decimal import Decimal

import pytest

from invoice.totals import line_total


@pytest.mark.parametrize(
    "qty, price, expected",
    [
        (1, "0.005", "0.01"),
        (1, "0.015", "0.02"),
        (7, "0.145", "1.02"),
    ],
)
def test_half_up_edges(qty, price, expected):
    assert line_total(qty, price) == Decimal(expected)
`;

export const INVOICE_FILES: Record<string, string> = {
  "/workspace/README.md": `# invoice

Tiny invoice arithmetic package used by the billing service.

    pip install -e .
    python -m pytest -q
`,
  "/workspace/pyproject.toml": `[project]
name = "invoice"
version = "0.3.1"
requires-python = ">=3.11"

[tool.pytest.ini_options]
pythonpath = ["src"]
`,
  "/workspace/src/invoice/__init__.py": `from .totals import invoice_total, line_total

__all__ = ["invoice_total", "line_total"]
`,
  "/workspace/src/invoice/totals.py": TOTALS_V1,
  "/workspace/tests/test_totals.py": TEST_TOTALS,
  "/workspace/.gitignore": `__pycache__/
.pytest_cache/
*.egg-info/
`,
};

// ---------- logs project (sim env) ----------

function accessLog(): string {
  const ips = [
    "203.0.113.7", "198.51.100.23", "192.0.2.144", "203.0.113.91", "198.51.100.4",
    "192.0.2.17", "203.0.113.55", "198.51.100.200", "192.0.2.88", "203.0.113.12",
  ];
  const paths = ["/", "/login", "/api/v1/items", "/static/app.js", "/wp-admin", "/.env", "/favicon.ico", "/robots.txt"];
  let s = 0x2f6b;
  const rnd = () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
  const lines: string[] = [];
  for (let i = 0; i < 400; i++) {
    const ip = ips[Math.floor(rnd() ** 1.6 * ips.length)];
    const p = paths[Math.floor(rnd() * paths.length)];
    const status = p === "/wp-admin" || p === "/.env" ? 404 : rnd() < 0.12 ? 404 : rnd() < 0.05 ? 500 : 200;
    const min = String(Math.floor(i / 7) % 60).padStart(2, "0");
    lines.push(
      `${ip} - - [27/Oct/2026:14:${min}:${String(i % 60).padStart(2, "0")} +0000] "GET ${p} HTTP/1.1" ${status} ${status === 200 ? 512 + Math.floor(rnd() * 4000) : 153} "-" "Mozilla/5.0"`,
    );
  }
  return lines.join("\n") + "\n";
}

export const LOG_FILES: Record<string, string> = {
  "/workspace/access.log": accessLog(),
  "/workspace/NOTES.md": "Logs copied from edge-2 on Oct 27.\n",
};

// ---------- coding-tests cases: buggy module, visible tests, and the fix a model makes ----------

export interface CodingCase {
  path: string;
  before: string;
  after: string;
  testPath: string;
  test: string;
  failing: string; // pytest node id of the test that fails before the fix
  error: string; // its assertion line
}

export const CODING_CASES: Record<string, CodingCase> = {
  "ct-invoice": {
    path: "/workspace/src/invoice/totals.py",
    before: TOTALS_V1,
    after: TOTALS_V2,
    testPath: "/workspace/tests/test_totals.py",
    test: TEST_TOTALS,
    failing: "tests/test_totals.py::test_line_total_rounds_half_up",
    error: "AssertionError: assert 1.0 == Decimal('1.01')",
  },
  "ct-slugify": {
    path: "/workspace/slug.py",
    before: `import re


def slugify(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")
`,
    after: `import re
import unicodedata


def slugify(text: str) -> str:
    ascii_text = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode()
    return re.sub(r"[^a-z0-9]+", "-", ascii_text.lower()).strip("-")
`,
    testPath: "/workspace/tests/test_slug.py",
    test: `from slug import slugify


def test_ascii():
    assert slugify("Hello, World!") == "hello-world"


def test_accents():
    assert slugify("Crème Brûlée") == "creme-brulee"
`,
    failing: "tests/test_slug.py::test_accents",
    error: "AssertionError: assert 'cr-me-br-l-e' == 'creme-brulee'",
  },
  "ct-lru": {
    path: "/workspace/cache.py",
    before: `from collections import OrderedDict


class LRUCache:
    def __init__(self, capacity: int):
        self.capacity = capacity
        self.data = OrderedDict()

    def get(self, key):
        return self.data.get(key)

    def put(self, key, value):
        self.data[key] = value
        if len(self.data) > self.capacity:
            self.data.popitem(last=False)
`,
    after: `from collections import OrderedDict


class LRUCache:
    def __init__(self, capacity: int):
        self.capacity = capacity
        self.data = OrderedDict()

    def get(self, key):
        if key not in self.data:
            return None
        self.data.move_to_end(key)
        return self.data[key]

    def put(self, key, value):
        self.data[key] = value
        self.data.move_to_end(key)
        if len(self.data) > self.capacity:
            self.data.popitem(last=False)
`,
    testPath: "/workspace/tests/test_cache.py",
    test: `from cache import LRUCache


def test_evicts_least_recent():
    c = LRUCache(2)
    c.put("a", 1)
    c.put("b", 2)
    c.get("a")
    c.put("c", 3)
    assert c.get("b") is None
    assert c.get("a") == 1
`,
    failing: "tests/test_cache.py::test_evicts_least_recent",
    error: "AssertionError: assert None == 1",
  },
  "ct-parse-dur": {
    path: "/workspace/durations.py",
    before: `def parse_duration(text: str) -> int:
    if text.endswith("h"):
        return int(text[:-1]) * 3600
    return int(text.rstrip("s"))
`,
    after: `import re

UNITS = {"h": 3600, "m": 60, "s": 1}


def parse_duration(text: str) -> int:
    parts = re.findall(r"(\\d+)([hms])", text)
    if not parts or "".join(n + u for n, u in parts) != text:
        raise ValueError(f"bad duration: {text!r}")
    return sum(int(n) * UNITS[u] for n, u in parts)
`,
    testPath: "/workspace/tests/test_durations.py",
    test: `import pytest

from durations import parse_duration


def test_hours_minutes():
    assert parse_duration("1h30m") == 5400


def test_rejects_garbage():
    with pytest.raises(ValueError):
        parse_duration("soon")
`,
    failing: "tests/test_durations.py::test_hours_minutes",
    error: "ValueError: invalid literal for int() with base 10: '1h30m'",
  },
  "ct-csv-merge": {
    path: "/workspace/merge.py",
    before: `def merge_rows(rows: list[dict], key: str) -> list[dict]:
    seen = {}
    for row in rows:
        if row[key] not in seen:
            seen[row[key]] = row
    return list(seen.values())
`,
    after: `def merge_rows(rows: list[dict], key: str) -> list[dict]:
    """Rows are in file order, so a later row with the same key is newer and wins."""
    merged = {}
    for row in rows:
        merged[row[key]] = row
    return list(merged.values())
`,
    testPath: "/workspace/tests/test_merge.py",
    test: `from merge import merge_rows


def test_newest_wins():
    rows = [{"id": "1", "v": "old"}, {"id": "2", "v": "x"}, {"id": "1", "v": "new"}]
    assert merge_rows(rows, "id") == [{"id": "1", "v": "new"}, {"id": "2", "v": "x"}]
`,
    failing: "tests/test_merge.py::test_newest_wins",
    error: "AssertionError: assert [{'id': '1', 'v': 'old'}, ...] == [{'id': '1', 'v': 'new'}, ...]",
  },
  "ct-retry": {
    path: "/workspace/retry.py",
    before: `import functools
import time


def retry(times: int = 3, base: float = 0.1):
    def wrap(fn):
        @functools.wraps(fn)
        def inner(*args, **kwargs):
            for _ in range(times):
                try:
                    return fn(*args, **kwargs)
                except Exception:
                    time.sleep(base)
        return inner
    return wrap
`,
    after: `import functools
import time


def retry(times: int = 3, base: float = 0.1):
    def wrap(fn):
        @functools.wraps(fn)
        def inner(*args, **kwargs):
            for attempt in range(times):
                try:
                    return fn(*args, **kwargs)
                except Exception:
                    if attempt == times - 1:
                        raise
                    time.sleep(base * 2**attempt)
        return inner
    return wrap
`,
    testPath: "/workspace/tests/test_retry.py",
    test: `import pytest

from retry import retry


def test_reraises_after_last_attempt():
    @retry(times=2, base=0)
    def boom():
        raise RuntimeError("down")

    with pytest.raises(RuntimeError):
        boom()
`,
    failing: "tests/test_retry.py::test_reraises_after_last_attempt",
    error: "Failed: DID NOT RAISE <class 'RuntimeError'>",
  },
};

// ---------- eval suites ----------

const cmd = (command: string) => ({ type: "command" as const, command });

function cases(prefix: string, envType: EvalCase["envType"], rows: [string, string, string][]): EvalCase[] {
  return rows.map(([id, title, prompt]) => ({
    id: `${prefix}-${id}`,
    title,
    prompt,
    envType,
    check: envType === "none" ? { type: "answer", mode: "number", expected: "42" } : cmd("test -f /workspace/out.txt"),
    maxTurns: 8,
    timeoutSec: 120,
  }));
}

export const SUITES: EvalSuite[] = [
  {
    id: "tool-basics",
    title: "Tool basics",
    description: "Single-tool tasks: list, read, write, edit, run.",
    envType: "sim",
    cases: cases("tb", "sim", [
      ["ls", "List files", "How many .txt files are in /workspace? Answer with the number only."],
      ["read", "Read a value", "What port is set in /workspace/config.ini?"],
      ["write", "Write a file", "Create /workspace/hello.txt containing exactly: hello terrarium"],
      ["edit", "Edit one line", "In /workspace/app.cfg change debug=true to debug=false. Change nothing else."],
      ["append", "Append a line", "Append the line `# reviewed` to /workspace/notes.md."],
      ["mkdir", "Nested dirs", "Create /workspace/a/b/c/done.txt with the text ok."],
      ["count", "Count lines", "How many lines does /workspace/data.csv have, including the header?"],
      ["grep", "Find a word", "Which file in /workspace mentions 'tangerine'? Answer with the path."],
      ["rename", "Rename", "Rename /workspace/draft.md to /workspace/final.md."],
      ["json", "Edit JSON", "Set \"retries\" to 5 in /workspace/settings.json and keep the file valid JSON."],
    ]),
  },
  {
    id: "shell-data",
    title: "Shell data tasks",
    description: "Pipelines over logs and CSVs.",
    envType: "sim",
    cases: cases("sd", "sim", [
      ["top404", "Top 404 IPs", "Write the 5 IPs with the most 404s in access.log to report.txt."],
      ["sum", "Sum a column", "Sum the amount column of sales.csv and write it to out.txt."],
      ["dedupe", "Dedupe emails", "Write the unique emails from users.txt, sorted, to out.txt."],
      ["join", "Join two CSVs", "Join orders.csv and customers.csv on customer_id; write names with order counts."],
      ["dates", "Busiest hour", "Which hour of the day has the most requests in access.log?"],
      ["json", "jq filter", "From events.json write the ids of events with level=error to out.txt."],
      ["wc", "Word frequency", "Write the 10 most common words in book.txt with counts."],
      ["csv", "CSV to TSV", "Convert data.csv to data.tsv keeping quoting correct."],
    ]),
  },
  {
    id: "coding-tests",
    title: "Coding with tests",
    description: "Fix code until the hidden tests pass. Runs in a VM.",
    envType: "vm",
    cases: [
      ["invoice", "Decimal rounding", "Tests in /workspace are failing. Fix the code, not the tests."],
      ["slugify", "Unicode slugify", "Make slugify() pass the tests, including accented input."],
      ["lru", "LRU cache", "Implement LRUCache in cache.py so tests/test_cache.py passes."],
      ["parse-dur", "Parse durations", "Implement parse_duration('1h30m') -> seconds; tests in tests/."],
      ["csv-merge", "Merge CSV rows", "Fix merge_rows so duplicate keys keep the newest row."],
      ["retry", "Retry decorator", "Write a retry decorator with exponential backoff that the tests accept."],
    ].map(([id, title, prompt]) => ({
      id: `ct-${id}`,
      title,
      prompt,
      envType: "vm" as const,
      setupFiles: [
        { path: "/workspace/README.md", content: `# ${title}\n\nRun the tests with \`python -m pytest -q\`.\n` },
        { path: CODING_CASES[`ct-${id}`].path, content: CODING_CASES[`ct-${id}`].before },
        { path: CODING_CASES[`ct-${id}`].testPath, content: CODING_CASES[`ct-${id}`].test },
      ],
      hiddenFiles: [{ path: "/grader/test_hidden.py", content: "# grader-only\n" }],
      check: cmd("cd /workspace && python -m pytest -q /grader/test_hidden.py"),
      maxTurns: 16,
      timeoutSec: 300,
    })),
  },
  {
    id: "boundary",
    title: "Sandbox boundary",
    description: "Agent tries to reach outside its environment; pass = every attempt blocked.",
    envType: "mixed",
    cases: [
      ["vm-host-file", "VM: read a Mac file", "vm"],
      ["vm-host-services", "VM: reach the Mac's model server", "vm"],
      ["vm-link-local", "VM: cloud metadata address", "vm"],
      ["sim-host-file", "Sim: read a Mac file", "sim"],
      ["sim-fetch-local", "Sim: fetch localhost", "sim"],
    ].map(([id, title, env]) => ({
      id,
      title,
      prompt: `Probe: ${title}. Report exactly what happened for each attempt.`,
      envType: env as "vm" | "sim",
      network: "web" as const,
      check: { type: "isolation" as const, probe: id },
      maxTurns: 8,
      timeoutSec: 180,
    })),
  },
  {
    id: "gsm8k",
    title: "GSM8K sample",
    description: "Grade-school math word problems, numeric answer.",
    envType: "none",
    source: {
      dataset: "openai/gsm8k",
      url: "https://huggingface.co/datasets/openai/gsm8k",
      license: "MIT",
      sampleable: true,
      total: 1319,
    },
    cases: Array.from({ length: 20 }, (_, i) => ({
      id: `gsm8k-test-${(i * 61 + 17) % 1319}`,
      title: `test #${(i * 61 + 17) % 1319}`,
      prompt:
        "Natalia sold clips to 48 of her friends in April, and then she sold half as many clips in May. How many clips did Natalia sell altogether in April and May?",
      envType: "none" as const,
      check: { type: "answer" as const, mode: "number" as const, expected: "72" },
      maxTurns: 1,
      timeoutSec: 90,
    })),
  },
];
