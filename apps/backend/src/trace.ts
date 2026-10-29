// Per-session event emitter: assigns seq, persists non-streamed events, fans out to the hub.

import type { TraceEvent } from "@terrarium/shared";
import type { Hub } from "./hub.ts";
import type { Store } from "./store/db.ts";

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type EventInput = DistributiveOmit<TraceEvent, "sessionId" | "seq" | "ts">;

export interface Tracer {
  readonly sessionId: string;
  /** Persisted event with a new seq. */
  emit(event: EventInput): TraceEvent;
  /** Streamed-only event (model_delta, tool_output): reuses the current seq, not persisted. */
  stream(event: EventInput): void;
  lastSeq(): number;
}

export class SessionTracer implements Tracer {
  readonly sessionId: string;
  private seq: number;
  private store: Store;
  private hub: Hub;
  private onEmit?: (event: TraceEvent) => void;

  constructor(sessionId: string, lastSeq: number, store: Store, hub: Hub, onEmit?: (event: TraceEvent) => void) {
    this.sessionId = sessionId;
    this.seq = lastSeq;
    this.store = store;
    this.hub = hub;
    this.onEmit = onEmit;
  }

  emit(input: EventInput): TraceEvent {
    const event = { ...input, sessionId: this.sessionId, seq: ++this.seq, ts: Date.now() } as TraceEvent;
    this.store.appendEvent(event);
    this.store.run("UPDATE sessions SET last_seq = ?, updated_at = ? WHERE id = ?", this.seq, event.ts, this.sessionId);
    this.hub.trace(event);
    this.onEmit?.(event);
    return event;
  }

  stream(input: EventInput): void {
    this.hub.trace({ ...input, sessionId: this.sessionId, seq: this.seq, ts: Date.now() } as TraceEvent);
  }

  lastSeq(): number {
    return this.seq;
  }
}
