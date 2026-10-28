# TODO_1: Terrarium (local model playground, rebuild of local_llms)

Date: 2026-10-28
Session: 4d7fa632-b05e-4dbb-857c-d7d9f81d874f (T3 thread 2f9ddd9e-65f4-42e4-9a56-0b40299173e2)

## Goal
Run small local models as agents in environments they can't escape, and see everything they do:
full transcripts, raw model requests/responses, every tool call and its output, the workspace's files and
how they changed, context usage. Create, reset, fork environments. Pick models freely. One-click evals that
open as normal transcripts.

Replaces ~/PRIMARY/Projects/local_llms (GPT Sol build, Oct 13-16, thread e1456805). Keep its downloaded
models (9.2 GB: Qwen3.5-4B 4bit, Ternary-Bonsai-2 2B/4B/9B 2bit), drop its dashboard and glue code.

## User decisions (2026-10-28)
- App form: Mac app (Tauri) with a web UI inside
- Environments: both real Linux micro-VMs and simulated just-bash environments, clearly labeled
- Network: off by default; per-environment toggle (package registries only, or full public web)
- Harness: I pick after research

## What went wrong last time (do not repeat)
- UI showed prose summaries and a static mermaid chart instead of the actual data
- Workspace contents invisible; unclear what kind of environment the agent was in
- Replies cut off: 8K context vs Pi's 4K reserve; "fixed" minimally
- No model picker (model name hard-coded in a corner, not clickable)
- Evals one click but opaque (couldn't see cases, outputs, what the agent did)
- Lots of filler subtitle text everywhere

## TODO
- [ ] Research: harness, models + inference server, sandbox/app tech (3 parallel Opus agents)
- [ ] Architecture + UI design doc
- [ ] Build backend: inference gateway with full request logging, env manager (VM + just-bash), harness runner, trace store
- [ ] Build UI: environments, live transcript + raw trace, workspace file tree + diffs, model picker, context meter, evals
- [ ] Tauri app shell + launch
- [ ] QA: independent review agents (design + correctness + security), fix
- [ ] Switchboard entry, UTILITIES.md entry, retire local_llms

## Decisions and why

## Hurdles / fixes
