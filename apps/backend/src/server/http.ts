// HTTP + WebSocket server on 127.0.0.1. Every request passes the Host/Origin/token gate in auth.ts.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import type {
  CreateEnvRequest,
  CreateSessionRequest,
  ExecRequest,
  FinishReason,
  ForkEnvRequest,
  LoadModelRequest,
  ModelCallDetail,
  PathKey,
  ResetEnvRequest,
  SendMessageRequest,
  SnapshotEnvRequest,
  StartEvalRunRequest,
  TraceEvent,
  UpdateEnvRequest,
  UpdateModelRequest,
  UpdateSessionRequest,
  UpdateSettingsRequest,
  WsClientMessage,
} from "@terrarium/shared";
import { WebSocket, WebSocketServer } from "ws";
import type { App } from "../app.ts";
import { harnessInfo } from "../harness/profiles.ts";
import { HttpError, errorMessage } from "../util/errors.ts";
import { logger } from "../util/log.ts";
import { bearerOk, hostAllowed, offeredProtocols, originAllowed, wsTokenOk } from "./auth.ts";

const log = logger("http");

const BODY_CAP = 1024 * 1024;
const BODY_CAP_LARGE = 16 * 1024 * 1024; // env creation with seed files
const WS_MAX_PAYLOAD = 64 * 1024;
const EVENTS_PAGE = 5000;

interface Ctx {
  params: string[];
  query: URLSearchParams;
  body: any;
  req: IncomingMessage;
  res: ServerResponse;
}

/** Returned by handlers that wrote the response themselves. */
const HANDLED = Symbol("handled");

type Handler = (ctx: Ctx) => Promise<unknown> | unknown;

interface Route {
  method: string;
  pattern: RegExp;
  handler: Handler;
  status?: number;
  bodyCap?: number;
}

function intParam(q: URLSearchParams, name: string): number | undefined {
  const v = q.get(name);
  if (v === null || v === "") return undefined;
  const n = Number(v);
  if (!Number.isInteger(n)) throw new HttpError(400, `${name} must be an integer`);
  return n;
}

function optNumber(v: unknown, name: string, min: number, max = Number.MAX_SAFE_INTEGER): number | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "number" || !Number.isFinite(v) || v < min || v > max) throw new HttpError(400, `${name} must be a number between ${min} and ${max}`);
  return v;
}

function routes(app: App): Route[] {
  const r = (method: string, path: string, handler: Handler, extra: Partial<Route> = {}): Route => ({
    method,
    pattern: new RegExp(`^${path.replace(/:[a-zA-Z]+/g, "([^/]+)")}$`),
    handler,
    ...extra,
  });
  const { envs, sessions, inference, evals, files, store, settings, downloads } = app;
  return [
    r("GET", "/api/state", () => app.state()),

    // ---- envs ----
    r("GET", "/api/envs", () => envs.list()),
    r("POST", "/api/envs", ({ body }) => envs.create(body as CreateEnvRequest), { status: 201, bodyCap: BODY_CAP_LARGE }),
    r("GET", "/api/envs/:id", ({ params }) => envs.get(params[0])),
    r("PATCH", "/api/envs/:id", ({ params, body }) => {
      const b = (body ?? {}) as UpdateEnvRequest;
      return envs.update(params[0], { name: b.name, network: b.network });
    }),
    r("DELETE", "/api/envs/:id", async ({ params }) => {
      await envs.delete(params[0]);
    }),
    r("POST", "/api/envs/:id/start", ({ params }) => envs.start(params[0])),
    r("POST", "/api/envs/:id/stop", ({ params }) => envs.stop(params[0])),
    r("POST", "/api/envs/:id/reset", ({ params, body }) => envs.reset(params[0], ((body ?? {}) as ResetEnvRequest).snapshotId)),
    r("POST", "/api/envs/:id/snapshot", ({ params, body }) => envs.snapshot(params[0], ((body ?? {}) as SnapshotEnvRequest).label), { status: 201 }),
    r("POST", "/api/envs/:id/fork", ({ params, body }) => {
      const b = (body ?? {}) as ForkEnvRequest;
      return envs.fork(params[0], { name: b.name, snapshotId: b.snapshotId });
    }, { status: 201 }),
    r("GET", "/api/envs/:id/snapshots", ({ params }) => envs.snapshots(params[0])),
    r("GET", "/api/envs/:id/tree", ({ params, query }) => files.tree(params[0], { at: intParam(query, "at"), sessionId: query.get("sessionId") || undefined })),
    r("GET", "/api/envs/:id/file", ({ params, query }) => files.file(params[0], query.get("path"), { at: intParam(query, "at"), sessionId: query.get("sessionId") || undefined })),
    r("POST", "/api/envs/:id/exec", ({ params, body }) => envs.exec(params[0], (body ?? {}) as ExecRequest)),
    r("GET", "/api/envs/:id/net", ({ params, query }) => envs.netLog(params[0], intParam(query, "limit") ?? 500)),

    // ---- sessions ----
    r("GET", "/api/sessions", () => sessions.list()),
    r("POST", "/api/sessions", ({ body }) => sessions.create((body ?? {}) as CreateSessionRequest), { status: 201 }),
    r("GET", "/api/sessions/:id", ({ params }) => sessions.get(params[0])),
    r("PATCH", "/api/sessions/:id", ({ params, body }) => sessions.update(params[0], (body ?? {}) as UpdateSessionRequest)),
    r("DELETE", "/api/sessions/:id", async ({ params }) => {
      await sessions.delete(params[0]);
    }),
    r("GET", "/api/sessions/:id/prompt", ({ params }) => sessions.prompt(params[0])),
    r("GET", "/api/sessions/:id/events", ({ params, query }) => {
      const after = intParam(query, "after") ?? 0;
      const limit = intParam(query, "limit");
      if (limit !== undefined) return sessions.events(params[0], after, Math.min(Math.max(limit, 1), 20000));
      // No limit: the whole history after `after`, read in pages until a short one, so long sessions keep their end.
      const out: TraceEvent[] = [];
      for (let from = after; ; ) {
        const page = sessions.events(params[0], from, EVENTS_PAGE);
        out.push(...page);
        if (page.length < EVENTS_PAGE) return out;
        from = page[page.length - 1].seq;
      }
    }),
    r("POST", "/api/sessions/:id/messages", ({ params, body }) => sessions.sendMessage(params[0], ((body ?? {}) as SendMessageRequest).text), { status: 202 }),
    r("POST", "/api/sessions/:id/continue", ({ params }) => sessions.continue(params[0]), { status: 202 }),
    r("POST", "/api/sessions/:id/retry", ({ params }) => sessions.retry(params[0]), { status: 202 }),
    r("POST", "/api/sessions/:id/stop", ({ params }) => sessions.stop(params[0])),

    // ---- model calls / blobs ----
    r("GET", "/api/model-calls/:id", ({ params }) => {
      const row = store.get<Record<string, any>>("SELECT * FROM model_calls WHERE id = ?", params[0]);
      if (!row) throw new HttpError(404, `model call not found: ${params[0]}`);
      const detail: ModelCallDetail = {
        id: row.id,
        sessionId: row.session_id,
        seq: row.seq,
        modelId: row.model_id,
        request: row.request_blob ? store.blobs.getJson(row.request_blob) : null,
        response: row.response_blob ? store.blobs.getJson(row.response_blob) : null,
        ...(row.raw_blob ? { rawResponseBlob: row.raw_blob } : {}),
        finishReason: (row.finish_reason ?? "error") as FinishReason,
        ...(row.usage_json ? { usage: JSON.parse(row.usage_json) } : {}),
        timing: row.timing_json ? JSON.parse(row.timing_json) : { totalMs: 0 },
        contextWindow: row.context_window ?? 0,
        maxTokens: row.max_tokens ?? 0,
      };
      return detail;
    }),
    r("GET", "/api/blobs/:sha", ({ params, req, res }) => {
      const sha = params[0];
      if (!/^[0-9a-f]{64}$/.test(sha)) throw new HttpError(400, "invalid blob id");
      const data = store.blobs.get(sha);
      if (!data) throw new HttpError(404, "blob not found");
      // Same CORS headers as JSON routes: the UI reads blobs cross-origin (Vite dev server, tauri://localhost).
      for (const [k, v] of Object.entries(baseHeaders(typeof req.headers.origin === "string" ? req.headers.origin : undefined))) res.setHeader(k, v);
      res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": data.length, "Cache-Control": "private, max-age=31536000, immutable" });
      res.end(data);
      return HANDLED;
    }),

    // ---- settings / harness ----
    r("GET", "/api/settings", () => settings.info()),
    r("PATCH", "/api/settings", ({ body }) => settings.update((body ?? {}) as UpdateSettingsRequest)),
    r("POST", "/api/reveal", ({ body }) => {
      settings.reveal(((body ?? {}) as { path: PathKey }).path);
      return { ok: true };
    }),
    r("GET", "/api/harness", () => harnessInfo(settings.prompts())),

    // ---- models / inference ----
    r("GET", "/api/models", () => inference.models()),
    r("GET", "/api/models/suggestions", () => downloads.suggestions()),
    r("POST", "/api/models/inspect", ({ body }) => downloads.inspect(((body ?? {}) as { repo?: unknown }).repo)),
    r("GET", "/api/models/downloads", () => downloads.list()),
    r("POST", "/api/models/downloads", ({ body }) => downloads.start(((body ?? {}) as { repo?: unknown }).repo), { status: 201 }),
    r("POST", "/api/models/downloads/:id/cancel", ({ params }) => downloads.cancel(params[0])),
    r("DELETE", "/api/models/:id", async ({ params }) => {
      const id = params[0];
      const res = await downloads.remove(id);
      store.run("DELETE FROM settings WHERE key = ?", `model:${id}`);
      if (settings.get().newSession.modelId === id) settings.update({ newSession: { modelId: null } });
      return res;
    }),
    r("POST", "/api/models/:id/load", async ({ params, body }) => {
      const id = params[0];
      if (!(await inference.model(id))) throw new HttpError(404, `model not found: ${id}`);
      const context = optNumber(((body ?? {}) as LoadModelRequest).context, "context", 2048);
      await inference.load(id, context);
      return inference.model(id);
    }),
    r("POST", "/api/models/:id/unload", async ({ params }) => {
      const id = params[0];
      if (!(await inference.model(id))) throw new HttpError(404, `model not found: ${id}`);
      await inference.unload(id);
      return inference.model(id);
    }),
    r("PATCH", "/api/models/:id", async ({ params, body }) => {
      const id = params[0];
      if (!(await inference.model(id))) throw new HttpError(404, `model not found: ${id}`);
      const b = (body ?? {}) as UpdateModelRequest;
      const s = b.sampling ?? {};
      return inference.updateModel(id, {
        defaultContext: optNumber(b.defaultContext, "defaultContext", 2048),
        defaultMaxOutput: optNumber(b.defaultMaxOutput, "defaultMaxOutput", 16),
        sampling: {
          ...(s.temperature !== undefined ? { temperature: optNumber(s.temperature, "temperature", 0, 5) } : {}),
          ...(s.topP !== undefined ? { topP: optNumber(s.topP, "topP", 0, 1) } : {}),
          ...(s.topK !== undefined ? { topK: optNumber(s.topK, "topK", 0, 1000) } : {}),
          ...(s.presencePenalty !== undefined ? { presencePenalty: optNumber(s.presencePenalty, "presencePenalty", -2, 2) } : {}),
        },
      });
    }),
    r("POST", "/api/inference/start", async () => {
      await inference.start();
      return inference.inferenceState();
    }),
    r("POST", "/api/inference/stop", async () => {
      await inference.stop();
      return inference.inferenceState();
    }),

    // ---- evals ----
    r("GET", "/api/evals/suites", () => evals.suites()),
    r("GET", "/api/evals/runs", () => evals.list()),
    r("POST", "/api/evals/runs", ({ body }) => evals.start((body ?? {}) as StartEvalRunRequest), { status: 201 }),
    r("GET", "/api/evals/runs/:id", ({ params }) => evals.detail(params[0])),
    r("POST", "/api/evals/runs/:id/stop", ({ params }) => evals.stop(params[0])),
  ];
}

function readBody(req: IncomingMessage, cap: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers["content-length"] ?? 0);
    if (declared > cap) {
      reject(new HttpError(413, `request body larger than ${cap} bytes`));
      req.resume();
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > cap) {
        reject(new HttpError(413, `request body larger than ${cap} bytes`));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function baseHeaders(origin: string | undefined): Record<string, string> {
  return {
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    ...(origin
      ? {
          "Access-Control-Allow-Origin": origin,
          Vary: "Origin",
          "Access-Control-Allow-Headers": "Authorization, Content-Type",
          "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
          "Access-Control-Max-Age": "600",
        }
      : {}),
  };
}

function sendJson(res: ServerResponse, status: number, value: unknown, origin: string | undefined): void {
  if (res.headersSent) return;
  for (const [k, v] of Object.entries(baseHeaders(origin))) res.setHeader(k, v);
  if (value === undefined) {
    res.writeHead(status === 200 ? 204 : status);
    res.end();
    return;
  }
  const body = JSON.stringify(value);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(body) });
  res.end(body);
}

export interface ApiServer {
  server: Server;
  listen(port: number): Promise<number>;
  close(): Promise<void>;
}

export function createApiServer(app: App): ApiServer {
  const table = routes(app);
  let port = 0;
  const server = createServer({ requestTimeout: 0, headersTimeout: 30_000 }, (req, res) => void handle(req, res));
  server.keepAliveTimeout = 5_000;

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const origin = typeof req.headers.origin === "string" ? req.headers.origin : undefined;
    if (!hostAllowed(req.headers.host, port)) return sendJson(res, 403, { error: "host not allowed" }, undefined);
    if (!originAllowed(origin)) return sendJson(res, 403, { error: "origin not allowed" }, undefined);
    if (req.method === "OPTIONS") return sendJson(res, 204, undefined, origin);
    if (!bearerOk(req, app.config.token)) return sendJson(res, 401, { error: "missing or invalid token" }, origin);
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
    let match: { route: Route; params: string[] } | null = null;
    let pathMatched = false;
    for (const route of table) {
      const m = route.pattern.exec(url.pathname);
      if (!m) continue;
      pathMatched = true;
      if (route.method !== req.method) continue;
      let params: string[];
      try {
        params = m.slice(1).map((p) => decodeURIComponent(p));
      } catch {
        return sendJson(res, 400, { error: "malformed percent-escape in path" }, origin);
      }
      match = { route, params };
      break;
    }
    if (!match) return sendJson(res, pathMatched ? 405 : 404, { error: pathMatched ? "method not allowed" : "not found" }, origin);
    try {
      let body: unknown;
      if (req.method === "POST" || req.method === "PATCH" || req.method === "PUT") {
        const raw = await readBody(req, match.route.bodyCap ?? BODY_CAP);
        if (raw.length) {
          const ct = String(req.headers["content-type"] ?? "");
          if (!ct.startsWith("application/json")) throw new HttpError(415, "content-type must be application/json");
          try {
            body = JSON.parse(raw.toString("utf8"));
          } catch {
            throw new HttpError(400, "invalid JSON body");
          }
          if (body === null || typeof body !== "object" || Array.isArray(body)) throw new HttpError(400, "body must be a JSON object");
        }
      } else {
        req.resume();
      }
      const out = await match.route.handler({ params: match.params, query: url.searchParams, body, req, res });
      if (out === HANDLED) return;
      sendJson(res, match.route.status ?? 200, out, origin);
    } catch (err) {
      if (err instanceof HttpError) return sendJson(res, err.status, { error: err.message, ...(err.detail ? { detail: err.detail } : {}) }, origin);
      log.error(`${req.method} ${url.pathname} failed`, err);
      sendJson(res, 500, { error: errorMessage(err) }, origin);
    }
  }

  // ---- WebSocket ----
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: WS_MAX_PAYLOAD,
    perMessageDeflate: false,
    handleProtocols: (protocols) => wsTokenOk(protocols, app.config.token) ?? false,
  });

  function reject(socket: Duplex, status: number, text: string): void {
    socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  }

  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const origin = typeof req.headers.origin === "string" ? req.headers.origin : undefined;
    const path = (req.url ?? "").split("?")[0];
    if (path !== "/api/ws") return reject(socket, 404, "Not Found");
    if (!hostAllowed(req.headers.host, port) || !originAllowed(origin)) return reject(socket, 403, "Forbidden");
    if (!wsTokenOk(offeredProtocols(req), app.config.token)) return reject(socket, 401, "Unauthorized");
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  });

  wss.on("connection", (ws: WebSocket) => {
    const subscriptions = new Set<string>();
    const remove = app.hub.add({
      send: (data) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(data);
      },
      subscriptions,
      buffered: () => ws.bufferedAmount,
    });
    let alive = true;
    const ping = setInterval(() => {
      if (!alive) return ws.terminate();
      alive = false;
      ws.ping();
    }, 30_000);
    ping.unref();
    ws.on("pong", () => (alive = true));
    ws.on("message", (data) => {
      alive = true;
      let msg: WsClientMessage;
      try {
        msg = JSON.parse(data.toString()) as WsClientMessage;
      } catch {
        return;
      }
      if (msg?.type === "subscribe" && Array.isArray(msg.sessionIds)) {
        subscriptions.clear();
        for (const id of msg.sessionIds.slice(0, 1000)) if (typeof id === "string") subscriptions.add(id);
      }
    });
    ws.on("close", () => {
      clearInterval(ping);
      remove();
    });
    ws.on("error", () => ws.terminate());
    app
      .state()
      .then((state) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "hello", state }));
      })
      .catch((err) => log.warn("hello failed", err));
  });

  return {
    server,
    listen(p: number) {
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(p, "127.0.0.1", () => {
          server.off("error", reject);
          const addr = server.address();
          port = typeof addr === "object" && addr ? addr.port : p;
          resolve(port);
        });
      });
    },
    close() {
      for (const ws of wss.clients) ws.terminate();
      return new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    },
  };
}
