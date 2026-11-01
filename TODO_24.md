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

## Other steerable models (research agent, 2026-11-01; nothing downloaded, MLX support read from configs and source)
1. mlx-community/Ministral-3-3B-Base-2512-4bit: 2.77 GB, Apache-2.0, mistral3/ministral3, hook unchanged, 26 layers, no post-MLP norm, base model so no assistant identity. Needs completion-style prompts. Try first.
2. mlx-community/gemma-3-4b-pt-8bit + google/gemma-scope-2-4b-pt: SAE steering needs a new layer-output hook. Raw neurons capped by the post-FFN norm (arXiv 2606.19831).
3. mlx-community/SmolLM3-3B-Base-4bit: 1.73 GB, Apache-2.0, hook unchanged, 36 layers.
4. mlx-community/Apertus-8B-2509-4bit: 4.53 GB, non-GLU MLP, ungated neurons.
5. warshanks/talkie-1930-13b-it-mlx-4bit: 8.59 GB, 1930 voice, needs an adapter and dose rescale.
Consistency: no published seed study at neuron level. Collapse coefficient 1.37 to 1.65 on Qwen/Llama vs 0.31 on Gemma 3 (2606.19831); installed Gemma 4 has the same post-norm, so check saturation. Trait expression follows an inverted U while coherence falls with dose (2511.18284). Distinct-bigram ratio with a 0.30 floor detects collapse. 24 samples per dose is a floor.
