import type { FileChange, NetEntry, TraceEvent } from "@terrarium/shared";
import type { LiveCall, OutChunk, Selection, Trace } from "../state/store";

export type Ev<T extends TraceEvent["type"]> = Extract<TraceEvent, { type: T }>;

export interface UserItem {
  kind: "user";
  key: string;
  seq: number;
  ts: number;
  text: string;
  /** The latest message sent again (Retry); it is already shown above. */
  retry?: "message" | "step";
}

export interface CallItem {
  kind: "call";
  key: string;
  seq: number;
  ts: number;
  callId: string;
  start: Ev<"model_call_start">;
  end?: Ev<"model_call_end">;
  msg?: Ev<"assistant_message">;
  live?: LiveCall;
  livePartial?: boolean; // the live text missed chunks (opened mid-stream, or dropped for a slow socket)
  repair?: Ev<"harness_repair">;
  toolIds: string[];
}

export interface ToolItem {
  kind: "tool";
  key: string;
  seq: number;
  ts: number;
  toolCallId: string;
  callId: string;
  name: string;
  args: unknown;
  start: Ev<"tool_start">;
  end?: Ev<"tool_end">;
  fs: FileChange[];
  fsSeq?: number;
  net: { seq: number; entry: NetEntry }[];
  live?: OutChunk[];
  livePartial?: boolean;
}

export interface RowItem {
  kind: "row";
  key: string;
  seq: number;
  ts: number;
  event: Ev<"compaction" | "warning" | "error" | "budget_exceeded" | "env_lifecycle" | "run_end" | "fs_change" | "net" | "system_prompt">;
}

export type Item = UserItem | CallItem | ToolItem | RowItem;

export interface Derived {
  items: Item[];
  calls: CallItem[];
  tools: ToolItem[];
  bySeq: Map<number, Item>;
  t0: number;
  lastTs: number;
  running: boolean;
  fsSteps: { seq: number; ts: number; toolCallId: string | null; changes: FileChange[]; label: string }[];
  nets: { seq: number; entry: NetEntry; toolCallId?: string }[];
  totals: { prompt: number; completion: number; calls: number; tools: number; errors: number };
}

export function derive(trace: Trace | undefined): Derived {
  const items: Item[] = [];
  const calls = new Map<string, CallItem>();
  const tools = new Map<string, ToolItem>();
  const bySeq = new Map<number, Item>();
  const fsSteps: Derived["fsSteps"] = [];
  const nets: Derived["nets"] = [];
  const totals = { prompt: 0, completion: 0, calls: 0, tools: 0, errors: 0 };
  let openTool: ToolItem | null = null;
  let running = false;
  const evs = trace?.events ?? [];

  for (const ev of evs) {
    switch (ev.type) {
      case "user_message": {
        const it: UserItem = { kind: "user", key: `u${ev.seq}`, seq: ev.seq, ts: ev.ts, text: ev.text, ...(ev.retry ? { retry: ev.retry } : {}) };
        items.push(it);
        bySeq.set(ev.seq, it);
        running = true;
        break;
      }
      case "model_call_start": {
        const it: CallItem = {
          kind: "call",
          key: `c${ev.callId}`,
          seq: ev.seq,
          ts: ev.ts,
          callId: ev.callId,
          start: ev,
          toolIds: [],
        };
        calls.set(ev.callId, it);
        items.push(it);
        bySeq.set(ev.seq, it);
        totals.calls++;
        running = true;
        break;
      }
      case "model_call_end": {
        const c = calls.get(ev.callId);
        if (c) {
          c.end = ev;
          bySeq.set(ev.seq, c);
        }
        if (ev.usage) {
          totals.prompt += ev.usage.promptTokens;
          totals.completion += ev.usage.completionTokens;
        }
        if (ev.finishReason === "error") totals.errors++;
        break;
      }
      case "assistant_message": {
        const c = calls.get(ev.callId);
        if (c) {
          c.msg = ev;
          bySeq.set(ev.seq, c);
        }
        break;
      }
      case "harness_repair": {
        const c = calls.get(ev.callId);
        if (c) {
          c.repair = ev;
          bySeq.set(ev.seq, c);
        }
        break;
      }
      case "tool_start": {
        const it: ToolItem = {
          kind: "tool",
          key: `t${ev.toolCallId}`,
          seq: ev.seq,
          ts: ev.ts,
          toolCallId: ev.toolCallId,
          callId: ev.callId,
          name: ev.name,
          args: ev.args,
          start: ev,
          fs: [],
          net: [],
        };
        tools.set(ev.toolCallId, it);
        calls.get(ev.callId)?.toolIds.push(ev.toolCallId);
        items.push(it);
        bySeq.set(ev.seq, it);
        openTool = it;
        totals.tools++;
        break;
      }
      case "tool_end": {
        const t = tools.get(ev.toolCallId);
        if (t) {
          t.end = ev;
          bySeq.set(ev.seq, t);
          if (ev.isError || (ev.exitCode != null && ev.exitCode !== 0)) totals.errors++;
        }
        if (openTool?.toolCallId === ev.toolCallId) openTool = null;
        break;
      }
      case "fs_change": {
        const t = ev.toolCallId ? tools.get(ev.toolCallId) : undefined;
        const label = t ? toolLabel(t.name, t.args) : "outside a tool call";
        fsSteps.push({ seq: ev.seq, ts: ev.ts, toolCallId: ev.toolCallId, changes: ev.changes, label });
        if (t) {
          t.fs = t.fs.concat(ev.changes);
          t.fsSeq = ev.seq;
          bySeq.set(ev.seq, t);
        } else {
          const it: RowItem = { kind: "row", key: `r${ev.seq}`, seq: ev.seq, ts: ev.ts, event: ev };
          items.push(it);
          bySeq.set(ev.seq, it);
        }
        break;
      }
      case "net": {
        const t = openTool;
        nets.push({ seq: ev.seq, entry: ev.entry, toolCallId: t?.toolCallId });
        if (t) {
          t.net.push({ seq: ev.seq, entry: ev.entry });
          bySeq.set(ev.seq, t);
        } else {
          const it: RowItem = { kind: "row", key: `r${ev.seq}`, seq: ev.seq, ts: ev.ts, event: ev };
          items.push(it);
          bySeq.set(ev.seq, it);
        }
        break;
      }
      case "compaction":
      case "warning":
      case "error":
      case "budget_exceeded":
      case "system_prompt":
      case "env_lifecycle": {
        const it: RowItem = { kind: "row", key: `r${ev.seq}`, seq: ev.seq, ts: ev.ts, event: ev };
        items.push(it);
        bySeq.set(ev.seq, it);
        break;
      }
      case "run_end": {
        const it: RowItem = { kind: "row", key: `r${ev.seq}`, seq: ev.seq, ts: ev.ts, event: ev };
        items.push(it);
        bySeq.set(ev.seq, it);
        running = false;
        break;
      }
      default:
        break;
    }
  }

  if (trace) {
    for (const [callId, live] of Object.entries(trace.live)) {
      const c = calls.get(callId);
      if (c && !c.msg) c.live = live;
    }
    for (const [id, out] of Object.entries(trace.liveOut)) {
      const t = tools.get(id);
      if (t && !t.end) t.live = out;
    }
    if (running) {
      // only a buffer that actually missed chunks; a call opened during prefill gets its first chunk and is whole
      for (const c of calls.values()) if (!c.msg && !c.end) c.livePartial = !!c.live && !trace.whole[c.callId];
      for (const t of tools.values()) if (!t.end) t.livePartial = !!t.live && !trace.whole[t.toolCallId];
    }
  }

  const t0 = evs.length ? evs[0].ts : Date.now();
  const lastTs = evs.length ? evs[evs.length - 1].ts : t0;
  return {
    items,
    calls: [...calls.values()],
    tools: [...tools.values()],
    bySeq,
    t0,
    lastTs,
    running,
    fsSteps,
    nets,
    totals,
  };
}

export function argsObj(args: unknown): Record<string, unknown> {
  if (args && typeof args === "object" && !Array.isArray(args)) return args as Record<string, unknown>;
  if (typeof args === "string") {
    try {
      const v = JSON.parse(args) as unknown;
      if (v && typeof v === "object") return v as Record<string, unknown>;
    } catch {
      return { input: args };
    }
  }
  return {};
}

/** The one-line form of a tool call: the command for bash, the path for file tools. */
export function toolLabel(name: string, args: unknown): string {
  const a = argsObj(args);
  if (typeof a.command === "string") return a.command;
  if (typeof a.path === "string") return a.path;
  if (typeof a.file_path === "string") return a.file_path;
  if (typeof a.pattern === "string") return a.pattern;
  const s = JSON.stringify(args);
  return s && s !== "{}" ? s : name;
}

export function shortToolLabel(name: string, args: unknown): string {
  const a = argsObj(args);
  if (typeof a.command === "string") {
    const cmd = a.command.replace(/^cd \S+ && /, "").trim();
    return cmd.split(/\s+/).slice(0, 3).join(" ");
  }
  const p = toolLabel(name, args);
  return p.split("/").pop() ?? p;
}

export type ToolKind = "bash" | "read" | "write" | "edit" | "other";
export function toolKind(name: string): ToolKind {
  const n = name.toLowerCase();
  if (n === "bash" || n === "shell" || n === "exec") return "bash";
  if (n === "read" || n === "ls" || n === "find" || n === "grep" || n === "glob") return "read";
  if (n === "write") return "write";
  if (n === "edit" || n === "multiedit" || n === "patch") return "edit";
  return "other";
}

export function toolFailed(t: ToolItem): boolean {
  return !!t.end && (t.end.isError || (t.end.exitCode != null && t.end.exitCode !== 0));
}

export function selectionSeq(sel: Selection | null): number | undefined {
  return sel?.seq;
}

/** The transcript item a selection points at. */
export function itemForSelection(d: Derived, sel: Selection | null): Item | undefined {
  if (!sel) return undefined;
  if (sel.kind === "call") return d.calls.find((c) => c.callId === sel.callId);
  if (sel.kind === "tool") return d.tools.find((t) => t.toolCallId === sel.toolCallId);
  return d.bySeq.get(sel.seq);
}

export function changeCounts(changes: FileChange[]) {
  const c = { added: 0, modified: 0, deleted: 0 };
  for (const x of changes) {
    if (x.kind === "added") c.added++;
    else if (x.kind === "deleted") c.deleted++;
    else c.modified++;
  }
  return c;
}
