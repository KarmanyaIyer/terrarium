// Incremental parser for OpenAI chat-completions SSE streams. Assembles the final response the way a
// non-streamed call would have returned it, and reports per-chunk deltas for live display.

export interface SseDelta {
  kind: "text" | "thinking" | "toolcall";
  delta: string;
}

interface ToolCallAcc {
  index: number;
  id?: string;
  type: string;
  function: { name: string; arguments: string };
}

export class SseAssembler {
  private buf = "";
  raw = "";
  id?: string;
  model?: string;
  created?: number;
  content = "";
  reasoning = "";
  toolCalls = new Map<number, ToolCallAcc>();
  finishReason: string | null = null;
  /** An error event in the stream (oMLX or the Lab report a failure after the 200 headers this way). */
  error: string | null = null;
  usage: Record<string, any> | null = null;
  done = false;
  firstTokenAt: number | null = null;
  chunks = 0;
  parseErrors = 0;

  /** Feed raw text; returns deltas found in complete events. */
  push(text: string, now = Date.now()): SseDelta[] {
    this.raw += text;
    this.buf += text;
    const out: SseDelta[] = [];
    for (;;) {
      const m = /\r?\n\r?\n/.exec(this.buf);
      if (!m) break;
      const block = this.buf.slice(0, m.index);
      this.buf = this.buf.slice(m.index + m[0].length);
      this.handleBlock(block, now, out);
    }
    return out;
  }

  /** Flush a trailing event without a blank-line terminator (stream ended abruptly). */
  end(now = Date.now()): SseDelta[] {
    const out: SseDelta[] = [];
    if (this.buf.trim()) this.handleBlock(this.buf, now, out);
    this.buf = "";
    return out;
  }

  private handleBlock(block: string, now: number, out: SseDelta[]): void {
    const data = block
      .split(/\r?\n/)
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).replace(/^ /, ""))
      .join("\n");
    if (!data) return; // comment / keepalive
    if (data.trim() === "[DONE]") {
      this.done = true;
      return;
    }
    let chunk: any;
    try {
      chunk = JSON.parse(data);
    } catch {
      this.parseErrors++;
      return;
    }
    if (chunk.model === "keepalive") return; // oMLX keepalive chunk mode
    this.chunks++;
    this.id ??= chunk.id;
    if (chunk.model) this.model = chunk.model;
    if (chunk.created) this.created = chunk.created;
    if (chunk.usage) this.usage = chunk.usage;
    if (chunk.error) this.error = String(chunk.error.message ?? chunk.error);
    for (const choice of chunk.choices ?? []) {
      const d = choice.delta ?? {};
      const reasoning = d.reasoning_content ?? d.reasoning ?? d.reasoning_text;
      if (typeof reasoning === "string" && reasoning) {
        this.reasoning += reasoning;
        out.push({ kind: "thinking", delta: reasoning });
      }
      if (typeof d.content === "string" && d.content) {
        this.content += d.content;
        out.push({ kind: "text", delta: d.content });
      }
      for (const tc of d.tool_calls ?? []) {
        const index = tc.index ?? this.toolCalls.size;
        let acc = this.toolCalls.get(index);
        if (!acc) {
          acc = { index, type: tc.type ?? "function", function: { name: "", arguments: "" } };
          this.toolCalls.set(index, acc);
        }
        if (tc.id) acc.id = tc.id;
        if (tc.function?.name) acc.function.name += tc.function.name;
        if (tc.function?.arguments) acc.function.arguments += tc.function.arguments;
        out.push({ kind: "toolcall", delta: (tc.function?.name ? `${tc.function.name} ` : "") + (tc.function?.arguments ?? "") });
      }
      if (choice.finish_reason) this.finishReason = choice.finish_reason;
    }
    if (out.length && this.firstTokenAt === null) this.firstTokenAt = now;
  }

  /** Final response in non-streamed chat.completion shape. */
  response(): Record<string, unknown> {
    const toolCalls = [...this.toolCalls.values()].sort((a, b) => a.index - b.index).map(({ index: _i, ...tc }) => tc);
    const message: Record<string, unknown> = { role: "assistant", content: this.content || (toolCalls.length ? null : "") };
    if (this.reasoning) message.reasoning_content = this.reasoning;
    if (toolCalls.length) message.tool_calls = toolCalls;
    return {
      id: this.id,
      object: "chat.completion",
      created: this.created,
      model: this.model,
      choices: [{ index: 0, message, finish_reason: this.finishReason }],
      ...(this.usage ? { usage: this.usage } : {}),
    };
  }
}
