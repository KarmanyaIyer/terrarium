// Fan-out of WsMessages to connected UI clients. Trace events only go to clients subscribed to that session.

import type { Id, TraceEvent, WsMessage } from "@terrarium/shared";

export interface HubClient {
  send(data: string): void;
  subscriptions: Set<Id>;
  /** Bytes queued but not yet flushed; used to drop streamed-only events for slow clients. */
  buffered(): number;
}

const STREAM_ONLY = new Set(["model_delta", "tool_output"]);
const SLOW_CLIENT_BYTES = 8 * 1024 * 1024;

export class Hub {
  private clients = new Set<HubClient>();
  private listeners = new Set<(msg: WsMessage) => void>();

  add(client: HubClient): () => void {
    this.clients.add(client);
    return () => this.clients.delete(client);
  }

  get clientCount(): number {
    return this.clients.size;
  }

  /** In-process listeners (eval runner, tests) see every message. */
  listen(fn: (msg: WsMessage) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  broadcast(msg: WsMessage): void {
    for (const fn of this.listeners) fn(msg);
    if (this.clients.size === 0) return;
    const data = JSON.stringify(msg);
    for (const c of this.clients) c.send(data);
  }

  trace(event: TraceEvent): void {
    const msg: WsMessage = { type: "trace", event };
    for (const fn of this.listeners) fn(msg);
    if (this.clients.size === 0) return;
    const data = JSON.stringify(msg);
    const streamed = STREAM_ONLY.has(event.type);
    for (const c of this.clients) {
      if (!c.subscriptions.has(event.sessionId) && !c.subscriptions.has("*")) continue;
      if (streamed && c.buffered() > SLOW_CLIENT_BYTES) continue;
      c.send(data);
    }
  }
}
