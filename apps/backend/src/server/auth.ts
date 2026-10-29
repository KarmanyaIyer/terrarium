// Request gate for the local API: exact Host, Origin allowlist, bearer token (header for HTTP,
// `Sec-WebSocket-Protocol: terrarium.<token>` for the WebSocket).

import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { ALLOWED_ORIGINS } from "../config.ts";

export const WS_PROTOCOL_PREFIX = "terrarium.";

export function tokenEquals(got: string, want: string): boolean {
  const a = Buffer.from(got);
  const b = Buffer.from(want);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Host must be exactly 127.0.0.1:<port> or localhost:<port> (blocks DNS rebinding). */
export function hostAllowed(host: string | undefined, port: number): boolean {
  return host === `127.0.0.1:${port}` || host === `localhost:${port}`;
}

/** Browsers always send Origin on CORS and WebSocket requests; absent Origin means a non-browser client. */
export function originAllowed(origin: string | undefined): boolean {
  return origin === undefined || ALLOWED_ORIGINS.has(origin);
}

export function bearerOk(req: IncomingMessage, token: string): boolean {
  const h = req.headers.authorization;
  if (typeof h !== "string" || !h.startsWith("Bearer ")) return false;
  return tokenEquals(h.slice(7), token);
}

/** Offered WebSocket subprotocols, from the raw header. */
export function offeredProtocols(req: IncomingMessage): string[] {
  const raw = req.headers["sec-websocket-protocol"];
  if (typeof raw !== "string") return [];
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

export function wsTokenOk(protocols: Iterable<string>, token: string): string | null {
  for (const p of protocols) if (p.startsWith(WS_PROTOCOL_PREFIX) && tokenEquals(p.slice(WS_PROTOCOL_PREFIX.length), token)) return p;
  return null;
}
