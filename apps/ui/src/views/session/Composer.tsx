import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowUp, Square } from "lucide-react";
import type { ContextUsage, SessionSummary } from "@terrarium/shared";
import { act, useStore } from "../../state/store";
import { fmtCtx, fmtInt, fmtTok } from "../../lib/format";
import { tokensOf } from "../../lib/tokens";
import { fitLabel, modelName } from "../../components/ModelPicker";
import { estimate } from "../../lib/memory";
import { runBlocked } from "../../lib/envuse";

function baseUsage(s: SessionSummary, last?: ContextUsage): ContextUsage {
  if (s.context) return s.context;
  if (last) return last;
  const sys = s.harness === "chat" ? 12 : 612;
  return {
    window: s.contextWindow,
    systemAndTools: sys,
    history: 0,
    outputReserve: s.maxOutputTokens,
    free: Math.max(0, s.contextWindow - sys - s.maxOutputTokens),
    source: "estimate",
  };
}

/** Latest `context` event in the loaded trace, for summaries that don't carry one. */
function useTraceContext(sessionId: string): ContextUsage | undefined {
  const events = useStore((s) => s.traces[sessionId]?.events);
  if (!events) return undefined;
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.type === "context") return e.usage;
  }
  return undefined;
}

/** The backend refuses a counted prompt that leaves less than this for the reply (64 margin + 128 minimum). */
const MIN_ROOM = 192;

export function ContextMeter({ session, draft }: { session: SessionSummary; draft: string }) {
  const traceCtx = useTraceContext(session.id);
  const u = baseUsage(session, traceCtx);
  const running = session.status === "running" || session.status === "stopping";
  // the window/reserve can change after the last call (picker); use the session's current values. During a run the
  // last count is the call in flight, with the output budget it was actually given.
  const window = session.contextWindow;
  const reserve = running && u.source === "tokenizer" ? u.outputReserve : session.maxOutputTokens;
  const draftTok = draft ? tokensOf(draft) : 0;
  const used = u.systemAndTools + u.history + draftTok;
  const free = Math.max(0, window - used - reserve);
  const over = used + reserve > window;
  // Over the window, the harness compacts history before the call; what compaction can't remove (system prompt and
  // tools plus the new message) still has to leave room for a reply, or the request is refused with the numbers.
  const tooLong = u.systemAndTools + draftTok + MIN_ROOM > window;
  const verdict = !over ? null : tooLong ? (draftTok ? "message too long" : "over the window") : draftTok ? "compacts on send" : "compacts next call";
  const verdictTitle = tooLong
    ? `System prompt and tools (${fmtInt(u.systemAndTools)}) plus ${draftTok ? `this message (~${fmtInt(draftTok)})` : "the history"} leave less than ${MIN_ROOM} tokens of the ${fmtInt(window)}-token window for a reply: the request would be refused. Raise the context window or shorten the message.`
    : `${fmtInt(used + reserve)} tokens with the ${fmtInt(reserve)}-token output reserve: older steps are dropped (and oversized tool outputs shortened) before the next call so it fits ${fmtInt(window)}.`;
  const segs = [
    { k: "sys", label: "System + tools", v: u.systemAndTools, cls: "sys" },
    { k: "hist", label: "History", v: u.history, cls: "hist" },
    { k: "draft", label: "This message", v: draftTok, cls: "draft" },
    { k: "res", label: "Output reserve", v: reserve, cls: "res" },
  ];
  const pctUsed = ((used + reserve) / window) * 100;
  const est = u.source === "estimate" || draftTok > 0;
  const totalTitle = draftTok
    ? `This message estimated at ~3.8 characters per token; the rest ${u.source === "estimate" ? "estimated" : u.source === "tokenizer" ? "counted by the model's tokenizer" : "from the last server usage report"}`
    : u.source === "estimate"
      ? "Estimated (the model's tokenizer was not reachable)"
      : u.source === "tokenizer"
        ? "Counted by the model's tokenizer before the call"
        : "From the last server usage report (prompt + reply)";
  let x = 0;
  return (
    <div className={`ctx-meter${over ? " over" : pctUsed > 85 ? " near" : ""}`}>
      <div className="ctx-bar" title={`${fmtInt(used + reserve)} of ${fmtInt(window)} tokens committed`}>
        {segs.map((s) => {
          const w = Math.min(100 - x, (s.v / window) * 100);
          const left = x;
          x += w;
          return w > 0 ? <span key={s.k} className={`ctx-seg ${s.cls}`} style={{ left: `${left}%`, width: `${w}%` }} title={`${s.label}: ${fmtInt(s.v)} tokens`} /> : null;
        })}
      </div>
      <div className="ctx-legend num">
        {segs.map((s) =>
          s.v > 0 || s.k !== "draft" ? (
            <span key={s.k} className="ctx-li" title={`${s.label}: ${fmtInt(s.v)} tokens`}>
              <span className={`ctx-key ${s.cls}`} />
              <span className="dim">{s.label}</span> {fmtTok(s.v)}
            </span>
          ) : null,
        )}
        <span className="ctx-li">
          <span className="ctx-key free" />
          <span className="dim">Free</span> <span className={over ? "err-text" : pctUsed > 85 ? "warn-text" : undefined}>{fmtTok(free)}</span>
        </span>
        {verdict && (
          <span className={`ctx-verdict ${tooLong ? "err-text" : "warn-text"}`} title={verdictTitle}>
            {verdict}
          </span>
        )}
        <span className="ctx-total" title={totalTitle}>
          {est ? "~" : ""}
          {fmtTok(used + reserve)} / {fmtCtx(window)}
        </span>
      </div>
    </div>
  );
}

export function Composer({ session }: { session: SessionSummary }) {
  const [text, setText] = useState("");
  const models = useStore((s) => s.models);
  const ref = useRef<HTMLTextAreaElement>(null);
  const running = session.status === "running" || session.status === "stopping";
  const samples = useStore((s) => s.samples);
  const budget = useStore((s) => s.budget);
  const model = models.find((m) => m.id === session.modelId);
  const env = useStore((s) => (session.envId ? s.envs[session.envId] : undefined));
  const blocked = runBlocked(env, session);
  const sample = samples[samples.length - 1];
  // the model loads on send; say so up front when it will not fit
  const fit = model && !model.loaded ? fitLabel(estimate(model, session.contextWindow, sample, budget, models), sample?.system.freeBytes) : null;

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${Math.min(240, Math.max(38, el.scrollHeight))}px`;
  }, [text]);

  // a starter task picked in the empty transcript
  const fill = useStore((s) => (s.composerFill?.sessionId === session.id ? s.composerFill : null));
  useEffect(() => {
    if (!fill) return;
    setText(fill.text);
    ref.current?.focus();
    useStore.setState({ composerFill: null });
  }, [fill]);

  // Eval case sessions belong to their run: the runner sends the prompt, and the env is discarded afterwards.
  if (session.evalRunId) {
    return (
      <div className="composer">
        <div className="composer-readonly">
          <span>Eval case, read-only{env?.released ? ", enclosure released" : ""}</span>
          {running && (
            <button className="btn sm stop" onClick={() => void act("Stop", (b) => b.stopSession(session.id))} title="Stop this case (it is recorded as stopped)">
              <Square /> Stop
            </button>
          )}
        </div>
      </div>
    );
  }

  const send = async () => {
    const t = text.trim();
    if (!t || running || blocked) return;
    setText("");
    const ok = await act("Send", (b) => b.sendMessage(session.id, t).then(() => true));
    if (!ok) setText(t);
  };

  return (
    <div className="composer">
      <div className="composer-box">
        <textarea
          ref={ref}
          className="composer-input selectable"
          value={text}
          placeholder={running ? `${modelName(models, session.modelId)} is working. Esc stops it.` : `Message ${modelName(models, session.modelId)}`}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              void send();
            }
          }}
        />
        <div className="composer-actions">
          {blocked && !running && (
            <span className="composer-fit composer-blocked warn-text" title={blocked}>
              {blocked}
            </span>
          )}
          {fit && fit.cls !== "ok" && !running && !blocked && (
            <span className={`composer-fit ${fit.cls}-text`} title={`${model?.name} is not loaded; sending loads it at ${fmtTok(session.contextWindow)} context`}>
              {fit.cls === "err" ? `Won't fit: ${fit.text}` : "Over the memory ceiling once loaded"}
            </span>
          )}
          {running ? (
            <button className="btn stop" onClick={() => void act("Stop", (b) => b.stopSession(session.id))} title="Stop the run (Esc)">
              <Square /> Stop <kbd>esc</kbd>
            </button>
          ) : (
            <button className="btn primary" disabled={!text.trim() || !!blocked} onClick={() => void send()} title={blocked ? `Can't send: ${blocked}` : "Send (⌘↵)"}>
              <ArrowUp /> Send <kbd>⌘↵</kbd>
            </button>
          )}
        </div>
      </div>
      <ContextMeter session={session} draft={text} />
    </div>
  );
}
