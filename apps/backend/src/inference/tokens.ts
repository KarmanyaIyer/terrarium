// Exact prompt token counts from the inference server itself. oMLX's /v1/tokenize renders chat messages and
// tools through the same preparation and chat template as /v1/chat/completions, so its count is the
// prompt_tokens the call will report. Counts are cached by request content (compaction counts the same
// candidate prompt more than once, and the stream counts the prompt compaction settled on).

import { createHash } from "node:crypto";
import { errorMessage } from "../util/errors.ts";
import type { Upstream } from "./gateway.ts";

const CACHE_SIZE = 128;
// oMLX loads the model on a tokenize request when it isn't loaded (first use, or evicted since), which takes a while for
// a large model; after that a count takes milliseconds. A count that takes longer fails, and the run counts with estimates.
const LOAD_TIMEOUT_MS = 120_000;
const TIMEOUT_MS = 20_000;

export interface ChatCountBody {
  model: string;
  messages: unknown[];
  tools?: unknown[];
  chat_template_kwargs?: Record<string, unknown>;
}

export class TokenCounter {
  private upstream: Upstream;
  private cache = new Map<string, number>();

  constructor(upstream: Upstream) {
    this.upstream = upstream;
  }

  /**
   * Prompt tokens for a chat request, including the generation prompt the server appends. `signal`: the run's (Stop).
   * `mayLoad`: the model may not be loaded yet (a run's first count), so the server gets time to load it.
   */
  countChat(body: ChatCountBody, signal?: AbortSignal, mayLoad?: boolean): Promise<number> {
    const req = { model: body.model, messages: body.messages, ...(body.tools?.length ? { tools: body.tools } : {}), ...(body.chat_template_kwargs ? { chat_template_kwargs: body.chat_template_kwargs } : {}), add_generation_prompt: true };
    return this.cached(req, signal, mayLoad);
  }

  /** Tokens of plain text (no chat template, no special tokens). */
  countText(model: string, text: string, signal?: AbortSignal, mayLoad?: boolean): Promise<number> {
    return this.cached({ model, prompt: text, add_special_tokens: false }, signal, mayLoad);
  }

  private async cached(req: Record<string, unknown>, signal?: AbortSignal, mayLoad = false): Promise<number> {
    const json = JSON.stringify(req);
    const key = createHash("sha256").update(json).digest("hex");
    const hit = this.cache.get(key);
    if (hit !== undefined) {
      this.cache.delete(key);
      this.cache.set(key, hit);
      return hit;
    }
    signal?.throwIfAborted();
    const ms = mayLoad ? LOAD_TIMEOUT_MS : TIMEOUT_MS;
    const timeout = AbortSignal.timeout(ms);
    const fail = (err: unknown): never => {
      if (signal?.aborted) throw signal.reason;
      throw new Error(timeout.aborted ? `tokenizer did not answer within ${ms / 1000} s` : `tokenizer unreachable: ${errorMessage(err)}`);
    };
    const res = await fetch(`${this.upstream.baseUrl()}/v1/tokenize`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.upstream.apiKey()}`, "content-type": "application/json" },
      body: json,
      signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
    }).catch(fail);
    const text = await res.text().catch(fail);
    if (!res.ok) throw new Error(`tokenizer returned ${res.status}: ${text.slice(0, 300)}`);
    const count = (JSON.parse(text) as { count?: unknown }).count;
    if (typeof count !== "number" || !Number.isFinite(count)) throw new Error("tokenizer response has no count");
    this.cache.set(key, count);
    if (this.cache.size > CACHE_SIZE) this.cache.delete(this.cache.keys().next().value!);
    return count;
  }
}
