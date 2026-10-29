import { INVOICE_FILES, LOG_FILES, SIM_SYSTEM, TERRARIUM_SYSTEM, TEST_ROUNDING, TOTALS_V1, TOTALS_V2 } from "./data";
import { Script, type Built } from "./script";

const R = "\x1b[31m";
const G = "\x1b[32m";
const B = "\x1b[1m";
const Y = "\x1b[33m";
const X = "\x1b[0m";

const QWEN = { temperature: 0.6, topP: 0.95, topK: 20, presencePenalty: 1.5 };

function numbered(text: string): string {
  return text
    .replace(/\n$/, "")
    .split("\n")
    .map((l, i) => `${String(i + 1).padStart(4, " ")}\t${l}`)
    .join("\n");
}

const PYTEST_FAIL = [
  `${R}.F.F${X}                                                                     [100%]\n`,
  `=================================== FAILURES ===================================\n`,
  `${R}${B}________________________ test_line_total_rounds_half_up ________________________${X}\n\n`,
  `    def test_line_total_rounds_half_up():\n>       assert line_total(3, "0.335") == Decimal("1.01")\n`,
  `${R}E       AssertionError: assert 1.0 == Decimal('1.01')${X}\n${R}E        +  where 1.0 = line_total(3, '0.335')${X}\n\n`,
  `${R}tests/test_totals.py${X}:11: AssertionError\n`,
  `${R}${B}______________________________ test_invoice_total ______________________________${X}\n\n`,
  `    def test_invoice_total():\n>       assert invoice_total([(2, "9.99"), (1, "0.50")]) == Decimal("22.12")\n`,
  `${R}E       AssertionError: assert 22.118400000000003 == Decimal('22.12')${X}\n${R}E        +  where 22.118400000000003 = invoice_total([(2, '9.99'), (1, '0.50')])${X}\n\n`,
  `${R}tests/test_totals.py${X}:19: AssertionError\n`,
  `${Y}=========================== short test summary info ============================${X}\n`,
  `${R}FAILED${X} tests/test_totals.py::${B}test_line_total_rounds_half_up${X} - AssertionError: assert 1.0 == Decimal('1.01')\n`,
  `${R}FAILED${X} tests/test_totals.py::${B}test_invoice_total${X} - AssertionError: assert 22.118400000000003 == Decimal('22.12')\n`,
  `${R}${B}2 failed${X}, ${G}2 passed${X}${R} in 0.08s${X}\n`,
];

const PIP_ERR = (n: number) =>
  `WARNING: Retrying (Retry(total=${n}, connect=None, read=None, redirect=None, status=None)) after connection broken by 'ProtocolError('Connection aborted.', ConnectionResetError(104, 'Connection reset by peer'))': /simple/py-moneyed/\n`;

const LONG_THINKING = `All 7 tests pass now. Let me write the summary for the user. Actually, let me double check the rounding edge cases first, because the user asked me to fix the code and I want to be sure the fix is right.

line_total(3, "0.335"): 3 * Decimal("0.335") = Decimal("1.005"). quantize(Decimal("0.01"), ROUND_HALF_UP) gives 1.01. Correct, the test expects 1.01.

invoice_total([(2, "9.99"), (1, "0.50")]): line 1 = 2 * 9.99 = 19.98, line 2 = 0.50. Subtotal = 20.48. Tax: 20.48 * 1.08 = 22.1184. Quantized half-up = 22.12. Correct.

Empty invoice: sum of nothing with start Decimal("0") = 0, times 1.08 = 0, quantized = 0.00. Test expects Decimal("0.00"). Decimal("0") == Decimal("0.00") is True in Python because Decimal equality compares values, not exponents. Good.

The new parametrized tests: 1 * 0.005 = 0.005 -> 0.01 half-up. 1 * 0.015 = 0.015 -> 0.02. 7 * 0.145 = 1.015 -> 1.02. All correct with ROUND_HALF_UP. With ROUND_HALF_EVEN (the default) 0.005 would round to 0.00 and 0.015 to 0.02 and 1.015 to 1.02, so the first case is the one that tells them apart. Good, the tests cover the difference.

Wait, should invoice_total round each line first or only the final total? The current code rounds each line in line_total and then the total. That matches how invoices are usually printed: each line shows cents. The test expects 22.12 either way. Let me verify the alternative: no per-line rounding, 2*9.99 + 0.50 = 20.48 exactly, same. So both give 22.12 here.

Also, is float(tax_rate) still used anywhere? No, I replaced it with Decimal(tax_rate). And the return type annotation changed from float to Decimal. Callers that expected float might break. Let me think about whether anything else in the package uses line_total... __init__.py only re-exports. The README doesn't mention return types.

Hmm, but what about callers passing unit_price as a float instead of a string? Decimal(0.1) gives 0.1000000000000000055511151231257827021181583404541015625, and quantize would still round to 0.10 correctly in most cases. But Decimal(float) can carry binary error, for example Decimal(1.005) is 1.00499999999999989341858963598497211933135986328125, which rounds half-up to 1.00, not 1.01. The type hint says str so callers should pass strings. Maybe I should convert with Decimal(str(unit_price)) to be safe for floats. Let me consider: Decimal(str(1.005)) = Decimal("1.005") -> 1.01. That would be more robust. But the user said fix the code, not change the API. Adding str() does not change the API. Should I make that change? It is outside what the tests check. I will mention it in the summary instead of changing it.

Let me re-verify line_total(3, "0.335") once more with the str() idea: Decimal(str("0.335")) = Decimal("0.335"), times 3 = 1.005, half-up 1.01. Same result. OK.

Now the summary. What was wrong: float arithmetic and Python's round() which rounds half to even on binary floats, so 1.005 became 1.0 and the total kept float noise 22.118400000000003. What I changed: totals.py now uses Decimal with quantize(Decimal("0.01"), ROUND_HALF_UP) for each line and the total. Tests: 4 original + 3 new parametrized edge cases, all 7 pass.

Wait, I should double check that pytest actually ran the new file. The verbose output listed tests/test_rounding.py::test_half_up_edges[1-0.005-0.01] PASSED, [1-0.015-0.02] PASSED, [7-0.145-1.02] PASSED. Yes. 7 passed.

Let me also think about whether the summary should mention the network. I tried pip install py-moneyed and it failed because the network is off. That is fine, the standard library was enough. I will mention it briefly.

Let me also reconsider the empty invoice case once more: sum((line_total(q, p) for q, p in []), Decimal("0")) = Decimal("0"). (Decimal("0") * (1 + Decimal("0.08"))) = Decimal("0.00"). Hmm, actually Decimal("0") * Decimal("1.08") = Decimal("0.00") because the exponent adds. Then quantize gives 0.00. Equal to Decimal("0.00"). Good.

And line_total(2, "1.25") = 2 * 1.25 = 2.50 -> 2.50. Correct.

OK now I am confident. Let me also reconsider whether I should round half-up or half-even for the tax. Financial regulations differ by country. The test expects 22.12 for 22.1184, which is not a tie, so both modes agree. Only the line rounding test requires half-up. Keep half-up everywhere for consistency.

Let me write the summary now. Actually, first let me re-verify the parametrized case 7 * 0.145. 7 * 0.145 = 1.015. Half-up gives 1.02. Correct. And 1 * 0.015 = 0.015, half-up gives 0.02. Correct. And 1 * 0.005 = 0.005, half-up gives 0.01. Correct.

Now the summary.`;

/** The live demo: Qwen3.5 9B fixing a failing pytest suite in a VM. */
export function buildInvoiceRun(sessionId: string, envId: string): Built {
  const s = new Script({
    sessionId,
    envId,
    modelId: "Qwen3.5-9B-MLX-4bit",
    window: 8192,
    maxOut: 1024,
    system: TERRARIUM_SYSTEM,
    thinking: true,
    sampling: QWEN,
    files: INVOICE_FILES,
  });
  s.user("Tests in /workspace are failing. Find out why, fix the code (not the tests), and run the suite to confirm.");

  s.call({
    prompt: 1342,
    thinking: "The user wants the failing tests fixed. First look at the layout and run the test suite to see the failures.",
    text: "Let me look at the project and run the tests.",
    tool: { name: "bash", args: { command: "cd /workspace && ls -R src tests && python -m pytest -q" } },
    ttftMs: 1100,
  });
  s.tool({
    duration: 2410,
    exit: 1,
    out: [
      { dt: 90, text: "src:\ninvoice\n\nsrc/invoice:\n__init__.py\ntotals.py\n\ntests:\ntest_totals.py\n" },
      ...PYTEST_FAIL.map((text, i) => ({ dt: 1500 + i * 55, text })),
    ],
  });

  s.call({
    prompt: 2154,
    cached: 1342,
    thinking: "Two failures. line_total returns a float but the tests expect Decimal with half-up rounding. Read totals.py.",
    tool: { name: "read", args: { path: "/workspace/src/invoice/totals.py" } },
    ttftMs: 820,
  });
  s.tool({ duration: 38, out: [{ dt: 20, text: numbered(TOTALS_V1) }] });

  s.call({
    prompt: 2476,
    cached: 2154,
    thinking:
      "The code uses float math and round(), which rounds half to even on binary floats, so 1.005 becomes 1.0. A money library would handle this. Check whether one can be installed.",
    text: "The code does float math. I'll try installing a money helper library.",
    tool: { name: "bash", args: { command: "pip install py-moneyed" } },
    ttftMs: 640,
  });
  s.tool({
    duration: 6820,
    exit: 1,
    out: [
      { dt: 1300, stream: "stderr", text: PIP_ERR(2) },
      { dt: 3100, stream: "stderr", text: PIP_ERR(1) },
      { dt: 5200, stream: "stderr", text: PIP_ERR(0) },
      {
        dt: 6700,
        stream: "stderr",
        text: "ERROR: Could not find a version that satisfies the requirement py-moneyed (from versions: none)\nERROR: No matching distribution found for py-moneyed\n",
      },
    ],
    net: [
      { dt: 220, url: "https://pypi.org/simple/py-moneyed/", decision: "deny", reason: "mode off" },
      { dt: 1350, url: "https://pypi.org/simple/py-moneyed/", decision: "deny", reason: "mode off" },
      { dt: 3150, url: "https://pypi.org/simple/py-moneyed/", decision: "deny", reason: "mode off" },
      { dt: 5250, url: "https://pypi.org/simple/py-moneyed/", decision: "deny", reason: "mode off" },
    ],
  });

  s.call({
    prompt: 3105,
    cached: 2476,
    thinking:
      "No network, so no packages. The standard library decimal module is enough: Decimal arithmetic and quantize(Decimal('0.01'), rounding=ROUND_HALF_UP).",
    text: "No network here, so I'll use the standard library `decimal` module instead.",
    tool: {
      name: "edit",
      args: { path: "/workspace/src/invoice/totals.py", oldText: TOTALS_V1.slice(28), newText: TOTALS_V2.slice(28) },
    },
    ttftMs: 700,
  });
  s.tool({
    duration: 61,
    out: [{ dt: 30, text: "Edited /workspace/src/invoice/totals.py (1 replacement, +6 -4 lines)" }],
    files: [{ path: "/workspace/src/invoice/totals.py", content: TOTALS_V2 }],
  });

  s.call({
    prompt: 3388,
    cached: 3105,
    tool: { name: "bash", args: { command: "cd /workspace && python -m pytest -q" } },
    ttftMs: 560,
  });
  s.tool({
    duration: 1880,
    exit: 0,
    out: [
      { dt: 1500, text: `${G}....${X}                                                                     [100%]\n` },
      { dt: 1620, text: `${G}4 passed in 0.05s${X}\n` },
    ],
  });

  s.mark("now");
  s.call({
    prompt: 3566,
    cached: 3388,
    thinking: "Tests pass. Add a test that pins the half-up edge cases so a regression to round() would be caught.",
    text: "All 4 pass. I'll add tests for the half-up edge cases.",
    tool: { name: "write", args: { path: "/workspace/tests/test_rounding.py", content: TEST_ROUNDING } },
    ttftMs: 610,
  });
  s.tool({
    duration: 47,
    out: [{ dt: 20, text: "Wrote /workspace/tests/test_rounding.py (338 bytes)" }],
    files: [{ path: "/workspace/tests/test_rounding.py", content: TEST_ROUNDING }],
  });

  s.call({
    prompt: 3804,
    cached: 3566,
    tool: { name: "bash", args: { command: "cd /workspace && python -m pytest -v" } },
    ttftMs: 590,
  });
  const verbose = [
    `${B}============================= test session starts ==============================${X}\n`,
    "platform linux -- Python 3.12.12, pytest-8.4.2, pluggy-1.6.0 -- /usr/bin/python3\n",
    "cachedir: .pytest_cache\nrootdir: /workspace\nconfigfile: pyproject.toml\n",
    `${B}collecting ... ${X}collected 7 items\n\n`,
    `tests/test_rounding.py::test_half_up_edges[1-0.005-0.01] ${G}PASSED${X}          [ 14%]\n`,
    `tests/test_rounding.py::test_half_up_edges[1-0.015-0.02] ${G}PASSED${X}          [ 28%]\n`,
    `tests/test_rounding.py::test_half_up_edges[7-0.145-1.02] ${G}PASSED${X}          [ 42%]\n`,
    `tests/test_totals.py::test_line_total_basic ${G}PASSED${X}                       [ 57%]\n`,
    `tests/test_totals.py::test_line_total_rounds_half_up ${G}PASSED${X}              [ 71%]\n`,
    `tests/test_totals.py::test_invoice_total_empty ${G}PASSED${X}                    [ 85%]\n`,
    `tests/test_totals.py::test_invoice_total ${G}PASSED${X}                          [100%]\n\n`,
    `${G}============================== ${B}7 passed${X}${G} in 0.06s ===============================${X}\n`,
  ];
  s.tool({ duration: 2240, exit: 0, out: verbose.map((text, i) => ({ dt: 1400 + i * 60, text })) });

  s.event({
    type: "compaction",
    beforeTokens: 4904,
    afterTokens: 3021,
    removedTurns: 0,
    note: "Prompt + output reserve passed 70% of the 8,192 window; truncated 3 old tool results (#1 bash, #2 read, #3 bash) to 240 chars.",
  });

  s.call({
    prompt: 3108,
    cached: 1342,
    thinking: LONG_THINKING,
    finish: "length",
    ttftMs: 1380,
  });
  s.event(
    {
      type: "warning",
      code: "output_truncated",
      message: "Output cap reached while thinking; no reply text was produced.",
      data: { contextWindow: 8192, promptTokens: 3108, maxOutputTokens: 1024, completionTokens: 1024, reasoningTokens: 1024 },
    },
    10,
  );
  s.runEnd("length");
  return s.finalize();
}

/** Continuation after the length stop (Continue button). */
export function buildInvoiceContinue(sessionId: string, envId: string, startSeq: number): Built {
  const s = new Script({
    sessionId,
    envId,
    modelId: "Qwen3.5-9B-MLX-4bit",
    window: 8192,
    maxOut: 1024,
    system: TERRARIUM_SYSTEM,
    thinking: false,
    sampling: QWEN,
  });
  s.turn = 8;
  s.call({
    prompt: 4140,
    cached: 3108,
    text: `**What was wrong:** \`line_total\` and \`invoice_total\` used float math and \`round()\`. Floats can't store 1.005 exactly and \`round()\` rounds half to even, so \`line_total(3, "0.335")\` gave \`1.0\` and the total kept float noise (\`22.118400000000003\`).

**What I changed:** \`src/invoice/totals.py\` now uses \`Decimal\` throughout and rounds each line and the total with \`quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)\`. Return types are now \`Decimal\`.

**Verified:** added \`tests/test_rounding.py\` with 3 half-up edge cases. \`python -m pytest -v\`: 7 passed.

Notes:
- \`pip install py-moneyed\` failed because the network is off; the standard library was enough.
- Callers passing a float price (instead of a string) could still see binary rounding error. \`Decimal(str(unit_price))\` would guard against that; I left the API unchanged.`,
    ttftMs: 1900,
    genTps: 22.8,
  });
  s.runEnd("done");
  return s.finalize(startSeq);
}

/** Generic reply to a user message typed in fixture mode. */
export function buildReply(
  o: {
    sessionId: string;
    envId: string | null;
    modelId: string;
    window: number;
    maxOut: number;
    thinking: boolean;
    turnBase?: number;
    history?: Record<string, unknown>[];
  },
  text: string,
  startSeq: number,
  prompt: number,
): Built {
  const s = new Script({
    ...o,
    system: o.envId ? TERRARIUM_SYSTEM : "You are a helpful assistant.",
    sampling: QWEN,
    tools: o.envId != null,
  });
  s.user(text);
  if (o.envId) {
    s.call({
      prompt: prompt + 40,
      cached: prompt,
      thinking: o.thinking ? "Check the current state of the workspace before answering." : undefined,
      tool: { name: "bash", args: { command: "cd /workspace && ls -la && git status --short 2>/dev/null | head" } },
    });
    s.tool({
      duration: 140,
      out: [
        {
          dt: 60,
          text: "total 24\ndrwxr-xr-x    5 agent    agent         4096 Oct 28 18:20 .\ndrwxr-xr-x    1 root     root          4096 Oct 28 17:02 ..\n-rw-r--r--    1 agent    agent           34 Oct 28 17:02 .gitignore\n-rw-r--r--    1 agent    agent          122 Oct 28 17:02 README.md\n-rw-r--r--    1 agent    agent          131 Oct 28 17:02 pyproject.toml\ndrwxr-xr-x    3 agent    agent         4096 Oct 28 17:02 src\ndrwxr-xr-x    3 agent    agent         4096 Oct 28 18:20 tests\n",
        },
      ],
    });
    s.call({
      prompt: prompt + 260,
      cached: prompt + 40,
      text: `I looked at the workspace again. Re your message ("${text.slice(0, 80)}"): the fixture backend replays scripted sessions, so this reply is canned. Connect a real backend to talk to the model.`,
    });
  } else {
    s.call({
      prompt: prompt + 30,
      cached: prompt,
      thinking: o.thinking ? "Answer briefly." : undefined,
      text: `This is fixture mode, so the reply is canned. Connect a real backend to talk to the model.`,
    });
  }
  s.runEnd("done");
  return s.finalize(startSeq);
}

/** Bonsai 2 9B doing a log task in a simulated shell; includes a harness repair and a denied fetch. */
export function buildLogsRun(sessionId: string, envId: string): Built {
  const s = new Script({
    sessionId,
    envId,
    modelId: "Ternary-Bonsai-2-9B-mlx-2bit",
    window: 16384,
    maxOut: 4096,
    system: SIM_SYSTEM,
    thinking: false,
    sampling: QWEN,
    files: LOG_FILES,
    systemAndTools: 548,
  });
  s.user(
    "access.log is an nginx log. Find the 5 client IPs with the most 404 responses and write them to report.txt as `count ip` lines, highest first. Then tell me which country the top one is from.",
  );
  s.call({
    prompt: 641,
    repairFrom: "First I will look at the log format.\n\n```bash\nhead -n 3 access.log\n```",
    tool: { name: "bash", args: { command: "head -n 3 access.log" } },
    genTps: 38.2,
    ttftMs: 420,
  });
  const head = LOG_FILES["/workspace/access.log"].split("\n").slice(0, 3).join("\n") + "\n";
  s.tool({ duration: 9, out: [{ dt: 4, text: head }] });
  s.call({
    prompt: 902,
    cached: 641,
    text: "Field 9 is the status code. Counting 404s per IP:",
    tool: {
      name: "bash",
      args: { command: "awk '$9 == 404 {print $1}' access.log | sort | uniq -c | sort -rn | head -5 > report.txt && cat report.txt" },
    },
    genTps: 38.2,
    ttftMs: 380,
  });
  const report = "     31 203.0.113.7\n     19 198.51.100.23\n     12 192.0.2.144\n      9 203.0.113.91\n      7 198.51.100.4\n";
  s.tool({
    duration: 31,
    out: [{ dt: 20, text: report }],
    files: [{ path: "/workspace/report.txt", content: report }],
  });
  s.call({
    prompt: 1048,
    cached: 902,
    text: "Now the country of 203.0.113.7.",
    tool: { name: "bash", args: { command: "curl -s https://ipinfo.io/203.0.113.7/country" } },
    genTps: 37.9,
    ttftMs: 360,
  });
  s.tool({
    duration: 14,
    exit: 7,
    out: [{ dt: 10, stream: "stderr", text: "curl: (7) network access denied by policy: mode off\n" }],
    net: [{ dt: 5, url: "https://ipinfo.io/203.0.113.7/country", decision: "deny", reason: "mode off" }],
  });
  s.call({
    prompt: 1122,
    cached: 1048,
    text: `Wrote \`report.txt\`:

| count | ip |
|---:|---|
| 31 | 203.0.113.7 |
| 19 | 198.51.100.23 |
| 12 | 192.0.2.144 |
| 9 | 203.0.113.91 |
| 7 | 198.51.100.4 |

I couldn't look up the country: network access is off in this environment. Also, 203.0.113.0/24 is a documentation range (TEST-NET-3), so it has no real location.`,
    genTps: 37.6,
    ttftMs: 410,
  });
  s.runEnd("done");
  return s.finalize();
}

/** Chat-only session with Gemma 4 12B, thinking on. */
export function buildChat(sessionId: string): Built {
  const s = new Script({
    sessionId,
    envId: null,
    modelId: "gemma-4-12B-it-4bit",
    window: 32768,
    maxOut: 4096,
    system: "You are a helpful assistant.",
    thinking: true,
    sampling: { temperature: 1.0, topP: 0.95, topK: 64 },
    tools: false,
  });
  s.user("Why does round(2.675, 2) return 2.67 in Python?");
  s.call({
    prompt: 38,
    thinking:
      "Classic floating point question. 2.675 cannot be represented exactly in binary; the stored double is slightly below 2.675, so rounding to 2 places gives 2.67. Mention Decimal for exact decimal rounding.",
    text: `Because \`2.675\` can't be stored exactly as a binary float. The closest double is:

\`\`\`python
>>> from decimal import Decimal
>>> Decimal(2.675)
Decimal('2.67499999999999982236431605997495353221893310546875')
\`\`\`

That value is just *below* the halfway point, so rounding to two places gives \`2.67\`. \`round()\` isn't broken; it rounds the number it was given correctly.

If you need decimal rounding (money, invoices), work in \`Decimal\` from strings.`,
    genTps: 15.2,
    ttftMs: 310,
  });
  s.wait(48_000);
  s.user("And how do I get 2.68?");
  s.call({
    prompt: 302,
    cached: 260,
    thinking: "Show Decimal with quantize and ROUND_HALF_UP, constructed from a string.",
    text: `Build the \`Decimal\` from a string and quantize with half-up rounding:

\`\`\`python
from decimal import Decimal, ROUND_HALF_UP

Decimal("2.675").quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
# Decimal('2.68')
\`\`\`

Two details matter:
1. **Use a string**: \`Decimal(2.675)\` inherits the float error and still gives \`2.67\`.
2. **Pick the rounding mode**: the default is \`ROUND_HALF_EVEN\` (banker's rounding), which would give \`2.68\` here but \`2.66\` for \`"2.665"\`.`,
    genTps: 15.0,
    ttftMs: 290,
  });
  s.runEnd("done");
  return s.finalize();
}

/** Earlier, finished session in the invoice env. */
export function buildReadme(sessionId: string, envId: string): Built {
  const s = new Script({
    sessionId,
    envId,
    modelId: "Qwen3.5-4B-MLX-4bit",
    window: 16384,
    maxOut: 4096,
    system: TERRARIUM_SYSTEM,
    thinking: false,
    sampling: QWEN,
    files: INVOICE_FILES,
  });
  s.user("What Python version and test command does this project use?");
  s.call({
    prompt: 1298,
    tool: { name: "bash", args: { command: "cd /workspace && cat pyproject.toml README.md" } },
    genTps: 41.0,
    ttftMs: 520,
  });
  s.tool({
    duration: 22,
    out: [{ dt: 10, text: INVOICE_FILES["/workspace/pyproject.toml"] + INVOICE_FILES["/workspace/README.md"] }],
  });
  s.call({
    prompt: 1514,
    cached: 1298,
    text: "It requires **Python 3.11+** (`requires-python = \">=3.11\"`) and runs tests with `python -m pytest -q`; pytest finds the package through `pythonpath = [\"src\"]`.",
    genTps: 41.3,
    ttftMs: 330,
  });
  s.runEnd("done");
  return s.finalize();
}

export type CellOutcome = "pass" | "fail" | "error";

/** Small session behind an eval cell. */
export function buildEvalCell(
  sessionId: string,
  envId: string | null,
  modelId: string,
  prompt: string,
  envType: "vm" | "sim" | "none",
  outcome: CellOutcome,
): Built {
  const s = new Script({
    sessionId,
    envId,
    modelId,
    window: 16384,
    maxOut: 4096,
    system: envType === "none" ? "You are a helpful assistant." : envType === "sim" ? SIM_SYSTEM : TERRARIUM_SYSTEM,
    thinking: false,
    sampling: QWEN,
    tools: envType !== "none",
  });
  s.user(prompt);
  if (envType === "none") {
    s.call({
      prompt: 120,
      text: outcome === "pass" ? "In May she sold 48 / 2 = 24 clips. Total: 48 + 24 = **72**." : "She sold 48 + 48 / 2 = **96** clips.",
      genTps: 30,
    });
  } else if (outcome === "error") {
    s.call({ prompt: 1310, error: `oMLX returned 503: model is loading (${modelId})`, ttftMs: 30_000 });
    s.event({ type: "error", message: "Model call failed after 3 retries", detail: "503 Service Unavailable" });
    s.runEnd("error");
    return s.finalize();
  } else {
    s.call({
      prompt: 1310,
      tool: { name: "bash", args: { command: envType === "vm" ? "cd /workspace && python -m pytest -q" : "ls -la" } },
    });
    s.tool({
      duration: envType === "vm" ? 1900 : 12,
      exit: envType === "vm" ? 1 : 0,
      out: [{ dt: 10, text: envType === "vm" ? `${R}F${X}\n${R}1 failed${X} in 0.04s\n` : "total 8\n-rw-r--r-- 1 agent 120 config.ini\n" }],
    });
    s.call({
      prompt: 1702,
      cached: 1310,
      text:
        outcome === "pass"
          ? "Done. The change is in place and the check passes."
          : "I updated the function but I'm not sure the edge cases are covered.",
    });
  }
  s.runEnd("done");
  return s.finalize();
}
