// Token accounting. Prompts are counted exactly by the inference server's own tokenizer and chat template
// (inference/tokens.ts) on the exact body pi-ai builds, before the request is sent. The server's usage
// (prompt_tokens) after each call checks that count; any shortfall it shows is added to later counts. When the
// tokenizer can't be reached, a heuristic calibrated against server usage, scaled up by a safety factor, stands in
// and is labeled an estimate.

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import { estimateMessageTokens } from "@earendil-works/pi-ai/utils/estimate";
import { errorMessage } from "../util/errors.ts";
import { logger } from "../util/log.ts";

const log = logger("budget");

/** The heuristic misses by up to ~35% on dense text (ids, numbers, code); estimates are scaled up by this. */
export const ESTIMATE_SAFETY = 1.35;

export function rawEstimate(messages: AgentMessage[]): number {
  const llm = messages.filter((m) => m.role === "system" || m.role === "user" || m.role === "assistant" || m.role === "toolResult") as Message[];
  // Pure per-message heuristic (system messages include declared tools). Not estimateContextTokens: that anchors
  // on the last assistant usage, which is stale after compaction and would be double-scaled by the calibrator.
  let total = 0;
  for (const m of llm) total += estimateMessageTokens(m);
  return total;
}

export class TokenCalibrator {
  private ratio = 1;

  /** Record server truth for a request whose messages estimated to `estimated` tokens. */
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

export interface PromptCount {
  tokens: number;
  /** Counted by the server's tokenizer (plus any correction from server usage), not estimated. */
  exact: boolean;
  /** The tokenizer's own count, before the correction. */
  tokenized?: number;
}

/** The server's tokenizer (inference/tokens.ts), or a fake in tests. */
export interface ChatTokenizer {
  countChat(body: { model: string; messages: unknown[]; tools?: unknown[]; chat_template_kwargs?: Record<string, unknown> }): Promise<number>;
  countText(model: string, text: string): Promise<number>;
}

export interface PromptCounterOptions {
  modelId: string;
  tokenizer?: ChatTokenizer;
  calibrator: TokenCalibrator;
  /** The exact request body pi-ai would send for these messages (stream.ts requestBody). */
  body(messages: Message[]): Promise<Record<string, unknown>>;
}

/** Counts prompts for one run of one session. */
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

  /** Why the last exact count failed, if it did. */
  get lastFailure(): string | null {
    return this.failed;
  }

  estimate(messages: AgentMessage[]): number {
    return Math.ceil(rawEstimate(messages) * Math.max(1, this.opts.calibrator.factor) * ESTIMATE_SAFETY);
  }

  async count(messages: AgentMessage[]): Promise<PromptCount> {
    const llm = messages.filter((m) => m.role === "system" || m.role === "user" || m.role === "assistant" || m.role === "toolResult") as Message[];
    if (this.opts.tokenizer) {
      try {
        const body = await this.opts.body(llm);
        const n = await this.opts.tokenizer.countChat({
          model: this.opts.modelId,
          messages: body.messages as unknown[],
          ...(Array.isArray(body.tools) ? { tools: body.tools } : {}),
          ...(body.chat_template_kwargs ? { chat_template_kwargs: body.chat_template_kwargs as Record<string, unknown> } : {}),
        });
        this.failed = null;
        return { tokens: n + this.correction, exact: true, tokenized: n };
      } catch (err) {
        if (this.failed === null) log.warn(`exact token count failed; using estimates: ${errorMessage(err)}`);
        this.failed = errorMessage(err);
      }
    }
    return { tokens: this.estimate(messages), exact: false };
  }

  /**
   * System prompt + tool declarations. Chat templates refuse a prompt with no user turn (Qwen: "No user query
   * found"), so this counts them with an empty user turn and subtracts that turn counted alone.
   */
  async countSystem(system: AgentMessage[]): Promise<PromptCount> {
    const empty = { role: "user", content: "", timestamp: 0 } as AgentMessage;
    const [withSystem, bare] = await Promise.all([this.count([...system, empty]), this.count([empty])]);
    if (withSystem.tokenized !== undefined && bare.tokenized !== undefined) return { tokens: withSystem.tokenized - bare.tokenized, exact: true };
    return { tokens: this.estimate(system), exact: false };
  }

  async countText(text: string): Promise<PromptCount> {
    if (this.opts.tokenizer) {
      try {
        return { tokens: await this.opts.tokenizer.countText(this.opts.modelId, text), exact: true };
      } catch {}
    }
    return { tokens: Math.ceil((text.length / 3.5) * Math.max(1, this.opts.calibrator.factor) * ESTIMATE_SAFETY), exact: false };
  }

  /** Server usage for a call whose prompt we counted as `counted` (raw heuristic `raw`). */
  observe(counted: PromptCount, raw: number, serverPromptTokens: number): void {
    this.opts.calibrator.observe(raw, serverPromptTokens);
    if (counted.tokenized !== undefined) this.correction = Math.max(0, serverPromptTokens - counted.tokenized);
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
