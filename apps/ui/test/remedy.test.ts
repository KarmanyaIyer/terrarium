// Remedy buttons (review 4, #2 and #3) and Send/Continue on a deleted env (#11). Run: node --test apps/ui/test/*.test.ts

import assert from "node:assert/strict";
import { test } from "node:test";
import type { EnvSummary, SessionSummary } from "@terrarium/shared";
import { runBlocked } from "../src/lib/envuse.ts";
import { CONTEXT_CHOICES } from "../src/lib/memory.ts";
import { COMPACTION_MARGIN, cutoffRemedy, overflowRemedy } from "../src/lib/remedy.ts";

const choices = CONTEXT_CHOICES;

test("cut off at the output cap with thinking on (cap = half the window): the window button raises the cap too (#2)", () => {
  // 8K, thinking on: cap 4,096 is half the window, so the cap can't grow inside it.
  const r = cutoffRemedy({ window: 8192, budget: 4096, cap: 4096, session: { contextWindow: 8192, maxOutputTokens: 4096 }, nativeContext: 262144, choices });
  assert.equal(r.cap, undefined, "no cap-only button: it can't grow within 8K");
  assert.deepEqual(r.window, { contextWindow: 16384, maxOutputTokens: 8192 }, "the old button kept 4,096, so the next Continue was cut at the same cap");
});

test("cut off at the cap with room to grow: raise the cap (at most half the window), no window change", () => {
  const r = cutoffRemedy({ window: 16384, budget: 2048, cap: 2048, session: { contextWindow: 16384, maxOutputTokens: 2048 }, nativeContext: 262144, choices });
  assert.deepEqual(r, { cap: 4096 });
});

test("cut off because the prompt filled the window: a bigger window, the cap stays", () => {
  const r = cutoffRemedy({ window: 8192, budget: 900, cap: 2048, session: { contextWindow: 8192, maxOutputTokens: 2048 }, nativeContext: 262144, choices });
  assert.deepEqual(r, { window: { contextWindow: 16384, maxOutputTokens: 2048 } });
  assert.deepEqual(cutoffRemedy({ window: 131072, budget: 900, cap: 2048, session: { contextWindow: 131072, maxOutputTokens: 2048 }, nativeContext: 131072, choices }), {}, "nothing past the native context");
  assert.equal(cutoffRemedy({ window: 8192, budget: 900, cap: 2048, session: { contextWindow: 16384, maxOutputTokens: 2048 }, choices }).window, undefined, "already raised");
});

test("over the window (8K, thinking on, a ~14K paste): the window offered is one compaction keeps the message in, then Retry (#3)", () => {
  const session = { contextWindow: 8192, maxOutputTokens: 4096 };
  const r = overflowRemedy({ promptTokens: 14_100, suggestedWindow: 32768, session, nativeContext: 262144, choices });
  assert.equal(r.retry, true);
  assert.deepEqual(r.raise, { contextWindow: 32768, maxOutputTokens: 4096 });
  assert.ok(r.raise!.contextWindow - r.raise!.maxOutputTokens - COMPACTION_MARGIN >= 14_100, "16K would leave compaction a 12,032-token limit");
  // After the user raised the window by hand, Retry alone.
  assert.deepEqual(overflowRemedy({ promptTokens: 14_100, session: { contextWindow: 32768, maxOutputTokens: 4096 }, nativeContext: 262144, choices }), { retry: true });
  // A cap raised meanwhile is kept and sized for.
  assert.deepEqual(overflowRemedy({ promptTokens: 14_100, session: { contextWindow: 16384, maxOutputTokens: 16384 }, nativeContext: 262144, choices }).raise, { contextWindow: 32768, maxOutputTokens: 16384 });
  // Nothing fits under the native context: no button that would fail.
  assert.deepEqual(overflowRemedy({ promptTokens: 40_000, session, nativeContext: 32768, choices }), { retry: false });
});

const session = (over: Partial<SessionSummary> = {}) => ({ id: "s1", envId: "env1", harness: "terrarium", ...over }) as SessionSummary;
const env = (over: Partial<EnvSummary> = {}) => ({ id: "env1", ...over }) as EnvSummary;

test("Send/Continue: a session whose env was deleted is blocked with that reason (#11)", () => {
  assert.equal(runBlocked(undefined, session()), "enclosure deleted");
  assert.equal(runBlocked(undefined, session({ harness: "chat" })), undefined, "chat sessions never use their env");
  assert.equal(runBlocked(undefined, session({ envId: null })), undefined);
  assert.equal(runBlocked(env(), session()), undefined);
  assert.equal(runBlocked(env({ released: true }), session()), "env storage released");
  assert.equal(runBlocked(env({ inUse: [{ kind: "session", sessionId: "s2", reason: 'session "other" running' }] }), session()), 'env busy: session "other" running');
});
