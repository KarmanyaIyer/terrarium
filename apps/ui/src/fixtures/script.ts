// Builds timed, realistic trace events for fixture sessions. Times are ms offsets from session start;
// FixtureBackend turns them into wall-clock `ts` when it plays them.

import type {
  ContextUsage,
  FileChange,
  FinishReason,
  ModelCallDetail,
  NetEntry,
  ToolCallRef,
  TraceEvent,
} from "@terrarium/shared";
import { unifiedDiff } from "../lib/diff";
import { TOOLS_SCHEMA } from "./data";
import { tokensOf } from "../lib/tokens";

type Body<T extends TraceEvent["type"]> = Omit<Extract<TraceEvent, { type: T }>, "sessionId" | "seq" | "ts">;
type AnyBody = { [K in TraceEvent["type"]]: Body<K> }[TraceEvent["type"]];

export interface Step {
  at: number;
  body: AnyBody;
  parent?: string; // callId/toolCallId whose seq a streamed event reuses
  key?: string; // callId/toolCallId this persisted event introduces
  seq: number; // assigned in finalize()
  effects?: {
    files?: { path: string; content: string | null }[];
    blobs?: Record<string, string>;
  };
}

export interface CallDetailDraft {
  callId: string;
  at: number;
  detail: Omit<ModelCallDetail, "sessionId" | "seq">;
}

export interface Built {
  steps: Step[];
  calls: CallDetailDraft[];
  marks: Record<string, number>;
  duration: number;
  blobs: Record<string, string>;
  lastSeq: number;
}

export interface CallSpec {
  prompt: number;
  cached?: number;
  thinking?: string;
  text?: string;
  tool?: { name: string; args: Record<string, unknown> };
  finish?: FinishReason;
  ttftMs?: number;
  genTps?: number;
  /** Raw content when the model wrote a tool call as text (harness repairs it). */
  repairFrom?: string;
  error?: string;
}

export interface ToolSpec {
  out?: { dt: number; stream?: "stdout" | "stderr"; text: string }[];
  exit?: number;
  isError?: boolean;
  duration: number;
  result?: string;
  files?: { path: string; content: string | null }[];
  net?: { dt: number; method?: string; url: string; decision: "allow" | "deny"; reason: string; status?: number; bytesIn?: number }[];
}

let idCounter = 0;
export function fid(prefix: string): string {
  idCounter++;
  const r = (Math.imul(idCounter, 2654435761) >>> 0).toString(36);
  return `${prefix}_${r}${idCounter.toString(36)}`;
}

export function fakeSha(text: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x9e3779b9;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 16777619);
    h2 = Math.imul(h2 ^ c, 2246822507);
  }
  let out = "";
  for (let i = 0; i < 8; i++) {
    h1 = Math.imul(h1 ^ (h1 >>> 15), 2246822507) ^ h2;
    h2 = Math.imul(h2 ^ (h2 >>> 13), 3266489909) ^ h1;
    out += (h1 >>> 0).toString(16).padStart(8, "0");
  }
  return out.slice(0, 64);
}


interface ScriptOpts {
  sessionId: string;
  envId: string | null;
  modelId: string;
  window: number;
  maxOut: number;
  system: string;
  thinking: boolean;
  sampling: { temperature: number; topP: number; topK?: number; presencePenalty?: number };
  tools?: boolean;
  files?: Record<string, string>;
  systemAndTools?: number;
}

export class Script {
  t = 0;
  turn = 0;
  steps: Step[] = [];
  calls: CallDetailDraft[] = [];
  marks: Record<string, number> = {};
  blobs: Record<string, string> = {};
  messages: Record<string, unknown>[] = [];
  files: Map<string, string>;
  o: ScriptOpts;
  private lastPrompt = 0;
  private pendingTool: { id: string; name: string; args: Record<string, unknown>; callId: string } | null = null;

  constructor(o: ScriptOpts) {
    this.o = o;
    this.files = new Map(Object.entries(o.files ?? {}));
    this.messages.push({ role: "system", content: o.system });
  }

  private push(at: number, body: AnyBody, extra: Partial<Step> = {}) {
    this.steps.push({ at, body, seq: 0, ...extra });
  }

  mark(name: string) {
    this.marks[name] = this.t;
    return this;
  }

  wait(ms: number) {
    this.t += ms;
    return this;
  }

  user(text: string) {
    this.push(this.t, { type: "user_message", text });
    this.messages.push({ role: "user", content: text });
    this.t += 120;
    return this;
  }

  private ctx(prompt: number): ContextUsage {
    const sys = this.o.systemAndTools ?? (this.o.tools === false ? tokensOf(this.o.system) : 612);
    const reserve = this.o.maxOut;
    return {
      window: this.o.window,
      systemAndTools: sys,
      history: Math.max(0, prompt - sys),
      outputReserve: reserve,
      free: Math.max(0, this.o.window - prompt - reserve),
      source: "server",
    };
  }

  /** One model call. Returns the tool call id when the model calls a tool. */
  call(spec: CallSpec): string | null {
    this.turn++;
    const callId = fid("mc");
    const ttft = spec.ttftMs ?? 600 + spec.prompt * 0.25;
    const tps = spec.genTps ?? 21.4;
    this.push(this.t, { type: "turn_start", turn: this.turn });
    this.push(
      this.t,
      {
        type: "model_call_start",
        callId,
        turn: this.turn,
        modelId: this.o.modelId,
        promptTokensEst: spec.prompt,
        contextWindow: this.o.window,
        maxTokens: this.o.maxOut,
      },
      { key: callId },
    );

    const request = {
      model: this.o.modelId,
      messages: JSON.parse(JSON.stringify(this.messages)) as unknown,
      ...(this.o.tools === false ? {} : { tools: TOOLS_SCHEMA, tool_choice: "auto" }),
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: this.o.maxOut,
      temperature: this.o.sampling.temperature,
      top_p: this.o.sampling.topP,
      ...(this.o.sampling.topK != null ? { top_k: this.o.sampling.topK } : {}),
      ...(this.o.sampling.presencePenalty != null ? { presence_penalty: this.o.sampling.presencePenalty } : {}),
      chat_template_kwargs: { enable_thinking: this.o.thinking },
    };

    let at = this.t + ttft;
    const step = 1000 / tps;
    let completion = 0;
    let reasoning = 0;
    const stream = (kind: "thinking" | "text" | "toolcall", s: string) => {
      // two tokens (~8 chars) per delta event
      for (let i = 0; i < s.length; i += 8) {
        const piece = s.slice(i, i + 8);
        this.push(at, { type: "model_delta", callId, kind, delta: piece }, { parent: callId });
        const toks = piece.length / 3.8;
        completion += toks;
        if (kind === "thinking") reasoning += toks;
        at += step * toks;
      }
    };
    if (spec.thinking) stream("thinking", spec.thinking);
    if (spec.repairFrom) stream("text", spec.repairFrom);
    else if (spec.text) stream("text", spec.text);
    let toolCalls: ToolCallRef[] = [];
    let toolId: string | null = null;
    if (spec.tool && !spec.repairFrom) {
      const argsText = JSON.stringify(spec.tool.args);
      stream("toolcall", argsText);
      completion += 6;
    }
    if (spec.tool) {
      toolId = fid("call");
      toolCalls = [{ id: toolId, name: spec.tool.name, args: spec.tool.args }];
    }

    const end = Math.max(at, this.t + ttft + 120);
    const finish: FinishReason = spec.finish ?? (spec.error ? "error" : spec.tool ? "tool_calls" : "stop");
    const completionTokens = finish === "length" ? this.o.maxOut : Math.round(completion);
    const reasoningTokens = finish === "length" && spec.thinking && !spec.text ? this.o.maxOut : Math.round(reasoning);
    const usage = {
      promptTokens: spec.prompt,
      completionTokens,
      cachedTokens: spec.cached,
      reasoningTokens: spec.thinking ? reasoningTokens : undefined,
    };
    const timing = {
      ttftMs: Math.round(ttft),
      totalMs: Math.round(end - this.t),
      promptTps: Math.round(((spec.prompt - (spec.cached ?? 0)) / ttft) * 1000),
      genTps: Math.round(tps * 10) / 10,
    };
    this.push(end, {
      type: "model_call_end",
      callId,
      finishReason: finish,
      usage: spec.error ? undefined : usage,
      timing,
      error: spec.error,
    });

    if (!spec.error) {
      const text = spec.repairFrom ?? spec.text ?? "";
      this.push(end + 2, {
        type: "assistant_message",
        callId,
        text,
        thinking: spec.thinking,
        toolCalls,
      });
      if (spec.repairFrom && spec.tool) {
        this.push(end + 4, {
          type: "harness_repair",
          callId,
          original: spec.repairFrom,
          repaired: toolCalls,
          reason: "no native tool call; fenced bash block parsed as a bash call",
        });
      }
      this.push(end + 6, { type: "context", usage: this.ctx(spec.prompt + completionTokens) });
    }
    this.lastPrompt = spec.prompt;

    const message: Record<string, unknown> = {
      role: "assistant",
      content: spec.repairFrom ?? spec.text ?? "",
    };
    if (spec.thinking) message.reasoning_content = spec.thinking;
    if (toolCalls.length)
      message.tool_calls = toolCalls.map((tc) => ({
        id: tc.id,
        type: "function",
        function: { name: tc.name, arguments: JSON.stringify(tc.args) },
      }));
    const response = {
      id: `chatcmpl-${callId.slice(3)}`,
      object: "chat.completion",
      created: 0,
      model: this.o.modelId,
      choices: [
        {
          index: 0,
          message: spec.repairFrom
            ? { role: "assistant", content: spec.repairFrom, ...(spec.thinking ? { reasoning_content: spec.thinking } : {}) }
            : message,
          finish_reason: finish === "tool_calls" && spec.repairFrom ? "stop" : finish,
        },
      ],
      usage: spec.error
        ? undefined
        : {
            prompt_tokens: spec.prompt,
            completion_tokens: completionTokens,
            total_tokens: spec.prompt + completionTokens,
            prompt_tokens_details: { cached_tokens: spec.cached ?? 0 },
            completion_tokens_details: spec.thinking ? { reasoning_tokens: reasoningTokens } : undefined,
            ttft_ms: timing.ttftMs,
            prompt_tps: timing.promptTps,
            generation_tps: timing.genTps,
          },
      ...(spec.error ? { error: { message: spec.error } } : {}),
    };
    this.calls.push({
      callId,
      at: this.t,
      detail: {
        id: callId,
        modelId: this.o.modelId,
        request,
        response,
        rawResponseBlob: undefined,
        finishReason: finish,
        usage: spec.error ? undefined : usage,
        timing,
        contextWindow: this.o.window,
        maxTokens: this.o.maxOut,
      },
    });
    if (!spec.error) this.messages.push(message);
    if (toolId && spec.tool) this.pendingTool = { id: toolId, name: spec.tool.name, args: spec.tool.args, callId };
    this.t = end + 40;
    return toolId;
  }

  /** Runs the tool the last call asked for. */
  tool(spec: ToolSpec) {
    const p = this.pendingTool;
    if (!p) throw new Error("tool() without a pending tool call");
    this.pendingTool = null;
    const t0 = this.t;
    this.push(t0, { type: "tool_start", toolCallId: p.id, callId: p.callId, name: p.name, args: p.args }, { key: p.id });
    let stdout = "";
    let stderr = "";
    for (const o of spec.out ?? []) {
      const stream = o.stream ?? "stdout";
      this.push(t0 + o.dt, { type: "tool_output", toolCallId: p.id, stream, chunk: o.text }, { parent: p.id });
      if (stream === "stdout") stdout += o.text;
      else stderr += o.text;
    }
    for (const n of spec.net ?? []) {
      const u = new URL(n.url);
      const entry: NetEntry = {
        id: fid("net"),
        envId: this.o.envId ?? "",
        sessionId: this.o.sessionId,
        ts: 0,
        method: n.method ?? "GET",
        url: n.url,
        host: u.hostname,
        ip: n.decision === "allow" ? "151.101.0.223" : undefined,
        decision: n.decision,
        reason: n.reason,
        status: n.status,
        bytesIn: n.bytesIn,
        bytesOut: n.decision === "allow" ? 412 : 0,
      };
      this.push(t0 + n.dt, { type: "net", entry });
    }

    const changes: FileChange[] = [];
    const blobs: Record<string, string> = {};
    for (const f of spec.files ?? []) {
      const before = this.files.get(f.path);
      const after = f.content;
      const diff = unifiedDiff(before ?? "", after ?? "", f.path) ?? "";
      const sha = fakeSha(diff);
      blobs[sha] = diff;
      this.blobs[sha] = diff;
      changes.push({
        path: f.path,
        kind: before == null ? "added" : after == null ? "deleted" : "modified",
        before: before == null ? undefined : { sha256: fakeSha(before), size: before.length, mode: 0o644, type: "file" },
        after: after == null ? undefined : { sha256: fakeSha(after), size: after.length, mode: 0o644, type: "file" },
        diffBlob: sha,
      });
      if (after == null) this.files.delete(f.path);
      else this.files.set(f.path, after);
    }

    const end = t0 + spec.duration;
    const exit = spec.exit ?? (p.name === "bash" ? 0 : undefined);
    const result =
      spec.result ??
      (p.name === "bash"
        ? `${stdout}${stderr ? (stdout ? "\n" : "") + stderr : ""}${exit ? `\n[exit code ${exit}]` : ""}`.trim() || "(no output)"
        : stdout || "(no output)");
    this.push(end, {
      type: "tool_end",
      toolCallId: p.id,
      name: p.name,
      exitCode: exit,
      durationMs: spec.duration,
      stdout,
      stderr,
      outputTruncated: false,
      resultForModel: result,
      isError: spec.isError ?? (exit != null && exit !== 0),
      fileChanges: changes.length,
    });
    if (changes.length)
      this.push(end + 4, { type: "fs_change", toolCallId: p.id, changes }, { effects: { files: spec.files, blobs } });
    this.messages.push({ role: "tool", tool_call_id: p.id, content: result });
    this.t = end + 60;
    return this;
  }

  event(body: AnyBody, dt = 20) {
    this.push(this.t, body);
    this.t += dt;
    return this;
  }

  runEnd(reason: "done" | "stopped" | "max_turns" | "error" | "length") {
    this.push(this.t, { type: "run_end", reason });
    this.t += 10;
    return this;
  }

  get prompt() {
    return this.lastPrompt;
  }

  /** Sorts by time and assigns seqs; streamed events reuse their parent's seq. */
  finalize(startSeq = 0): Built {
    const steps = this.steps.map((s, i) => ({ s, i })).sort((a, b) => a.s.at - b.s.at || a.i - b.i).map((x) => x.s);
    const parentSeq = new Map<string, number>();
    let seq = startSeq;
    for (const s of steps) {
      if (s.parent) {
        s.seq = parentSeq.get(s.parent) ?? seq;
      } else {
        s.seq = ++seq;
        if (s.key) parentSeq.set(s.key, s.seq);
      }
    }
    for (const c of this.calls) {
      const cs = parentSeq.get(c.callId);
      if (cs != null) (c.detail as unknown as { seq: number }).seq = cs;
    }
    return { steps, calls: this.calls, marks: this.marks, duration: this.t, blobs: this.blobs, lastSeq: seq };
  }
}
