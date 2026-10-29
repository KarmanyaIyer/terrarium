// Deterministic compaction (no model call): research/harness.md "Compaction for 8-12K windows".
// 1) truncate old tool outputs to head + tail lines; 2) drop the oldest whole turns, keeping the system
// messages, the current instruction (latest user message) and the newest step, and note what was removed
// on that instruction; 3) if a tool output is still too big for the window on its own, shorten it to its first
// and last tokens with a marker that says how many of how many were kept.
// Every decision is made on `count`, which the session backs with the model's own tokenizer.

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ShortenedOutput } from "@terrarium/shared";

export interface CompactionOptions {
  window: number;
  outputBudget: number;
  margin?: number;
  /** Prompt tokens for a message list (exact from the model's tokenizer when it is reachable). */
  count: (messages: AgentMessage[]) => Promise<number> | number;
  /** Tokens of a piece of text; sizes shortened tool outputs. Default: characters / 3.5. */
  countText?: (text: string) => Promise<number> | number;
  keepRecentToolResults?: number;
  headTailLines?: number;
  /** Paths changed so far, for the harness note. */
  filesChanged?: () => string[];
  /** Stores the full text of a tool output before it is shortened; returns its blob id. */
  saveOriginal?: (toolCallId: string, text: string) => string | undefined;
}

export interface CompactionResult {
  messages: AgentMessage[];
  beforeTokens: number;
  afterTokens: number;
  removedTurns: number;
  truncatedResults: number;
  shortened: ShortenedOutput[];
  note: string;
  /** Prompt tokens that leave the output budget (plus margin) free. */
  limit: number;
  /** afterTokens <= limit. False when what compaction may not touch (system prompt, the current instruction, the
   * newest assistant message) is already too big. */
  fits: boolean;
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((c: any) => (c?.type === "text" ? c.text : "")).join("");
  return "";
}

const NOTE_RE = /\n\n\[harness: (\d+) earlier steps? removed to fit the context window[^\]]*\]$/;
const SHORTENED_RE = /\n\[tool output shortened by the harness to fit the context window: kept the first \d+ and last \d+ of (\d+) tokens\]\n/;
/** Smallest piece of a tool output kept when shortening it (head + tail). */
const MIN_KEEP_TOKENS = 64;
/** Tokens set aside for the shortening marker itself. */
const MARKER_TOKENS = 40;

export function headTail(text: string, lines: number): { text: string; cut: boolean } {
  const all = text.split("\n");
  if (all.length <= lines * 2 + 1) return { text, cut: false };
  const removed = all.length - lines * 2;
  return { text: [...all.slice(0, lines), `[... ${removed} lines removed by the harness to save context ...]`, ...all.slice(-lines)].join("\n"), cut: true };
}

/** Never split a UTF-16 surrogate pair (the server rejects lone surrogates). */
function safeHead(s: string, n: number): string {
  const h = s.slice(0, Math.max(0, n));
  const last = h.charCodeAt(h.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? h.slice(0, -1) : h;
}

function safeTail(s: string, n: number): string {
  if (n <= 0) return "";
  const t = s.slice(Math.max(0, s.length - n));
  const first = t.charCodeAt(0);
  return first >= 0xdc00 && first <= 0xdfff ? t.slice(1) : t;
}

export function shortenedMarker(head: number, tail: number, total: number): string {
  return `\n[tool output shortened by the harness to fit the context window: kept the first ${head} and last ${tail} of ${total} tokens]\n`;
}

/** Tokens kept free beyond the output budget: compaction's limit is window - output budget - this. */
export const COMPACTION_MARGIN = 256;

/** Smallest window whose compaction limit holds `promptTokens` with `outputBudget` free, from `windows` (ascending). */
export function windowThatFits(promptTokens: number, outputBudget: number, windows: number[], max: number): number | undefined {
  return windows.find((w) => w <= max && w - outputBudget - COMPACTION_MARGIN >= promptTokens);
}

export async function compact(messages: AgentMessage[], opts: CompactionOptions): Promise<CompactionResult> {
  const margin = opts.margin ?? COMPACTION_MARGIN;
  const limit = opts.window - opts.outputBudget - margin;
  const countText = opts.countText ?? ((t: string) => Math.ceil(t.length / 3.5));
  const beforeTokens = await opts.count(messages);
  const done = (r: Omit<CompactionResult, "beforeTokens" | "limit" | "fits">): CompactionResult => ({ ...r, beforeTokens, limit, fits: r.afterTokens <= limit });
  if (beforeTokens <= limit) return done({ messages, afterTokens: beforeTokens, removedTurns: 0, truncatedResults: 0, shortened: [], note: "" });

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
  let tokens = await opts.count(working);
  const step1Note = truncatedResults ? `[harness: ${truncatedResults} older tool outputs shortened to their first and last ${lines} lines]` : "";
  if (tokens <= limit) return done({ messages: working, afterTokens: tokens, removedTurns: 0, truncatedResults, shortened: [], note: step1Note });

  // Step 2: drop oldest turns. Protected: leading system messages and the current instruction (the latest
  // user message). Earlier exchanges go first, oldest first, then the oldest steps of the current one; the
  // newest step always stays. The fewest removals that fit are found by bisection on exact counts.
  let removedTurns = 0;
  let note = step1Note;
  let headEnd = 0;
  while (headEnd < working.length && working[headEnd].role === "system") headEnd++;
  let taskIdx = -1;
  for (let i = working.length - 1; i >= headEnd; i--) {
    if (working[i].role === "user") {
      taskIdx = i;
      break;
    }
  }
  if (taskIdx >= 0) {
    const toGroups = (msgs: AgentMessage[]): AgentMessage[][] => {
      const groups: AgentMessage[][] = [];
      for (const m of msgs) {
        if ((m.role === "toolResult" || m.role === "system") && groups.length) groups[groups.length - 1].push(m);
        else groups.push([m]);
      }
      return groups;
    };
    const head = working.slice(0, headEnd);
    const older = toGroups(working.slice(headEnd, taskIdx));
    const current = toGroups(working.slice(taskIdx + 1));
    const groups = [...older, ...current];
    const maxRemove = older.length + Math.max(0, current.length - 1);
    // A previous compaction left a note on this message: replace it and keep counting from its total.
    const task = working[taskIdx] as any;
    const taskTextRaw = textOf(task.content);
    const prior = taskTextRaw.match(NOTE_RE);
    const priorRemoved = prior ? Number(prior[1]) : 0;
    const taskText = taskTextRaw.replace(NOTE_RE, "");
    const noteFor = (n: number) => {
      const total = n + priorRemoved;
      const files = opts.filesChanged?.() ?? [];
      const fileList = files.length ? `; files changed so far: ${files.slice(0, 12).join(", ")}${files.length > 12 ? ` (+${files.length - 12} more)` : ""}` : "";
      return `[harness: ${total} earlier step${total === 1 ? "" : "s"} removed to fit the context window${fileList}]`;
    };
    const build = (k: number): AgentMessage[] => {
      // Keep tool-declaration system messages from dropped turns so the tool set stays valid.
      const removedSystem = groups.slice(0, k).flatMap((g) => g.filter((m) => m.role === "system"));
      const noted = { ...task, content: [{ type: "text", text: `${taskText}\n\n${noteFor(k)}` }] };
      const keptOlder = older.slice(Math.min(k, older.length));
      const keptCurrent = current.slice(Math.max(0, k - older.length));
      return [...head, ...removedSystem, ...keptOlder.flat(), noted, ...keptCurrent.flat()];
    };
    if (maxRemove > 0) {
      const counted = new Map<number, number>();
      const at = async (k: number) => {
        if (!counted.has(k)) counted.set(k, await opts.count(build(k)));
        return counted.get(k)!;
      };
      let k = maxRemove;
      if ((await at(maxRemove)) <= limit) {
        let lo = 1;
        let hi = maxRemove;
        while (lo < hi) {
          const mid = (lo + hi) >> 1;
          if ((await at(mid)) <= limit) hi = mid;
          else lo = mid + 1;
        }
        k = lo;
      }
      removedTurns = k;
      working = build(k);
      tokens = await at(k);
      note = noteFor(k);
    }
  }
  if (tokens <= limit) return done({ messages: working, afterTokens: tokens, removedTurns, truncatedResults, shortened: [], note });

  // Step 3: a tool output (any, the newest included) that is still too big is cut to its first and last tokens,
  // largest first, with a marker giving the numbers.
  const shortened: ShortenedOutput[] = [];
  const sizes = new Map<number, number>();
  for (let i = 0; i < working.length; i++) if (working[i].role === "toolResult") sizes.set(i, await countText(textOf((working[i] as any).content)));
  const order = [...sizes.entries()].sort((a, b) => b[1] - a[1]).map(([i]) => i);
  for (const i of order) {
    if (tokens <= limit) break;
    const msg = working[i] as any;
    const current = textOf(msg.content);
    // Already shortened once: shorten its kept head and tail further, keeping the original total.
    const prev = current.match(SHORTENED_RE);
    const [srcHead, srcTail] = prev ? [current.slice(0, prev.index), current.slice(prev.index! + prev[0].length)] : [current, ""];
    const total = prev ? Number(prev[1]) : sizes.get(i)!;
    const size = sizes.get(i)!;
    if (size <= MIN_KEEP_TOKENS + MARKER_TOKENS) continue;
    let target = Math.max(MIN_KEEP_TOKENS + MARKER_TOKENS, size - (tokens - limit) - 16);
    for (let attempt = 0; attempt < 4 && tokens > limit; attempt++) {
      const keep = target - MARKER_TOKENS;
      const charsPerToken = current.length / Math.max(1, size);
      const headChars = Math.floor(keep * 0.4 * charsPerToken);
      const tailChars = Math.floor((keep - keep * 0.4) * charsPerToken);
      let headText: string;
      let tailText: string;
      if (prev) {
        headText = safeHead(srcHead, Math.min(srcHead.length, headChars));
        tailText = safeTail(srcTail, Math.min(srcTail.length, tailChars));
      } else {
        headText = safeHead(srcHead, headChars);
        tailText = safeTail(srcHead.slice(headText.length), tailChars);
      }
      const [h, t] = [await countText(headText), await countText(tailText)];
      const text = `${headText}${shortenedMarker(h, t, total)}${tailText}`;
      const next = working.slice();
      next[i] = { ...msg, content: [{ type: "text", text }] } as AgentMessage;
      const nextTokens = await opts.count(next);
      if (nextTokens >= tokens && attempt > 0) break;
      working = next;
      tokens = nextTokens;
      const entry: ShortenedOutput = { toolCallId: msg.toolCallId, toolName: msg.toolName, keptHead: h, keptTail: t, total };
      const blob = shortened.some((s) => s.toolCallId === msg.toolCallId) ? undefined : opts.saveOriginal?.(msg.toolCallId, current);
      const at = shortened.findIndex((s) => s.toolCallId === msg.toolCallId);
      if (at >= 0) shortened[at] = { ...shortened[at], keptHead: h, keptTail: t };
      else shortened.push(blob ? { ...entry, originalBlob: blob } : entry);
      if (target <= MIN_KEEP_TOKENS + MARKER_TOKENS) break;
      // The cut is sized by this output's characters per token; if the rest of the prompt still doesn't fit, cut
      // by what is still missing.
      target = Math.max(MIN_KEEP_TOKENS + MARKER_TOKENS, target - (tokens - limit) - 16);
    }
  }
  const outNote = shortened.length
    ? `${note ? `${note} ` : ""}[harness: ${shortened.length} tool output${shortened.length === 1 ? "" : "s"} shortened to fit the context window]`
    : note;
  return done({ messages: working, afterTokens: tokens, removedTurns, truncatedResults, shortened, note: outNote });
}
