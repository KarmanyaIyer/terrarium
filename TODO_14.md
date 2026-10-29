# TODO_14: review 4 findings (#2, #3, #8, #9, #10, #11, nits)

Date: 2026-10-29
Session: 88f79554-27bb-4ed1-a2a9-f34c9392c0ad

Source: qa/REVIEW_4_delta.md. Another agent worked on eval grading in the same checkout at the same time (grade*.py,
apps/backend/src/evals/**, evals/**, guest/README.md, guest/verify.sh, qa/review*-probes/**); none of its hunks are
in these commits (qa/review4-probes/ is theirs, left untracked).

Commits: 8025131, a4ea414, e8b7139, 9a0f621, 92bc010, cc1e424.

## List

- [x] #3 over-window suggestion uses compaction's rule (window - cap - 256, full cap); Retry after a refusal; the
      refused message's fate is in the trace
- [x] #8 tokenizer failure: estimates that err high (conservativeTokens), held to the window like exact counts,
      refused/compacted on that number, one visible warning per run
- [x] #9 Stop cancels /v1/tokenize (run's abort signal); fall back after one failure for the rest of the run; 20 s
      timeout (120 s for a run's first count, which may load the model)
- [x] #2 cut off at the output cap: the window button raises the cap too and says so
- [x] #10 vmSlots: Promise.race on the closing VMMs, then count again (manager.test.ts)
- [x] #11 Send/Continue/Retry disabled with "environment deleted"; backend 409 with a clear message
- [x] Nit: net log at 5,000 knows whether more exist (backend answers up to 5,001)
- [x] Nit: live net row in the same millisecond as the oldest fetched row is kept
- [x] Nit: reaper's pid-only krun record must name this env's disk in the runner config
- [x] Unit tests that fail on old code; full backend suite; VM tests; UI tests; tsc; vite build
- [x] Live checks of #3, #2, #8 with Qwen3.5-4B
- [x] Own review pass over the diff (2 bugs found and fixed, below)

## What changed

- #3: `windowThatFits` (compaction.ts) is the one rule: smallest window w with w - cap - 256 >= prompt. Both the
  pre-send refusal (describeOverflow) and the oMLX "Prompt is too long" explanation use it with the session's full cap.
  `POST /api/sessions/:id/retry` runs again what a refused run left without a reply, adding nothing to the
  conversation (agent.continue()), so it stays the newest step and compaction keeps it. The trace marks it
  (`user_message.retry`: "message" or "step"); the UI shows "Sent your message again" / "Ran the refused step again".
  A new message after an unanswered one gets a warning saying whether compaction kept the earlier one or removed it.
  The UI button is "Raise context window to N and retry" (patch, then retry) or "Retry"; only on the latest turn.
- #8: `conservativeTokens` (budget.ts) and request estimates anchored on the server's prompt_tokens for the previous
  request's prefix (an upper bound: Qwen drops old reasoning). If the server ever counts more than an estimate, later
  estimates are scaled up (x1.05 margin) and a warning names the numbers. stream.ts sizes max_tokens and refuses with
  the same callBudget/MIN_REPLY_TOKENS rule for estimates as for exact counts.
- #9: TokenCounter takes the run's signal (AbortSignal.any with the timeout); PromptCounter rethrows on abort, else
  falls back once per run and calls onFallback (the "token_estimate" warning).
- #2: apps/ui/src/lib/remedy.ts (pure): cap-limited cutoff with the cap already at half the window offers the next
  window with the cap doubled (at most half that window, at most window - 1024); label "Raise context window to 16K
  and output cap to 8,192".
- Dev: `TERRARIUM_TOKENIZER_URL` (only with TERRARIUM_DEV=1) points the tokenizer elsewhere to try the fallback live.

## Decisions

- Retry instead of re-sending the text as a new message: a new message would duplicate the paste in the transcript
  and turn the original into an earlier turn, which compaction drops first.
- Conservative estimate errs high by design (prose ~2.3x before the first server count anchors it). Erring low is what
  sends an over-window request; erring high only compacts more, and the warning says so.
- Fallback is per run: the next run tries the tokenizer again (it may have been a model load or a restart).
- A run's first count gets 120 s (oMLX loads the model on a tokenize request if it was evicted), later ones 20 s.
  First version used a process-wide "warm" set; review found an evicted model would then get 20 s and fall back
  for nothing.

## Estimator calibration (conservativeTokens vs Qwen3.5-4B tokenizer.json, add_special_tokens false)

| sample | chars | real | est | est/real | old (chars/3.5 x1.35)/real |
|---|---|---|---|---|---|
| prose (DESIGN.md) | 15039 | 4030 | 9181 | 2.28 | 1.44 |
| ts | 12557 | 3563 | 8039 | 2.26 | 1.36 |
| tsx | 20000 | 5610 | 12291 | 2.19 | 1.38 |
| py | 3410 | 963 | 2011 | 2.09 | 1.37 |
| json | 9370 | 3730 | 6216 | 1.67 | 0.97 |
| pnpm lock | 20000 | 10793 | 14592 | 1.35 | 0.71 |
| digits | 6000 | 6000 | 6601 | 1.10 | 0.39 |
| digit rows | 6289 | 6289 | 6918 | 1.10 | 0.39 |
| hex | 6499 | 5721 | 6232 | 1.09 | 0.44 |
| base64 | 8000 | 5886 | 7446 | 1.27 | 0.52 |
| random lower | 8000 | 4218 | 4890 | 1.16 | 0.73 |
| random mixed case | 8000 | 5170 | 7333 | 1.42 | 0.60 |
| ids | 14999 | 10257 | 11549 | 1.13 | 0.56 |
| CJK | 3840 | 1920 | 8272 | 4.31 | 0.77 |
| rare CJK | 3000 | 5453 | 6601 | 1.21 | 0.21 |
| Cyrillic | 5800 | 1802 | 6381 | 3.54 | 1.24 |
| emoji | 2263 | 5243 | 6637 | 1.27 | 0.28 |
| dashes | 8100 | 200 | 2310 | 11.55 | 15.62 |
| whitespace | 4799 | 1474 | 1649 | 1.12 | 1.26 |
| URLs | 14699 | 7540 | 9961 | 1.32 | 0.75 |
| symbols | 4000 | 2603 | 4264 | 1.64 | 0.59 |
| CamelCase ids | 8799 | 4886 | 6159 | 1.26 | 0.69 |
| Latin-1 | 6100 | 2302 | 5280 | 2.29 | 1.02 |
| Devanagari | 4200 | 1901 | 8141 | 4.28 | 0.85 |
| Arabic | 4000 | 902 | 4400 | 4.88 | 1.71 |

Minimum est/real 1.09; the old rule went as low as 0.21. Script: /tmp/terr14/calib (scratch).

## Proof on old code (tests run against a `git archive` of the previous commit)

- estimate.test.ts 3/3 fail: old sent the 6,000-digit request (estimate 1,188, server 3,050); Stop waited 20 s.
- context.test.ts review-4 tests 3/3 fail (old suggested 16K for a 14,056-token prompt with a 4,096 cap; no Retry;
  no fate warning; deleted env started). Mid-run Retry test: old detail said "without a reply" and Retry answered
  409 "nothing to retry". mayLoad test fails on old (no hint).
- manager.test.ts: race test fails (C started at 3,035 ms, after both closing VMs), net 5,001 test fails.
- reaper.test.ts: another env's krun runner on a reused pid was stopped by old code.
- UI: catchup tie test and #11 runBlocked test fail on old. #2 had no old function to test (logic was inline).

## Live checks (Qwen3.5-4B, dev backend on 8797, data in /tmp/terr14/data)

- #3 (ses_mvtc653gd879e671, 8K, thinking): 52,061-char paste refused at 13,878 tokens; suggested 32,768 (old rule:
  16,384). "Raise context window to 32K and retry" set 32,768/4,096 and retried: one request, [system, user], counted
  13,878 = server 13,878, max_tokens 4,096, no compaction; answer "PELICAN-42"; trace row "Sent your message again".
- #2 (ses_mvtcfuvt5eac6d33, 8K, thinking, "count 1 to 900"): cut at 4,096 with 4,097 reasoning tokens and no text.
  Button "Raise context window to 16K and output cap to 8,192" set 16,384/8,192; Continue got max_tokens 8,192, cut
  again (4,530 thinking + text up to 754). Button then offered "32K and output cap to 16,384"; Continue finished with
  stop: "... 899, 900 / DONE". (An essay session before it also got 8,192 but the 4B kept writing past it.)
- #8 (tokenizer at 127.0.0.1:9, ses_mvtcqe7s693ee11c, 4K chat): 6,000 digits refused at about 6,710 tokens, never
  sent; warning "Token counts are estimates for the rest of this run ..."; suggestion 8,192 (cap 1,024). Then 1,500
  digits: warning that the refused message was removed by compaction; estimate 1,814 vs server 1,570; sent
  1,570 + 1,024 = 2,594 <= 4,096. With tools (sim env, 8K): terrarium harness est/server 1,305/793, 933/861,
  1,076/988; pi-stock 1,852/1,030, 1,176/1,098, 1,319/1,225. Every request: server prompt + max_tokens <= window.

## Tests

- Backend `node --test`: 191 tests, 189 pass, 0 fail, 2 skipped (none failing from the other agent's files).
- `TERRARIUM_VM_TESTS=1 node --test src/envs/vm/vm.test.ts src/envs/vm/reaper.test.ts`: 28/28 pass.
- `node --test apps/ui/test/*.test.ts`: 13/13. Backend and UI tsc clean. vite build OK.

## Review pass (own diff)

- Found: Retry after a refusal that came mid-run (after tool steps) answered 409, and the detail claimed the message
  had no reply. Fixed: Retry resumes from the latest tool result; detail says the run stopped before this step.
- Found: process-wide tokenizer "warm" flag gave a reloading model 20 s. Fixed: per-run first-count hint.
- Moved the earlier-message fate warning after the compaction row it refers to.
- Checked: vmSlots can't spin (a VM's `closing` is cleared before vmmClosed resolves); reaper compares the same
  `diskPath` the driver gives Gondolin; compaction never shortens user messages, so the fate check's text match holds.

## Hurdles

- dcg blocks `cat > file <<EOF` and `unlink`; used Write/Edit and `mv` to scratch.
- Old-code runs of sim-env tests: the export's symlinked node_modules sat outside the sim sandbox-exec profile
  (ERR_MODULE_NOT_FOUND for just-bash); relinked the export's backend links to absolute targets.
- oMLX's API key is random per start and kept in backend memory; calibration counted with tokenizer.json via the
  venv's `tokenizers` instead (same as /v1/tokenize without special tokens).

## Noticed, not fixed

- With thinking on, the 4B can spend the whole cap on reasoning (4,097 of 4,096) and return no text; the cutoff
  remedy handles it, but each round costs minutes.
- A mid-run over-window refusal is hard to provoke with the real model (tool outputs get shortened first); the
  step Retry is covered by the fake-server test only.
