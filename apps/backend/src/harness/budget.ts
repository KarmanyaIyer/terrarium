// Token accounting. Prompts are counted exactly by the inference server's own tokenizer and chat template
// (inference/tokens.ts) on the exact body pi-ai builds, before the request is sent. The server's usage
// (prompt_tokens) after each call checks that count; any shortfall it shows is added to later counts. When the
// tokenizer fails, the rest of the run is counted with estimates that err high (conservativeTokens), added to the
// server's own count of the part of the request it has already seen; they are labeled estimates everywhere.

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import { estimateMessageTokens } from "@earendil-works/pi-ai/utils/estimate";
import { errorMessage } from "../util/errors.ts";
import { logger } from "../util/log.ts";

const log = logger("budget");

/**
 * Token count of text that errs high, for when the model's tokenizer can't be used. pi-ai's chars/3.5 counts 6,000
 * digits as ~1,700 tokens; Qwen's tokenizer makes them 6,000. Rules, checked against Qwen3.5's tokenizer on prose,
 * code, JSON, lockfiles, digits, hex, base64, random letters, ids, URLs, CJK (common and rare), Cyrillic, Arabic,
 * Devanagari, emoji and whitespace (TODO_14): a digit or an ASCII symbol is a token (a run of one repeated symbol, one
 * per 4); a non-ASCII character is its UTF-8 length minus one, at least one; a run of ASCII letters is one per 3
 * letters plus one per change of case, and at least one per 1.8 letters past 12 (no word is that long; random
 * strings are); a run of whitespace is one, plus one per 8 characters after the first. Plus 10%: the closest rules
 * (hex, ids, random letters, whitespace) came within 5% of the real count.
 */
export function conservativeTokens(text: string): number {
  let n = 0;
  let letters = 0;
  let caseChanges = 0;
  let lastUpper: boolean | null = null;
  let space = 0;
  let symbol = 0;
  let symbolRun = 0;
  const endLetters = () => {
    if (!letters) return;
    n += Math.max(Math.ceil(letters / 3) + caseChanges, letters > 12 ? Math.ceil(letters / 1.8) : 0);
    letters = 0;
    caseChanges = 0;
    lastUpper = null;
  };
  const endSpace = () => {
    if (!space) return;
    n += 1 + Math.floor((space - 1) / 8);
    space = 0;
  };
  const endSymbols = () => {
    if (!symbolRun) return;
    n += Math.ceil(symbolRun / 4);
    symbolRun = 0;
    symbol = 0;
  };
  for (const ch of text) {
    const c = ch.codePointAt(0)!;
    const upper = c >= 65 && c <= 90;
    if (upper || (c >= 97 && c <= 122)) {
      endSpace();
      endSymbols();
      if (lastUpper !== null && lastUpper !== upper) caseChanges++;
      lastUpper = upper;
      letters++;
      continue;
    }
    endLetters();
    if (c === 32 || c === 9 || c === 10 || c === 13) {
      endSymbols();
      space++;
      continue;
    }
    endSpace();
    if (c < 128 && !(c >= 48 && c <= 57)) {
      if (c === symbol) {
        symbolRun++;
        continue;
      }
      endSymbols();
      symbol = c;
      symbolRun = 1;
      continue;
    }
    endSymbols();
    if (c < 128) n++; // digit
    else n += Math.max(1, (c < 0x800 ? 2 : c < 0x10000 ? 3 : 4) - 1);
  }
  endLetters();
  endSpace();
  endSymbols();
  return Math.ceil(n * 1.1);
}

/** Chat-template tokens around one message (role markers, end of turn, tool response wrapper). */
const MESSAGE_OVERHEAD = 10;
/** Around one tool call (Qwen's XML function and parameter tags). */
const TOOL_CALL_OVERHEAD = 30;
/** The generation prompt the server appends (role marker, empty thinking block). */
const GENERATION_PROMPT = 12;
/** The template's tool-use instructions around the declarations. */
const TOOLS_OVERHEAD = 400;

function stringTokens(v: unknown): number {
  if (typeof v === "string") return conservativeTokens(v);
  if (Array.isArray(v)) return v.reduce((a: number, x) => a + stringTokens(x), 0);
  if (v && typeof v === "object") return Object.values(v).reduce((a: number, x) => a + stringTokens(x), 0);
  return 0;
}

/** One request message (OpenAI format) or agent message, estimated high. */
function messageTokens(m: unknown): number {
  const calls = (m as { tool_calls?: unknown[] }).tool_calls;
  const content = (m as { content?: unknown }).content;
  const agentCalls = Array.isArray(content) ? content.filter((c: { type?: string }) => c?.type === "toolCall").length : 0;
  return MESSAGE_OVERHEAD + stringTokens(m) + TOOL_CALL_OVERHEAD * ((Array.isArray(calls) ? calls.length : 0) + agentCalls);
}

export function rawEstimate(messages: AgentMessage[]): number {
  const llm = messages.filter((m) => m.role === "system" || m.role === "user" || m.role === "assistant" || m.role === "toolResult") as Message[];
  // Pure per-message heuristic (system messages include declared tools). Not estimateContextTokens: that anchors
  // on the last assistant usage, which is stale after compaction and would be double-scaled by the calibrator.
  let total = 0;
  for (const m of llm) total += estimateMessageTokens(m);
  return total;
}

/** A request the server has counted: later requests that start with the same messages build on its count. */
interface Anchor {
  messages: string[];
  key: string;
  tokens: number;
}

/** What server usage has taught about a session's counts (kept across its runs; reset on a model switch). */
export class TokenCalibrator {
  private ratio = 1;
  /** The last request the server counted. */
  anchor: Anchor | null = null;
  /** Estimates are multiplied by this once the server counted more than one. */
  scale = 1;

  /** Record server truth for a request whose messages estimated to `estimated` tokens (pi-ai's heuristic). */
  observe(estimated: number, serverPromptTokens: number): void {
    if (estimated > 50 && serverPromptTokens > 0) {
      const r = serverPromptTokens / estimated;
      if (r > 0.3 && r < 4) this.ratio = r;
    }
  }

  estimate(messages: AgentMessage[]): number {
    return Math.ceil(rawEstimate(messages) * this.ratio);
  }

  get factor(): number {
    return this.ratio;
  }
}

/** The request a count was taken on, as JSON per message plus its tools and template arguments. */
export interface CountBasis {
  messages: string[];
  key: string;
  /** Estimates only: tokens taken from the server's count of an earlier request with the same first messages. */
  anchored?: number;
  /** Estimates only: the rest, estimated (before `scale`). */
  estimated?: number;
}

export interface PromptCount {
  tokens: number;
  /** Counted by the server's tokenizer (plus any correction from server usage), not estimated. */
  exact: boolean;
  /** The tokenizer's own count, before the correction. */
  tokenized?: number;
  basis?: CountBasis;
}

/** The server's tokenizer (inference/tokens.ts), or a fake in tests. */
export interface ChatTokenizer {
  countChat(body: { model: string; messages: unknown[]; tools?: unknown[]; chat_template_kwargs?: Record<string, unknown> }, signal?: AbortSignal): Promise<number>;
  countText(model: string, text: string, signal?: AbortSignal): Promise<number>;
}

export interface PromptCounterOptions {
  modelId: string;
  tokenizer?: ChatTokenizer;
  calibrator: TokenCalibrator;
  /** The exact request body pi-ai would send for these messages (stream.ts requestBody). */
  body(messages: Message[]): Promise<Record<string, unknown>>;
  /** The run's abort signal: Stop cancels a count in flight. */
  signal?(): AbortSignal | undefined;
  /** The tokenizer failed; the rest of the run is counted with estimates. Called once. */
  onFallback?(reason: string): void;
}

/** Counts prompts for one run of one session. After the tokenizer fails once, the rest of the run uses estimates. */
export class PromptCounter {
  private opts: PromptCounterOptions;
  /** Tokens the server counted beyond our count on the last call (0 when they agree). */
  private correction = 0;
  private failed: string | null = null;

  constructor(opts: PromptCounterOptions) {
    this.opts = opts;
  }

  get calibrator(): TokenCalibrator {
    return this.opts.calibrator;
  }

  /** Why the tokenizer failed, if it did; counts are estimates from then on. */
  get lastFailure(): string | null {
    return this.failed;
  }

  private get usable(): boolean {
    return !!this.opts.tokenizer && this.failed === null;
  }

  private fellBack(err: unknown): void {
    const signal = this.opts.signal?.();
    if (signal?.aborted) throw signal.reason ?? err;
    if (this.failed !== null) return;
    this.failed = errorMessage(err);
    log.warn(`exact token count failed; estimating for the rest of the run: ${this.failed}`);
    this.opts.onFallback?.(this.failed);
  }

  /** Estimate for messages without a request body (system prompt split, meter). */
  estimate(messages: AgentMessage[]): number {
    let n = 0;
    for (const m of messages) if (m.role === "system" || m.role === "user" || m.role === "assistant" || m.role === "toolResult") n += messageTokens(m);
    return Math.ceil(n * this.opts.calibrator.scale);
  }

  /** Estimate for a request body: the server's count of the longest earlier request it starts with, plus the rest. */
  private estimateBody(body: Record<string, unknown>, basis: CountBasis): PromptCount {
    const msgs = Array.isArray(body.messages) ? (body.messages as unknown[]) : [];
    const a = this.opts.calibrator.anchor;
    const anchored = !!a && a.key === basis.key && a.messages.length <= basis.messages.length && a.messages.every((s, i) => s === basis.messages[i]);
    let estimated = anchored ? 0 : GENERATION_PROMPT + (Array.isArray(body.tools) && body.tools.length ? TOOLS_OVERHEAD + stringTokens(body.tools) : 0);
    for (let i = anchored ? a!.messages.length : 0; i < msgs.length; i++) estimated += messageTokens(msgs[i]);
    const base = anchored ? a!.tokens : 0;
    return { tokens: base + Math.ceil(estimated * this.opts.calibrator.scale), exact: false, basis: { ...basis, anchored: base, estimated } };
  }

  async count(messages: AgentMessage[]): Promise<PromptCount> {
    const llm = messages.filter((m) => m.role === "system" || m.role === "user" || m.role === "assistant" || m.role === "toolResult") as Message[];
    let body: Record<string, unknown>;
    try {
      body = await this.opts.body(llm);
    } catch (err) {
      log.warn(`building the request body to count failed: ${errorMessage(err)}`);
      return { tokens: this.estimate(messages), exact: false };
    }
    const basis: CountBasis = {
      messages: (Array.isArray(body.messages) ? body.messages : []).map((m) => JSON.stringify(m)),
      key: JSON.stringify([body.tools ?? null, body.chat_template_kwargs ?? null]),
    };
    if (this.usable) {
      try {
        const n = await this.opts.tokenizer!.countChat(
          {
            model: this.opts.modelId,
            messages: body.messages as unknown[],
            ...(Array.isArray(body.tools) ? { tools: body.tools } : {}),
            ...(body.chat_template_kwargs ? { chat_template_kwargs: body.chat_template_kwargs as Record<string, unknown> } : {}),
          },
          this.opts.signal?.(),
        );
        return { tokens: n + this.correction, exact: true, tokenized: n, basis };
      } catch (err) {
        this.fellBack(err);
      }
    }
    return this.estimateBody(body, basis);
  }

  /**
   * System prompt + tool declarations. Chat templates refuse a prompt with no user turn (Qwen: "No user query
   * found"), so this counts them with an empty user turn and subtracts that turn counted alone.
   */
  async countSystem(system: AgentMessage[]): Promise<PromptCount> {
    const empty = { role: "user", content: "", timestamp: 0 } as AgentMessage;
    // One after the other: if the tokenizer fails on the first, the second is estimated without asking it again.
    const withSystem = await this.count([...system, empty]);
    const bare = await this.count([empty]);
    if (withSystem.tokenized !== undefined && bare.tokenized !== undefined) return { tokens: withSystem.tokenized - bare.tokenized, exact: true };
    return { tokens: Math.max(0, withSystem.tokens - bare.tokens), exact: false };
  }

  async countText(text: string): Promise<PromptCount> {
    if (this.usable) {
      try {
        return { tokens: await this.opts.tokenizer!.countText(this.opts.modelId, text, this.opts.signal?.()), exact: true };
      } catch (err) {
        this.fellBack(err);
      }
    }
    return { tokens: Math.ceil(conservativeTokens(text) * this.opts.calibrator.scale), exact: false };
  }

  /**
   * Server usage for a call whose prompt we counted as `counted` (raw heuristic `raw`). Later requests that start with
   * this one's messages build on the server's count; an estimate the server counted more than scales later ones up.
   */
  observe(counted: PromptCount, raw: number, serverPromptTokens: number): void {
    const c = this.opts.calibrator;
    c.observe(raw, serverPromptTokens);
    if (counted.tokenized !== undefined) this.correction = Math.max(0, serverPromptTokens - counted.tokenized);
    const b = counted.basis;
    if (!b || serverPromptTokens <= 0) return;
    if (!counted.exact && b.estimated && serverPromptTokens > counted.tokens) c.scale = Math.max(c.scale, ((serverPromptTokens - (b.anchored ?? 0)) / b.estimated) * 1.05);
    c.anchor = { messages: b.messages, key: b.key, tokens: serverPromptTokens };
  }
}

/**
 * Output budget for one call: the session's max output, but never more than what is left in the window after
 * the prompt (minus a small margin). This replaces pi-ai's fixed 4,096-token safety clamp.
 */
export function callBudget(window: number, promptTokens: number, sessionMaxOutput: number, margin = 64): number {
  return Math.max(1, Math.min(sessionMaxOutput, window - promptTokens - margin));
}

/** Smallest reply room worth sending a request for; below it the call is refused with the numbers instead. */
export const MIN_REPLY_TOKENS = 128;
