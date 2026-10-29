import { useLayoutEffect, useRef, useState } from "react";
import { ArrowUp, Square } from "lucide-react";
import type { ContextUsage, SessionSummary } from "@terrarium/shared";
import { act, useStore } from "../../state/store";
import { fmtInt, fmtTok } from "../../lib/format";
import { tokensOf } from "../../lib/tokens";
import { modelName } from "../../components/ModelPicker";

function baseUsage(s: SessionSummary): ContextUsage {
  if (s.context) return s.context;
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

export function ContextMeter({ session, draft }: { session: SessionSummary; draft: string }) {
  const u = baseUsage(session);
  // the window/reserve can change after the last call (picker); use the session's current values
  const window = session.contextWindow;
  const reserve = session.maxOutputTokens;
  const draftTok = draft ? tokensOf(draft) : 0;
  const used = u.systemAndTools + u.history + draftTok;
  const free = Math.max(0, window - used - reserve);
  const over = used + reserve > window;
  const segs = [
    { k: "sys", label: "System + tools", v: u.systemAndTools, cls: "sys" },
    { k: "hist", label: "History", v: u.history, cls: "hist" },
    { k: "draft", label: "This message", v: draftTok, cls: "draft" },
    { k: "res", label: "Output reserve", v: reserve, cls: "res" },
  ];
  const pctUsed = ((used + reserve) / window) * 100;
  const est = u.source === "estimate" || draftTok > 0;
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
        <span className="ctx-total" title={est ? "Estimated at ~3.8 characters per token until the server reports usage" : "From the last server usage report"}>
          {est ? "~" : ""}
          {fmtTok(used + reserve)} / {fmtTok(window)}
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

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${Math.min(240, Math.max(38, el.scrollHeight))}px`;
  }, [text]);

  const send = async () => {
    const t = text.trim();
    if (!t || running) return;
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
          {running ? (
            <button className="btn stop" onClick={() => void act("Stop", (b) => b.stopSession(session.id))} title="Stop the run (Esc)">
              <Square /> Stop <kbd>esc</kbd>
            </button>
          ) : (
            <button className="btn primary" disabled={!text.trim()} onClick={() => void send()} title="Send (⌘↵)">
              <ArrowUp /> Send <kbd>⌘↵</kbd>
            </button>
          )}
        </div>
      </div>
      <ContextMeter session={session} draft={text} />
    </div>
  );
}
