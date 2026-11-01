# Terrarium design

Terrarium is a Mac app for running small local LLMs as agents in environments they cannot escape, while
seeing everything they do. Research behind every choice here: `research/harness.md`,
`research/models-inference.md`, `research/sandbox-app.md`. Read the relevant one before building a part.

## Product rules (from what failed last time)

1. **Show data, not descriptions.** No subtitles under headings, no explanatory paragraphs, no static
   diagrams. If something needs explaining, the UI shows the fact (a value, a state, a log line) and,
   at most, a tooltip that defines a term. Empty states: one short line plus the action button. One
   exception: an empty session shows its model, harness and environment with one line each on what that
   part does, because that split is what new users miss.
2. **Everything the model saw and did is inspectable**: the exact request JSON sent to the server, the
   exact response, finish reason, token usage, timings, every tool call with streamed stdout/stderr,
   exit code and duration, every file change as a diff, every network attempt (allowed and denied).
3. **The environment is concrete.** The UI states what it is in facts: "Linux micro-VM (Gondolin/krun),
   Alpine 3.x, kernel 6.x, 2 vCPU, 1024 MiB, /workspace on VM disk, user agent (uid 1000), network off,
   no Mac folders mounted", or "Simulated shell (just-bash 3.6): not a real OS, in-memory filesystem,
   N commands, Python (WASM) on/off". Gathered from the env itself, not hard-coded prose.
4. **Every visible control works.** No decorative labels that look clickable. The model is chosen from
   a real picker anywhere a model is shown.
5. **Truncation is never silent.** `finish_reason: length` produces a visible warning with the numbers
   (context window, prompt tokens, output cap) and a one-click Continue. A context meter is always
   visible while composing.
6. **Live visualization means live data**: a run timeline that grows as the agent works, a memory bar
   that moves, a file tree that updates. Not a picture of the architecture.

## Architecture

```
Tauri 2 shell (Rust) ── spawns ──> Node 24 backend (127.0.0.1:random, bearer token)
      │                                 │
   WKWebView UI <── HTTP + 1 WebSocket ─┘
                                        ├─ Harness runner (pi-agent-core 1.4.0, our prompt + 4 tools)
                                        ├─ Model gateway (logging HTTP proxy) ──> oMLX 0.7.2 on 127.0.0.1:8010 (API key)
                                        ├─ Env manager (state machine; max 2 running VMs)
                                        │    ├─ VM envs: Gondolin 0.14 (krun, QEMU fallback), in-process SDK
                                        │    └─ Sim envs: just-bash 3.6 in a child process under sandbox-exec
                                        ├─ Policy engine (off | registries | web), one module, one log, both env types
                                        ├─ Observer (per-tool-call manifest diff -> fs_change events)
                                        ├─ Trace store (node:sqlite + content-addressed blob dir)
                                        └─ Eval runner (suites -> sessions in disposable forks)
```

Key decisions:
- **Harness runs on the host.** The model never gets a network route to the Mac; VM network can be truly
  off. One harness and one trace format for both env types.
- **Model gateway is a logging proxy** inside the backend: pi-ai's `baseUrl` points at
  `http://127.0.0.1:<gw>/s/<sessionId>/v1`, the proxy records the exact request bytes and the exact
  (streamed) response, then forwards to oMLX. Works for any harness, including future ones.
- **Cancel pi-ai's 4,096-token safety clamp** (research/harness.md "The 4,096-token clamp"). Our own
  budget decides output size. This was the root cause of last time's one-token replies.
- **Workspace lives on the VM disk** (fast, included in snapshots). A root-owned observer helper in the
  guest produces a manifest before/after each tool call; the backend fetches changed files via
  `vm.fs.readFile` (guest-resolved paths; the host never follows guest symlinks on the Mac). Agent
  commands run as uid 1000 `agent`.
- **just-bash env**: one child process per env, JSON over stdio, `sandbox-exec` profile (deny network,
  deny file writes, deny home reads except app code + node). `InMemoryFs` wrapped in a recording proxy
  gives exact diffs. Network goes through a custom `fetch` that RPCs to the backend policy engine.
  Snapshot = serialize paths/stat/contents (34 ms per 1.2k files).
- **Network policy** shared by both env types: `off` (default), `registries` (GET/HEAD to a fixed host
  list: pypi, files.pythonhosted.org, npm, github/codeload/objects/raw/release-assets, alpine CDN), `web`
  (public HTTP/HTTPS). Internal, loopback, link-local and private ranges are denied in every mode. Every
  decision is logged (allowed too), switchable while running.
- **No oMLX admin UI exposed.** Keep oMLX on loopback with a key; never use its code-executing
  benchmarks. Any eval that executes model output runs inside an environment; model-written code never
  runs as root or as the uid that can read hidden tests.
- **Nothing starts at login.** Quitting the app stops VMs, the backend and oMLX. Closing the window hides it.

## Repo layout (pnpm workspace)

```
apps/backend/      Node 24 TypeScript (erasable syntax only; run with node type stripping in dev, tsc build for prod)
  src/main.ts            HTTP + WS server, auth, handshake line {"port":N} on stdout
  src/store/             SQLite schema + blob store
  src/inference/         oMLX process manager, admin client, logging gateway, memory estimates
  src/harness/           pi-agent-core wiring, tools, compaction, text tool-call fallback, profiles
  src/envs/              EnvManager + Env interface
  src/envs/vm/           Gondolin adapter, image build config, observer integration
  src/envs/sim/          just-bash child process host + worker + sandbox profile
  src/policy/            network policy engine
  src/evals/             runner + graders
apps/ui/           Vite + React 19 + TypeScript
packages/shared/   API + event types (types only; import with `import type`)
guest/             Gondolin image config, observer helper source
evals/suites/      suite definitions (JSON) + fixtures
src-tauri/         Tauri 2 shell
models/            MLX model dirs (gitignored)
data/              runtime state: sqlite, blobs, env disks, snapshots (gitignored)
research/          research reports
```

The contract between backend and UI is `packages/shared/src/index.ts`. Change it only by editing that
file and updating both sides.

## Data model (SQLite, `data/terrarium.db`)

- `envs`: id, name, type (`vm`|`sim`), status, network, parent_env_id, base_snapshot_id, config_json,
  facts_json (EnvFacts gathered from the env), created_at
- `snapshots`: id, env_id, label, kind (`factory`|`manual`|`auto`), bytes, created_at, storage path
- `sessions`: id, env_id (null for chat-only), title, model_id, harness, context_window, max_output_tokens,
  status, eval_run_id, eval_case_id, created_at
- `events`: session_id, seq, ts, type, payload_json (TraceEvent minus streamed-only types)
- `model_calls`: id, session_id, seq, request_blob, response_blob, finish_reason, usage_json, timing_json
- `manifests`: env_id, session_id, seq, blob (workspace manifest after a tool call; enables time travel)
- `net_log`: env_id, session_id, ts, method, url, host, decision, reason, status, bytes
- `eval_runs`, `eval_results`: run config; per (case, model) result with session_id, pass, score, detail
- Blobs: `data/blobs/<sha256[0:2]>/<sha256>`; text diffs and raw payloads stored as blobs.

## API (all routes need `Authorization: Bearer <token>`; exact Host and Origin checks)

REST (JSON):
- `GET /api/state` → `AppState` (envs, sessions, models, inference status, budget)
- Envs: `POST /api/envs` (CreateEnvRequest) · `PATCH /api/envs/:id` (name, network) ·
  `POST /api/envs/:id/{start,stop,reset,snapshot,fork}` · `DELETE /api/envs/:id` ·
  `GET /api/envs/:id/snapshots` · `GET /api/envs/:id/tree?at=<seq>&sessionId=` ·
  `GET /api/envs/:id/file?path=&at=&sessionId=` · `POST /api/envs/:id/exec` (user shell command; logged
  as `user_exec` on the env, never shown to the model) · `GET /api/envs/:id/net?limit=`
- Sessions: `POST /api/sessions` · `PATCH /api/sessions/:id` (model, context, title) ·
  `GET /api/sessions/:id/events?after=<seq>` · `POST /api/sessions/:id/messages` ·
  `POST /api/sessions/:id/continue` · `POST /api/sessions/:id/retry` (send the latest message again when it got no
  reply) · `POST /api/sessions/:id/stop` · `DELETE /api/sessions/:id`
- Model calls: `GET /api/model-calls/:id` → full request + response JSON
- Blobs: `GET /api/blobs/:sha256`
- Models/inference: `GET /api/models` · `POST /api/models/:id/{load,unload}` ·
  `PATCH /api/models/:id` (default context, sampling) · `POST /api/inference/{start,stop}`
- Evals: `GET /api/evals/suites` · `POST /api/evals/runs` · `GET /api/evals/runs` ·
  `GET /api/evals/runs/:id` · `POST /api/evals/runs/:id/stop`

WebSocket `/api/ws` (token in `Sec-WebSocket-Protocol: terrarium.<token>`): server pushes `WsMessage`s;
client sends `{type:"subscribe", sessionIds:[...]}`. Topics: trace events (incl. streamed deltas and tool
output chunks), env updates, model/inference updates, resource samples (1 Hz), eval progress.

## Harness profiles

- `terrarium` (default): pi-agent-core Agent, our ~125-token prompt, tools `bash`, `read`, `write`, `edit`;
  sequential tool execution; text tool-call fallback (`<tool_call>` JSON, fenced bash) with a
  `harness_repair` event; deterministic compaction (truncate old tool output, then drop oldest turns
  with a harness note); output budget `clamp(0.25*window, 512, 4096)`, raised for thinking models.
- `pi-stock`: Pi coding-agent's own tools and pinned 1.4.0 prompt, routed into our envs (comparison).
- `chat`: no tools, no env needed.

Thinking: per session toggle (`enable_thinking` via `chat_template_kwargs`), thinking text shown
collapsed in the transcript. Sampling defaults per family from research/models-inference.md.

## Models

oMLX 0.7.2 installed into `.venv` (Python 3.13) from the GitHub release wheel, pinned. Model dir
`models/`. Starter lineup: Qwen3.5-4B 4bit, Qwen3.5-9B 4bit, Gemma 4 12B-it 4bit, Ternary-Bonsai-2-27B
2bit, Ternary-Bonsai-2-9B 2bit, Ternary-Bonsai-2-2B 2bit. Memory estimate per model per context:
`weights + ctx * kvBytesPerToken + fixed + ~1 GB`; KV numbers in research/models-inference.md §3.
Budget default 12 GB (setting). The picker shows, for every model: size, loaded state, estimate at the
session's context, and whether it fits the current free memory.

## Evals

Suites are JSON in `evals/suites/`. A case: id, title, prompt, setup files, env type (`sim`|`vm`|`none`),
max turns, timeout, and a check: `answer` (exact/regex/number/choice), `file` (path + contains/equals),
`command` (after every agent process is killed, runs in /workspace as the agent uid with a clean PATH and
an empty HOME, never as root and never as a uid that can read `/grader`; pass on exit 0, so it can't be
trusted to judge code it runs), or `tests` (VM only: hidden unittest file in `/grader`, graded twice by
the guest grader: isolated, with candidate code as the agent uid and the tests as the grader uid in
separate processes, then plain in-process unittest as the agent uid; the tests read the candidate's source
from a root-owned copy without symlinks, taken before candidate code runs; pass only when both runs pass
every counted test; runs that disagree are a grader error, shown with both runs' results). Candidate code can
forge the plain run, so the isolated run must be sound: it never reports a pass the same tests would not give
the same code in one process. It answers where it reproduces Python exactly (containers linked both ways,
by-value objects keeping their identity across calls, stand-in classes with the candidate's MRO, real
functions, generators, coroutines and modules standing for the candidate's and kept in sync both ways,
process state mirrored both ways: streams, argv, environment, working directory, umask, locale, time zone,
logger levels and quiet handlers, random, decimal, warnings, the tests' `sys.path` and standard-library
assignments, settings CPython keeps in C) and raises a grader error where it can't (state one process can't
share, introspection of the other half: refcounts, referrers, frames, the tests looking at workspace files
candidate code changed in its own copy), and a run in which code caught a grader error can't pass; a forged
plain run can then only turn a fail into a disagreement. Per-message work scales with what changed, not with
what either side holds (except candidate-held functions the tests have stand-ins for: about 1.3 us each).
guest/README.md lists the remaining differences that make it stricter and the known
gaps where it can still pass code one process fails (raw `is` on values that arrive as new objects, some
workspace and standard-library state routes; qa/review6-cases checks both). Every case runs as a
normal session in a disposable fork, so clicking any result opens the full transcript, files and raw
requests. One click runs a suite across selected models. Built-in suites: tool basics (sim), shell data
tasks (sim), coding with tests (vm), chat reasoning/knowledge sample (none), isolation probes (vm+sim,
pass = escape blocked, verified from net log/host facts), speed (tokens/s prefill and decode).
Dataset-backed suites (GSM8K, MMLU, HumanEval, MBPP) with a sample size selector; datasets downloaded to
`data/datasets/` on first use; code ones execute in a VM only.

## UI

Dense desktop dev-tool feel (think Xcode / Linear / Chrome DevTools), not a marketing dashboard.
Light and dark. UI font: system (SF Pro). Data font: SF Mono / JetBrains Mono. One accent color;
semantic colors for status (running, error, denied) and tool kinds.

Layout: left sidebar, main pane, right inspector (resizable, collapsible).

**Top bar**: memory bar (live, 1 Hz): system used vs free, with segments for oMLX (weights + KV), each
running VM, backend, and the budget line. Inference status (stopped/starting/ready) with start/stop.

**Sidebar**: Environments (each: name, VM/SIM chip, status dot, network icon; expand to its sessions;
"New enclosure" and "New chat" actions; the UI calls an environment an enclosure), Evals, Models.

**Session view (main pane)**:
- Header: env chip (click opens Environment inspector), **model picker**, harness picker, thinking
  toggle, network mode switch (for the env).
- **Run timeline** (live, horizontal, zoomable): lanes for Model calls (bar = duration, split prefill vs
  generation, label tokens), Tools (bar per call, colored by tool, red on non-zero exit), Files (ticks
  per change), Network (ticks, red when denied). Click selects the event in transcript + inspector.
- **Transcript**: user messages; assistant text (markdown, escaped, no raw HTML); thinking collapsed;
  tool call blocks showing command/args, live stdout/stderr, exit code, duration, "3 files changed";
  harness events (compaction, repair) as compact rows; warnings (truncation) prominent with Continue.
  Each model call row has a "Request" affordance that opens the raw request/response.
- **Composer**: text box, context meter (stacked bar: system+tools / history / output reserve / free,
  with token numbers), send, stop.

**Inspector tabs** (follow the selection):
- *Files*: live tree of `/workspace` with change badges; file viewer; diff for the selected tool call;
  a step scrubber to view the workspace at any step of the session.
- *Request*: exact request JSON (messages, tools, params) and response (finish_reason, usage, timings),
  with a readable view and a raw view, copy buttons.
- *Network*: log table (time, method, URL, decision, reason, status, bytes) with filters.
- *Environment*: EnvFacts as a key-value list, snapshots list (create/restore/fork from), actions
  (start/stop/reset/fork/delete), resource sparklines (RSS, CPU).
- *Shell*: run your own commands in the env (as `agent` or `root`), labeled as yours.

**Evals view**: suites list with case counts; run config (models multi-select, harness, sample size);
results matrix (rows = cases, columns = models; pass/fail/error cells with duration); totals row;
click a cell to open that case's session; case definition (prompt, setup files, check) visible.

**Models view**: table (name, family, params, quant, disk, tool format, loaded, context default,
memory estimate at that context), load/unload, edit defaults.
