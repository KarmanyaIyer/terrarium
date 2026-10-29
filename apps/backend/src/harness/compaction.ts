// Deterministic compaction (no model call): research/harness.md "Compaction for 8-12K windows".
// 1) truncate old tool outputs to head + tail lines; 2) drop the oldest whole turns, keeping the system
// messages, the task message and the newest turns, and note what was removed in the task message.

import type { AgentMessage } from "@earendil-works/pi-agent-core";

export interface CompactionOptions {
  window: number;
  outputBudget: number;
  margin?: number;
  /** Token estimate for a message list (calibrated against server usage). */
  estimate: (messages: AgentMessage[]) => number;
  keepRecentToolResults?: number;
  headTailLines?: number;
  /** Paths changed so far, for the harness note. */
  filesChanged?: () => string[];
}

export interface CompactionResult {
  messages: AgentMessage[];
  beforeTokens: number;
  afterTokens: number;
  removedTurns: number;
  truncatedResults: number;
  note: string;
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((c: any) => (c?.type === "text" ? c.text : "")).join("");
  return "";
}

const NOTE_RE = /\n\n\[harness: (\d+) earlier steps? removed to fit the context window[^\]]*\]$/;

export function headTail(text: string, lines: number): { text: string; cut: boolean } {
  const all = text.split("\n");
  if (all.length <= lines * 2 + 1) return { text, cut: false };
  const removed = all.length - lines * 2;
  return { text: [...all.slice(0, lines), `[... ${removed} lines removed by the harness to save context ...]`, ...all.slice(-lines)].join("\n"), cut: true };
}

export function compact(messages: AgentMessage[], opts: CompactionOptions): CompactionResult {
  const margin = opts.margin ?? 256;
  const limit = opts.window - opts.outputBudget - margin;
  const beforeTokens = opts.estimate(messages);
  const unchanged: CompactionResult = { messages, beforeTokens, afterTokens: beforeTokens, removedTurns: 0, truncatedResults: 0, note: "" };
  if (beforeTokens <= limit) return unchanged;

  // Step 1: shrink old tool results.
  const keepRecent = opts.keepRecentToolResults ?? 2;
  const lines = opts.headTailLines ?? 20;
  const resultIdx = messages.map((m, i) => (m.role === "toolResult" ? i : -1)).filter((i) => i >= 0);
  const shrinkable = new Set(resultIdx.slice(0, Math.max(0, resultIdx.length - keepRecent)));
  let truncatedResults = 0;
  let working: AgentMessage[] = messages.map((m, i) => {
    if (!shrinkable.has(i)) return m;
    const { text, cut } = headTail(textOf((m as any).content), lines);
    if (!cut) return m;
    truncatedResults++;
    return { ...(m as any), content: [{ type: "text", text }] } as AgentMessage;
  });
  let tokens = opts.estimate(working);
  if (tokens <= limit) {
    const note = `[harness: ${truncatedResults} older tool outputs shortened to their first and last ${lines} lines]`;
    return { messages: working, beforeTokens, afterTokens: tokens, removedTurns: 0, truncatedResults, note };
  }

  // Step 2: drop oldest turns. Head = leading system messages + first user message (the task).
  let headEnd = 0;
  while (headEnd < working.length && working[headEnd].role === "system") headEnd++;
  const taskIdx = working.findIndex((m, i) => i >= headEnd && m.role === "user");
  if (taskIdx < 0) return { ...unchanged, messages: working, afterTokens: tokens, truncatedResults };
  const head = working.slice(0, taskIdx + 1);
  const groups: AgentMessage[][] = [];
  for (const m of working.slice(taskIdx + 1)) {
    if (m.role === "toolResult" && groups.length) groups[groups.length - 1].push(m);
    else if (m.role === "system" && groups.length) groups[groups.length - 1].push(m);
    else groups.push([m]);
  }
  let removedTurns = 0;
  const removedSystem: AgentMessage[] = [];
  // A previous compaction left a note on the task message: replace it and keep counting from its total.
  const task = head[head.length - 1] as any;
  const taskTextRaw = textOf(task.content);
  const prior = taskTextRaw.match(NOTE_RE);
  const priorRemoved = prior ? Number(prior[1]) : 0;
  const taskText = taskTextRaw.replace(NOTE_RE, "");
  const build = (note: string): AgentMessage[] => {
    const noted = note ? { ...task, content: [{ type: "text", text: `${taskText}\n\n${note}` }] } : task;
    return [...head.slice(0, -1), ...removedSystem, noted, ...groups.slice(removedTurns).flat()];
  };
  const noteFor = (n: number) => {
    const total = n + priorRemoved;
    const files = opts.filesChanged?.() ?? [];
    const fileList = files.length ? `; files changed so far: ${files.slice(0, 12).join(", ")}${files.length > 12 ? ` (+${files.length - 12} more)` : ""}` : "";
    return `[harness: ${total} earlier step${total === 1 ? "" : "s"} removed to fit the context window${fileList}]`;
  };
  while (removedTurns < groups.length - 1) {
    // Keep tool-declaration system messages from dropped turns so the tool set stays valid.
    for (const m of groups[removedTurns]) if (m.role === "system") removedSystem.push(m);
    removedTurns++;
    working = build(noteFor(removedTurns));
    tokens = opts.estimate(working);
    if (tokens <= limit) break;
  }
  return { messages: working, beforeTokens, afterTokens: tokens, removedTurns, truncatedResults, note: noteFor(removedTurns) };
}
