import { useState, type ReactNode } from "react";
import { AlertTriangle, Loader2 } from "lucide-react";
import type { LabSnippet, NeuronRef } from "@terrarium/shared";
import { ChartTip, Hint, useNow, type TipState } from "../../components/ui";
import { nid, sameRef } from "../../lib/recipe";
import { LAB_TIP } from "../../lib/labExplain";
import { openNeuron, useLab, type LabErr } from "../../state/lab";

// ---------- numbers ----------

/** Raw activation: 3 significant figures. */
export function fmtAct(v: number): string {
  const a = Math.abs(v);
  return a >= 100 ? v.toFixed(0) : a >= 10 ? v.toFixed(1) : v.toFixed(2);
}

/** x typical, e.g. 3.1× */
export function fmtRel(r: number): string {
  return `${Math.abs(r) >= 10 ? r.toFixed(0) : r.toFixed(1)}×`;
}

export function fmtSecs(ms: number): string {
  return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;
}

export const fmtPct0 = (x: number) => `${Math.round(x * 100)}%`;

/** Token text with its whitespace visible: newlines as ↵, tabs as →. */
export function tokText(t: string): string {
  return t.replace(/\n/g, "↵").replace(/\t/g, "→");
}

/** Activation shading: orange for positive, violet for negative, by x typical (2.5× and up is full). */
export function heat(rel: number | undefined): string | undefined {
  if (rel == null || !Number.isFinite(rel) || Math.abs(rel) < 0.15) return undefined;
  const pct = Math.round(Math.min(1, Math.abs(rel) / 2.5) * 78);
  return `color-mix(in srgb, var(${rel > 0 ? "--act-pos" : "--act-neg"}) ${pct}%, transparent)`;
}

// ---------- busy ----------

export function Elapsed({ since }: { since: number }) {
  const now = useNow("frame");
  return <span className="num lab-elapsed">{fmtSecs(Math.max(0, now - since))}</span>;
}

/** Spinner, what it's doing, and how long it has been at it. */
export function Busy({ since, children }: { since: number; children: ReactNode }) {
  return (
    <span className="lab-busy">
      <Loader2 size={13} className="spin" />
      <span>{children}</span>
      <Elapsed since={since} />
    </span>
  );
}

export function ErrLine({ err, children }: { err: LabErr; children?: ReactNode }) {
  return (
    <div className="lab-err" role="alert">
      <AlertTriangle size={13} />
      <span className="selectable">
        <b>{err.error}</b>
        {err.detail ? <span className="dim2"> {err.detail}</span> : null}
      </span>
      {children}
    </div>
  );
}

// ---------- neurons ----------

/** A neuron id that opens its card. */
export function NeuronLink({ r, className }: { r: NeuronRef; className?: string }) {
  const open = useLab((s) => !!s.card && sameRef(s.card.ref, r));
  return (
    <button
      type="button"
      className={`nid${open ? " on" : ""} ${className ?? ""}`}
      title={`Open ${nid(r)}: layer ${r.layer}, neuron ${r.neuron}`}
      onClick={(e) => {
        e.stopPropagation();
        void openNeuron(r);
      }}
    >
      {nid(r)}
    </button>
  );
}

export function LayerKind({ kind }: { kind?: string }) {
  if (!kind) return null;
  return (
    <Hint tip={LAB_TIP.layerKinds}>
      <span className={`chip lk ${kind}`}>{kind === "full" ? "full attn" : kind === "linear" ? "linear attn" : kind}</span>
    </Hint>
  );
}

/** Token chips for what a neuron pushes toward (or away from). */
export function TokChips({ tokens, neg, max = 8 }: { tokens: string[]; neg?: boolean; max?: number }) {
  if (!tokens.length) return <span className="dim2">none</span>;
  return (
    <span className="tokchips">
      {tokens.slice(0, max).map((t, i) => (
        <span key={i} className={`tokchip${neg ? " neg" : ""}`} title={JSON.stringify(t)}>
          {tokText(t.trim() || t)}
        </span>
      ))}
    </span>
  );
}

// ---------- shaded text ----------

/** A text as tokens, each shaded by the neuron's value on it. */
export function ShadedText({ s, typical, className }: { s: LabSnippet; typical: number; className?: string }) {
  const [tip, setTip] = useState<TipState | null>(null);
  return (
    <span className={`shaded ${className ?? ""}`} onMouseLeave={() => setTip(null)}>
      {s.tokens.map((t, i) => (
        <span
          key={i}
          className={`stok${i === s.peakAt ? " peak" : ""}`}
          style={{ background: heat(s.values[i] / typical) }}
          onMouseMove={(e) =>
            setTip({
              x: e.clientX,
              y: e.clientY,
              content: (
                <>
                  <div className="tip-head mono">{JSON.stringify(t)}</div>
                  <div className="tip-row">
                    <span>Activation</span>
                    <span>{fmtAct(s.values[i])}</span>
                  </div>
                  <div className="tip-row">
                    <span>x typical</span>
                    <span>{fmtRel(s.values[i] / typical)}</span>
                  </div>
                </>
              ),
            })
          }
        >
          {tokText(t)}
        </span>
      ))}
      <ChartTip tip={tip} />
    </span>
  );
}

/** Tiny per-token trace. */
export function MiniSpark({ values, typical, w = 72, h = 16, at }: { values: number[]; typical: number; w?: number; h?: number; at?: number }) {
  if (values.length < 2) return null;
  const max = Math.max(typical, ...values.map(Math.abs)) || 1;
  const x = (i: number) => (i / (values.length - 1)) * w;
  const y = (v: number) => h / 2 - (v / max) * (h / 2 - 1);
  const d = values.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join("");
  return (
    <svg className="minispark" width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden>
      <line x1={0} x2={w} y1={h / 2} y2={h / 2} className="ms-zero" />
      <path d={d} />
      {at != null && <circle cx={x(at)} cy={y(values[at])} r={2} />}
    </svg>
  );
}

/** Small horizontal meter with its value. */
export function Meter({ frac, tone, children, title }: { frac: number; tone: "ok" | "warn" | "err"; children: ReactNode; title?: string }) {
  return (
    <span className={`meter ${tone}`} title={title}>
      <span className="meter-track">
        <span style={{ width: `${Math.max(2, Math.min(100, frac * 100))}%` }} />
      </span>
      <span className="num">{children}</span>
    </span>
  );
}

/** Fluency (mean log-prob per token) as a meter: -4 is empty, 0 is full. */
export function FluencyMeter({ v, base }: { v: number; base?: number }) {
  const drop = base != null ? base - v : -1 - v;
  const tone = v < -2 || drop > 0.8 ? "err" : drop > 0.35 ? "warn" : "ok";
  return (
    <Hint tip={LAB_TIP.fluency}>
      <span className="meter-l">fluency</span>
      <Meter frac={(v + 4) / 4} tone={tone}>
        {v.toFixed(2)}
      </Meter>
    </Hint>
  );
}

export function RepetitionMeter({ v }: { v: number }) {
  return (
    <Hint tip={LAB_TIP.repetition}>
      <span className="meter-l">repetition</span>
      <Meter frac={v} tone={v > 0.3 ? "err" : v > 0.1 ? "warn" : "ok"}>
        {fmtPct0(v)}
      </Meter>
    </Hint>
  );
}

/** Reply text with the mix's words marked. */
export function ReplyText({ text, words }: { text: string; words: string[] }) {
  const stems = [...new Set(words.map((w) => w.trim().toLowerCase().replace(/[^a-z0-9]/g, "")).filter((w) => w.length >= 3))].map((w) => w.replace(/s$/, ""));
  if (!stems.length) return <div className="reply selectable">{text}</div>;
  const re = new RegExp(`\\b(${stems.map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\\w*`, "gi");
  const parts: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(re)) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    parts.push(
      <mark key={m.index} className="cw">
        {m[0]}
      </mark>,
    );
    last = m.index + m[0].length;
  }
  parts.push(text.slice(last));
  return <div className="reply selectable">{parts}</div>;
}
