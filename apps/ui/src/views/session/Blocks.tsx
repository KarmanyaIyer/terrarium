import { memo, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { AlertTriangle, ChevronRight, CircleX, FileDiff, Loader2, Minimize2, Play, Wrench } from "lucide-react";
import type { SessionSummary } from "@terrarium/shared";
import type { CallItem, Derived, RowItem, ToolItem, UserItem } from "../../lib/trace";
import { argsObj, changeCounts, toolFailed, toolKind, toolLabel } from "../../lib/trace";
import { act, select, showFilesFor, useStore } from "../../state/store";
import { exactTime, fmtBytes, fmtInt, fmtMs, fmtTok, fmtTps, offsetTime } from "../../lib/format";
import { Markdown } from "../../components/Markdown";
import { partialFields } from "../../lib/partialJson";
import { ansiSpans, stripAnsi } from "../../components/Ansi";
import { DiffView } from "../../components/DiffView";
import { CopyButton, Expander, useNow } from "../../components/ui";
import { modelName } from "../../components/ModelPicker";

function Stamp({ ts, t0 }: { ts: number; t0: number }) {
  return (
    <span className="blk-time num" title={exactTime(ts)}>
      {offsetTime(ts - t0)}
    </span>
  );
}

// ---------- user ----------

export const UserBlock = memo(function UserBlock({ it, t0 }: { it: UserItem; t0: number }) {
  return (
    <div className="blk user">
      <div className="blk-head">
        <span className="blk-who">You</span>
        <span className="blk-spacer" />
        <CopyButton text={it.text} />
        <Stamp ts={it.ts} t0={t0} />
      </div>
      <div className="user-text selectable">{it.text}</div>
    </div>
  );
});

// ---------- model call ----------

function FinishChip({ reason }: { reason: string }) {
  const cls = reason === "stop" || reason === "tool_calls" ? "" : reason === "aborted" ? "warn" : "err";
  const title: Record<string, string> = {
    stop: "The model ended its reply",
    tool_calls: "The model asked to run a tool",
    length: "Stopped at the output cap: the reply is cut off",
    error: "The server returned an error",
    aborted: "Stopped by you",
  };
  return (
    <span className={`chip ${cls}`} title={title[reason]}>
      {reason}
    </span>
  );
}

function Thinking({ text, live, tokens }: { text: string; live: boolean; tokens?: number }) {
  const [open, setOpen] = useState(false);
  const preview = live && !open ? text.slice(-140).replace(/\s+/g, " ") : "";
  return (
    <div className={`thinking${open ? " open" : ""}`}>
      <button className="thinking-head" onClick={() => setOpen(!open)}>
        <ChevronRight size={12} className="tw" />
        <span>Thinking</span>
        <span className="dim num">{fmtInt(tokens ?? Math.round(text.length / 3.8))} tok</span>
        {live && <Loader2 size={11} className="spin dim" />}
        {preview && <span className="thinking-preview truncate">{preview}</span>}
      </button>
      {open && <div className="thinking-body selectable">{text}</div>}
    </div>
  );
}

/** Tool-call arguments as they stream: one row per field, strings unescaped so code reads as code. */
function StreamingArgs({ raw }: { raw: string }) {
  const fields = partialFields(raw);
  if (!fields?.length)
    return (
      <div className="call-toolcall mono dim selectable">
        <span className="dim2">calling tool</span> {raw}
        <span className="caret" />
      </div>
    );
  return (
    <div className="call-toolcall stream-args selectable" title="Arguments as the model writes them">
      <span className="dim2 stream-args-head">calling tool</span>
      {fields.map((f, i) => {
        const last = i === fields.length - 1;
        const multi = f.string && f.value.includes("\n");
        return (
          <div key={f.key} className={`stream-arg${multi ? " multi" : ""}`}>
            <span className="mono dim stream-key">{f.key}</span>
            <span className={`mono stream-val${f.string ? "" : " raw"}`}>
              {f.value}
              {last && !f.done && <span className="caret" />}
            </span>
          </div>
        );
      })}
    </div>
  );
}

export const CallBlock = memo(function CallBlock({ it, t0, selected }: { it: CallItem; t0: number; selected: boolean }) {
  const models = useStore((s) => s.models);
  const live = !it.end;
  const now = useNow(live ? "frame" : "5s");
  const text = it.msg?.text ?? it.live?.text ?? "";
  const thinking = it.msg?.thinking ?? it.live?.thinking ?? "";
  const usage = it.end?.usage;
  const liveTok = it.live ? Math.round((it.live.text.length + it.live.thinking.length + it.live.toolcall.length) / 3.8) : 0;
  const repaired = it.repair;
  const [showOrig, setShowOrig] = useState(false);
  const pending = live && !it.live;

  return (
    <div className={`blk call${selected ? " selected" : ""}${live ? " live" : ""}`}>
      <div className="blk-head" onClick={() => select({ kind: "call", callId: it.callId, seq: it.seq }, { follow: false })}>
        <span className="call-glyph" />
        <button
          className="blk-model"
          title="Show this request"
          onClick={(e) => {
            e.stopPropagation();
            select({ kind: "call", callId: it.callId, seq: it.seq });
            useStore.setState({ inspectorOpen: true });
          }}
        >
          {modelName(models, it.start.modelId)}
        </button>
        <span className="dim">turn {it.start.turn}</span>
        <span className="call-stats num">
          {usage ? (
            <>
              <span title="prompt tokens → output tokens">
                {fmtInt(usage.promptTokens)} → {fmtInt(usage.completionTokens)}
              </span>
              {usage.cachedTokens ? <span className="dim" title="prompt tokens served from the KV cache">{fmtTok(usage.cachedTokens)} cached</span> : null}
              <span className="dim" title="time to first token (prefill)">ttft {fmtMs(it.end?.timing.ttftMs)}</span>
              <span className="dim">{fmtTps(it.end?.timing.genTps)}</span>
              <span className="dim">{fmtMs(it.end?.timing.totalMs)}</span>
            </>
          ) : live ? (
            <>
              <span>{fmtInt(it.start.promptTokensEst)} →</span>
              <span className="live-count">{pending ? "prefill" : `${fmtInt(liveTok)} tok`}</span>
              <span className="dim">{fmtMs(now - it.start.ts)}</span>
            </>
          ) : (
            <span className="dim">{fmtMs(it.end?.timing.totalMs)}</span>
          )}
        </span>
        {it.end && <FinishChip reason={it.end.finishReason} />}
        <span className="blk-spacer" />
        <button
          className="btn sm ghost"
          onClick={(e) => {
            e.stopPropagation();
            select({ kind: "call", callId: it.callId, seq: it.seq });
            useStore.setState({ inspectorOpen: true, inspectorTab: "request" });
          }}
        >
          Request
        </button>
        <Stamp ts={it.ts} t0={t0} />
      </div>
      {thinking && <Thinking text={thinking} live={live && !it.live?.text && !it.live?.toolcall} tokens={usage?.reasoningTokens} />}
      {pending && (
        <div className="call-pending dim">
          <Loader2 size={12} className="spin" /> Reading {fmtInt(it.start.promptTokensEst)} prompt tokens
        </div>
      )}
      {text && !repaired && (
        <div className="call-text">
          <Markdown text={text} />
          {live && it.live?.text && !it.live.toolcall && <span className="caret" />}
        </div>
      )}
      {repaired && (
        <div className="repair">
          <div className="repair-head">
            <Wrench size={12} />
            <span>Harness repair</span>
            <span className="dim">{repaired.reason}</span>
            <button className="btn sm ghost" onClick={() => setShowOrig(!showOrig)}>
              {showOrig ? "Hide" : "Show"} raw reply
            </button>
          </div>
          {showOrig && <pre className="well selectable">{repaired.original}</pre>}
        </div>
      )}
      {live && it.live?.toolcall && <StreamingArgs raw={it.live.toolcall} />}
      {it.end?.finishReason === "error" && it.end.error && <div className="call-error selectable">{it.end.error}</div>}
    </div>
  );
});

// ---------- tool ----------

/** Blob text, or the load error with a way to try again (a failed fetch is not "still loading"). */
function useBlob(sha: string | undefined) {
  const backend = useStore((s) => s.backend);
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!sha || !backend) return;
    let alive = true;
    setError(null);
    backend
      .getBlob(sha)
      .then((t) => alive && setText(t))
      .catch((err: unknown) => {
        if (!alive) return;
        setText(null);
        setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      alive = false;
    };
  }, [sha, backend, attempt]);
  return { text, error, retry: () => setAttempt((n) => n + 1) };
}

function ToolDiffs({ t }: { t: ToolItem }) {
  return (
    <>
      {t.fs.slice(0, 3).map((c) => (
        <ToolDiff key={c.path} path={c.path} sha={c.diffBlob} kind={c.kind} />
      ))}
      {t.fs.length > 3 && (
        <button className="btn sm ghost" onClick={() => showFilesFor(t.toolCallId)}>
          {t.fs.length - 3} more files
        </button>
      )}
    </>
  );
}

function ToolDiff({ path, sha, kind }: { path: string; sha?: string; kind: string }) {
  const { text, error, retry } = useBlob(sha);
  return (
    <div className="tool-diff">
      <div className="tool-diff-head mono">
        <span className={`fc-badge ${kind}`}>{kind === "added" ? "A" : kind === "deleted" ? "D" : "M"}</span>
        {path}
      </div>
      {text != null ? (
        <Expander lines={text.split("\n").length} limit={16}>
          {() => <DiffView text={text} compact />}
        </Expander>
      ) : error ? (
        <div className="tool-diff-wait tool-diff-err">
          <span className="err-text">Diff did not load: {error}</span>
          <button className="btn sm ghost" onClick={retry}>
            Retry
          </button>
        </div>
      ) : (
        <div className="dim tool-diff-wait">{sha ? "Loading diff" : "No diff stored"}</div>
      )}
    </div>
  );
}

function Output({ chunks }: { chunks: { stream: "stdout" | "stderr"; text: string }[] }) {
  const all = chunks.map((c) => c.text).join("");
  const lines = all.replace(/\n$/, "").split("\n").length;
  if (!all) return null;
  return (
    <Expander lines={lines} limit={14}>
      {() => (
        <pre className="well out selectable">
          {chunks.map((c, i) => (
            <span key={i} className={c.stream === "stderr" ? "stderr" : undefined}>
              {ansiSpans(c.text, `${i}-`)}
            </span>
          ))}
        </pre>
      )}
    </Expander>
  );
}

/** True when the element's single line is cut off (its full text is wider than its box). */
function useCutOff(text: string) {
  const ref = useRef<HTMLSpanElement>(null);
  const [cut, setCut] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const check = () => setCut(el.scrollWidth > el.clientWidth + 1);
    check();
    const ro = new ResizeObserver(check);
    ro.observe(el);
    return () => ro.disconnect();
  }, [text]);
  return { ref, cut: cut || text.includes("\n") };
}

export const ToolBlock = memo(function ToolBlock({ it, t0, selected }: { it: ToolItem; t0: number; selected: boolean }) {
  const [sent, setSent] = useState(false);
  const live = !it.end;
  const now = useNow(live ? "frame" : "5s");
  const kind = toolKind(it.name);
  const failed = toolFailed(it);
  const a = argsObj(it.args);
  const label = toolLabel(it.name, it.args);
  const chunks =
    it.live ??
    (it.end
      ? [
          ...(it.end.stdout ? [{ stream: "stdout" as const, text: it.end.stdout }] : []),
          ...(it.end.stderr ? [{ stream: "stderr" as const, text: it.end.stderr }] : []),
        ]
      : []);
  const cc = changeCounts(it.fs);
  const cmdCut = useCutOff(label);
  const showDiffs = (kind === "edit" || kind === "write") && it.fs.length > 0;

  let cmd: ReactNode;
  if (kind === "bash")
    cmd = (
      <>
        <span className="tool-prompt">$</span> {label}
      </>
    );
  else if (kind === "write") cmd = <>{label} <span className="dim">{typeof a.content === "string" ? fmtBytes(a.content.length) : ""}</span></>;
  else cmd = label;

  return (
    <div className={`blk tool k-${kind}${selected ? " selected" : ""}${failed ? " failed" : ""}`}>
      <div className="blk-head" onClick={() => select({ kind: "tool", toolCallId: it.toolCallId, callId: it.callId, seq: it.seq }, { follow: false })}>
        <span className="tool-name">{it.name}</span>
        <span ref={cmdCut.ref} className="tool-cmd mono truncate selectable" title={label}>
          {cmd}
        </span>
        <span className="blk-spacer" />
        {live ? (
          <span className="tool-status num">
            <Loader2 size={11} className="spin" /> {fmtMs(now - it.start.ts)}
          </span>
        ) : (
          <span className="tool-status num">
            {it.end?.exitCode != null && (
              <span className={`chip ${it.end.exitCode === 0 ? "" : "err"}`} title="Exit code">
                exit {it.end.exitCode}
              </span>
            )}
            {it.end?.exitCode == null && it.end?.isError && <span className="chip err">error</span>}
            {it.end?.outputTruncated && (
              <span className="chip warn" title="Output was cut for the model; the full output is stored">
                truncated
              </span>
            )}
            <span className="dim">{fmtMs(it.end?.durationMs)}</span>
          </span>
        )}
        {it.fs.length > 0 && (
          <button
            className="btn sm ghost files-btn"
            title="Show changed files"
            onClick={(e) => {
              e.stopPropagation();
              select({ kind: "tool", toolCallId: it.toolCallId, callId: it.callId, seq: it.seq }, { follow: false });
              showFilesFor(it.toolCallId);
            }}
          >
            <FileDiff />
            {it.fs.length} file{it.fs.length > 1 ? "s" : ""}
            {cc.added ? <span className="ok-text">+{cc.added}</span> : null}
            {cc.deleted ? <span className="err-text">−{cc.deleted}</span> : null}
          </button>
        )}
        {it.end && (
          <button
            className={`btn sm ghost${sent ? " on" : ""}`}
            title="Exactly what the model received as the tool result"
            onClick={(e) => {
              e.stopPropagation();
              setSent(!sent);
            }}
          >
            Result
          </button>
        )}
        <Stamp ts={it.ts} t0={t0} />
      </div>
      {cmdCut.cut && (
        <Expander lines={label.split("\n").length} limit={8}>
          {() => (
            <pre className="well cmd selectable">
              {kind === "bash" && <span className="tool-prompt">$ </span>}
              {label}
            </pre>
          )}
        </Expander>
      )}
      {sent && it.end && (
        <div className="tool-sent">
          <div className="tool-sent-head dim">
            Sent to model <span className="num">{fmtInt(it.end.resultForModel.length)} chars</span>
            <CopyButton text={it.end.resultForModel} />
          </div>
          <pre className="well selectable">{stripAnsi(it.end.resultForModel)}</pre>
        </div>
      )}
      {showDiffs ? <ToolDiffs t={it} /> : <Output chunks={chunks} />}
      {kind === "edit" && !it.fs.length && typeof a.newText === "string" && (
        <pre className="well selectable">{String(a.newText)}</pre>
      )}
      {it.net.length > 0 && (
        <div className="tool-net">
          {it.net.map(({ entry, seq }) => (
            <button key={entry.id} className={`net-row ${entry.decision}`} onClick={() => select({ kind: "net", entryId: entry.id, seq })}>
              <span className={`chip ${entry.decision === "deny" ? "err" : "ok"}`}>{entry.decision === "deny" ? "denied" : "allowed"}</span>
              <span className="mono truncate">
                {entry.method} {entry.url}
              </span>
              <span className="dim">{entry.reason}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
});

// ---------- rows ----------

function TruncationWarning({ it, session, d }: { it: RowItem; session: SessionSummary; d: Derived }) {
  if (it.event.type !== "warning") return null;
  const data = it.event.data ?? {};
  const n = (k: string) => (typeof data[k] === "number" ? (data[k] as number) : undefined);
  const window = n("contextWindow") ?? session.contextWindow;
  const prompt = n("promptTokens");
  const cap = n("maxOutputTokens") ?? session.maxOutputTokens;
  const gen = n("completionTokens");
  const reasoning = n("reasoningTokens");
  const isLast = d.items[d.items.length - 1]?.seq <= it.seq + 1 || d.items.slice(d.items.indexOf(it) + 1).every((x) => x.kind === "row");
  const nextCap = cap * 2;
  const canRaise = prompt != null && prompt + nextCap <= window && session.maxOutputTokens < nextCap;
  const thinkingAte = reasoning != null && gen != null && reasoning >= gen * 0.8;
  const running = session.status === "running";
  return (
    <div className="warn-box">
      <div className="warn-title">
        <AlertTriangle size={14} />
        Reply cut off at the output cap
      </div>
      <div className="warn-msg">{it.event.message}</div>
      <div className="warn-nums num">
        <div>
          <span>Context window</span>
          <b>{fmtInt(window)}</b>
        </div>
        <div>
          <span>Prompt</span>
          <b>{fmtInt(prompt)}</b>
        </div>
        <div>
          <span>Output cap</span>
          <b>{fmtInt(cap)}</b>
        </div>
        <div>
          <span>Generated</span>
          <b>{fmtInt(gen)}</b>
        </div>
        {reasoning != null && (
          <div>
            <span>of which thinking</span>
            <b>{fmtInt(reasoning)}</b>
          </div>
        )}
      </div>
      {isLast && (
        <div className="warn-actions">
          <button className="btn primary" disabled={running} onClick={() => void act("Continue", (b) => b.continueSession(session.id))}>
            <Play /> Continue
          </button>
          {canRaise && (
            <button
              className="btn"
              disabled={running}
              onClick={() =>
                void act("Raise output cap", (b) => b.updateSession(session.id, { maxOutputTokens: nextCap })).then((s) => {
                  if (s) useStore.setState((st) => ({ sessions: { ...st.sessions, [s.id]: s } }));
                })
              }
            >
              Raise output cap to {fmtInt(nextCap)}
            </button>
          )}
          {thinkingAte && session.thinking && (
            <button
              className="btn"
              disabled={running}
              onClick={() =>
                void act("Turn off thinking", (b) => b.updateSession(session.id, { thinking: false })).then((s) => {
                  if (s) useStore.setState((st) => ({ sessions: { ...st.sessions, [s.id]: s } }));
                })
              }
            >
              Turn off thinking
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export const RowBlock = memo(function RowBlock({ it, t0, session, d }: { it: RowItem; t0: number; session: SessionSummary; d: Derived }) {
  const ev = it.event;
  switch (ev.type) {
    case "compaction":
      return (
        <div className="row-ev compaction" onClick={() => select({ kind: "event", seq: it.seq })}>
          <Minimize2 size={12} />
          <span>
            Context compacted <span className="num">{fmtInt(ev.beforeTokens)} → {fmtInt(ev.afterTokens)}</span> tokens
            {ev.removedTurns ? `, ${ev.removedTurns} turns dropped` : ""}
          </span>
          <span className="dim truncate row-note" title={ev.note}>
            {ev.note}
          </span>
          <Stamp ts={it.ts} t0={t0} />
        </div>
      );
    case "warning":
      if (ev.code === "output_truncated") return <TruncationWarning it={it} session={session} d={d} />;
      return (
        <div className="row-ev warning">
          <AlertTriangle size={12} />
          <span className="selectable">{ev.message}</span>
          <span className="dim">{ev.code}</span>
          <Stamp ts={it.ts} t0={t0} />
        </div>
      );
    case "error":
      return (
        <div className="err-box">
          <div className="warn-title">
            <CircleX size={14} /> {ev.message}
          </div>
          {ev.detail && <pre className="well selectable">{ev.detail}</pre>}
        </div>
      );
    case "env_lifecycle":
      return (
        <div className="row-ev dim">
          <span>
            Environment {ev.action}
            {ev.detail ? `: ${ev.detail}` : ""}
          </span>
          <Stamp ts={it.ts} t0={t0} />
        </div>
      );
    case "run_end": {
      const idx = d.items.indexOf(it);
      let startTs = d.t0;
      let turns = 0;
      let tokens = 0;
      for (let i = idx - 1; i >= 0; i--) {
        const x = d.items[i];
        if (x.kind === "user") {
          startTs = x.ts;
          break;
        }
        if (x.kind === "call") {
          turns++;
          tokens += x.end?.usage?.completionTokens ?? 0;
        }
      }
      const reasonCls = ev.reason === "done" ? "" : ev.reason === "stopped" ? "warn" : "err";
      // a run you stopped, or one that hit the turn limit, picks up where it left off
      const resumable = (ev.reason === "stopped" || ev.reason === "max_turns") && idx === d.items.length - 1 && session.status === "idle";
      return (
        <div className="row-ev run-end">
          <span className="run-end-line" />
          <span className={`chip ${reasonCls}`}>{ev.reason === "max_turns" ? "max turns" : ev.reason}</span>
          <span className="dim num">
            {turns} turn{turns === 1 ? "" : "s"}  {fmtMs(it.ts - startTs)}  {fmtInt(tokens)} tokens out
          </span>
          {resumable && (
            <button className="btn sm" onClick={() => void act("Continue", (b) => b.continueSession(session.id))}>
              <Play /> Continue
            </button>
          )}
          <span className="run-end-line" />
        </div>
      );
    }
    case "fs_change":
      return (
        <div className="row-ev">
          <FileDiff size={12} />
          <span>{ev.changes.length} files changed outside a tool call</span>
          <Stamp ts={it.ts} t0={t0} />
        </div>
      );
    case "net":
      return (
        <button className={`net-row ${ev.entry.decision}`} onClick={() => select({ kind: "net", entryId: ev.entry.id, seq: it.seq })}>
          <span className={`chip ${ev.entry.decision === "deny" ? "err" : "ok"}`}>{ev.entry.decision === "deny" ? "denied" : "allowed"}</span>
          <span className="mono truncate">
            {ev.entry.method} {ev.entry.url}
          </span>
          <span className="dim">{ev.entry.reason}</span>
        </button>
      );
    default:
      return null;
  }
});
