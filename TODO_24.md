# TODO_24: Lab fixes, UX pass, original personalities, fresh install

Date: 2026-11-01
Session: 4d7fa632-b05e-4dbb-857c-d7d9f81d874f (T3 thread 2f9ddd9e-65f4-42e4-9a56-0b40299173e2)

## TODO
- [x] Verify the Trace direction complaint on the real model (confirmed, see below)
- [ ] Lab app pass (record TODO_25): Trace sign and ranking, integrated flow, Find rethink, signed fine sweep, dose visibility, undo/redo, strain save, LFM3 steering
- [ ] Personality search (record TODO_26): original recipes that hold across seeds, replace examples
- [ ] Other steerable models research
- [ ] App-wide noise pass + QA open items (sim cap, Lab memory guard, labSupport cache, Storage row)
- [ ] Independent QA, package, install, back up user data, reset to fresh install

## Findings
Trace direction (scratch: /tmp/labfix/signcheck.py, Qwen3.5-4B, "Who are you?" prefill "I am", target " a", foil " **", dose 0.8):
| Neuron | attr shown | logit diff at +0.8 | at -0.8 |
| --- | --- | --- | --- |
| L31N5813 | +1.911 (top) | -45.94, top token " **" | +59.69 |
| L21N9045 | -0.583 | +13.81, top token " a" | -6.06 |
- attr = activation x gradient. Its sign mixes the activation's sign in, so it does not say which dose sign helps. The attr sign picked the better dose sign in 5 of 12 neurons here (9/12, 11/12 in other prompts).
- "+ mix" always adds +0.8, so the top row often pushes the exact token the user wanted to avoid.
- Gradients are local; real effects at dose 0.8 are tens of logits. Ranking must come from measured interventions.
- `single_token` silently keeps the first token of the input ("**Qwen" becomes "**").

LFM3: `w2(swiglu(w1(x), w3(x)))` is the same shape as `down_proj(gate * up)`. The refusal in support.ts is a naming limit, not an architecture limit.
