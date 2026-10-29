// Stream function for pi-agent-core that talks to oMLX through the logging gateway.
//
// pi-ai's streamSimple() clamps max_tokens to (contextWindow - estimated input - 4096) (simple-options.js
// clampMaxTokensToContext). On an 8K window that leaves a few hundred tokens or less, and estimates drift, so
// long sessions degrade into one-token replies. We call the openai-completions adapter's `stream` directly with
// an explicit max_tokens computed from server-calibrated token counts (budget.ts), so the clamp never runs.

import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import { stream as openaiStream } from "@earendil-works/pi-ai/api/openai-completions";
import type { CallResult, Gateway } from "../inference/gateway.ts";
import type { Tracer } from "../trace.ts";
import { newId } from "../util/ids.ts";
import { callBudget, rawEstimate, type TokenCalibrator } from "./budget.ts";
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
  estimate: number;
  maxTokens: number;
  params: CallParams;
}

export interface StreamHooks {
  gateway: Gateway;
  tracer: Tracer;
  calibrator: TokenCalibrator;
  params(): CallParams;
  /** Start oMLX and make sure the model accepts this window/output (oMLX loads the model on first request). */
  ensureReady(p: CallParams): Promise<void>;
  toolNames(): string[];
  fencedBash: boolean;
  /** Before the request is sent (lets the session refuse a call that can't fit). */
  onCallStart?(info: CallInfo): void;
  /** Gateway finished the call (runs before the agent sees the final message). */
  onCallEnd(result: CallResult, info: CallInfo): void;
  onRepair(callId: string, info: RepairInfo): void;
}

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

export function makeStreamFn(h: StreamHooks): StreamFn {
  return async (model: Model<Api>, context, options) => {
    const p = h.params();
    const raw = rawEstimate(context.messages);
    const estimate = Math.ceil(raw * h.calibrator.factor);
    const maxTokens = callBudget(p.window, estimate, p.maxOutput);
    const callId = newId("call");
    const info: CallInfo = { callId, rawEstimate: raw, estimate, maxTokens, params: p };
    await h.ensureReady(p);
    h.onCallStart?.(info);
    const { baseUrl, result } = h.gateway.register({
      tracer: h.tracer,
      callId,
      modelId: p.modelId,
      turn: p.turn,
      contextWindow: p.window,
      maxTokens,
      promptTokensEst: estimate,
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
    return withTextToolCallFallback(source, h.toolNames, { fencedBash: h.fencedBash, idPrefix: callId, onRepair: (r) => h.onRepair(callId, r) });
  };
}
