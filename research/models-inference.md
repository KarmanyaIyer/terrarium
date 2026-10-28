# Terrarium research: models, inference server, context sizing

Date: 2026-10-28. Hardware: MacBook Pro M5, 24 GB (verified: `sysctl hw.memsize` = 25,769,803,776 B; macOS 27.0.1; `memory_pressure` reported 24% free during this session). Budget: 8-12 GB for weights + KV, 14 GB hard max.

Labels: **[V]** = verified, with source and date. **[I]** = inferred or estimated, with reasoning. Vendor benchmark numbers are verified as *published*. Most of them are self-reported and not independently reproduced.

---

## TL;DR

1. **Server: keep oMLX and upgrade 0.7.0 to 0.7.2** (latest stable, 2026-10-21). Don't move to 0.7.3rc1. oMLX is the only candidate that natively runs *every* shortlisted MLX pack: Prism Bonsai's `prism_hadamard_qwen35`, Gemma 4 12B's `gemma4_unified` (mlx-vlm only), and Mellum. It already returns TTFT, prompt and generation tok/s, cached tokens and load time in `usage`. It also has a memory-ceiling setting and load/unload/status endpoints with an API key. **One gap:** LFM3 isn't loadable in oMLX ≤0.7.3rc1, because the pinned mlx-vlm predates LFM3 support.
2. **Starter lineup (5 models, about 25 GB on disk; 99 GiB free):**

   | Tier | Model | Role |
   |---|---|---|
   | Tiny | Qwen3.5-4B 4bit (already have) | Baseline. Best tau2 at 4B |
   | Tiny (when oMLX supports it) | LFM3-1.7B MLX 4bit | Fastest tool-caller, 1 GB |
   | Mid | Qwen3.5-9B MLX 4bit | Main workhorse for agents/coding |
   | Mid, other family | Gemma 4 12B-it 4bit | Family diversity, tiny KV cache |
   | Large | Ternary-Bonsai-2-27B MLX 2bit | Qwen3.8-27B in 7.7 GB. Run it alone |

3. **Existing models:** keep Qwen3.5-4B and Bonsai-2-9B. Keep Bonsai-2-2B until LFM3 runs in oMLX. Drop Bonsai-2-4B (opinion; reasons in §1.5).
4. **Context rule:** `needed_GB = weights + ctx × KV_bytes_per_token + fixed_state + overhead (0.5 to 1 GB)`. The Qwen3.5 and Bonsai hybrids cost about 33 KB/token at 4B/9B and about 65 KB/token at 27B. Gemma 4 12B costs about 16 KB/token plus 0.34 GB fixed. Use **32K as the default agent context** for everything except Bonsai-27B, which gets 24-32K. Per-model table in §3.
5. **Raise the oMLX memory guard from 5 GiB to 11-12 GiB.** At 5 GiB the 9B already hit prompt throttling **[V: local_llms/README.md line 116]**.

---

## 1. Models

### 1.1 Family status as of 2026-10-28

| Family | Newest small releases | Fits budget? | Verdict |
|---|---|---|---|
| **Qwen** | Qwen3.5 0.8B/2B/4B/9B (Feb-Mar 2026). Qwen3.6 has only 27B and 35B-A3B (Apr 2026). Qwen3.8 has only 27B, Flash-Next (180B) and 2.4T (Aug 2026) **[V: HF author listing 2026-10-28]** | 2B/4B/9B yes. 27B only as Bonsai ternary | **Core family.** No new small Qwen since March |
| **Gemma 4** | E2B, E4B (Mar 2026), 12B "unified" (May 2026), 26B-A4B, 31B **[V: HF]** | E2B/E4B/12B yes. 26B-A4B at 4-bit is about 15 GB, so no **[I]** | **12B is a good second family** |
| **NVIDIA Nemotron 3.5 Bolt E4B** | Gemma-4-E4B post-trained with RL. GA 2026-10-23 **[V: model card]** | 4.2 GB MLX 4bit | Optional small alternative to Gemma E4B |
| **Liquid LFM3** | LFM3-1.7B (2026-10-23), official MLX 4/5/8-bit uploaded 2026-10-27 **[V: HF]**. LFM2.5-24B-A2B is about 13.5 GB at 4-bit, which is over budget **[I]** | 1.7B yes | **Best tiny tool-caller on paper.** Not in oMLX yet |
| **Prism Bonsai 2 (ternary)** | 2B/4B/9B (Qwen3.5 base, 2026-10-01 MLX), **27B (Qwen3.8-27B base, 2026-09-16 MLX)**. Also 1-bit Bonsai-27B (Qwen3.6 base, Jul 2026) **[V: HF prism-ml]** | 27B ternary = 8.6 GB pack, 7.67 GB without vision | **27B is the only way to get a 27B-class model into this budget** |
| **JetBrains Mellum2.1** | 12B-A2.5B MoE Thinking (2026-09-20) **[V: HF]** | about 6.5 GB at 4-bit | Optional coding specialist. Community MLX quant only |
| **MiniCPM5** | 1B (May), 2B (Sep 2026) with official MLX **[V: HF]** | 1.4 GB | Alternative tiny model. All-global attention, so heavier KV |
| **Mistral** | Ministral 3 3B/8B/14B (Dec 2025). Nothing small since then (Timestral, Shieldstral, Leanstral 119B) **[V: HF]**. Devstral Small 2 is 24B, about 13 GB at 4-bit | 8B/14B yes | Ten months old. No agentic numbers found this pass. Skip |
| **IBM Granite** | granite-4.1-8b (May 2026), granite-switch-4.1 8B/30B (Oct 2026, "decision models") **[V: HF]** | yes | No reason to prioritize. Skip |
| **OpenAI gpt-oss** | Still only gpt-oss-20b/120b (Aug 2025). **No gpt-oss-small exists** **[V: HF openai listing]** | 20b MXFP4 is about 12-13 GB plus KV, over 12 GB **[I]** | Skip |
| **Meta Llama** | No new small Llama. Meta's new line is Muse Spark Open (816B-A42B) **[V: oMLX 0.7.1rc1 notes, HF]** | no | Skip |
| **Microsoft Phi** | Last was Phi-4-reasoning-vision-15B (Jan 2026) **[V: HF]** | marginal | Skip |
| **GLM (Z.ai)** | GLM-5.3 and GLM-5.3-Flash. Flash is 321B **[V: HF]**. No new small GLM | no | Skip |
| **SmolLM** | SmolLM3-3B (Jul 2025) is still the latest **[V: HF]** | yes | Outdated. Skip |
| **Other recent (last 3 months)** | Cohere North-Mini-Code 30B-A3B (Jun), Recursive Flint 40B, Nanbeige4.3-33B, XHToken Spark-X2.6-4B (custom arch, no MLX), DeepSeek V4.1 Flash (large) **[V: HF trending 2026-10-28]** | no, or no MLX path | Skip |

### 1.2 Candidate details

Weights = MLX safetensors size from `hf_fs ls` **[V 2026-10-28]**. Downloads and updated dates come from HF `hub_repo_details` **[V 2026-10-28]**; the counting period isn't stated, so read them as rough popularity. KV/token is my calculation from each `config.json` at fp16 (§3).

| Model | Params | MLX repo (exact id) | Quant | Weights GB | Native ctx | KV KB/tok | Tool format / oMLX parser | Repo downloads, updated |
|---|---|---|---|---|---|---|---|---|
| Qwen3.5-4B | 4.5B dense hybrid (24 GatedDeltaNet + 8 full-attn) | `mlx-community/Qwen3.5-4B-MLX-4bit` | 4bit g64 | 2.9 (2.58 text-only, measured) | 262K | 32.8 | XML `<tool_call><function=…>`, `qwen3_coder` | 292K, 2026-03-02 |
| Qwen3.5-9B | 9.4B dense hybrid | `mlx-community/Qwen3.5-9B-MLX-4bit` (alt: `lmstudio-community/Qwen3.5-9B-MLX-4bit`, 3.3M dl, 2026-06-02) | 4bit | 5.95 (about 5.0 text-only **[I]**) | 262K | 32.8 | `qwen3_coder` | 381K, 2026-03-23 |
| Qwen3.5-2B | 2.2B hybrid | `mlx-community/Qwen3.5-2B-MLX-4bit` | 4bit | 1.72 | 262K | 12.3 | `qwen3_coder` | 66K, 2026-03-02 |
| Gemma 4 12B-it | 12.0B dense (40 sliding-1024 + 8 global, K=V on global) | `mlx-community/gemma-4-12B-it-4bit` | 4bit | 6.74 | 256K | 16.4 + 0.34 GB fixed | Gemma 4 native, `gemma4` (+ oMLX robust fallback) | 73K, 2026-06-08 |
| Gemma 4 E4B-it | 8B total / 4B effective | `mlx-community/gemma-4-e4b-it-4bit` | 4bit | 5.15 (includes audio/vision) | 128K | 16.4 | `gemma4` | 277K, 2026-07-06 |
| Nemotron 3.5 Bolt E4B | 8B / 4B eff. (Gemma 4 E4B arch) | `lmstudio-community/NVIDIA-Nemotron-3.5-Bolt-E4B-MLX-4bit` | 4bit | 4.20 | 128K config; card says 64K in / 64K out | 16.4 | `gemma4` (vLLM uses `gemma4` parser) | 1.3K, 2026-10-20 |
| LFM3-1.7B | 1.73B (13 conv + 5 SWA-256 + 6 global) | `LiquidAI/LFM3-1.7B-MLX-4bit` (official) | 4bit | 0.97 | 256K | 12.3 | XML `<tool_call><function=…><parameter=…>`, same shape as qwen3_coder **[I]** | 687, 2026-10-27 |
| Ternary-Bonsai-2-27B | 27.4B dense hybrid (48 linear + 16 full), Qwen3.8-27B base | `prism-ml/Ternary-Bonsai-2-27B-mlx-2bit` | ternary in affine 2bit g128 | 8.60 (7.67 LM + 0.92 vision) | 262K | 65.5 | Qwen chat template, `qwen3_coder` **[I]** | 94.6K, 2026-09-22 |
| Ternary-Bonsai-2-9B | 9.0B LM + 0.46B vision | `prism-ml/Ternary-Bonsai-2-9B-mlx-2bit` (have) | 2bit | 3.46 | 262K | 32.8 | `qwen3_coder`; tool roundtrip verified locally | 9.5K, 2026-10-01 |
| Mellum2.1-12B-A2.5B-Thinking | 12.1B / 2.5B active MoE (21 SWA-1024 + 7 full) | `randmaru/Mellum2.1-12B-A2.5B-Thinking-mlx-mxfp4` (community; `mlx-community/…-6bit` exists but is about 9.5 GB **[I]**) | mxfp4 | 6.46 | 131K | 14.3 | hermes (per JetBrains vLLM docs) | 1.1K, 2026-10-19 |
| MiniCPM5-2B | 2.5B dense, all 42 layers global | `openbmb/MiniCPM5-2B-MLX` (official) | 4bit | 1.42 | 131K | 43 | `minicpm5` parser (mlx-lm 0.32.0) | 719K, 2026-09-12 |
| Ministral 3 14B | 13.9B dense | `mlx-community/Ministral-3-14B-Instruct-2512-4bit` | 4bit | 8.42 | n/a | n/a | `mistral` | 24.5K, 2025-12-03 |

### 1.3 Published agentic and coding scores

Different harnesses give very different numbers for the same model. For example, Gemma 4 E4B scored SWE-bench Verified **0.5** in Liquid's OpenCode run and **23.0** in JetBrains' run. Compare within a column, not across sources.

**Vendor model cards [V: fetched 2026-10-28]**

| Model | BFCL | tau2 | SWE-bench Verified | Terminal-Bench 2.1 | LiveCodeBench v6 | Source |
|---|---|---|---|---|---|---|
| Qwen3.5-9B (thinking) | V4 66.1 | 79.1 | n/a | n/a | 65.6 | Qwen/Qwen3.5-9B card |
| Qwen3.5-4B (thinking) | V4 50.3 | 79.9 | n/a | n/a | 55.8 | same |
| Gemma 4 12B-it | n/a | 69.0 | n/a | n/a | 72.0 | google/gemma-4-12B-it card |
| Gemma 4 E4B-it | n/a | 42.2 | n/a | n/a | 52.0 | same |
| Gemma 4 E2B-it | n/a | 24.5 | n/a | n/a | 44.0 | same |
| Ternary-Bonsai-2-27B | **v3 74.9** (FP16 base 76.7) | n/a | n/a | n/a | 90.1 (base 90.05) | prism-ml card. Average 98.2% of FP16 over 14 benchmarks |
| Nemotron 3.5 Bolt E4B (Q4_K_M) | v3 67.3 | 52.3 | n/a | n/a | n/a | NVIDIA card. Same table: Qwen3.5-4B Q4 BFCL-v3 70.6, tau2 61.7 |

**Liquid's LFM3 card (one harness, self-reported) [V]**

| | LFM3-1.7B | Qwen3.5-4B | Qwen3.5-9B | Gemma 4 E4B | MiniCPM5-2B |
|---|---|---|---|---|---|
| BFCL V4 | **71.4** | 55.1 | 62.8 | 48.3 | 62.7 |
| tau3-bench (4-domain average) | 68.0 | 66.0 | 67.1 | 33.5 | 69.4 |
| SWE-bench Verified (OpenCode) | 43.4 | 41.2 | 51.2 | 0.5 | 34.8 |
| Terminal-Bench 2.1 (OpenCode) | 12.9 | 13.5 | 18.0 | 0.0 | 5.6 |
| LiveCodeBench v6 | 73.5 | 62.0 | 69.9 | 71.0 | 70.5 |

**JetBrains' Mellum2.1 card (self-reported) [V]:** Mellum2.1 SWE-V 47.0, TB2.1 17.4, LCB v6 82.0, BFCL v4 62.3. On the same harness, Qwen3.5-9B scored 50.0 / 21.7 / 75.4 / 58.5 and Gemma 4 E4B scored 23.0 / 3.4 / 69.4 / 52.5.

**Cross-checks (forum hype vs reality):**
- LFM3: every headline number is Liquid's own. Independent hands-on testing (MindStudio, Oct 2026) found tool calls and JSON arguments correct, but agentic coding failed: it couldn't fix a planted bug and misreported success. Liquid's own docs advise against agentic coding **[V: mindstudio.ai/blog/liquid-ai-lfm3-1-7b-local-agent-model, Oct 2026; TUN and orcarouter write-ups]**. Treat it as a tool-calling and chat model, not a coder.
- Qwen3.5-9B vs Gemma 4 12B: blog comparisons lean toward Qwen for tool calling (tau2 79.1 vs 69.0). One anecdote found Gemma more robust on long chained calls **[V: betterclaw.io comparison, 2026; SEO-style, low weight]**. I found no r/LocalLLaMA threads through search for either model (Reddit indexing was poor this session).
- Bonsai-2-27B: no independent reviews found on Reddit or HN. Benchmarks are vendor-only. Treat it as a high-upside experiment.
- Several "best local LLM for 24GB Mac" roundups recommend gpt-oss-20b, LFM2 24B-A2B, Gemma 4 26B-A4B and Qwen3.6 27B **[V: modelfit.io, llmcheck.net, Sep-Oct 2026]**. All of these blow the 8-12 GB budget once other work is running.

### 1.4 Starter lineup and reasons

| # | Model and repo | Disk | RAM at 32K **[I, §3]** | Why |
|---|---|---|---|---|
| 1 | **Qwen3.5-4B** `mlx-community/Qwen3.5-4B-MLX-4bit` (have) | 2.9 GB | 4.7 GB | Baseline, and the base of Bonsai-4B for quantization A/B. tau2 79.9 is the best published small-model tau2 |
| 2 | **Qwen3.5-9B** `mlx-community/Qwen3.5-9B-MLX-4bit` | 6.0 GB | 7.1 GB | Strongest all-round agent/coder that fits comfortably: BFCL-V4 66.1, SWE-V about 50, TB2.1 18-22. Same parser as #1, so lowest integration risk |
| 3 | **Gemma 4 12B-it** `mlx-community/gemma-4-12B-it-4bit` | 6.7 GB | 8.6 GB | Second family with a different tool-call format, a useful contrast in evals. KV is 2x cheaper per token than Qwen. LCB 72 |
| 4 | **Ternary-Bonsai-2-27B** `prism-ml/Ternary-Bonsai-2-27B-mlx-2bit` | 8.6 GB | 11.0 GB | Qwen3.8-27B (BFCL v3 74.9). The only 27B-class option in budget. Load it alone with 24-32K ctx |
| 5 | **LFM3-1.7B** `LiquidAI/LFM3-1.7B-MLX-4bit` (add once oMLX's mlx-vlm includes LFM3; see §2.5) | 1.0 GB | 1.9 GB | Tiny and fast. Independently confirmed decent at tool calls. Until it runs, use Bonsai-2-2B for the tiny tier |

Optional extras: `lmstudio-community/NVIDIA-Nemotron-3.5-Bolt-E4B-MLX-4bit` (4.2 GB; multi-turn tool use, When2Call best in class) and `randmaru/Mellum2.1-12B-A2.5B-Thinking-mlx-mxfp4` (6.5 GB; fast MoE coder. The quant is from a single community uploader with 1.1K downloads, which is a provenance red flag, so verify hashes and output before trusting it).

Rough decode-speed expectations **[I]**: decode on Apple Silicon is limited by memory bandwidth, roughly bandwidth ÷ bytes read per token. The base M5 has about 153 GB/s (Apple's Oct 2025 spec; not re-checked this session). Realistic throughput is about 60-70% of that ceiling:

| Model | Bytes read per token | Expected decode |
|---|---|---|
| Qwen3.5-9B (4-bit) | about 5 GB | about 18-22 tok/s |
| Gemma 4 12B | about 6.7 GB | about 14-16 tok/s |
| Bonsai-27B | about 7.7 GB | about 12-14 tok/s |
| Mellum (2.5B active) | — | about 50+ tok/s |
| LFM3 | about 1 GB | about 80+ tok/s |

Measure these in the app. oMLX already reports `generation_tokens_per_second`.

### 1.5 Already-downloaded models

| Model | Verdict | Reason |
|---|---|---|
| Qwen3.5-4B-MLX-4bit | **Keep** | Lineup #1. Its tool roundtrip is verified locally |
| Ternary-Bonsai-2-9B | **Keep** | 9B quality at 2.5 GB resident. It pairs with Qwen3.5-9B 4-bit for a 2-bit-vs-4-bit experiment on the same base, which suits Terrarium's model-comparison focus. No published benchmarks for the 9B, so the app's evals will be the first data |
| Ternary-Bonsai-2-2B | **Keep for now** | Smallest working tiny tier (1.1 GB, 12 KB/token KV) until LFM3 loads. Then drop it |
| Ternary-Bonsai-2-4B | **Drop** (opinion) | Dominated: same KV cost as Qwen3.5-4B, only 0.7 GB smaller on disk than Bonsai-9B, and no published scores |

Runtime facts about the Bonsai packs **[V: prism-ml model cards, 2026-10-28]**:
- They declare `model_type: prism_hadamard_qwen35`. On the 27B, *standard MLX loaders give incorrect output instead of an error*.
- mlx-vlm ≥0.7.8 loads them natively. mlx-lm v0.32.0 release notes list PR #1941 adding `prism_hadamard_qwen35`, but the 9B card says mlx-lm 0.32.0 can't load it yet, so check on install.
- The local oMLX 0.7.0 runs the 2B/4B/9B correctly through its VLM path **[V: local_llms/evidence, 2026-10-15]**. The 27B uses the same model_type, so it should work the same way **[I]**; it hasn't been tested yet.
- Thinking is on by default at reasoning effort `xhigh`. Allow ≥8K output tokens or disable thinking per model.

---

## 2. Inference server

### 2.1 Repo health [V: GitHub API, 2026-10-28]

| Server | Latest | Stars | Last push | Open issues | Notes |
|---|---|---|---|---|---|
| oMLX (jundot/omlx) | **v0.7.2 stable (2026-10-21)**, v0.7.3rc1 (2026-10-27) | 23.1K | today | 587 | 62 contributors with ≥5 commits, but jundot has 2,193 commits (a single-maintainer core). Releases every 1-3 days, so expect regressions |
| mlx-lm (ml-explore) | v0.32.2 (2026-10-16) | 7.5K | today | 250 | Apple-maintained |
| mlx-vlm (Blaizzy) | v0.7.11 (2026-10-28) | 5.7K | today | 273 | |
| Ollama | v0.40.12 (2026-10-27), 0.40.13-rc0 | 185K | today | 4.5K | |
| llama.cpp | v0.8.0 (2026-10-28) plus b11972 builds | 133K | today | 2.6K | |
| LM Studio | app 0.4.22 is the newest changelog entry found (2026-08-28); `lms` CLI repo last pushed 2026-10-14 | `lms` 5.4K | — | 346 | App and llmster are closed source |
| vllm-mlx / vmlx / mlx-openai-server | — | 1.6K / 0.9K / 0.4K | Oct 2026 | — | Under 2K stars and small teams. Red flag, skip |

### 2.2 Criteria matrix

| Criterion | **oMLX 0.7.2** | LM Studio 0.4.x headless (`llmster` / `lms`) | Ollama 0.40.12 | llama.cpp `llama-server` router (v0.8.0) | `mlx_lm.server` 0.32 |
|---|---|---|---|---|---|
| OpenAI chat + tool parsing per family | Yes. Uses mlx-lm parsers (`qwen3_coder`, `gemma4`, `mistral`, `minicpm5`, `json_tools`, `pythonic`, …) plus oMLX fallbacks (hermes, robust Gemma 4 arg recovery) **[V: local source, omlx/api/tool_calling.py]** | Yes, per-family parsing in app **[I]** | Yes, per-model templates in Ollama's registry **[I, long-standing]** | Yes with `--jinja` (default on), broadest template coverage **[V: server README]** | Basic, via mlx-lm parsers |
| Model formats | MLX dirs; GGUF via the "Splash" external engine since 0.7.1 **[V: release notes]** | MLX + GGUF | Own registry and blob store. MLX runtime by default for supported archs (Qwen3.5/3.6/3.8, Gemma 4) since v0.40.0 (2026-09-25); llama.cpp otherwise **[V: GitHub release]** | GGUF only | MLX only |
| Runs our shortlist | Qwen3.5, Gemma 4 12B (unified via mlx-vlm), Bonsai prism, Mellum, MiniCPM5. **Not LFM3** in 0.7.2 or 0.7.3rc1 (mlx-vlm pins 2026-10-13 and 10-22 lack `models/lfm3`) **[V: GitHub contents API]** | LFM3 GGUF likely. Bonsai prism MLX unknown **[I]** | Qwen3.5 and Gemma 4 on MLX; LFM3 in library (0.40.12) **[V]**. Bonsai MLX no. Ternary GGUF `q2_0` type added in 0.40.6, untested **[V notes / I support]** | LFM3 yes (v0.8.0) **[V]**. Bonsai 2 GGUF needs PrismML's fork **[V: card]**. No MLX packs | No `gemma4_unified`, no LFM3 **[V: repo contents]** |
| Multi-model, load/unload on demand | Yes: `POST /v1/models/{id}/load`, `/unload`, LRU eviction, pinning, per-model TTL **[V: source v0.7.0, routes present in v0.7.2]** | Yes: `POST /api/v1/models/load` and `/unload`, JIT load, idle TTL auto-evict **[V: lmstudio.ai docs]** | Yes: `keep_alive` (0 = unload), `OLLAMA_MAX_LOADED_MODELS` **[I, long-standing]** | Yes: `POST /models/load`, `/models/unload`, `--models-max`, autoload **[V: README]** | One model; swaps on request |
| Explicit memory cap | **Yes:** `memory_guard_tier=custom` + `memory_guard_custom_ceiling_gb`, plus a prefill memory guard **[V: local configure_omlx.py]** | "Model loading guardrails" setting **[I]** | No hard GB cap (the scheduler estimates fit) **[I]** | `--models-memory-margin N` MiB free, with LRU unload until a model fits **[V]** | No |
| Per-model context / max_tokens | Per-model `max_context_window` and `max_tokens` via `PUT /api/models/{id}/settings` or `ModelSettingsManager`. `max_tokens` per request **[V]** | `context_length` per load **[V]**. Per-request max_tokens | `num_ctx` per request (changing it reloads the model) | Per-model `-c` in a `--models-preset` INI. Per-request `max_tokens` | Request `max_tokens` only |
| usage / finish_reason / timing | `usage` + `prompt_tokens_details.cached_tokens`, `time_to_first_token`, `time_to_first_visible_token`, `prompt_tokens_per_second`, `generation_tokens_per_second`, `model_load_duration`, `total_time` **[V: omlx/api/openai_models.py; ttft present in v0.7.2 server.py]** | Native API emits load and prompt-processing events; full stats fields not confirmed **[V partial]** | Native `/api/chat` timing (prompt_eval_count/duration, eval_count/duration, load_duration) **[I, long-standing]**; the OpenAI endpoint returns usage only **[I]** | `timings` object (prompt_n, prompt_ms, predicted_per_second, …), `truncated` flag **[V]** | usage only, `finish_reason` stop/length **[V]** |
| Streaming | Yes | Yes | Yes | Yes | Yes |
| Prompt caching | Prefix cache plus RAM hot cache plus SSD tier, `cached_tokens` reported **[V: source / notes]** | Yes **[I]** | KV reuse within a loaded model **[I]** | `cache_prompt` default on **[V]** | Yes |
| Admin API for a model picker | `GET /v1/models/status` → per model: `loaded`, `is_loading`, `estimated_size`, `actual_size`, `model_context_length`, `max_context_window`, `max_tokens`, `pinned`, `last_access`; pool: `final_ceiling`, `current_model_memory`, `loaded_count` **[V: source]** | `GET /api/v1/models`, load returns `instance_id` and `load_time_seconds` **[V]** | `GET /api/tags`; `GET /api/ps` → `size`, `size_vram`, `context_length`, `expires_at` **[V: docs.ollama.com]** | `GET /models` → status (loaded/loading/sleeping/unloaded/failed), memory `min`/`max`/`effective` measurements, plus `GET /models/sse` live events **[V]** | `GET /v1/models` only |

### 2.3 Recommendation: keep oMLX, pinned at 0.7.2

**Why:**
- It runs every MLX pack in the lineup, including the two exotic ones: Bonsai's Hadamard ternary and Gemma 4 12B unified, which mlx-lm alone can't load.
- Its `usage` already carries every metric Terrarium wants to display.
- Its status endpoint gives loaded state and memory per model.
- The current project is already wired to it.

**Runner-up:** llama.cpp router mode. It has the best-designed admin API (memory measurements, SSE) and the broadest tool-template support. The cost is GGUF only, which drops the Bonsai MLX packs (stock llama.cpp can't run Bonsai 2 GGUF either) and MLX's speed edge on M5. Ollama measured MLX at 112 vs 58 tok/s decode against its llama.cpp path on an M5 for Qwen3.5-35B-A3B, but those were different quants (NVFP4 vs Q4_K_M) **[V: ollama.com/blog/mlx, 2026-03-30]**.

**Ollama:** good timing fields, but its own blob store and its lack of a hard memory cap make it a worse base for a picker over arbitrary HF repos.

**LM Studio:** closed source and less scriptable to verify.

**mlx_lm.server:** single-model and no admin API, so not suitable.

### 2.4 Concrete notes for oMLX

**Install / upgrade** **[V: release assets]**
- Install the official wheel into the project venv (Python 3.13): `omlx-0.7.2-cp313-cp313-macosx_15_0_universal2.whl` from GitHub release v0.7.2.
- oMLX isn't on PyPI.
- It pins `mlx==0.32.4` plus git SHAs of mlx-lm (`94cdcae1`) and mlx-vlm (`97902318`, dated 2026-10-13).
- Pin the version, and gate upgrades behind the app's own tool-call smoke eval for each installed model.

**Admin endpoints the app should call** (API key `Authorization: Bearer <key>`) **[V: source]**

| Method | Endpoint | Use |
|---|---|---|
| GET | `/v1/models` | Picker list |
| GET | `/v1/models/status` | Loaded state, memory, ctx, last access, pool ceiling |
| POST | `/v1/models/{id}/load` | Load |
| POST | `/v1/models/{id}/unload` | Unload |
| PUT | `/api/models/{id}/settings` | Per-model `max_context_window`, `max_tokens`, `enable_thinking`, sampling, `ttl_seconds`, `model_type_override` |
| GET | `/api/models/{id}/generation_config` | Model defaults |
| GET | `/api/device-info`, `/api/stats` | Machine info |

The `/api/*` routes are dashboard routes, so confirm they accept the API key and not only a session login **[I]**.

**Setting context per model:**
- Keep using `ModelSettingsManager` (as in `scripts/configure_omlx.py`) or call `PUT /api/models/{id}/settings` with `max_context_window` and `max_tokens`.
- Also set `model_type_override="llm"` for Qwen3.5, Bonsai and Gemma. Text-only loading dropped Qwen3.5-4B from 3.18 to about 2.4 GiB **[V: local_llms/README.md]**.

**Global settings:**
- Raise `memory_guard_custom_ceiling_gb` from 5 to 11 or 12.
- Keep `prefill_memory_guard` on.
- Turn on 8-bit KV cache (new in 0.7.1 **[V]**) only for Bonsai-27B at more than 32K context.

**Pitfalls**
- **oMLX open bugs [V: GitHub issues, 2026-10-28]:**
  - #2877: `tool_choice:"required"` and named-function choices are silently downgraded to `auto`.
  - #3229: Gemma 4 tool arguments containing markdown `**Label:**` fragment into bogus keys.
  - #4321: the xgrammar compiled-grammar cache grows about 0.45 GB per distinct JSON schema. Avoid unique `response_format` schemas per request.
  - #2841: ANE prefill can trigger a memory-pressure abort.
- **Recently fixed but worth regression-testing:**
  - #2394: chat completions silently truncated long prompts to about 6K tokens.
  - #4903: the prefill memory guard got stuck and rejected all prompts.
  - Terrarium should compare `usage.prompt_tokens` against its own token count on every turn.
- **Qwen3.5 / Bonsai:**
  - No `/think` soft switch. Use `chat_template_kwargs: {"enable_thinking": false}` or the per-model setting.
  - mlx-lm/mlx-vlm ignore `generation_config.json`, so set sampling explicitly. Non-thinking: temp 0.7, top_p 0.8, top_k 20, presence_penalty 1.5. Thinking: temp 1.0, top_p 0.95 **[V: Qwen and Prism cards]**.
  - Greedy decoding with thinking on can loop.
- **Gemma 4:**
  - Turn thinking on with `<|think|>` in the system prompt or `enable_thinking`.
  - The 12B still emits an empty `<|channel>thought<channel|>` block when thinking is off **[V: card]**. Strip it in the transcript view.
- **LFM3:**
  - Reasoning is on by default, and `enable_thinking=False` is inconsistent on reasoning-heavy tasks.
  - Recommended sampling is temp 0.1, top_k 50, rep 1.1 **[V: card]**.
  - It needs an oMLX release whose mlx-vlm is at or after commit "Add native LFM3 and LFM3-VL preview support" (2026-10-22). Watch oMLX release notes.
  - Interim option: run it as a GGUF through llama.cpp v0.8.0 or Ollama 0.40.12.
- **Nemotron Bolt:** the chat template rejects stray `tool` messages that don't follow an assistant `tool_calls` turn **[V: card]**. That matters if the harness injects tool results.

### 2.5 If oMLX stability becomes a problem

Switch to `llama-server --models-dir <gguf dir> --models-preset terrarium.ini --models-memory-margin 4096 --models-max 2`, with per-model `-c` in the INI. The app reads `GET /models` memory `min`/`max` for its warnings. The cost is losing the MLX Bonsai packs.

---

## 3. Context sizing

### 3.1 Formula

```
total_GB = W + ctx × B_tok + F + O

  W     = resident weights, GB (text-only where the pack has a vision tower)
  B_tok = Σ over full-attention layers that own KV: 2 × n_kv_heads × head_dim × bytes_per_elem
          (fp16 = 2 B; 8-bit KV ≈ 1.06 B; 4-bit KV ≈ 0.56 B incl. group scales [I])
  F     = fixed state, independent of ctx:
          sliding-window layers: L_swa × 2 × n_kv × head_dim × 2 B × window
          linear-attention (GatedDeltaNet) layers: L_lin × Hv × Dv × Dk × 4 B (fp32 state)
  O     = runtime overhead: about 0.5 GB for models under 2B, about 1.0 GB otherwise [I].
          Covers prefill activations at the default 2048-token chunks, Metal buffers, tokenizer.
```

How the terms were checked:
- Layer counts and head shapes come from each repo's `config.json` **[V 2026-10-28]**.
- The cache layout is verified in mlx-lm source **[V: local mlx_lm 0.31.4.dev]**:
  - Gemma 4 global layers use `global_head_dim` 512.
  - KV-shared layers (`num_kv_shared_layers`) store nothing.
  - Sliding layers use `RotatingKVCache(max_size=sliding_window)`.
  - Qwen3.5 linear layers use `ArraysCache` with an fp32 state.

### 3.2 Per-model numbers [I: computed from configs]

| Model | W (GB) | KV KB/token | Fixed MB | 8K | 16K | 32K | 64K | 128K | Max ctx within 12 GB (capped at native) |
|---|---|---|---|---|---|---|---|---|---|
| LFM3-1.7B 4bit | 0.97 | 12.3 | 3 | 1.6 | 1.7 | 1.9 | 2.3 | 3.1 | 256K (native) |
| Qwen3.5-2B 4bit | 1.72 | 12.3 | 19 | 2.3 | 2.4 | 2.6 | 3.0 | 3.8 | 256K |
| Ternary-Bonsai-2-2B | 1.10 | 12.3 | 19 | 1.7 | 1.8 | 2.0 | 2.4 | 3.2 | 256K |
| Qwen3.5-4B 4bit (text-only, measured) | 2.58 | 32.8 | 50 | 3.9 | 4.2 | 4.7 | 5.8 | 7.9 | 249K |
| Ternary-Bonsai-2-4B | 1.80 | 32.8 | 50 | 3.1 | 3.4 | 3.9 | 5.0 | 7.1 | 256K |
| Ternary-Bonsai-2-9B (LM only) | 2.54 | 32.8 | 50 | 3.9 | 4.1 | 4.7 | 5.7 | 7.9 | 250K |
| Nemotron Bolt E4B 4bit | 4.20 | 16.4 | 21 | 5.4 | 5.5 | 5.8 | 6.3 | 7.4 | 128K (native) |
| Qwen3.5-9B 4bit (text-only est.) | 5.0 | 32.8 | 50 | 6.3 | 6.6 | 7.1 | 8.2 | 10.3 | 177K |
| Mellum2.1 mxfp4 | 6.46 | 14.3 | 44 | 7.6 | 7.7 | 8.0 | 8.4 | 9.4 | 128K (native) |
| Gemma 4 12B 4bit | 6.74 | 16.4 | 336 | 8.2 | 8.3 | 8.6 | 9.1 | 10.2 | 233K |
| Ternary-Bonsai-2-27B (LM only) | 7.67 | 65.5 | 151 | 9.4 | 9.9 | **11.0** | 13.1 | 17.4 | **47K** |
| *Reference: classic dense 8B (Llama-3.1-8B)* | about 4.5 | 131 | 0 | | | +4.3 GB KV alone | | | |

**Takeaway:** the hybrid-attention models (Qwen3.5, Bonsai, Gemma 4, LFM3, Mellum) make long context cheap. Weights, not KV, are what limit the budget. The exception is Bonsai-27B, whose 16 full-attention layers cost 65 KB/token.

### 3.3 Rule the app should implement

1. `budget = min(user_cap (default 12 GB), free_mem_now + already_resident_model_bytes − 2 GB safety)`. Read free memory from `vm_stat` or `host_statistics64`; oMLX `/v1/models/status` gives `current_model_memory` and `final_ceiling`.
2. `max_ctx = floor((budget − W − F − O) / B_tok)`, rounded **down** to a step (8K, 16K, 32K, 64K, 128K) and capped at the native context.
3. **Defaults:**
   - Agent mode: 32K, or `max_ctx` if smaller (Bonsai-27B → 32K only when nothing else is loaded, else 24K).
   - Chat mode: 16K.
   - Never go below 16K for agents. The harness system prompt and tool schemas take 2-4K before the first user turn **[I]**, and the old 8K setup left about 1 output token.
4. **Display:** "Qwen3.5-9B at 32K needs about 7.1 GB (weights 5.0 + context 1.1 + overhead 1.0)". Re-evaluate whenever another model is loaded, since two loaded models share the budget.
5. **Truncation guard before each request:**
   - Check `prompt_tokens_est + max_tokens + harness_reserve ≤ ctx`.
   - If it fails, warn and either compact or lower `max_tokens`.
   - After each response, show a context meter from `usage.prompt_tokens + usage.completion_tokens` vs ctx.
   - Flag `finish_reason == "length"` as truncated.
6. **Thinking models** (Qwen3.5, Bonsai, LFM3, Mellum with thinking on):
   - Reserve at least 8K output (Prism recommends at least 8,192 **[V]**).
   - With 32K context that leaves about 20K for history.
7. **Quantized KV (oMLX 4/8-bit):**
   - It cuts B_tok by about 2-3.5x.
   - Attention on a quantized cache isn't fused. It materializes a `prefill_step × ctx` score matrix **[V: mlx-lm SERVER.md]**, about 2 GiB at a 2048 step, 32K ctx and 16 heads **[I]**.
   - Pair it with a prefill step of 512 or less, and only use it when ctx is above 32K.

---

## Sources (all accessed 2026-10-28)

**Hugging Face Hub (via MCP `hub_repo_search`, `hub_repo_details`, `hf_fs`):**
- Model cards: Qwen/Qwen3.5-9B, google/gemma-4-12B-it, LiquidAI/LFM3-1.7B, nvidia/NVIDIA-Nemotron-3.5-Bolt-E4B-BF16, prism-ml/Ternary-Bonsai-2-27B-mlx-2bit, prism-ml/Ternary-Bonsai-2-9B-mlx-2bit, JetBrains/Mellum2.1-12B-A2.5B-Thinking, CohereLabs/North-Mini-Code-1.0
- Plus each repo's `config.json` and file listing.

**GitHub API:**
- jundot/omlx releases v0.7.0 to v0.7.3rc1, pyproject pins, issues #2394, #2576, #2841, #2877, #3229, #4321, #4903
- ml-explore/mlx-lm v0.32.0 notes and `models/` listing
- Blaizzy/mlx-vlm LFM3 commit history
- ollama/ollama v0.40.0 to v0.40.13-rc0 notes
- ggml-org/llama.cpp v0.8.0 notes and `tools/server/README.md` (router mode)
- ml-explore/mlx-lm `SERVER.md`

**Docs and blogs:**
- docs.ollama.com/api/ps
- ollama.com/blog/mlx (2026-03-30)
- lmstudio.ai/docs/developer/rest and /rest/load
- lmstudio.ai changelog (0.4.22, 2026-08-28)
- mindstudio.ai LFM3 hands-on (Oct 2026)
- betterclaw.io Gemma 4 12B vs Qwen3.5 9B
- modelfit.io and llmcheck.net roundups (Sep-Oct 2026; low weight, SEO-style)

**Local:**
- /Users/karvi/PRIMARY/Projects/local_llms: README.md, QA.md, config/setup.json, scripts/configure_omlx.py
- oMLX 0.7.0 and mlx_lm source in its .venv
- model config.json files
