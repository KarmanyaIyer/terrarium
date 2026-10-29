// Logging gateway: an in-process HTTP proxy on 127.0.0.1. Harness calls go to
// http://127.0.0.1:<port>/s/<sessionId>/<callId>/v1/chat/completions. The gateway records the exact request
// bytes and the raw response stream, assembles the final response, measures timing, emits model_call_* events
// and stores a model_calls row, then forwards everything unchanged to oMLX.

import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { FinishReason, ModelCallTiming, ModelCallUsage } from "@terrarium/shared";
import type { Store } from "../store/db.ts";
import type { Tracer } from "../trace.ts";
import { errorMessage } from "../util/errors.ts";
import { logger } from "../util/log.ts";
import { SseAssembler } from "./sse.ts";

const log = logger("gateway");
const MAX_REQUEST_BYTES = 32 * 1024 * 1024;
const MAX_RAW_BYTES = 64 * 1024 * 1024;

export interface Upstream {
  baseUrl(): string;
  apiKey(): string;
  ensureReady(): Promise<void>;
}

export interface CallContext {
  tracer: Tracer;
  callId: string;
  modelId: string;
  turn: number;
  contextWindow: number;
  maxTokens: number;
  promptTokensEst: number;
}

export interface CallResult {
  callId: string;
  startSeq: number;
  finishReason: FinishReason;
  usage?: ModelCallUsage;
  timing: ModelCallTiming;
  error?: string;
  response?: Record<string, unknown>;
}

export function mapFinishReason(raw: string | null | undefined): FinishReason {
  switch (raw) {
    case "stop":
    case "length":
    case "tool_calls":
      return raw;
    case "function_call":
      return "tool_calls";
    default:
      return "stop";
  }
}

export function usageFrom(u: Record<string, any> | null | undefined): ModelCallUsage | undefined {
  if (!u) return undefined;
  return {
    promptTokens: u.prompt_tokens ?? u.input_tokens ?? 0,
    completionTokens: u.completion_tokens ?? u.output_tokens ?? 0,
    cachedTokens: u.prompt_tokens_details?.cached_tokens,
    reasoningTokens: u.completion_tokens_details?.reasoning_tokens,
  };
}

/** Prefer the server's own measurements (oMLX reports them in usage); fall back to ours. */
export function timingFrom(u: Record<string, any> | null | undefined, startedAt: number, firstTokenAt: number | null, endedAt: number, usage?: ModelCallUsage): ModelCallTiming {
  const totalMs = endedAt - startedAt;
  const ttftMs = typeof u?.time_to_first_token === "number" ? Math.round(u.time_to_first_token * 1000) : firstTokenAt !== null ? firstTokenAt - startedAt : undefined;
  let promptTps: number | undefined = typeof u?.prompt_tokens_per_second === "number" ? u.prompt_tokens_per_second : undefined;
  let genTps: number | undefined = typeof u?.generation_tokens_per_second === "number" ? u.generation_tokens_per_second : undefined;
  if (promptTps === undefined && usage && ttftMs) promptTps = Math.round(((usage.promptTokens - (usage.cachedTokens ?? 0)) / (ttftMs / 1000)) * 100) / 100;
  if (genTps === undefined && usage && ttftMs !== undefined && totalMs > ttftMs) genTps = Math.round((usage.completionTokens / ((totalMs - ttftMs) / 1000)) * 100) / 100;
  return { ttftMs, totalMs, promptTps, genTps };
}

export class Gateway {
  private server: Server | null = null;
  private port = 0;
  private secret = randomBytes(24).toString("hex");
  private pending = new Map<string, { ctx: CallContext; resolve: (r: CallResult) => void }>();
  private store: Store;
  private upstream: Upstream;

  constructor(store: Store, upstream: Upstream) {
    this.store = store;
    this.upstream = upstream;
  }

  get apiKey(): string {
    return this.secret;
  }

  async listen(): Promise<number> {
    this.server = createServer((req, res) => {
      this.handle(req, res).catch((err) => {
        log.error("gateway handler failed", err);
        if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: errorMessage(err) } }));
      });
    });
    this.server.requestTimeout = 0;
    this.server.headersTimeout = 30_000;
    await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
    this.port = (this.server.address() as { port: number }).port;
    return this.port;
  }

  async close(): Promise<void> {
    for (const { ctx, resolve } of this.pending.values()) resolve({ callId: ctx.callId, startSeq: 0, finishReason: "aborted", timing: { totalMs: 0 }, error: "gateway closed" });
    this.pending.clear();
    if (this.server) await new Promise<void>((r) => this.server!.close(() => r()));
    this.server?.closeAllConnections();
  }

  /** Registers one model call. Returns the OpenAI base URL to use and a promise of the call's result. */
  register(ctx: CallContext): { baseUrl: string; result: Promise<CallResult> } {
    let resolve!: (r: CallResult) => void;
    const result = new Promise<CallResult>((r) => (resolve = r));
    this.pending.set(ctx.callId, { ctx, resolve });
    return { baseUrl: `http://127.0.0.1:${this.port}/s/${encodeURIComponent(ctx.tracer.sessionId)}/${encodeURIComponent(ctx.callId)}/v1`, result };
  }

  /** Called when a registered call never reached the gateway (request setup failed client-side). */
  cancel(callId: string, error: string): void {
    const p = this.pending.get(callId);
    if (!p) return;
    this.pending.delete(callId);
    p.resolve({ callId, startSeq: 0, finishReason: "error", timing: { totalMs: 0 }, error });
  }

  private authorized(req: IncomingMessage): boolean {
    const got = Buffer.from(String(req.headers.authorization ?? ""));
    const want = Buffer.from(`Bearer ${this.secret}`);
    return got.length === want.length && timingSafeEqual(got, want);
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const m = /^\/s\/([^/]+)\/([^/]+)\/v1\/chat\/completions$/.exec(req.url ?? "");
    if (req.method !== "POST" || !m) {
      res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: "not found" } }));
      return;
    }
    if (!this.authorized(req)) {
      res.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: "unauthorized" } }));
      return;
    }
    const callId = decodeURIComponent(m[2]);
    const pending = this.pending.get(callId);
    if (!pending || pending.ctx.tracer.sessionId !== decodeURIComponent(m[1])) {
      res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: "unknown call" } }));
      return;
    }
    this.pending.delete(callId);
    const { ctx, resolve } = pending;

    const chunks: Buffer[] = [];
    let size = 0;
    for await (const c of req) {
      size += (c as Buffer).length;
      if (size > MAX_REQUEST_BYTES) {
        res.writeHead(413).end();
        resolve({ callId, startSeq: 0, finishReason: "error", timing: { totalMs: 0 }, error: "request too large" });
        return;
      }
      chunks.push(c as Buffer);
    }
    const body = Buffer.concat(chunks);
    const requestBlob = this.store.blobs.put(body);
    let requestJson: any = {};
    try {
      requestJson = JSON.parse(body.toString("utf8"));
    } catch {}
    const streamed = requestJson.stream === true;

    const start = ctx.tracer.emit({
      type: "model_call_start",
      callId,
      turn: ctx.turn,
      modelId: ctx.modelId,
      promptTokensEst: ctx.promptTokensEst,
      contextWindow: ctx.contextWindow,
      maxTokens: ctx.maxTokens,
    });
    const startedAt = Date.now();
    const asm = new SseAssembler();
    let finalized = false;
    let rawOverflow = false;

    const finalize = (finishReason: FinishReason, error?: string, response?: Record<string, unknown>, rawUsage?: Record<string, any> | null) => {
      if (finalized) return;
      finalized = true;
      const endedAt = Date.now();
      const usage = usageFrom(rawUsage);
      const timing = timingFrom(rawUsage, startedAt, asm.firstTokenAt, endedAt, usage);
      const rawBlob = streamed && asm.raw ? this.store.blobs.put(asm.raw) : undefined;
      const responseBlob = response ? this.store.blobs.putJson(response) : undefined;
      ctx.tracer.emit({ type: "model_call_end", callId, finishReason, usage, timing, ...(error ? { error } : {}) });
      this.store.run(
        "INSERT OR REPLACE INTO model_calls (id, session_id, seq, model_id, request_blob, response_blob, raw_blob, finish_reason, usage_json, timing_json, context_window, max_tokens, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        callId,
        ctx.tracer.sessionId,
        start.seq,
        ctx.modelId,
        requestBlob,
        responseBlob ?? null,
        rawBlob ?? null,
        finishReason,
        usage ? JSON.stringify(usage) : null,
        JSON.stringify(timing),
        ctx.contextWindow,
        ctx.maxTokens,
        startedAt,
      );
      resolve({ callId, startSeq: start.seq, finishReason, usage, timing, error, response });
    };

    const upstreamAbort = new AbortController();
    res.on("close", () => {
      if (!res.writableFinished) {
        upstreamAbort.abort();
        finalize("aborted", "client closed the connection", asm.chunks ? asm.response() : undefined, asm.usage);
      }
    });

    let upstreamRes: Response;
    try {
      await this.upstream.ensureReady();
      upstreamRes = await fetch(`${this.upstream.baseUrl()}/v1/chat/completions`, {
        method: "POST",
        headers: { authorization: `Bearer ${this.upstream.apiKey()}`, "content-type": "application/json", accept: streamed ? "text/event-stream" : "application/json" },
        body,
        signal: upstreamAbort.signal,
      });
    } catch (err) {
      const message = `inference server unreachable: ${errorMessage(err)}`;
      finalize(upstreamAbort.signal.aborted ? "aborted" : "error", message);
      if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message } }));
      return;
    }

    if (!upstreamRes.ok || !upstreamRes.body) {
      const text = await upstreamRes.text().catch(() => "");
      let message = `inference server returned ${upstreamRes.status}`;
      try {
        const j = JSON.parse(text);
        message += `: ${typeof j.detail === "string" ? j.detail : (j.error?.message ?? JSON.stringify(j.detail ?? j).slice(0, 500))}`;
      } catch {
        if (text) message += `: ${text.slice(0, 500)}`;
      }
      finalize("error", message, text ? { error: text.slice(0, 20000) } : undefined);
      res.writeHead(upstreamRes.status, { "content-type": upstreamRes.headers.get("content-type") ?? "application/json" });
      res.end(text);
      return;
    }

    res.writeHead(upstreamRes.status, {
      "content-type": upstreamRes.headers.get("content-type") ?? (streamed ? "text/event-stream" : "application/json"),
      "cache-control": "no-cache",
    });

    if (!streamed) {
      const text = await upstreamRes.text();
      let json: any = null;
      try {
        json = JSON.parse(text);
      } catch {}
      const choice = json?.choices?.[0];
      if (choice?.message?.content || choice?.message?.tool_calls) asm.firstTokenAt = Date.now();
      finalize(mapFinishReason(choice?.finish_reason), json ? undefined : "invalid JSON from inference server", json ?? { raw: text.slice(0, 20000) }, json?.usage);
      res.end(text);
      return;
    }

    const decoder = new TextDecoder();
    try {
      for await (const part of upstreamRes.body as AsyncIterable<Uint8Array>) {
        const text = decoder.decode(part, { stream: true });
        if (asm.raw.length + text.length > MAX_RAW_BYTES) rawOverflow = true;
        const deltas = rawOverflow ? [] : asm.push(text);
        for (const d of deltas) ctx.tracer.stream({ type: "model_delta", callId, kind: d.kind, delta: d.delta });
        // Emit model_call_end before the client sees [DONE], so trace order is call end -> assistant message.
        if (asm.done) finalize(mapFinishReason(asm.finishReason), undefined, asm.response(), asm.usage);
        res.write(part);
      }
      asm.end();
      finalize(asm.finishReason ? mapFinishReason(asm.finishReason) : "error", asm.finishReason ? undefined : "stream ended without finish_reason", asm.response(), asm.usage);
      res.end();
    } catch (err) {
      finalize(upstreamAbort.signal.aborted ? "aborted" : "error", errorMessage(err), asm.chunks ? asm.response() : undefined, asm.usage);
      res.destroy();
    }
  }
}
