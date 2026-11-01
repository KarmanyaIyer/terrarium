# Consistency metric (fixed before any search, 2026-11-01)

A recipe is judged only on the held-out protocol below. Nothing here changes after results come in.

Sampling: Qwen3.5-4B (models/Qwen3.5-4B-MLX-4bit), stock `Lab.apply_mix` + `Lab.reply` path from the lab_core.py snapshot,
temperature 0.7, top_p 0.95 (what Lab.reply always uses), thinking off, no system prompt, max_tokens 120.
Steering at every position (prompt and reply) unless a recipe's generation settings say otherwise. Any other setting a
recipe needs (presence penalty, reply-only) is part of the recipe and reported; temperature stays 0.7.

Held-out prompts, never used for selection or dose tuning (6, covering the 4 required kinds):
1. identity: Who are you?
2. task: What should I make for dinner tonight?
3. factual: Why is the sky blue?
4. creative: Tell me a short story about a lost key.
5. task: Give me three tips for sleeping better.
6. factual: What is the capital of Australia?

Held-out seeds: 9000 to 9023 (24), each run on all 6 prompts, N = 144 replies per recipe.

Per reply, judged by reading:
- concept: someone not told the target would name the trait from this reply alone. It must be clearly shown (in-character
  voice, recurring theme, or the style itself), not one passing word. Words the prompt itself invites don't count.
- coherent: readable from start to the token cap in the expected language (English unless the trait is a language or
  speech style), not looping (same phrase three or more times, unless repetition is the style), not garbled, no Q or
  "**" spam, no stray script mixing. Being cut off at the token cap is fine. It does not have to answer well.
- joint: both.

Rates: concept, coherent, joint, with Wilson 95% interval on joint and per-prompt joint.
- Keeper: joint >= 80%.
- Promising: 60% <= joint < 80%.
- Unsteered baseline replies are judged blind in the same batches as a false-positive check.

Selection data never touches this set: tuning uses the selection prompts and seeds in common.py. Every recipe sent to the
held-out set is logged in results/heldout.jsonl, including failures, so the number of attempts per theme is visible.
Not new, so not counted as original: owl, alien (L22N2742), evil/hostile, golden gate, anime girl, all caps, flatterer,
contempt, poet, upbeat, suspicious, condescending, wistful, oracle, bleak, dismissive, ornate, curt, kosher, rabbi and the
other biblical ones, Hebrew/German, Bibi, Rabin, Arnold, plus the app's starter sets (pirate talk, French, sadness, joy,
ocean, outer space, Python).
