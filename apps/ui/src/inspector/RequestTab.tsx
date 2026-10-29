import { useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronRight, Loader2 } from "lucide-react";
import type { ModelCallDetail, SessionSummary } from "@terrarium/shared";
import { select, useStore } from "../state/store";
import type { Derived } from "../lib/trace";
import { fmtInt, fmtMs, fmtTps } from "../lib/format";
import { JsonView } from "../components/JsonView";
import { CopyButton, Popover, Segmented, usePop } from "../components/ui";
import { modelName } from "../components/ModelPicker";

type Msg = {
  role: string;
  content?: unknown;
  reasoning_content?: string;
  tool_calls?: { id?: string; function?: { name?: string; arguments?: string } }[];
  tool_call_id?: string;
  name?: string;
};

function contentText(c: unknown): string {
  if (c == null) return "";
  if (typeof c === "string") return c;
  if (Array.isArray(c))
    return c
      .map((p) => (p && typeof p === "object" && "text" in p ? String((p as { text: unknown }).text) : JSON.stringify(p)))
      .join("\n");
  return JSON.stringify(c, null, 2);
}

function Fold({ title, right, children, open: open0 = false, count }: { title: React.ReactNode; right?: React.ReactNode; children: React.ReactNode; open?: boolean; count?: string }) {
  const [open, setOpen] = useState(open0);
  return (
    <section className={`fold${open ? " open" : ""}`}>
      <div className="fold-head" onClick={() => setOpen(!open)}>
        <ChevronRight size={12} className="tw" />
        <span className="fold-title">{title}</span>
        {count && <span className="dim num">{count}</span>}
        <span className="blk-spacer" />
        <span onClick={(e) => e.stopPropagation()}>{right}</span>
      </div>
      {open && <div className="fold-body">{children}</div>}
    </section>
  );
}

function LongText({ text, limit = 16 }: { text: string; limit?: number }) {
  const [open, setOpen] = useState(false);
  const lines = text.split("\n");
  const long = lines.length > limit || text.length > 2400;
  const shown = long && !open ? lines.slice(0, limit).join("\n").slice(0, 2400) : text;
  return (
    <>
      <pre className="well selectable">{shown || <span className="dim">(empty)</span>}</pre>
      {long && (
        <button className="expander-btn" onClick={() => setOpen(!open)}>
          {open ? "Collapse" : `Show all ${fmtInt(lines.length)} lines, ${fmtInt(text.length)} chars`}
        </button>
      )}
    </>
  );
}

function MessageView({ m, i }: { m: Msg; i: number }) {
  const text = contentText(m.content);
  return (
    <div className={`rq-msg role-${m.role}`}>
      <div className="rq-msg-head">
        <span className="rq-idx num">{i}</span>
        <span className={`rq-role ${m.role}`}>{m.role}</span>
        {m.tool_call_id && <span className="dim mono">{m.tool_call_id}</span>}
        <span className="dim num">{fmtInt(text.length)} chars</span>
        <span className="blk-spacer" />
        <CopyButton text={() => JSON.stringify(m, null, 2)} />
      </div>
      {m.reasoning_content && (
        <Fold title="reasoning_content" count={`${fmtInt(m.reasoning_content.length)} chars`}>
          <LongText text={m.reasoning_content} />
        </Fold>
      )}
      {(text || !m.tool_calls?.length) && <LongText text={text} limit={m.role === "system" ? 40 : 12} />}
      {m.tool_calls?.map((tc, j) => (
        <div key={j} className="rq-toolcall">
          <span className="rq-fn mono">{tc.function?.name}</span>
          <span className="dim mono">{tc.id}</span>
          <pre className="well selectable">{prettyArgs(tc.function?.arguments)}</pre>
        </div>
      ))}
    </div>
  );
}

function prettyArgs(a: string | undefined): string {
  if (!a) return "";
  try {
    return JSON.stringify(JSON.parse(a), null, 2);
  } catch {
    return a;
  }
}

function CallPicker({ d, callId, onPick }: { d: Derived; callId: string; onPick: (id: string) => void }) {
  const pop = usePop();
  const models = useStore((s) => s.models);
  const cur = d.calls.find((c) => c.callId === callId);
  return (
    <>
      <button ref={pop.ref} className="hdr-btn rq-pick" onClick={pop.toggle}>
        Call {cur ? d.calls.indexOf(cur) + 1 : "–"}
        <span className="dim">of {d.calls.length}</span>
        {cur && <span className="dim">turn {cur.start.turn}</span>}
        <ChevronDown size={12} className="dim" />
      </button>
      <Popover anchor={pop.ref} open={pop.open} onClose={pop.close} width={330}>
        <div className="menu">
          {d.calls.map((c, i) => (
            <button
              key={c.callId}
              className={`menu-item${c.callId === callId ? " active" : ""}`}
              onClick={() => {
                pop.close();
                onPick(c.callId);
              }}
            >
              <span className="num" style={{ width: 20 }}>
                {i + 1}
              </span>
              <span className="truncate" style={{ flex: 1 }}>
                {modelName(models, c.start.modelId)} <span className="dim">turn {c.start.turn}</span>
              </span>
              <span className="dim num">{c.end?.usage ? `${fmtInt(c.end.usage.promptTokens)}→${fmtInt(c.end.usage.completionTokens)}` : "running"}</span>
              <span className="dim">{c.end?.finishReason ?? ""}</span>
            </button>
          ))}
        </div>
      </Popover>
    </>
  );
}

export function RequestTab({ d }: { session: SessionSummary; d: Derived }) {
  const backend = useStore((s) => s.backend);
  const selection = useStore((s) => s.selection);
  const [view, setView] = useState<"readable" | "raw">("readable");
  const [detail, setDetail] = useState<ModelCallDetail | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [sse, setSse] = useState<string | null>(null);

  const selectedCall =
    selection?.kind === "call"
      ? selection.callId
      : selection?.kind === "tool"
        ? selection.callId
        : undefined;
  const callId = selectedCall && d.calls.some((c) => c.callId === selectedCall) ? selectedCall : d.calls[d.calls.length - 1]?.callId;
  const item = d.calls.find((c) => c.callId === callId);
  const ended = !!item?.end;

  useEffect(() => {
    if (!backend || !callId) return;
    let alive = true;
    setErr(null);
    setSse(null);
    backend.getModelCall(callId).then(
      (x) => alive && setDetail(x),
      (e) => alive && setErr(String((e as Error).message ?? e)),
    );
    return () => {
      alive = false;
    };
  }, [backend, callId, ended]);

  const req = (detail?.id === callId ? detail?.request : null) as Record<string, unknown> | null;
  const res = (detail?.id === callId ? detail?.response : null) as Record<string, unknown> | null;
  const messages = (req?.messages as Msg[] | undefined) ?? [];
  const tools = (req?.tools as { function?: { name?: string; description?: string; parameters?: unknown } }[] | undefined) ?? [];
  const params = useMemo(() => (req ? Object.entries(req).filter(([k]) => k !== "messages" && k !== "tools") : []), [req]);
  const choice = (res?.choices as { message?: Msg; finish_reason?: string }[] | undefined)?.[0];
  const system = messages.find((m) => m.role === "system");
  const reqBytes = useMemo(() => (req ? JSON.stringify(req).length : 0), [req]);

  if (!d.calls.length) return <div className="empty">No model calls yet</div>;
  return (
    <div className="request">
      <div className="rq-bar">
        <CallPicker d={d} callId={callId!} onPick={(id) => select({ kind: "call", callId: id, seq: d.calls.find((c) => c.callId === id)!.seq }, { follow: false })} />
        <span className="blk-spacer" />
        <Segmented
          small
          value={view}
          onChange={setView}
          options={[
            { value: "readable", label: "Readable" },
            { value: "raw", label: "Raw JSON" },
          ]}
        />
      </div>
      {err ? (
        <div className="empty err-text">{err}</div>
      ) : !detail || detail.id !== callId ? (
        <div className="empty">Loading</div>
      ) : view === "raw" ? (
        <div className="rq-scroll">
          <Fold title="Request body" count={`${fmtInt(reqBytes)} bytes`} open right={<CopyButton text={() => JSON.stringify(req, null, 2)} label="Copy" />}>
            <JsonView value={req} open={2} />
          </Fold>
          <Fold
            title="Response"
            open
            right={res ? <CopyButton text={() => JSON.stringify(res, null, 2)} label="Copy" /> : undefined}
          >
            {res ? <JsonView value={res} open={3} /> : <div className="dim pad"><Loader2 size={12} className="spin" /> Streaming</div>}
          </Fold>
          {detail.rawResponseBlob && (
            <Fold
              title="Raw SSE stream"
              right={sse != null ? <CopyButton text={sse} label="Copy" /> : undefined}
            >
              {sse == null ? (
                <button className="btn sm" onClick={() => backend?.getBlob(detail.rawResponseBlob!).then(setSse, (e) => setSse(String(e)))}>
                  Load
                </button>
              ) : (
                <LongText text={sse} limit={30} />
              )}
            </Fold>
          )}
        </div>
      ) : (
        <div className="rq-scroll">
          <div className="rq-summary">
            <div className="rq-stat">
              <span>Finish</span>
              <b className={detail.finishReason === "length" || detail.finishReason === "error" ? "err-text" : undefined}>{res ? detail.finishReason : "streaming"}</b>
            </div>
            <div className="rq-stat">
              <span>Prompt</span>
              <b className="num">{fmtInt(detail.usage?.promptTokens ?? item?.start.promptTokensEst)}</b>
            </div>
            <div className="rq-stat">
              <span>Output</span>
              <b className="num">
                {fmtInt(detail.usage?.completionTokens)}
                <small className="dim"> / {fmtInt(detail.maxTokens)}</small>
              </b>
            </div>
            {detail.usage?.reasoningTokens != null && (
              <div className="rq-stat">
                <span>Thinking</span>
                <b className="num">{fmtInt(detail.usage.reasoningTokens)}</b>
              </div>
            )}
            <div className="rq-stat">
              <span>Cached</span>
              <b className="num">{fmtInt(detail.usage?.cachedTokens ?? 0)}</b>
            </div>
            <div className="rq-stat">
              <span>Window</span>
              <b className="num">{fmtInt(detail.contextWindow)}</b>
            </div>
            <div className="rq-stat">
              <span>TTFT</span>
              <b className="num">{fmtMs(detail.timing.ttftMs)}</b>
            </div>
            <div className="rq-stat">
              <span>Prefill</span>
              <b className="num">{fmtTps(detail.timing.promptTps)}</b>
            </div>
            <div className="rq-stat">
              <span>Decode</span>
              <b className="num">{fmtTps(detail.timing.genTps)}</b>
            </div>
            <div className="rq-stat">
              <span>Total</span>
              <b className="num">{fmtMs(detail.timing.totalMs)}</b>
            </div>
          </div>

          <Fold title="Parameters" count={`${params.length}`} open>
            <dl className="kv rq-params">
              {params.map(([k, v]) => (
                <div key={k} style={{ display: "contents" }}>
                  <dt className="mono">{k}</dt>
                  <dd className="mono selectable">{typeof v === "object" ? JSON.stringify(v) : String(v)}</dd>
                </div>
              ))}
            </dl>
          </Fold>

          {system && (
            <Fold title="System prompt" count={`${fmtInt(contentText(system.content).length)} chars`} open right={<CopyButton text={contentText(system.content)} />}>
              <pre className="well selectable">{contentText(system.content)}</pre>
            </Fold>
          )}

          {tools.length > 0 && (
            <Fold title="Tools" count={`${tools.length}`}>
              {tools.map((t, i) => (
                <Fold key={i} title={<span className="mono">{t.function?.name}</span>} right={<span className="dim rq-tool-desc truncate">{t.function?.description}</span>}>
                  <JsonView value={t.function?.parameters} open={3} />
                </Fold>
              ))}
            </Fold>
          )}

          <Fold title="Messages sent" count={`${messages.length}`} open>
            {messages.map((m, i) => (m.role === "system" ? null : <MessageView key={i} m={m} i={i} />))}
          </Fold>

          <Fold title="Response" open>
            {!res ? (
              <div className="dim pad">
                <Loader2 size={12} className="spin" /> Streaming
              </div>
            ) : choice?.message ? (
              <MessageView m={choice.message} i={messages.length} />
            ) : (
              <JsonView value={res} />
            )}
          </Fold>
        </div>
      )}
    </div>
  );
}
