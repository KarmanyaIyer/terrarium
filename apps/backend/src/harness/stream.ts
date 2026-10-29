// Stream function for pi-agent-core that talks to oMLX through the logging gateway.
//
// pi-ai's streamSimple() clamps max_tokens to (contextWindow - estimated input - 4096) (simple-options.js
// clampMaxTokensToContext). On an 8K window that leaves a few hundred tokens or less, and estimates drift, so
// long sessions degrade into one-token replies. We call the openai-completions adapter's `stream` directly with
// an explicit max_tokens computed from the prompt's exact token count (budget.ts), so the clamp never runs. A
// prompt counted to leave less than MIN_REPLY_TOKENS of the window is not sent; the call fails with the numbers.

import type { StreamFn } from "@earendil-works/pi-agent-core";
import { type Api, type AssistantMessage, type AssistantMessageEvent, type AssistantMessageEventStream, type Context, createAssistantMessageEventStream, type Message, type Model } from "@earendil-works/pi-ai";
import { stream as openaiStream } from "@earendil-works/pi-ai/api/openai-completions";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import type { CallResult, Gateway } from "../inference/gateway.ts";
import type { Tracer } from "../trace.ts";
import { newId } from "../util/ids.ts";
import { callBudget, MIN_REPLY_TOKENS, type PromptCount, rawEstimate, type TokenCalibrator } from "./budget.ts";
import { type RepairInfo, withTextToolCallFallback } from "./fallback.ts";

export interface Sampling {
  temperature: number;
  topP: number;
  topK?: number;
  presencePenalty?: number;
}

export interface CallParams {
  modelId: string;
  window: number;
  maxOutput: number;
  thinking: boolean;
  sampling: Sampling;
  turn: number;
}

export interface CallInfo {
  callId: string;
  rawEstimate: number;
  /** Prompt tokens this call was sized with: exact when `prompt.exact`. */
  estimate: number;
  prompt: PromptCount;
  maxTokens: number;
  params: CallParams;
}

export interface StreamHooks {
  gateway: Gateway;
  tracer: Tracer;
  calibrator: TokenCalibrator;
  /** Prompt tokens for the messages being sent (budget.ts PromptCounter). Without it: calibrated heuristic. */
  count?(messages: Message[]): Promise<PromptCount>;
  params(): CallParams;
  /** Start oMLX and make sure the model accepts this window/output (oMLX loads the model on first request). */
  ensureReady(p: CallParams): Promise<void>;
  toolNames(): string[];
  fencedBash: boolean;
  /** Before the request is sent. */
  onCallStart?(info: CallInfo): void;
  /** The prompt leaves no room for a reply, so the request is not sent. Returns the error text to fail with. */
  onOverflow?(info: CallInfo): string | Promise<string>;
  /** Gateway finished the call (runs before the agent sees the final message). */
  onCallEnd(result: CallResult, info: CallInfo): void;
  onRepair(callId: string, info: RepairInfo): void;
  /** The server rejected a malformed tool call and the call is being retried. */
  onRetry?(callId: string, attempt: number, reason: string): void;
}

/** oMLX withholds tool-call markup it can't parse and fails the response (no text reaches us to repair). */
export const TOOL_PARSE_ERROR = /incomplete_tool_call|invalid_tool_call|unrecoverable tool call/i;
export const MAX_TOOL_PARSE_RETRIES = 2;

/** pi-ai Model for an oMLX model id. baseUrl is replaced per call with the gateway URL. */
export function omlxModel(id: string, window: number, maxOutput: number): Model<"openai-completions"> {
  return {
    id,
    name: id,
    api: "openai-completions",
    provider: "omlx",
    baseUrl: "http://127.0.0.1:1/v1",
    reasoning: false, // we set chat_template_kwargs ourselves; pi-ai must not add its own thinking fields
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: window,
    maxTokens: maxOutput,
    compat: {
      maxTokensField: "max_tokens",
      supportsDeveloperRole: false,
      supportsStore: false,
      supportsStrictMode: false,
      supportsUsageInStreaming: true,
    },
  } as Model<"openai-completions">;
}

/**
 * Retries a call when the server rejected a malformed tool call. Events of an attempt are buffered and
 * forwarded only once it is final, so the agent never sees two partial messages. (Live streaming to the UI
 * comes from the gateway's model_delta events, not from these.)
 */
export function makeStreamFn(h: StreamHooks): StreamFn {
  const once = makeSingleCall(h);
  return async (model: Model<Api>, context, options) => {
    const out = createAssistantMessageEventStream();
    void (async () => {
      for (let attempt = 0; ; attempt++) {
        const events: AssistantMessageEvent[] = [];
        let callId = "";
        let src: AssistantMessageEventStream;
        try {
          ({ stream: src, callId } = await once(model, context, options));
          for await (const ev of src) events.push(ev);
        } catch (err) {
          events.push({ type: "error", reason: "error", error: errorFor(model, err) } as AssistantMessageEvent);
        }
        const last = events.at(-1);
        const msg = last?.type === "error" ? last.error : undefined;
        const retry = msg && !options?.signal?.aborted && attempt < MAX_TOOL_PARSE_RETRIES && TOOL_PARSE_ERROR.test(msg.errorMessage ?? "");
        if (retry) {
          h.onRetry?.(callId, attempt + 1, msg.errorMessage ?? "tool call rejected by the server");
          continue;
        }
        for (const ev of events) out.push(ev);
        out.end();
        return;
      }
    })();
    return out;
  };
}

function errorFor(model: Model<Api>, err: unknown): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "error",
    errorMessage: err instanceof Error ? err.message : String(err),
    timestamp: Date.now(),
  };
}

const CAPTURED = Symbol("captured");

/**
 * The exact request body pi-ai builds for this context (messages, tools) plus our chat_template_kwargs, without
 * sending anything: pi-ai hands the body to onPayload before it opens a connection, and throwing there ends the
 * attempt.
 */
export async function requestBody(model: Model<"openai-completions">, context: Context, thinking: boolean): Promise<Record<string, unknown>> {
  let body: Record<string, unknown> | undefined;
  const s = openaiStream(model, normalizeContext(context), {
    apiKey: "count-only",
    maxRetries: 0,
    onPayload: (payload) => {
      body = payload as Record<string, unknown>;
      throw CAPTURED;
    },
  });
  await s.result();
  if (!body) throw new Error("pi-ai did not build a request body");
  return { ...body, chat_template_kwargs: { enable_thinking: thinking } };
}

/** An assistant stream that fails at once with `message` (nothing is sent). */
function failedStream(model: Model<Api>, message: string): AssistantMessageEventStream {
  const out = createAssistantMessageEventStream();
  out.push({ type: "error", reason: "error", error: errorFor(model, new Error(message)) } as AssistantMessageEvent);
  out.end();
  return out;
}

function makeSingleCall(h: StreamHooks) {
  return async (model: Model<Api>, context: Parameters<StreamFn>[1], options: Parameters<StreamFn>[2]): Promise<{ stream: AssistantMessageEventStream; callId: string }> => {
    const p = h.params();
    const raw = rawEstimate(context.messages);
    await h.ensureReady(p);
    const prompt: PromptCount = h.count ? await h.count(context.messages) : { tokens: Math.ceil(raw * h.calibrator.factor), exact: false };
    // An estimate is deliberately high (budget.ts ESTIMATE_SAFETY): it never refuses a call, and the reply keeps
    // at least MIN_REPLY_TOKENS; if the server finds the prompt too long, its error is explained (sessions.ts).
    const maxTokens = prompt.exact ? callBudget(p.window, prompt.tokens, p.maxOutput) : Math.min(p.maxOutput, Math.max(MIN_REPLY_TOKENS, p.window - prompt.tokens - 64));
    const callId = newId("call");
    const info: CallInfo = { callId, rawEstimate: raw, estimate: prompt.tokens, prompt, maxTokens, params: p };
    if (prompt.exact && p.window - prompt.tokens - 64 < MIN_REPLY_TOKENS) {
      const message =
        (await h.onOverflow?.(info)) ??
        `Request not sent: the prompt is ${prompt.exact ? "" : "about "}${prompt.tokens} tokens, which leaves no room for a reply in the ${p.window}-token context window.`;
      return { stream: failedStream(model, message), callId };
    }
    h.onCallStart?.(info);
    const { baseUrl, result } = h.gateway.register({
      tracer: h.tracer,
      callId,
      modelId: p.modelId,
      turn: p.turn,
      contextWindow: p.window,
      maxTokens,
      promptTokensEst: prompt.tokens,
      promptCount: prompt.exact ? "tokenizer" : "estimate",
    });
    result.then((r) => h.onCallEnd(r, info));
    const callModel = { ...(model as Model<"openai-completions">), id: p.modelId, baseUrl, contextWindow: p.window, maxTokens: p.maxOutput };
    const source = openaiStream(callModel, context, {
      apiKey: h.gateway.apiKey,
      signal: options?.signal,
      maxTokens,
      maxRetries: 0,
      temperature: p.sampling.temperature,
      samplingParams: {
        top_p: p.sampling.topP,
        ...(p.sampling.topK !== undefined ? { top_k: p.sampling.topK } : {}),
        ...(p.sampling.presencePenalty !== undefined ? { presence_penalty: p.sampling.presencePenalty } : {}),
      },
      onPayload: (payload) => ({ ...(payload as Record<string, unknown>), chat_template_kwargs: { enable_thinking: p.thinking } }),
    });
    // If the request never reached the gateway (client-side failure), settle the registered call.
    source.result().then(
      (m) => {
        if (m.stopReason === "error" || m.stopReason === "aborted") setTimeout(() => h.gateway.cancel(callId, m.errorMessage ?? m.stopReason), 2000);
      },
      () => h.gateway.cancel(callId, "stream failed"),
    );
    return { stream: withTextToolCallFallback(source, h.toolNames, { fencedBash: h.fencedBash, idPrefix: callId, onRepair: (r) => h.onRepair(callId, r) }), callId };
  };
}
