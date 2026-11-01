import { Play, Plus } from "lucide-react";
import type { LabAttributeResult } from "@terrarium/shared";
import { addToMix, runAttribute, useLab } from "../../state/lab";
import { nid, sameRef } from "../../lib/recipe";
import { fmtBytes, fmtInt, fmtMs } from "../../lib/format";
import { Switch } from "../../components/ui";
import { Term } from "../../lib/labExplain";
import { Busy, ErrLine, fmtPct0, LayerKind, NeuronLink, TokChips, tokText } from "./bits";

/** Which neurons pushed the model toward one next token instead of another. */
export function Trace() {
  const s = useLab((x) => x);
  const set = useLab.setState;
  const go = () => void runAttribute();
  const keys = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey || e.currentTarget.tagName === "INPUT")) {
      e.preventDefault();
      go();
    }
  };
  return (
    <div className="trace lab-scroll">
      <div className="trace-form">
        <label className="lab-field wide">
          <span>Prompt</span>
          <textarea className="textarea" rows={2} value={s.attrPrompt} onChange={(e) => set({ attrPrompt: e.target.value })} onKeyDown={keys} />
        </label>
        <label className="lab-field">
          <span>Answer starts</span>
          <input className="input" value={s.attrPrefill} placeholder="I am an" onChange={(e) => set({ attrPrefill: e.target.value })} onKeyDown={keys} />
        </label>
        <label className="lab-field">
          <span>Next token</span>
          <input className="input mono" value={s.attrTarget} placeholder=" alien" onChange={(e) => set({ attrTarget: e.target.value })} onKeyDown={keys} />
        </label>
        <label className="lab-field">
          <span>Instead of</span>
          <input className="input mono" value={s.attrFoil} placeholder="its own top pick" onChange={(e) => set({ attrFoil: e.target.value })} onKeyDown={keys} />
        </label>
        <Switch on={s.attrMix} onChange={(v) => set({ attrMix: v })} label={`With the mix (${s.mix.length})`} disabled={!s.mix.length} />
        <button className="btn primary" disabled={s.attrBusy != null || !s.attrPrompt.trim() || !s.attrTarget} onClick={go}>
          {s.attrBusy != null ? <Busy since={s.attrBusy}>Tracing</Busy> : <><Play /> Trace</>}
        </button>
      </div>
      <div className="lab-note dim2">Tokens usually start with a space: " alien", not "alien".</div>
      {s.attrErr && <ErrLine err={s.attrErr} />}
      {s.attrRes ? (
        <div className={s.attrBusy != null ? "stale" : undefined}>
          <TraceResult r={s.attrRes} />
        </div>
      ) : (
        !s.attrErr &&
        s.attrBusy == null && <div className="lab-empty">Pick a next token and see which neurons voted for it over the alternative. Pairs well with the mix on: did your push do the work?</div>
      )}
    </div>
  );
}

function TraceResult({ r }: { r: LabAttributeResult }) {
  const kinds = useLab((s) => s.lab?.model?.layerKinds);
  const mix = useLab((s) => s.mix);
  const set = useLab.setState;
  const max = Math.max(1e-9, ...r.nodes.map((n) => Math.abs(n.attr)));
  return (
    <>
      <div className="trace-sum">
        <span>
          <Term k="metric">
            <span className="mono">{tokText(r.target)}</span> over <span className="mono">{tokText(r.foil)}</span>
          </Term>{" "}
          <b className="num">{r.metric >= 0 ? "+" : ""}{r.metric.toFixed(2)}</b>
        </span>
        <span className="dim2 num">
          {fmtMs(r.ms)}, peak {fmtBytes(r.peakBytes)}
        </span>
      </div>
      <div className="trace-next">
        <span className="dim2">Model's next token</span>
        {r.topNext.map((t) => (
          <button
            key={t.token}
            className={`chip tok-chip${t.token === r.target ? " on" : ""}`}
            title="Click: trace this one. Alt-click: compare against it."
            onClick={(e) => set(e.altKey ? { attrFoil: t.token } : { attrTarget: t.token })}
          >
            <span className="mono">{tokText(t.token)}</span> <span className="num dim2">{fmtPct0(t.prob)}</span>
          </button>
        ))}
      </div>
      <div className="trace-nodes">
        <div className="tnode tnode-head" aria-hidden>
          <span>Neuron</span>
          <span>
            <Term k="attribute">Push toward {tokText(r.target)}</Term>
          </span>
          <span className="r">Share</span>
          <span>Pushes</span>
          <span />
        </div>
        {r.nodes.map((n) => {
          const inMix = mix.some((p) => sameRef(p, n));
          const w = `${(Math.abs(n.attr) / max) * 50}%`;
          return (
            <div key={nid(n)} className="tnode">
              <span className="cand-id">
                <NeuronLink r={n} />
                <LayerKind kind={kinds?.[n.layer]} />
                {inMix && <span className="chip">in mix</span>}
              </span>
              <span className="tbar" title={`${n.attr >= 0 ? "+" : ""}${n.attr.toFixed(3)} logit difference`}>
                <span className="tbar-track">
                  <span className={n.attr >= 0 ? "pos" : "neg"} style={n.attr >= 0 ? { left: "50%", width: w } : { right: "50%", width: w }} />
                </span>
                <span className="num">{n.attr >= 0 ? "+" : ""}{n.attr.toFixed(2)}</span>
              </span>
              <span className="r num">{fmtPct0(n.share)}</span>
              <span className="tnode-toks">
                <TokChips tokens={n.promotes} max={3} />
              </span>
              <span className="r">
                <button className="btn sm ghost" disabled={inMix} onClick={() => addToMix(n)} title="Add to the mix at dose +0.8">
                  <Plus /> mix
                </button>
              </span>
            </div>
          );
        })}
      </div>
      <div className="dim2 lab-note num">
        Top {fmtInt(r.nodes.length)} by size. Positive bars pushed toward {tokText(r.target)}; negative bars pushed toward {tokText(r.foil)}.
      </div>
    </>
  );
}
