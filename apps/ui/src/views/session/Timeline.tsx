import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Maximize2, Minus, Plus } from "lucide-react";
import type { Derived, ToolItem } from "../../lib/trace";
import { changeCounts, shortToolLabel, toolFailed, toolKind, toolLabel } from "../../lib/trace";
import { select, useStore, type Selection } from "../../state/store";
import { fmtInt, fmtMs, fmtTok, fmtTps } from "../../lib/format";
import { ChartTip, useNow, type TipState } from "../../components/ui";

const LANE_H = 16;
const LANE_GAP = 6;
const PAD_L = 8;
const PAD_R = 28;
const GAP_IDLE_MS = 12_000; // idle stretches longer than this are folded
const GAP_PX = 22;
const LANES = ["Model", "Tools", "Files", "Network"] as const;
const AXIS_H = 20;
const TOP = 6;

/** Tooltip text cut to n chars, with an ellipsis when cut. */
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

interface Block {
  t0: number;
  t1: number;
}

interface Mapper {
  x: (t: number) => number;
  width: number;
  blocks: Block[];
  gaps: { x: number; ms: number }[];
}

function buildMapper(intervals: [number, number][], pps: number, start: number, end: number): Mapper {
  const sorted = intervals.filter(([a, b]) => b >= a).sort((a, b) => a[0] - b[0]);
  const blocks: Block[] = [];
  for (const [a, b] of sorted) {
    const last = blocks[blocks.length - 1];
    if (last && a - last.t1 <= GAP_IDLE_MS) last.t1 = Math.max(last.t1, b);
    else blocks.push({ t0: a, t1: b });
  }
  if (!blocks.length) blocks.push({ t0: start, t1: end });
  blocks[0].t0 = Math.min(blocks[0].t0, start);
  blocks[blocks.length - 1].t1 = Math.max(blocks[blocks.length - 1].t1, end);
  const xs: number[] = [];
  let x = PAD_L;
  const gaps: Mapper["gaps"] = [];
  blocks.forEach((b, i) => {
    if (i > 0) {
      gaps.push({ x: x + GAP_PX / 2, ms: b.t0 - blocks[i - 1].t1 });
      x += GAP_PX;
    }
    xs.push(x);
    x += ((b.t1 - b.t0) / 1000) * pps;
  });
  const width = x + PAD_R;
  const map = (t: number) => {
    for (let i = 0; i < blocks.length; i++) {
      const b = blocks[i];
      if (t <= b.t1 || i === blocks.length - 1) {
        if (t < b.t0) {
          // inside the gap before block i
          const prevEnd = i > 0 ? xs[i - 1] + ((blocks[i - 1].t1 - blocks[i - 1].t0) / 1000) * pps : PAD_L;
          const g = i > 0 ? b.t0 - blocks[i - 1].t1 : 1;
          const f = i > 0 ? (t - blocks[i - 1].t1) / g : 0;
          return prevEnd + Math.max(0, Math.min(1, f)) * GAP_PX;
        }
        return xs[i] + ((t - b.t0) / 1000) * pps;
      }
    }
    return PAD_L;
  };
  return { x: map, width, blocks, gaps };
}

function activeMs(intervals: [number, number][], start: number, end: number): { ms: number; gaps: number } {
  const m = buildMapper(intervals, 1, start, end);
  return { ms: m.blocks.reduce((a, b) => a + (b.t1 - b.t0), 0), gaps: m.blocks.length - 1 };
}

function niceStep(pps: number): number {
  const target = 90 / pps; // seconds per ~90px
  const steps = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800, 3600];
  return steps.find((s) => s >= target) ?? 3600;
}

/** Axis label: whole seconds once the step is >= 1s, m:ss past a minute. */
function axisLabel(s: number, step: number): string {
  if (s < 60) return step < 1 ? `${s.toFixed(1)}s` : `${Math.round(s)}s`;
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.round(s - m * 60)).padStart(2, "0")}`;
}

const isSel = (sel: Selection | null, kind: Selection["kind"], id: string) =>
  !!sel &&
  sel.kind === kind &&
  ((sel.kind === "call" && sel.callId === id) || (sel.kind === "tool" && sel.toolCallId === id) || (sel.kind === "net" && sel.entryId === id));

export function Timeline({ d, sessionStatus, hasEnv }: { d: Derived; sessionStatus: string; hasEnv: boolean }) {
  const selection = useStore((s) => s.selection);
  const live = d.running || sessionStatus === "running";
  const now = useNow(live ? "frame" : "5s");
  const thinkPat = `tlthink${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
  const scrollRef = useRef<HTMLDivElement>(null);
  const [viewW, setViewW] = useState(600);
  const [zoom, setZoom] = useState<number | null>(null); // px per second; null = fit
  const [tip, setTip] = useState<TipState | null>(null);
  const follow = useRef(true);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setViewW(el.clientWidth));
    ro.observe(el);
    setViewW(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  const end = live ? Math.max(now, d.lastTs) : d.lastTs;
  const start = d.t0;

  const intervals = useMemo(() => {
    const iv: [number, number][] = [];
    for (const c of d.calls) iv.push([c.start.ts, c.end?.ts ?? end]);
    for (const t of d.tools) iv.push([t.start.ts, t.end?.ts ?? end]);
    for (const it of d.items) if (it.kind === "user" || it.kind === "row") iv.push([it.ts, it.ts]);
    for (const n of d.nets) iv.push([n.entry.ts || n.seq, n.entry.ts || n.seq]);
    if (live) iv.push([end - 1, end]);
    return iv;
  }, [d, end, live]);

  const fitPps = useMemo(() => {
    const { ms, gaps } = activeMs(intervals, start, end);
    const avail = viewW - PAD_L - PAD_R - gaps * GAP_PX;
    return Math.max(0.5, avail / Math.max(1, ms / 1000));
  }, [intervals, start, end, viewW]);

  const pps = zoom ?? fitPps;
  const M = useMemo(() => buildMapper(intervals, pps, start, end), [intervals, pps, start, end]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el && zoom != null && follow.current && live) el.scrollLeft = el.scrollWidth;
  });

  const zoomBy = (f: number, anchorX?: number) => {
    const el = scrollRef.current;
    const cur = pps;
    const next = Math.max(fitPps, Math.min(2000, cur * f));
    if (next === fitPps) {
      setZoom(null);
      return;
    }
    if (el) {
      const ax = anchorX ?? el.clientWidth / 2;
      const contentX = el.scrollLeft + ax;
      const ratio = next / cur;
      requestAnimationFrame(() => {
        el.scrollLeft = contentX * ratio - ax;
      });
    }
    setZoom(next);
  };

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        const rect = el.getBoundingClientRect();
        zoomBy(Math.exp(-e.deltaY * 0.01), e.clientX - rect.left);
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  });

  // a chat has no tools, files or network: draw only the model lane
  const lanes = hasEnv || d.tools.length || d.nets.length || d.fsSteps.length ? LANES : LANES.slice(0, 1);
  const laneY = (i: number) => TOP + i * (LANE_H + LANE_GAP);
  const h = TOP + lanes.length * (LANE_H + LANE_GAP) + AXIS_H;

  const tipAt = (e: React.MouseEvent, content: ReactNode) => setTip({ x: e.clientX, y: e.clientY, content });

  const step = niceStep(pps);
  const ticks: { x: number; label: string }[] = [];
  for (const b of M.blocks) {
    const first = Math.ceil((b.t0 - start) / 1000 / step) * step;
    for (let s = first; start + s * 1000 <= b.t1 + 1; s += step) {
      const x = M.x(start + s * 1000);
      if (ticks.length && x - ticks[ticks.length - 1].x < 50) continue;
      ticks.push({ x, label: axisLabel(s, step) });
    }
  }

  const callBars = d.calls.map((c) => {
    const s0 = c.start.ts;
    const e0 = c.end?.ts ?? end;
    const x0 = M.x(s0);
    const x1 = Math.max(x0 + 2, M.x(e0));
    let preEnd: number;
    let textStart: number | null = null;
    if (c.end) {
      preEnd = s0 + (c.end.timing.ttftMs ?? 0);
      const u = c.end.usage;
      if (u?.reasoningTokens && u.completionTokens) {
        const genMs = e0 - preEnd;
        textStart = preEnd + genMs * Math.min(1, u.reasoningTokens / u.completionTokens);
      }
    } else if (c.live) {
      preEnd = Math.min(c.live.firstAt, e0);
      if (c.live.thinking) textStart = c.live.textAt ?? e0;
    } else preEnd = e0;
    const xp = Math.min(x1, M.x(preEnd));
    const xt = textStart != null ? Math.min(x1, M.x(textStart)) : null;
    const err = c.end && (c.end.finishReason === "error" || c.end.finishReason === "length" || c.end.finishReason === "aborted");
    return { c, x0, x1, xp, xt, err, running: !c.end };
  });

  const toolBars = d.tools.map((t) => {
    const x0 = M.x(t.start.ts);
    const x1 = Math.max(x0 + 3, M.x(t.end?.ts ?? end));
    return { t, x0, x1 };
  });

  const toolTip = (t: ToolItem) => (
    <>
      <div className="tip-head">
        <span className="key" style={{ background: `var(--c-${toolKind(t.name)})`, width: 10, height: 10 }} />
        {t.name}
      </div>
      <div className="mono tip-cmd">{clip(toolLabel(t.name, t.args), 160)}</div>
      <div className="tip-row">
        <span>Duration</span>
        <span>{t.end ? fmtMs(t.end.durationMs) : "running"}</span>
      </div>
      {t.end?.exitCode != null && (
        <div className="tip-row">
          <span>Exit</span>
          <span className={t.end.exitCode ? "err-text" : undefined}>{t.end.exitCode}</span>
        </div>
      )}
      {t.fs.length > 0 && (
        <div className="tip-row">
          <span>Files</span>
          <span>{t.fs.length} changed</span>
        </div>
      )}
      {t.net.length > 0 && (
        <div className="tip-row">
          <span>Network</span>
          <span>
            {t.net.length} attempt{t.net.length > 1 ? "s" : ""}, {t.net.filter((n) => n.entry.decision === "deny").length} denied
          </span>
        </div>
      )}
    </>
  );

  const markers = d.items.filter((it) => it.kind === "user" || (it.kind === "row" && (it.event.type === "compaction" || it.event.type === "warning" || it.event.type === "error")));

  return (
    <div className="timeline">
      <div className="tl-labels" style={{ height: h }}>
        {lanes.map((l, i) => (
          <div key={l} className="tl-label" style={{ top: laneY(i), height: LANE_H }}>
            {l}
          </div>
        ))}
      </div>
      <div
        className="tl-scroll"
        ref={scrollRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          follow.current = el.scrollLeft + el.clientWidth >= el.scrollWidth - 4;
        }}
        onMouseLeave={() => setTip(null)}
      >
        <svg width={Math.max(M.width, viewW)} height={h} className="tl-svg" onClick={() => select(null)}>
          <defs>
            <pattern id={thinkPat} width={4} height={4} patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
              <rect width={4} height={4} className="tl-think-bg" />
              <rect width={1.5} height={4} className="tl-think-st" />
            </pattern>
          </defs>
          {/* lane tracks */}
          {lanes.map((l, i) => (
            <rect key={l} x={0} y={laneY(i) + LANE_H / 2 - 0.5} width={Math.max(M.width, viewW)} height={1} className="tl-track" />
          ))}
          {/* folded idle gaps */}
          {M.gaps.map((g, i) => (
            <g key={i} className="tl-gap">
              <rect x={g.x - GAP_PX / 2 + 3} y={TOP - 2} width={GAP_PX - 6} height={lanes.length * (LANE_H + LANE_GAP)} rx={2} />
              <title>{`${fmtMs(g.ms)} idle, folded`}</title>
              <path d={`M${g.x - 3} ${h - AXIS_H + 4} l3 -3 l3 3`} />
            </g>
          ))}
          {/* axis */}
          <line x1={0} x2={Math.max(M.width, viewW)} y1={h - AXIS_H + 0.5} y2={h - AXIS_H + 0.5} className="tl-axis" />
          {ticks.map((t, i) => (
            <g key={i}>
              <line x1={t.x} x2={t.x} y1={h - AXIS_H} y2={h - AXIS_H + 3} className="tl-axis" />
              <text x={t.x} y={h - 5} className="tl-tick" style={t.x < 14 ? { textAnchor: "start" } : undefined}>
                {t.label}
              </text>
            </g>
          ))}
          {/* milestones on the axis */}
          {markers.map((it) => {
            const x = M.x(it.ts);
            const kind = it.kind === "user" ? "user" : it.kind === "row" ? it.event.type : "";
            const label =
              it.kind === "user"
                ? `You: ${clip(it.text, 80)}`
                : it.kind === "row" && it.event.type === "compaction"
                  ? `Compaction ${fmtInt(it.event.beforeTokens)} → ${fmtInt(it.event.afterTokens)} tokens`
                  : it.kind === "row" && it.event.type === "warning"
                    ? it.event.message
                    : it.kind === "row" && it.event.type === "error"
                      ? it.event.message
                      : "";
            return (
              <g
                key={it.key}
                className={`tl-mark ${kind}`}
                onMouseMove={(e) => tipAt(e, <div className="tip-head">{label}</div>)}
                onClick={(e) => {
                  e.stopPropagation();
                  select({ kind: "event", seq: it.seq });
                }}
              >
                <rect x={x - 6} y={h - AXIS_H - 6} width={12} height={12} fill="transparent" />
                {kind === "user" ? (
                  <path d={`M${x - 4} ${h - AXIS_H - 4} h8 l-4 5 z`} />
                ) : (
                  <path d={`M${x} ${h - AXIS_H - 5} l4 4 l-4 4 l-4 -4 z`} />
                )}
              </g>
            );
          })}

          {/* model lane */}
          {callBars.map(({ c, x0, x1, xp, xt, err, running }) => {
            const sel = isSel(selection, "call", c.callId);
            const y = laneY(0);
            const w = x1 - x0;
            const label = c.end?.usage ? `${fmtTok(c.end.usage.promptTokens)}→${fmtTok(c.end.usage.completionTokens)}` : "";
            // the label goes on one segment and takes that segment's ink, so it stays legible in both themes
            const tw = label.length * 5.6 + 8;
            const genX = xt ?? xp;
            const lbl = !label
              ? null
              : x1 - genX >= tw
                ? { x: genX + 4, cls: "on-gen" }
                : xp - x0 >= tw
                  ? { x: x0 + 4, cls: "on-pre" }
                  : xt != null && xt - xp >= tw
                    ? { x: xp + 4, cls: "on-think" }
                    : null;
            return (
              <g
                key={c.callId}
                className={`tl-bar${sel ? " sel" : ""}${running ? " running" : ""}`}
                onMouseMove={(e) =>
                  tipAt(
                    e,
                    <>
                      <div className="tip-head">
                        <span className="key" style={{ background: "var(--c-model)", width: 10, height: 10 }} />
                        Model call, turn {c.start.turn}
                      </div>
                      <div className="tip-row">
                        <span>
                          <span className="key" style={{ background: "var(--c-model-pre)" }} />
                          Prompt
                        </span>
                        <span>{fmtInt(c.end?.usage?.promptTokens ?? c.start.promptTokensEst)} tok</span>
                      </div>
                      {c.end?.usage?.reasoningTokens != null && (
                        <div className="tip-row">
                          <span>
                            <span className="key think" />
                            Thinking
                          </span>
                          <span>{fmtInt(c.end.usage.reasoningTokens)} tok</span>
                        </div>
                      )}
                      <div className="tip-row">
                        <span>
                          <span className="key" style={{ background: "var(--c-model)" }} />
                          Output
                        </span>
                        <span>{c.end?.usage ? `${fmtInt(c.end.usage.completionTokens)} tok` : "streaming"}</span>
                      </div>
                      <div className="tip-row">
                        <span>TTFT</span>
                        <span>{fmtMs(c.end?.timing.ttftMs)}</span>
                      </div>
                      <div className="tip-row">
                        <span>Speed</span>
                        <span>{fmtTps(c.end?.timing.genTps)}</span>
                      </div>
                      <div className="tip-row">
                        <span>Total</span>
                        <span>{c.end ? fmtMs(c.end.timing.totalMs) : fmtMs(end - c.start.ts)}</span>
                      </div>
                      {c.end && (
                        <div className="tip-row">
                          <span>Finish</span>
                          <span className={err ? "err-text" : undefined}>{c.end.finishReason}</span>
                        </div>
                      )}
                    </>,
                  )
                }
                onClick={(e) => {
                  e.stopPropagation();
                  select({ kind: "call", callId: c.callId, seq: c.seq });
                }}
              >
                <rect x={x0} y={y - 3} width={Math.max(w, 6)} height={LANE_H + 6} fill="transparent" />
                <rect x={x0} y={y} width={Math.max(1, xp - x0)} height={LANE_H} rx={2} className="tl-pre" />
                {x1 > xp + 0.5 && xt != null && xt > xp && (
                  <rect x={xp} y={y} width={Math.max(0, Math.min(xt, x1) - xp)} height={LANE_H} className="tl-think" style={{ fill: `url(#${thinkPat})` }} />
                )}
                {x1 > (xt ?? xp) + 0.5 && <rect x={xt ?? xp} y={y} width={x1 - (xt ?? xp)} height={LANE_H} className="tl-gen" />}
                {err && <rect x={x1 - 2} y={y} width={2} height={LANE_H} className="tl-err-end" />}
                {sel && <rect x={x0 - 1.5} y={y - 1.5} width={Math.max(w, 2) + 3} height={LANE_H + 3} rx={3} className="tl-sel" />}
                {lbl && (
                  <text x={lbl.x} y={y + LANE_H / 2 + 3.5} className={`tl-text ${lbl.cls}`}>
                    {label}
                  </text>
                )}
              </g>
            );
          })}

          {/* tools lane */}
          {toolBars.map(({ t, x0, x1 }) => {
            const sel = isSel(selection, "tool", t.toolCallId);
            const failed = toolFailed(t);
            const y = laneY(1);
            const w = x1 - x0;
            const label = shortToolLabel(t.name, t.args);
            const fits = w > label.length * 5.6 + 10;
            return (
              <g
                key={t.toolCallId}
                className={`tl-bar${sel ? " sel" : ""}${t.end ? "" : " running"}`}
                onMouseMove={(e) => tipAt(e, toolTip(t))}
                onClick={(e) => {
                  e.stopPropagation();
                  select({ kind: "tool", toolCallId: t.toolCallId, callId: t.callId, seq: t.seq });
                }}
              >
                <rect x={x0 - 3} y={y - 3} width={Math.max(w, 3) + 6} height={LANE_H + 6} fill="transparent" />
                <rect x={x0} y={y} width={w} height={LANE_H} rx={2} style={{ fill: failed ? "var(--err)" : `var(--c-${toolKind(t.name)})` }} />
                {sel && <rect x={x0 - 1.5} y={y - 1.5} width={w + 3} height={LANE_H + 3} rx={3} className="tl-sel" />}
                {fits && (
                  <text x={x0 + 5} y={y + LANE_H / 2 + 3.5} className={`tl-text on-${failed ? "err" : toolKind(t.name)}`}>
                    {label}
                  </text>
                )}
              </g>
            );
          })}

          {/* files lane */}
          {d.fsSteps.map((f) => {
            const x = M.x(f.ts);
            const y = laneY(2);
            const cc = changeCounts(f.changes);
            const cls = cc.deleted && !cc.added && !cc.modified ? "del" : cc.added && !cc.modified ? "add" : "mod";
            const sel = !!selection && selection.kind === "tool" && selection.toolCallId === f.toolCallId;
            return (
              <g
                key={f.seq}
                className={`tl-tick-g${sel ? " sel" : ""}`}
                onMouseMove={(e) =>
                  tipAt(
                    e,
                    <>
                      <div className="tip-head">
                        {f.changes.length} file{f.changes.length > 1 ? "s" : ""} changed
                      </div>
                      {f.changes.slice(0, 8).map((c) => (
                        <div key={c.path} className="tip-row">
                          <span className="mono">{c.path.replace(/^\/workspace\//, "")}</span>
                          <span className={c.kind === "added" ? "ok-text" : c.kind === "deleted" ? "err-text" : "warn-text"}>{c.kind}</span>
                        </div>
                      ))}
                      {f.changes.length > 8 && <div className="tip-row dim">{f.changes.length - 8} more</div>}
                    </>,
                  )
                }
                onClick={(e) => {
                  e.stopPropagation();
                  if (f.toolCallId) {
                    const t = d.tools.find((x) => x.toolCallId === f.toolCallId);
                    select({ kind: "tool", toolCallId: f.toolCallId, callId: t?.callId, seq: t?.seq ?? f.seq });
                    useStore.setState({ inspectorTab: "files", inspectorOpen: true });
                  } else select({ kind: "event", seq: f.seq });
                }}
              >
                <rect x={x - 5} y={y - 2} width={10} height={LANE_H + 4} fill="transparent" />
                <rect x={x - 1.5} y={y} width={3} height={LANE_H} rx={1} className={`tl-fs ${cls}`} />
                {f.changes.length > 1 && (
                  <text x={x + 5} y={y + LANE_H / 2 + 3.5} className="tl-text ink">
                    {f.changes.length}
                  </text>
                )}
              </g>
            );
          })}

          {/* network lane */}
          {d.nets.map((n) => {
            const x = M.x(n.entry.ts);
            const y = laneY(3);
            const sel = isSel(selection, "net", n.entry.id);
            const deny = n.entry.decision === "deny";
            return (
              <g
                key={n.entry.id}
                className={`tl-tick-g${sel ? " sel" : ""}`}
                onMouseMove={(e) =>
                  tipAt(
                    e,
                    <>
                      <div className="tip-head">
                        <span className={deny ? "err-text" : "ok-text"}>{deny ? "Denied" : "Allowed"}</span>
                        <span className="dim">{n.entry.reason}</span>
                      </div>
                      <div className="mono tip-cmd">
                        {n.entry.method} {n.entry.url}
                      </div>
                    </>,
                  )
                }
                onClick={(e) => {
                  e.stopPropagation();
                  select({ kind: "net", entryId: n.entry.id, seq: n.seq });
                }}
              >
                <rect x={x - 5} y={y - 2} width={10} height={LANE_H + 4} fill="transparent" />
                {deny ? (
                  <path d={`M${x - 3.5} ${y + 4.5} l7 7 m0 -7 l-7 7`} className="tl-net deny" />
                ) : (
                  <rect x={x - 1.5} y={y + 2} width={3} height={LANE_H - 4} rx={1} className="tl-net allow" />
                )}
              </g>
            );
          })}

          {/* live edge */}
          {live && (
            <g className="tl-now">
              <line x1={M.x(end)} x2={M.x(end)} y1={TOP - 4} y2={h - AXIS_H} />
              <circle cx={M.x(end)} cy={TOP - 3} r={2.5} />
            </g>
          )}
        </svg>
      </div>
      <div className="tl-tools">
        <button className="icon-btn sm" title="Zoom in (⌘ + scroll)" onClick={() => zoomBy(1.6)}>
          <Plus />
        </button>
        <button className="icon-btn sm" title="Zoom out" onClick={() => zoomBy(1 / 1.6)} disabled={zoom == null}>
          <Minus />
        </button>
        <button className={`icon-btn sm${zoom == null ? " on" : ""}`} title="Fit whole run" onClick={() => setZoom(null)}>
          <Maximize2 />
        </button>
      </div>
      <ChartTip tip={tip} />
    </div>
  );
}
