// Text tool-call fallback. Small models sometimes put a tool call in the text instead of the server's
// structured tool_calls (template drift, a parser miss, or a truncated special token). If the final message
// has no structured calls, recover them from the text, rewrite the message, and report a harness_repair.

import { type AssistantMessage, type AssistantMessageEventStream, createAssistantMessageEventStream, type ToolCall } from "@earendil-works/pi-ai";

export interface ParsedCall {
  name: string;
  arguments: Record<string, unknown>;
}

export interface ParseResult {
  calls: ParsedCall[];
  text: string; // remaining text with the call markup removed
  reason: string;
}

function coerce(value: string): unknown {
  const v = value.replace(/^\n/, "").replace(/\n$/, "");
  if (/^-?\d+(\.\d+)?$/.test(v.trim())) return Number(v.trim());
  if (v.trim() === "true" || v.trim() === "false") return v.trim() === "true";
  if (/^[[{]/.test(v.trim())) {
    try {
      return JSON.parse(v.trim());
    } catch {}
  }
  return v;
}

function looseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {}
  // Gemma-style {command:<|"|>ls<|"|>} -> {"command":"ls"}
  const fixed = text.replace(/<\|"\|>/g, '"').replace(/([{,]\s*)([A-Za-z_][\w-]*)\s*:/g, '$1"$2":');
  try {
    return JSON.parse(fixed);
  } catch {
    return undefined;
  }
}

function asCall(obj: unknown, tools: Set<string>): ParsedCall | null {
  if (!obj || typeof obj !== "object") return null;
  const o = obj as Record<string, any>;
  const name = o.name ?? o.function?.name ?? o.tool;
  let args = o.arguments ?? o.parameters ?? o.args ?? o.function?.arguments ?? {};
  if (typeof args === "string") args = looseJson(args) ?? {};
  if (typeof name !== "string" || !tools.has(name) || typeof args !== "object" || Array.isArray(args)) return null;
  return { name, arguments: args };
}

/** Parse tool calls out of assistant text. `fencedBash`: treat ```bash blocks as bash calls (text protocol only). */
export function parseTextToolCalls(text: string, toolNames: string[], opts: { fencedBash?: boolean } = {}): ParseResult | null {
  const tools = new Set(toolNames);
  const calls: ParsedCall[] = [];
  let rest = text;

  // 1) qwen3_coder XML: <tool_call><function=NAME><parameter=K>V</parameter>...</function></tool_call>
  const xml = /(?:<tool_call>\s*)?<function=([\w.-]+)>([\s\S]*?)<\/function>(?:\s*<\/tool_call>)?/g;
  for (const m of text.matchAll(xml)) {
    if (!tools.has(m[1])) continue;
    const args: Record<string, unknown> = {};
    for (const p of m[2].matchAll(/<parameter=([\w.-]+)>([\s\S]*?)<\/parameter>/g)) args[p[1]] = coerce(p[2]);
    calls.push({ name: m[1], arguments: args });
    rest = rest.replace(m[0], "");
  }
  if (calls.length) return { calls, text: rest.trim(), reason: "tool call in text (qwen3_coder XML) instead of tool_calls" };

  // 2) Hermes JSON: <tool_call>{"name": ..., "arguments": ...}</tool_call>
  for (const m of text.matchAll(/<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g)) {
    const call = asCall(looseJson(m[1]), tools);
    if (call) {
      calls.push(call);
      rest = rest.replace(m[0], "");
    }
  }
  if (calls.length) return { calls, text: rest.trim(), reason: "tool call in text (<tool_call> JSON) instead of tool_calls" };

  // 3) Gemma 4: <|tool_call>call:NAME{...}<tool_call|>
  for (const m of text.matchAll(/<\|tool_call>\s*call:([\w.-]+)\s*(\{[\s\S]*?\})\s*<tool_call\|>/g)) {
    const args = looseJson(m[2]);
    if (tools.has(m[1]) && args && typeof args === "object" && !Array.isArray(args)) {
      calls.push({ name: m[1], arguments: args as Record<string, unknown> });
      rest = rest.replace(m[0], "");
    }
  }
  if (calls.length) return { calls, text: rest.trim(), reason: "tool call in text (gemma4 markup) instead of tool_calls" };

  // 4) The whole reply is one JSON call object (optionally fenced as json).
  const bare = text.trim().replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/, "$1");
  if (bare.startsWith("{") && bare.endsWith("}")) {
    const call = asCall(looseJson(bare), tools);
    if (call) return { calls: [call], text: "", reason: "reply was a bare JSON tool call" };
  }

  // 5) Text protocol: fenced bash blocks are commands.
  if (opts.fencedBash && tools.has("bash")) {
    for (const m of text.matchAll(/```(?:bash|sh|shell)\n([\s\S]*?)```/g)) {
      calls.push({ name: "bash", arguments: { command: m[1].trim() } });
      rest = rest.replace(m[0], "");
    }
    if (calls.length) return { calls, text: rest.trim(), reason: "fenced bash block (text protocol)" };
  }
  return null;
}

export interface RepairInfo {
  original: string;
  calls: ToolCall[];
  reason: string;
}

/**
 * Wrap a stream: forward every event; on `done` without structured tool calls, try the text parser and, if it
 * finds calls, replace the final message (text minus markup + toolCall blocks, stopReason toolUse).
 */
export function withTextToolCallFallback(
  source: AssistantMessageEventStream,
  toolNames: () => string[],
  opts: { fencedBash?: boolean; onRepair?: (info: RepairInfo) => void; idPrefix?: string } = {},
): AssistantMessageEventStream {
  const out = createAssistantMessageEventStream();
  (async () => {
    try {
      for await (const ev of source) {
        if (ev.type === "done" && ev.reason !== "length") {
          const repaired = repairMessage(ev.message, toolNames(), opts);
          if (repaired) {
            opts.onRepair?.(repaired.info);
            out.push({ type: "done", reason: "toolUse", message: repaired.message });
            continue;
          }
        }
        out.push(ev);
      }
      out.end();
    } catch (err) {
      out.end();
      throw err;
    }
  })();
  return out;
}

export function repairMessage(message: AssistantMessage, toolNames: string[], opts: { fencedBash?: boolean; idPrefix?: string } = {}): { message: AssistantMessage; info: RepairInfo } | null {
  if (!toolNames.length || message.content.some((c) => c.type === "toolCall")) return null;
  const text = message.content.filter((c) => c.type === "text").map((c) => (c as { text: string }).text).join("");
  if (!text.trim()) return null;
  const parsed = parseTextToolCalls(text, toolNames, opts);
  if (!parsed) return null;
  const prefix = opts.idPrefix ?? "repair";
  const calls: ToolCall[] = parsed.calls.map((c, i) => ({ type: "toolCall", id: `${prefix}_${Date.now().toString(36)}_${i}`, name: c.name, arguments: c.arguments as ToolCall["arguments"] }));
  const content: AssistantMessage["content"] = [
    ...message.content.filter((c) => c.type === "thinking"),
    ...(parsed.text ? [{ type: "text" as const, text: parsed.text }] : []),
    ...calls,
  ];
  return { message: { ...message, content, stopReason: "toolUse" }, info: { original: text, calls, reason: parsed.reason } };
}
