import { useEffect, useState } from "react";
import { Play } from "lucide-react";
import type { LabAttributeResult, LabTraceNode } from "@terrarium/shared";
import { runAttribute, useLab } from "../../state/lab";
import { useStore } from "../../state/store";
import { findPush, nid } from "../../lib/recipe";
import { fmtInt } from "../../lib/format";
import { Hint, Switch } from "../../components/ui";
import { Term } from "../../lib/labExplain";
import { Busy, ErrLine, fmtPct0, fmtSecs, LayerKind, NeuronLink, TokChips, tokText } from "./bits";
import { NeuronActions, QUALITY, RecipeLine } from "./Reply";

/** What the tokenizer makes of a field, a moment after you stop typing. */
function useTokens(text: string): string[] | null {
  const [tokens, setTokens] = useState<string[] | null>(null);
  useEffect(() => {
    if (!text) {
      setTokens(null);
      return;
    }
    let live = true;
    const t = window.setTimeout(() => {
      void useStore
        .getState()
        .backend?.lab.tokens([text])
        .then((r) => live && setTokens(r.tokens[0]?.map((x) => x.text) ?? null))
        .catch(() => live && setTokens(null));
    }, 200);
    return () => {
      live = false;
      window.clearTimeout(t);
    };
  }, [text]);
  return tokens;
}

function Chips({ tokens, tail, first }: { tokens: string[] | null; tail?: number; first?: boolean }) {
  if (!tokens?.length) return null;
  const cut = tail && tokens.length > tail ? tokens.length - tail : 0;
  return (
    <span className="tokline" aria-label="How the model reads this">
      {cut > 0 && <span className="dim2">…</span>}
      {tokens.slice(cut).map((t, i) => (
        <span key={i} className={`tk${first && i > 0 ? " off" : ""}`}>
          {tokText(t)}
        </span>
      ))}
    </span>
  );
}

function FieldNote({ children, fix, onFix }: { children: React.ReactNode; fix?: string; onFix?: () => void }) {
  return (
    <span className="field-note">
      {children}
      {fix && (
        <button type="button" className="cell-link" onClick={onFix}>
          {fix}
        </button>
      )}
    </span>
  );
}

/** Which neurons make it write one word, measured by pushing them. */
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
  const pre = useTokens(s.attrPrefill);
  const tgt = useTokens(s.attrTarget);
  const foil = useTokens(s.attrFoilFrom ? "" : s.attrFoil);
  const trailing = s.attrPrefill.endsWith(" ") && s.attrPrefill.trim().length > 0;
  const noSpace = /[\p{L}\p{N},;:.!?]$/u.test(s.attrPrefill) && !!s.attrTarget && /^[\p{L}\p{N}]/u.test(s.attrTarget);
  const canCompareOff = s.attrMix && s.mix.length > 0;
  return (
    <div className="trace lab-scroll">
      <div className="trace-form">
        <label className="lab-field wide">
          <span>Prompt</span>
          <textarea className="textarea" rows={2} value={s.attrPrompt} onChange={(e) => set({ attrPrompt: e.target.value })} onKeyDown={keys} />
        </label>
        <label className="lab-field wide">
          <span>The answer so far</span>
          <input className="input" value={s.attrPrefill} placeholder="I am an" onChange={(e) => set({ attrPrefill: e.target.value })} onKeyDown={keys} />
          <Chips tokens={pre} tail={8} />
          {trailing && (
            <FieldNote fix="Fix it" onFix={() => set({ attrPrefill: s.attrPrefill.trimEnd(), attrTarget: /^\s/.test(s.attrTarget) ? s.attrTarget : ` ${s.attrTarget}` })}>
              A space at the end becomes its own odd token, so it moves onto the next word.
            </FieldNote>
          )}
        </label>
        <label className="lab-field">
          <span>Next word</span>
          <input className="input mono" value={s.attrTarget} placeholder=" alien" onChange={(e) => set({ attrTarget: e.target.value })} onKeyDown={keys} />
          <Chips tokens={tgt} first />
          {tgt && tgt.length > 1 && <FieldNote>The model writes this in {tgt.length} pieces. Only the first, "{tokText(tgt[0])}", is traced.</FieldNote>}
          {noSpace && (
            <FieldNote fix="Add the space" onFix={() => set({ attrTarget: ` ${s.attrTarget}` })}>
              Words mid-sentence usually start with a space.
            </FieldNote>
          )}
        </label>
        <div className="lab-field">
          <span>Instead of</span>
          {s.attrFoilFrom ? (
            <span className="foil-from">
              what it writes without the mix
              <button type="button" className="cell-link" onClick={() => set({ attrFoilFrom: false })}>
                Type a word
              </button>
            </span>
          ) : (
            <>
              <input className="input mono" value={s.attrFoil} placeholder="its own top pick" onChange={(e) => set({ attrFoil: e.target.value })} onKeyDown={keys} aria-label="Instead of" />
              <Chips tokens={foil} first />
              {foil && foil.length > 1 && <FieldNote>Only the first piece, "{tokText(foil[0])}", counts.</FieldNote>}
              {canCompareOff && (
                <button type="button" className="cell-link" onClick={() => set({ attrFoilFrom: true, attrFoil: "" })}>
                  Compare with what it writes without the mix
                </button>
              )}
            </>
          )}
        </div>
        <div className="trace-go">
          <button className="btn primary" disabled={s.attrBusy != null || !s.attrPrompt.trim() || !s.attrTarget} onClick={go}>
            {s.attrBusy != null ? <Busy since={s.attrBusy}>Pushing each neuron both ways</Busy> : <><Play /> Trace</>}
          </button>
          <Switch on={s.attrMix} onChange={(v) => set({ attrMix: v, attrFoilFrom: v ? s.attrFoilFrom : false })} label={`With the mix (${s.mix.length})`} disabled={!s.mix.length} />
        </div>
      </div>
      {s.attrErr && <ErrLine err={s.attrErr} />}
      {s.attrRes ? (
        <div className={s.attrBusy != null ? "stale" : undefined}>
          <TraceResult r={s.attrRes} />
        </div>
      ) : (
        !s.attrErr && s.attrBusy == null && <div className="lab-empty">Ask about one word of an answer, or click any word in a reply on Steer or Find to land here with it filled in.</div>
      )}
    </div>
  );
}

const fmtS = (v: number) => `${v >= 0 ? "+" : ""}${v.toFixed(1)}`;
const fmtD = (v: number) => `${v > 0 ? "+" : ""}${Math.round(v * 1000) / 1000}`;

function TraceResult({ r }: { r: LabAttributeResult }) {
  const run = useLab((s) => s.attrRun);
  const set = useLab.setState;
  const nodes = r.nodes.filter((n) => n.best);
  const already = r.top === r.target;
  const m = r.measure;
  return (
    <>
      <div className="answer-strip">
        <div className="answer-q dim2 selectable">{run?.prompt}</div>
        <div className="answer-a selectable">
          {r.prefill}
          <mark className="at">{tokText(r.target)}</mark>
          <span className="answer-foil dim2">instead of {tokText(r.foil)}</span>
        </div>
        <div className="answer-now">
          {already ? (
            <>The model already writes <b className="mono">{tokText(r.top)}</b> here.</>
          ) : (
            <>Right now it writes <b className="mono">{tokText(r.top)}</b> here.</>
          )}{" "}
          <Term k="metric">
            <span className="dim2">Gap toward {tokText(r.target)}:</span> <b className="num">{fmtS(r.metric)}</b>
          </Term>
        </div>
        <div className="trace-next">
          <span className="dim2">Its next-word odds, click one to trace it</span>
          {r.topNext.map((t) => (
            <button key={t.token} className={`chip tok-chip${t.token === r.target ? " on" : ""}`} title="Click: trace this one. Alt-click: compare against it." onClick={(e) => set(e.altKey ? { attrFoil: t.token, attrFoilFrom: false } : { attrTarget: t.token })}>
              <span className="mono">{tokText(t.token)}</span> <span className="num dim2">{fmtPct0(t.prob)}</span>
            </button>
          ))}
        </div>
        {run && <RecipeLine r={{ modelId: run.modelId, prompt: run.prompt, pushes: run.pushes, seed: 0, temperature: 0, maxTokens: 0, thinking: false }} traceOnly />}
        {r.notes?.map((n, i) => (
          <div key={i} className="field-note">
            {n}
          </div>
        ))}
      </div>
      {m && (
        <p className="trace-how dim2">
          Measured, not estimated: gradients picked a shortlist of {fmtInt(m.shortlisted)} neurons, then each of the {fmtInt(m.neurons)} shown was really pushed at {[...new Set(m.doses.map(Math.abs))].join(", ")} in both directions and the logits read back ({fmtInt(m.passes)} model runs, {fmtSecs(m.ms)}). "Now writes" is what the model picks with that dose in place.
          {m.neurons < m.shortlisted ? ` It ran out of its time budget after ${m.neurons}.` : ""}
        </p>
      )}
      <div className="trows">
        {nodes.map((n) => (
          <TraceRow key={nid(n)} n={n} target={r.target} />
        ))}
      </div>
      {!m && <div className="dim2 lab-note">Gradient estimates only, nothing was pushed.</div>}
    </>
  );
}

function TraceRow({ n, target }: { n: LabTraceNode; target: string }) {
  const kinds = useLab((s) => s.lab?.model?.layerKinds);
  const push = useLab((s) => findPush(s.mix, n));
  const b = n.best!;
  const useful = b.change > 0;
  const total = (n.held ?? 0) + b.dose;
  const opposite = n.attr !== 0 && Math.sign(n.attr) !== Math.sign(b.dose);
  return (
    <div className={`trow${b.flips ? " flips" : ""}`}>
      <div className="trow-main">
        <span className="cand-id">
          <NeuronLink r={n} />
          <LayerKind kind={kinds?.[n.layer]} />
          {push && <span className="chip num">in mix {fmtD(push.value)}</span>}
        </span>
        <span className={`trow-dose num ${b.dose < 0 ? "neg" : "pos"}`}>{fmtD(b.dose)}</span>
        <span className="trow-effect num" title={`Moves the gap between ${tokText(target)} and the other word from ${fmtS(b.metric - b.change)} to ${fmtS(b.metric)}`}>
          <b className={useful ? "ok-text" : "dim2"}>{fmtS(b.change)}</b> <span className="dim2">gap</span>
        </span>
        <span className="trow-top">
          <span className="dim2">now writes</span> <b className="mono">{tokText(b.top)}</b>
          {b.flips && <span className="chip ok">gets it</span>}
        </span>
        <Hint
          tip={
            <>
              <span className="hint-title">What was measured</span>
              <div className="hint-rows num">
                {(n.measured ?? []).map((m) => (
                  <span key={m.dose} className="contents">
                    <span>{fmtD(m.dose)}</span>
                    <span>
                      gap {fmtS(m.metric)}, writes {tokText(m.top)}
                    </span>
                  </span>
                ))}
              </div>
              {n.held ? <div className="hint-line">On top of its {fmtD(n.held)} already in the mix.</div> : null}
              <div className="hint-line">Gradient estimate before pushing: {n.attr >= 0 ? "+" : ""}{n.attr.toFixed(2)}{opposite ? ". It pointed the wrong way, which is why this is measured." : "."}</div>
            </>
          }
        >
          <span className="hint-text dim2">details</span>
        </Hint>
      </div>
      {n.check && (
        <div className="trow-check">
          <span className={`q q-${n.check.quality}`}>{QUALITY[n.check.quality]?.word}</span>
          <span className="truncate selectable">{n.check.text}</span>
        </div>
      )}
      <div className="trow-foot">
        <TokChips tokens={n.promotes} max={4} />
        <span className="blk-spacer" />
        <NeuronActions r={n} dose={Math.round(total * 1000) / 1000} primary={b.flips} />
      </div>
    </div>
  );
}
