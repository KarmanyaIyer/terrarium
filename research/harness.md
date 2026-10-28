# Harness research: which agent loop drives Terrarium's models

Date: 2026-10-28 (checked with `date`)
Session: b15d5e02-7347-4d64-883b-08dad4bd88f8 (research sub-agent for the Terrarium build thread)

Legend: **[V]** = verified by me today (source given). **[I]** = inferred or my judgement.
Token counts use the Qwen3 tokenizer (`Qwen/Qwen3-4B` tokenizer.json) on raw text. The model's chat template adds its own wrapper tokens on top, which aren't counted here.

---

## 1. Answer

**Recommendation: run the agent loop on the host with `@earendil-works/pi-agent-core@1.4.0`, and have Terrarium own the prompt, tools, compaction and tool-call parsing.**

- The loop runs in the Node backend. Tools (`bash`, `read`, `write`, `edit`) call one `Env` interface. It has two adapters: Gondolin (`vm.exec`, `vm.fs`) and just-bash (`bash.exec`, `bash.fs`).
- Every model call goes through the logging gateway. pi-agent-core's events feed the trace store.
- pi-agent-core adds **0 prompt tokens and 0 tools** of its own. The drafted Terrarium prompt plus 4 tool schemas costs **385 tokens**. Stock Pi costs about **1,409** (section 6).
- Two comparison profiles sit behind the same event schema. "Pi stock" uses Pi's own prompt and tools with our executors. "Pi in VM" runs the Pi CLI in RPC mode inside Gondolin; it's the only way the agent can write its own extensions.

**Runner-up: our own bare loop**, about 250 lines of TypeScript over `fetch` to `/v1/chat/completions`. It's slightly better on transparency and worse on edge cases. It also fits pi-agent-core's `streamFn` seam, so we can move to it later without changing the event pipeline.

**Not chosen:**
- libfx: too young, single maintainer, and the loop is native Zig.
- AI SDK v7 with bash-tool: a fine comparison adapter, but it adds abstraction layers between us and the wire.
- OpenCode, Qwen Code, Codex, Hermes, smolagents: their prompts are too large or they can't be embedded.
- mini-swe-agent: Python. Good as an eval baseline later.

---

## 2. Host-side loop vs harness inside the VM

| | Host-side loop (recommended) | Harness inside the VM (old setup) |
|---|---|---|
| Works for just-bash envs | Yes. just-bash is a TS interpreter in our process [V just-bash README] | **No.** just-bash has no real OS or Node to run Pi in (its JS is QuickJS) [V README] |
| One harness for both env types | Yes | No, needs a second path |
| Event stream | In-process `agent.subscribe` | JSON lines over `vm.exec` stdio (Pi `--mode rpc`) [V Pi README links RPC docs] |
| Raw model traffic | Gateway | Still the gateway, if the VM's network policy allows only the gateway host [I] |
| Network-off-by-default promise | Intact: the VM never needs to reach the model | Weakened: the VM must reach the gateway [I] |
| Agent can tamper with harness logs/settings | No | Yes. Session files and settings live in the VM [I] |
| Snapshot/fork semantics | Clean. VM state is env state, harness state is ours | Mixed. Forking a VM forks the harness session too [I] |
| Agent writes its own harness extensions | No | Yes |
| Per-tool-call cost | One `vm.exec` round trip | Local inside the VM |

Verdict [I]: host-side by default. Self-extension is fun but optional, so make "Pi in VM" a selectable harness for VM environments only. It's the same pattern as Gondolin's own `host/examples/pi-gondolin.ts`, which runs Pi on the host and routes its four tools into the VM through Pi's `operations` hooks [V].

---

## 3. Comparison table

Stars and push dates from `gh api` on 2026-10-28 [V].

| Harness | Form | Own prompt + tool tokens | Text/XML tool-call fallback | Small-context handling | Custom tool executors | Event stream | Swap prompt/schemas | Maturity | Verdict |
|---|---|---|---|---|---|---|---|---|---|
| **pi-agent-core 1.4.0** (earendil-works/pi) | TS library, Node 22.19+ | **0** (you supply both) [V] | None; relies on server `tool_calls` (no text parsing in `pi-ai/src`) [V grep] | No compaction in core, only a `transformContext` hook. pi-ai caps output at window minus estimate minus **4,096** [V] | `AgentTool.execute()` [V] | 10 typed events incl. `tool_execution_*` with `durationMs` [V] | Fully | 118.5k stars, pushed 2026-10-28, MIT. badlogic (Mario Zechner) 4,028 commits, mitsuhiko (Armin Ronacher) 919. 1.0 on 2026-10-01 [V] | **Recommended** |
| Pi coding-agent 1.4.0 (CLI / SDK / RPC) | TS app + SDK | **804 + 605 = ~1,409** (509 of the 804 is a "Pi documentation" block) [V measured] | None [V] | Compaction default `reserveTokens` 16,384, `keepRecentTokens` 20,000, with per-model overrides [V] | `BashOperations`, `ReadOperations`, `WriteOperations`, `EditOperations` [V] | Same events; JSON and RPC modes [V] | Via extensions (`before_agent_start`) | Same repo | "Pi stock" comparison profile |
| libfx 0.0.15 / fx CLI (vercel-labs/fx) | Zig engine as a Node native addon + WASM | libfx: **0** (`system_prompt = ""`) [V `napi_core_main.zig:738`]. fx CLI prompt: 1,175 [V] | Not found [V grep] | CLI compacts and keeps full text on disk [V README]; no libfx knobs documented | `tools[].execute` [V] | `hooks.onEvent` (`FxHookEvent`); content capture capped at 64 KiB per event [V] | Instructions yes; the loop is native | 3.6k stars, repo created 2026-08-11, Apache-2.0. One maintainer has 3,339 commits; the next has 82 [V] | Watch; revisit in ~6 months |
| AI SDK 7.0.156 `ToolLoopAgent` + bash-tool 1.3.19 | TS library | bash-tool adds its own tool prompt (not measured) | Through `@ai-sdk-tool/parser` 5.1.6 (92 stars, solo dev) [V]. `repairToolCall` fixes bad JSON [V d.ts] | `prepareStep` can rewrite messages each step [V d.ts] | bash-tool `Sandbox` = `executeCommand`, `readFile`, `writeFiles` [V] | `onLanguageModelCallStart/End`, `onToolExecutionStart/End`, `includeRawChunks` [V d.ts] | Yes | ai: 27.6k stars, Apache-2.0, Vercel; majors v5 to v7 in about a year [V npm dist-tags]. bash-tool: 629 stars, last push 2026-08-22 [V] | Viable comparison adapter |
| just-bash's own integrations | README "Integrations" = bash-tool (above) + a `@vercel/sandbox`-compatible `Sandbox` class [V] | | | | | | | just-bash 3.6.0: 4.4k stars, pushed 2026-10-27, Apache-2.0 in package.json [V] | Use as an **environment**, not a harness |
| mini-swe-agent | Python | 1,292 for the whole `mini.yaml` [V] | Text-based mode (`mini_textbased.yaml`) [V] | Linear history; step/cost limits [I] | Python environment classes [V] | Trajectory files | YAML | 8.9k stars, MIT, SWE-agent team. Last main commit 2026-09-03 [V] | Eval baseline later (subprocess) |
| smolagents | Python | Tool-calling prompt 2,476; code-agent yaml 17 KB [V] | CodeAgent writes Python instead of JSON | Not tuned for small windows [I] | Python tools | Callbacks | Yes | 30.1k stars, Apache-2.0, Hugging Face [V] | No |
| OpenCode 1.19.5 | TS app; `opencode serve` + `@opencode-ai/sdk` [V npm] | Default `system.txt` is 756 bytes plus injected tool guidance and ~10 tools (total not measured) [V file] | Not checked | Auto compaction [I] | Plugins; tools run on the host FS [I] | Server SSE [I] | Partly | 222.7k stars, MIT [V] | Only as an in-VM comparison |
| Goose | Rust app + server | `system.md` 1,232 bytes; **`tiny_model_system.md` uses a `$ command` text protocol, no JSON tools** [V] | Yes: `toolshim.rs` + tiny-model mode [V] | `goose-context-management` crate [V] | MCP extensions | goosed server | Partly | 55.9k stars, Apache-2.0, AAIF [V] | Borrow the tiny-model idea; not embeddable in Node |
| Qwen Code | TS (Gemini CLI fork), `@qwen-code/sdk` 0.1.25 [V] | `prompts.ts` source is 92.8 KB, so multi-thousand tokens [I] | | | | | | 28.8k stars, Apache-2.0 [V] | No (prompt size) |
| Qwen-Agent | Python | | | | | | | 17.2k stars, last push 2026-03-04 (stale) [V] | No |
| Hermes Agent | Python | Official docs: "requires at least 64,000 tokens for agentic work with tools" [V docs page, undated, footer 2026]. A third-party guide claims ~13K tokens of system context [unverified] | | | Six terminal backends | | | 258k stars, MIT, Nous Research [V] | No (context floor is 5-8x our budget) |
| Codex CLI (`--oss`) | Rust | Base prompt (`models-manager/prompt.md`): **4,398** [V counted] | | | | | | 131.4k stars, Apache-2.0 [V] | No |
| DeepSeek Harness (`dsh`) | TS app with web UI, plugin architecture | Not measured | | | | | | 264.8k stars, created 2026-08-13, MIT. README: "developer preview ... compatibility-breaking changes" [V] | Watch; it's an app, not a library |
| little-coder | Pi + ~30 extensions + 30 skills | ~7K-token cold start (README) [V] | Parser repairs fenced and non-native tool calls [V blog] | Targets 32K; defaults to Qwen3.6-35B-A3B [V] | Pi extensions | Pi | | 2.7k stars, solo, Apache-2.0, last push 2026-09-18 [V] | Mine for ideas, not a dependency |
| **Bare loop (ours)** | ~250 lines of TS | **385** (125 prompt + 260 tools, drafted below) [V counted] | Yes, we write it | Ours | Ours | Ours | Fully | n/a | **Runner-up** |

---

## 4. Published evidence: does the harness matter for small models?

Short version: yes, by large margins. But almost no data exists for models **under** 9B; most of it is 9B to 27B or frontier models. Terrarium's own evals will produce better data for 1-4B than anything published.

| Evidence | Date | What it shows | Trust |
|---|---|---|---|
| little-coder blog "Honey, I Shrunk the Coding Agent" | 2026-04-19 | **Same Qwen3.5-9B Q4_K_M weights on Aider Polyglot (225 exercises): 45.56% with little-coder vs 19.11% with an Aider baseline**, both at 32K context. Load-bearing pieces: a write guard, a 2,048-token thinking cap, a retry path (removing it drops the score to 37.6%), ~500-token skill cards, and a parser for malformed or fenced tool calls. | Author's own numbers, no formal ablations. ~6 months old but still the most direct small-model evidence [V fetched] |
| r/LocalLLaMA "Which model, which harness? I have data for you." (71 points, 56 comments) | 2026-10-05 | Same quant, same RTX 5090: **22% to 96% depending on harness**. Averages over 3 models: OpenCode 94%, oh-my-pi 91%, **Pi 71% (96/80/37)**, Hermes 67%, OpenClaw 56%. | The poster runs the leaderboard site (login-walled), so read it as possible self-promotion. Top comments flag a likely misconfiguration (MTP lowering accuracy) and question the Pi timing. Models are 27B-class. Directional only [V read thread] |
| r/LocalLLaMA "Agentic harness for small models" (41 points, 52 comments) | 2026-08-15 | Top answer: "Use Pi" (55 points). Anecdote, time to first reply for "Hi" on the same model and settings: **Hermes 40 s, Open WebUI 30 s, Pi 3 s**. OpenCode "has a larger prompt for the initial first response so prefill ... is pretty important." | Anecdotes, but consistent with the measured prompt sizes in section 6 [V read thread] |
| r/LocalLLaMA "Which agent harness do you use and why?" (266 points, 267 comments) | 2026-09-05 | Pi preferred "on more memory constrained systems ... to conserve context". oh-my-pi, OpenCode and DeepSeek Harness are popular for 27B-class models. | The original post's benchmark promotes TrueForge (possible marketing). Comments look organic [V read thread] |
| NLT replication study, arXiv 2607.03953 | 2026-07-04 | 14 models, 8,560 trials. Tool selection accuracy: 62.3% with natural-language tool calls vs 47.4% with structured JSON calls, with 93% fewer critical errors. **Smaller models and models without native tool calling gained +24.0 to +43.1 points** (reported as one group). | Peer-review status unknown; the group figure isn't split by size [V abstract] |
| "The Bitter Lesson of Tool Calling", arXiv 2608.06370 | 2026-08-06 | Code-style tool calls match or beat JSON in 11 of 14 models on BFCL v4. | No small-model breakdown [V abstract] |
| Goose repo | checked 2026-10-28 | Ships `tiny_model_system.md`: tiny models get shell commands as `$ ...` lines, not JSON tools. | Design evidence from a 55.9k-star project [V] |
| Terminal-Bench 2.0, frontier models | blog 2026-04-09, updated 2026-10-28 | Claude Opus 4.6: 58.0% in Claude Code vs 74.7% in Terminus-KIRA. Even frontier models swing 15+ points by harness. | Blog; partly cites tbench.ai [V fetched] |

What this means for Terrarium [I]:
1. **Prompt and schema overhead is the first-order cost at 8K.** Stock Pi spends ~17% of an 8K window before the task arrives; the Terrarium draft spends ~5%. Prefill time on the M5 scales with it too.
2. **Tool-call parsing and repair are where 1-4B models fail.** Build the fallback parser first, and log both the raw and the repaired message.
3. **Make the tool-call format a variable.** Offer native `tool_calls`, Hermes-style `<tool_call>` text, and a Goose/mini-swe-style "`$ command` / fenced bash" text protocol. That's cheap when we own the prompt layer, and it's the comparison the evidence says matters most for small models.

---

## 5. Why pi-agent-core over the alternatives

1. **Small models.** The core ships no prompt and no tools, so everything that matters for small models is ours. Tool args are validated against the TypeBox schema, and a thrown error goes back to the model as a tool error with `isError: true` [V README]. If a response hits the output limit mid-tool-call, the call is **not executed**, and the model is told: "the response hit the output token limit, so its arguments may be truncated. Re-issue the tool call" [V `agent-loop.ts:503`]. That's exactly the failure an 8K window produces.
2. **Embeddable.** It's a plain class. `execute(toolCallId, params, signal, onUpdate)` lets us route into any env. It also has `beforeToolCall` (policy/blocking), `afterToolCall`, `transformContext` (compaction), `prepareRequest`, `finishTurn`, steering, follow-up, abort, and parallel or sequential tool batches [V README].
3. **Transparency.** Its event stream maps one-to-one onto a trace UI. `onPayload` exposes the exact request body pi-ai built, and the gateway captures the bytes on the wire [V].
4. **Maturity.** 118.5k stars and two well-known maintainers. Since the 1.0 slimming on 2026-10-01 ("the package now contains only `Agent`, the agent loop, the proxy stream, and their types"), the agent-core changelog has been additive only (`identity`, `durationMs`) [V CHANGELOG]. little-coder [V its README] and OpenClaw [V Pi README] build on Pi. oh-my-pi (37k stars) is Pi-based according to a Reddit comment [unverified].
5. **Pluggable.** "Pi stock" is the same `Agent` class with Pi's prompt and Pi's tool factories over our `Operations`, so the comparison against our minimal profile is apples to apples, with identical events. Any other harness (Pi in VM, AI SDK, mini-swe-agent) can sit behind a `HarnessAdapter` that emits Terrarium events [I].

Why not the bare loop first [I]: we'd re-implement streaming tool-call delta assembly, abort, steering, batching, argument validation, and provider quirks (reasoning fields, usage in streams). The `StreamFn` type is `(model, context, options) => AssistantMessageEventStream` [V `agent/src/types.ts`], and `createAssistantMessageEventStream()` is exported from pi-ai [V]. That means the runner-up can replace pi-ai's transport later, inside the recommendation, with no UI changes.

Why not libfx [V facts, I verdict]:
- v0.0.15, 11 weeks old, one maintainer with about 95% of commits.
- The loop is compiled Zig, so it can't be patched from JS.
- No text tool-call fallback.
- Its README mentions auxiliary "title-model calls", which would also hit the small local model.
- The design is good: an empty default prompt, rich hooks, and durability. Revisit in about 6 months.

Why not AI SDK as primary [I]:
- Its provider abstraction (LanguageModelV4) sits between us and the wire.
- Three majors in about a year.
- Text tool-call parsing depends on a 92-star solo package.
- It's still worth one comparison adapter, because bash-tool's `Sandbox` interface is three methods and just-bash plugs in directly [V].

---

## 6. Integration notes for the recommendation

### Packages (all pin exact versions)

| Package | Version | Published | Note |
|---|---|---|---|
| `@earendil-works/pi-agent-core` | 1.4.0 | 2026-10-21 [V npm] | Loop |
| `@earendil-works/pi-ai` | 1.4.0 | 2026-10-21 [V npm] | Transport; `openai-completions` API |
| `typebox` | whatever pi-agent-core resolves | | Tool schemas (`import { Type } from "typebox"`) [V README] |
| `@earendil-works/gondolin` | 0.14.0 | 2026-10-22 [V npm] | VM env |
| `just-bash` | 3.6.0 | [V npm] | Simulated env |
| `@earendil-works/pi-coding-agent` | 1.4.0 | optional, "Pi stock" profile only | Heavy: pulls provider SDKs such as `@aws-sdk/*` [V pnpm install path]. Load it lazily |

Node 22.19+ (Pi's stated requirement) [V README].

### Model + provider (pointed at our gateway, not oMLX)

```ts
import { Agent, type AgentTool, type StreamFn } from "@earendil-works/pi-agent-core";
import { createModels, createProvider, type Model } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { Type } from "typebox";

const model: Model<"openai-completions"> = {
  id: "qwen3.5-4b-4bit", name: "Qwen3.5 4B", api: "openai-completions", provider: "terrarium",
  baseUrl: "http://127.0.0.1:GATEWAY_PORT/v1",
  reasoning: false, input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 8192, maxTokens: 2048,
  compat: {
    supportsDeveloperRole: false, // otherwise reasoning models get role "developer" [V openai-completions.ts:1220]
    supportsStore: false,
    maxTokensField: "max_tokens",
    supportsStrictMode: false,
  },
};
const provider = createProvider({
  id: "terrarium", name: "Terrarium gateway", baseUrl: model.baseUrl,
  auth: { apiKey: { name: "none", resolve: async () => ({ auth: {} }) } }, // keyless local server [V README]
  models: [model], api: openAICompletionsApi(),
});
const models = createModels();
models.setProvider(provider);
```

All fields above come from pi-ai's README example and its compat interface [V]. Which compat flags oMLX actually needs is [I]: check them against the first gateway logs.

### The 4,096-token clamp (root cause of last time's cut-off replies) [V]

`pi-ai/src/api/simple-options.ts` contains:

```ts
const CONTEXT_SAFETY_TOKENS = 4096;
available = model.contextWindow - estimateContextTokens(context).tokens - CONTEXT_SAFETY_TOKENS;
maxTokens = Math.min(maxTokens, Math.max(1, available));
```

Every `streamSimple` call for `openai-completions` goes through this clamp [V `openai-completions.ts:726`].

What that means at 8,192 tokens [I, arithmetic]:
- With Pi's ~1.4K of prompt and tools, output is capped near 2.5K tokens on the first turn.
- The cap falls to **1 token** once the transcript passes about 4.1K.

Separately, Pi coding-agent's default compaction reserve (16,384) is bigger than the whole window. `shouldCompact` returns `contextTokens > contextWindow - reserveTokens` [V `compaction.ts:269`], so with defaults it's always true for an 8K model.

Fix [I, test first]: wrap `streamSimple` and cancel the margin, so our own budget decides output size.

```ts
const terrariumStream: StreamFn = (m, context, options) =>
  models.streamSimple(
    { ...m, contextWindow: m.contextWindow + 4096 },   // cancel pi-ai's fixed safety margin
    context,
    { ...options, maxTokens: outputBudget(m, context), onPayload: (p) => trace.payload(runId, p) },
  );
```

Alternative: call `models.stream()`, the non-simple path, with an explicit `maxTokens`. The clamp only lives in `buildBaseOptions`, which only the `streamSimple` paths use [V grep].

### Environments behind one interface [V APIs, I interface]

```ts
interface Env {
  id: string;
  exec(cmd: string, o: { signal?: AbortSignal; timeoutMs?: number; onData?: (s: string) => void }):
    Promise<{ exitCode: number; stdout: string; stderr: string }>;
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
}
```

- **Gondolin:**
  - Commands: `vm.exec(["/bin/bash", "-lc", cmd], { cwd: "/workspace", signal, stdout: "pipe", stderr: "pipe" })`. Stream output with `for await (const chunk of proc.output())`, then `await proc` for the exit code. This is the same code as `pi-gondolin.ts:116-160`.
  - Files: `vm.fs.readFile(p, { encoding: "utf8" })` and `vm.fs.writeFile(p, s)` [V docs/sdk-vm.md].
  - Note: `vm.exec("string")` runs `/bin/sh -lc`; the argv form doesn't search `$PATH` [V README].
- **just-bash:**
  - Setup: `const bash = new Bash({ cwd: "/workspace", files })`.
  - Commands: `await bash.exec(cmd)` returns `{ stdout, stderr, exitCode }`.
  - Files: `bash.fs` is an `IFileSystem` [V README, `Bash.ts:331`].
  - **Each `exec()` resets env vars, functions and cwd; only the filesystem persists** [V README]. The prompt says "each call starts a fresh shell" for both env types, so they behave the same.

### Tools

```ts
const bashTool = (env: Env): AgentTool => ({
  name: "bash", label: "bash",
  description: "Run a shell command in /workspace. Returns exit code, stdout and stderr (truncated to the last 200 lines).",
  parameters: Type.Object({ command: Type.String({ description: "The command to run" }) }),
  executionMode: "sequential",
  execute: async (_id, { command }, signal, onUpdate) => {
    const r = await env.exec(command, {
      signal,
      onData: (s) => onUpdate?.({ content: [{ type: "text", text: s }], details: {} }),
    });
    return { content: [{ type: "text", text: formatForModel(r) }], details: { exitCode: r.exitCode, raw: r } };
  },
});
```

- `details` is for the UI and never reaches the model [V README: "details" vs content].
- A non-zero exit is information, so return it as content. Throw only for harness failures such as a timeout or a dead VM. The README rule is "throw on failure" [V]; the exit-code split is [I].
- `read`, `write` and `edit` follow the same pattern. `edit` returns a unified diff in `details` for the file-change view [I].

### Agent + event capture

```ts
const agent = new Agent({
  initialState: {
    systemPrompt: TERRARIUM_PROMPT, model, thinkingLevel: "off",
    tools: [bashTool(env), readTool(env), writeTool(env), editTool(env)],
  },
  streamFn: withTextToolCallFallback(terrariumStream),
  toolExecution: "sequential",
  transformContext: compactFor(model),          // ours, see below
  beforeToolCall: async ({ toolCall }) => policy(toolCall),
  identity: { attribution: null },              // no Pi attribution headers [V README]
});
agent.subscribe((event) => trace.append(runId, event));
await agent.prompt(taskText);
```

- Events [V README]: `agent_start`, `turn_start`, `message_start`, `message_update` (streaming deltas), `message_end`, `tool_execution_start` (with `args`), `tool_execution_update`, `tool_execution_end` (with `result` and `durationMs`), `turn_end`, `agent_end`.
- Context meter: each `AssistantMessage.usage` has `input`, `output`, `cacheRead`, `cacheWrite` and optionally `reasoning` [V `pi-ai/src/types.ts:459`]. Use the server-reported `usage.input` as ground truth; `estimateContextTokens` is only an estimate [I].
- Prompt and tool changes: pi-agent-core keeps the system prompt and tool declarations **in the transcript as system messages**. Later changes are appended as patch messages [V README]. With `supportsMidConvoSystemMessages` false (the default), pi-ai folds them into the leading prompt [V compat docs]. The UI should show the request as sent (from `onPayload` or the gateway), not reconstruct it.

### Text tool-call fallback [V seam, I implementation]

- The loop reads `await response.result()` and filters `content` for `type === "toolCall"` [V `agent-loop.ts:268, 419`].
- The wrapper re-emits the stream. On the final message, if there are no `toolCall` blocks and the text contains `<tool_call>{"name":..,"arguments":..}</tool_call>`, convert it to `{ type: "toolCall", id, name, arguments }` and set `stopReason: "toolUse"` [V `ToolCall` and `StopReason` types]. Do the same for a fenced bash block when the profile uses the text protocol.
- Build the stream with `createAssistantMessageEventStream()` [V export].
- Emit a `harness_repair` trace event that holds both versions.

### Compaction for 8-12K windows [I]

- Output budget: `clamp(0.25 * window, 512, 2048)`. Compact when `lastUsage.input + budget > window - 256`.
- First, deterministic shrink with no model call: truncate old tool outputs to head and tail (about 20 lines each).
- Then drop the oldest turns. Keep the task message and the last N turns. Insert a harness note built from the trace, e.g. `[harness: 6 earlier steps removed; files changed: a.py, b.txt]`.
- Skip LLM summarization by default. 1-4B models summarize poorly, and it costs a model call.
- Log every compaction as a trace event with token counts before and after.
- Cap each tool result at about 1,500 tokens (head and tail) for 8K windows.

### "Pi stock" comparison profile

- `createBashTool("/workspace", { operations: gondolinBashOps(vm) })`, and the same for read, write and edit. This copies `pi-gondolin.ts` [V]. Factories are exported from the package root (`createBashTool`, `createCodingTools`, `create*ToolDefinition`) [V `index.ts`].
- `buildSystemPrompt` is **not** exported. The package `exports` map is only `"."` and `"./rpc-entry"` [V package.json].
  - Option 1: use `createAgentSession` (exported [V]) from Pi's SDK with custom tools.
  - Option 2: snapshot the 1.4.0 prompt text (Appendix A) and pin it to the version.
- Set compaction `modelOverrides` for 8K models, e.g. reserve 2,048 and keep-recent 3,000 [I values].

### "Pi in VM" profile (VM envs only) [I]

- Bake Node 22 and Pi into a Gondolin image.
- Run `pi --mode rpc` through `vm.exec` with piped stdin and stdout, and map its RPC events to Terrarium events.
- Point Pi's model `baseUrl` at the gateway, and allow only the gateway host in Gondolin's network policy.

---

## 7. Default system prompts

### Pi coding-agent 1.4.0 default (cwd `/workspace`, no AGENTS.md, no skills) [V dumped via `buildSystemPrompt` from the installed package]

804 tokens as dumped; 509 of them are the `<docs>` block, which is inflated by long pnpm install paths. Tool schemas (read/bash/edit/write as OpenAI JSON) add 605 more. Pass `customPrompt` and the prompt drops to about 300 plus tools [I].

```text
You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.

<tools>
- read: Read file contents
- bash: Execute bash commands (ls, grep, find, etc.)
- edit: Make precise file edits with exact text replacement, including multiple disjoint edits in one call
- write: Create or overwrite files

In addition to the tools above, you may have access to other custom tools depending on the project.
</tools>

<rules>
- Use bash for file operations like ls, rg, find
- Use read to examine files instead of cat or sed.
- You can inspect PI_* environment variables for current model and session details.
- Use edit for precise changes (edits[].oldText must match exactly)
- When changing multiple separate locations in one file, use one edit call with multiple entries in edits[] instead of multiple edit calls
- Each edits[].oldText is matched against the original file, not after earlier edits are applied. Do not emit overlapping or nested edits. Merge nearby changes into one edit.
- Keep edits[].oldText as small as possible while still being unique in the file. Do not pad with large unchanged regions.
- Use write only for new files or complete rewrites.
- Be concise in your responses
- Show file paths clearly when working with files
</rules>

<docs>
Pi documentation (read only when the user asks about pi itself, its SDK, extensions, themes, skills, or TUI):
- Main documentation: <install>/README.md
- Additional docs: <install>/docs
- Examples: <install>/examples (extensions, custom tools, SDK)
- (five more lines on which docs to read for which topic)
</docs>

<cwd>
/workspace
</cwd>
```

### Terrarium draft (125 tokens) [V counted]

```text
You are an agent working in a sandboxed Linux environment. Your working directory is /workspace.

Use tools to inspect files and run commands. Do not guess file contents.
- bash: run a shell command. Each call starts a fresh shell in /workspace.
- read: read a text file. Use offset and limit for long files.
- write: create or overwrite a file.
- edit: replace one exact piece of text in a file.

Call one tool at a time and check its output before the next step. Keep replies short. When the task is done, reply with a short summary and no tool call.
```

Tool schemas: 260 tokens for `bash(command)`, `read(path, offset?, limit?)`, `write(path, content)` and `edit(path, old_text, new_text)` [V counted]. The draft files are in `/tmp/terr-research/terr-prompt.txt` and `terr-tools.json` (temporary).

### Other measured prompts (Qwen3 tokens) [V]

| Prompt | Tokens |
|---|---|
| libfx default | 0 |
| fx CLI `src/builtins/system_prompt.md` | 1,175 |
| mini-swe-agent `mini.yaml` (all templates) | 1,292 |
| smolagents `toolcalling_agent.yaml` | 2,476 |
| Codex `codex-rs/models-manager/prompt.md` | 4,398 |
| Goose `tiny_model_system.md` | 839 bytes, about 200 tokens [I] |

---

## 8. Risks

1. **Pi moves fast.** Pi itself went from 1.0.0 to 1.4.0 in 20 days, and pi-ai internals change often. Pin exact versions and add a test that snapshots the request body for a fixed transcript [V release dates; I mitigation].
2. **pi-ai request shaping vs oMLX.** Watch the developer role, `store`, `stream_options`, session-affinity and `prompt_cache_key` fields, and attribution headers. Set `compat` and `identity`, then confirm in gateway logs [V that these fields exist; I that oMLX cares].
3. **The 4,096 clamp** needs the wrapper above [V cause, I fix].
4. **No text tool-call parsing upstream.** We own it [V].
5. **Upstream contribution policy.** "New issues and PRs from new contributors are auto-closed by default" [V Pi README]. Expect to carry patches in our wrapper rather than upstream them.
6. **Normalized events.** Pi events are post-normalization, and even `onProviderStreamEvent` "is not guaranteed to be the original HTTP bytes or SSE frame" [V pi-ai README]. The gateway has to be the source of truth for raw traffic.
7. **Patching Pi's prompt by string replacement breaks silently.** `pi-gondolin.ts` replaces `Current working directory: ...`, but Pi 1.4.0 renders `<cwd>` sections, so that replacement now does nothing [V by comparing the example with the dumped prompt]. Build our own prompt instead of patching Pi's.
8. **No self-extension in host mode.** Mitigated by the "Pi in VM" profile.
9. **just-bash limits.** About 80 commands and no persistent shell state, so small models will try commands that don't exist. Surface "command not found" clearly, and list the available commands in the env info panel [V README, I mitigation].
10. **Thin evidence below 9B.** Nothing published measures 1-4B models across harnesses. Terrarium's one-click evals should cover at minimum: native vs text tool-call format, minimal vs Pi-stock prompt, and compaction on vs off [I].

---

## 9. Sources (all checked 2026-10-28)

- Pi: https://github.com/earendil-works/pi (cloned at `c466a35`; `packages/agent`, `packages/ai`, `packages/coding-agent`, `packages/durable`, `packages/env`); npm `@earendil-works/pi-*` 1.4.0
- Gondolin: https://github.com/earendil-works/gondolin (`host/examples/pi-gondolin.ts`, `docs/sdk-vm.md`), npm 0.14.0
- fx / libfx: https://github.com/vercel-labs/fx (`sdk/README.md`, `src/builtins/system_prompt.md`, `src/napi_core_main.zig`), npm libfx 0.0.15
- just-bash: https://github.com/vercel-labs/just-bash (README "Integrations"), npm 3.6.0
- bash-tool: https://github.com/vercel-labs/bash-tool (`src/types.ts`), npm 1.3.19
- AI SDK: https://github.com/vercel/ai, npm `ai` 7.0.156 (`dist/index.d.ts`)
- @ai-sdk-tool/parser: https://github.com/minpeter/ai-sdk-tool-call-middleware
- mini-swe-agent: https://github.com/SWE-agent/mini-swe-agent
- smolagents: https://github.com/huggingface/smolagents
- OpenCode: https://github.com/anomalyco/opencode
- Goose: https://github.com/aaif-goose/goose (`crates/goose/src/prompts/tiny_model_system.md`, `providers/toolshim.rs`)
- Qwen Code: https://github.com/QwenLM/qwen-code; Qwen-Agent: https://github.com/QwenLM/Qwen-Agent
- Hermes Agent: https://github.com/NousResearch/hermes-agent; docs: https://hermes-agent.nousresearch.com/docs/guides/local-ollama-setup
- Codex: https://github.com/openai/codex
- DeepSeek Harness: https://github.com/deepseek-ai/deepseek-harness
- little-coder: https://github.com/itayinbarr/little-coder; blog: https://itayinbarr.substack.com/p/honey-i-shrunk-the-coding-agent (2026-04-19)
- Reddit (read via browser): https://www.reddit.com/r/LocalLLaMA/comments/1wy5bmy/ (2026-10-05), https://www.reddit.com/r/LocalLLaMA/comments/1vpcj2j/ (2026-08-15), https://www.reddit.com/r/LocalLLaMA/comments/1w8f7bp/ (2026-09-05)
- NLT replication: https://arxiv.org/abs/2607.03953 (2026-07-04)
- Programmatic tool calling: https://arxiv.org/abs/2608.06370 (2026-08-06)
- Terminal-Bench harness gaps: https://codex.danielvaughan.com/2026/04/09/harness-performance-terminal-bench/ (2026-04-09, updated 2026-10-28)
