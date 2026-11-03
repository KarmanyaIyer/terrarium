// New character: a description becomes a vector. The job runs in the backend, so this only draws what LabState.grow says:
// the stages, what the model writes as the fit improves, then real replies and whether it took.

import { useEffect, useState } from "react";
import { Check, Circle, FlaskConical, Loader2, MessageSquare, Plus, Search, Sprout, Square, Target, X } from "lucide-react";
import type { LabGrow, LabGrowResult, LabGrowStage, LabLensHit, LabScreenResult } from "@terrarium/shared";
import { cancelGrow, chatWithStrain, dismissGrow, growToMix, growSeeds, keepGrown, lensLookup, screenHit, screenToMix, startGrow, stopScreen, useLab } from "../../state/lab";
import { isVector } from "../../lib/recipe";
import { Busy, ErrLine, Elapsed, fmtSecs, TokChips } from "./bits";

const STAGES: { id: LabGrowStage; label: string }[] = [
  { id: "text", label: "Writing text as the character" },
  { id: "fit", label: "Fitting a vector to that text" },
  { id: "strength", label: "Finding the strength" },
  { id: "replies", label: "Writing test replies" },
];

const plain = (t: string) => t.replace(/\*\*/g, "").trim();

export function GrowBox() {
  const text = useLab((s) => s.growText);
  const running = useLab((s) => s.lab?.grow?.status === "running");
  const facts = useLab((s) => s.lab?.model);
  return (
    <section className="ask">
      <form
        className="ask-box"
        onSubmit={(e) => {
          e.preventDefault();
          if (!running) void startGrow();
        }}
      >
        <label htmlFor="grow-text">New character</label>
        <div className="ask-line">
          <input id="grow-text" className="input ask-input" value={text} placeholder="a lighthouse keeper" onChange={(e) => useLab.setState({ growText: e.target.value })} autoComplete="off" spellCheck={false} />
          <button className="btn primary" disabled={!text.trim() || running}>
            <Sprout /> Build
          </button>
        </div>
        <p className="dim2 ask-how">{/LFM|Bonsai-2-2B/.test(facts?.modelId ?? "") ? "Takes a few minutes." : "Takes about 10 minutes."}</p>
      </form>
    </section>
  );
}

export function GrowPanel({ grow }: { grow: LabGrow }) {
  if (grow.status === "running") return <Running grow={grow} />;
  if (grow.result) return <Result grow={grow} r={grow.result} />;
  return (
    <section className="grow-job">
      <div className="flow-head">
        <h3>{grow.description}</h3>
        <span className="blk-spacer" />
        <button className="btn sm ghost" onClick={() => void dismissGrow()}>
          Dismiss
        </button>
      </div>
      {grow.status === "cancelled" ? <p className="dim2">Stopped.</p> : <ErrLine err={{ error: grow.error ?? "The grow failed." }} />}
    </section>
  );
}

function Running({ grow }: { grow: LabGrow }) {
  const at = STAGES.findIndex((s) => s.id === grow.stage);
  const latest = grow.partial.at(-1);
  return (
    <section className="grow-job" aria-live="polite">
      <div className="flow-head">
        <h3>{grow.description}</h3>
        <Elapsed since={grow.startedAt} />
        <span className="blk-spacer" />
        <button className="btn sm" onClick={() => void cancelGrow()}>
          <Square /> Stop
        </button>
      </div>
      <ol className="flow-steps">
        {STAGES.map((s, i) => (
          <li key={s.id} className={`flow-step ${i < at ? "done" : i === at ? "run" : "wait"}`}>
            {i < at ? <Check size={13} /> : i === at ? <Loader2 size={13} className="spin" /> : <Circle size={9} />}
            <span>
              {s.label}
              {i === at && grow.of > 0 && (
                <span className="dim2 num">
                  {" "}
                  {grow.step} of {grow.of}
                  {s.id === "fit" && grow.loss != null && grow.firstLoss != null ? `, loss ${grow.firstLoss.toFixed(2)} to ${grow.loss.toFixed(2)}` : ""}
                </span>
              )}
            </span>
          </li>
        ))}
      </ol>
      {grow.note && <p className="lab-note dim2">{grow.note}</p>}
      {latest && (
        <figure className="spec-reply grow-peek" key={`${latest.label}${latest.prompt}`}>
          <blockquote className="selectable">{plain(latest.reply)}</blockquote>
          <figcaption className="dim2">
            <span>{latest.label}</span>
            <span>{latest.prompt}</span>
          </figcaption>
        </figure>
      )}
    </section>
  );
}


function Result({ grow, r }: { grow: LabGrow; r: LabGrowResult }) {
  // By vector, not by name: growing the same description again is a new vector and a new strain.
  const kept = useLab((s) => s.strains?.find((st) => st.baseModelId === grow.modelId && st.pushes.some((p) => isVector(p) && p.id === r.vector.id)));
  const [busy, setBusy] = useState(false);
  const best = [...r.replies].sort((a, b) => Number(b.inCharacter) - Number(a.inCharacter));
  return (
    <section className="grow-job">
      <div className="flow-head">
        <h3>{r.name}</h3>
        <span className="blk-spacer" />
        <button className="btn sm ghost" onClick={() => void dismissGrow()}>
          Dismiss
        </button>
      </div>
      <p className="grow-verdict">{r.verdict.text}</p>
      <div className="grow-acts">
        <button className="btn sm primary" disabled={busy} onClick={() => (setBusy(true), void growSeeds(grow).finally(() => setBusy(false)))} >
          <Target /> Test across seeds
        </button>
        {kept ? (
          <button className="btn sm" onClick={() => void chatWithStrain(kept)} >
            <MessageSquare /> Chat with strain
          </button>
        ) : (
          <button className="btn sm" onClick={() => void keepGrown(grow)} title="Adds it to Strains and the model pickers">
            <FlaskConical /> Save as strain
          </button>
        )}
        <button className="btn sm ghost" onClick={() => void growToMix(grow)}>
          <Plus /> Add to the mix
        </button>
      </div>
      <div className="grow-replies">
        {best.map((x) => (
          <figure key={x.prompt} className={`spec-reply${x.inCharacter ? "" : " grow-plain"}`}>
            <blockquote className="selectable">{plain(x.reply)}</blockquote>
            <figcaption className="dim2">
              <span>{x.prompt}</span>
              {!x.coherent ? <span>garbled</span> : !x.inCharacter && <span>out of character</span>}
            </figcaption>
          </figure>
        ))}
      </div>
      <details className="spec-more">
        <summary>Strength {r.vector.strength}, layer {r.vector.layer}</summary>
        <table className="grow-rungs num">
          <thead>
            <tr>
              <th>Strength</th>
              <th>Readable</th>
              <th>In character</th>
            </tr>
          </thead>
          <tbody>
            {r.rungs.map((g) => (
              <tr key={g.strength} className={g.strength === r.vector.strength ? "on" : undefined}>
                <td>{g.strength}</td>
                <td>
                  {g.coherent} of {g.n}
                </td>
                <td>
                  {g.inCharacter} of {g.n}
                </td>
              </tr>
            ))}
            <tr>
              <td>Unsteered</td>
              <td />
              <td>
                {r.baseline.inCharacter} of {r.baseline.n}
              </td>
            </tr>
          </tbody>
        </table>
        <p className="dim2 num">
          Took {fmtSecs(r.ms)}.
        </p>
      </details>
    </section>
  );
}

// ---------- word search ----------

/** Single neurons that write a word family, from the table this model's search built. */
export function WordSearch() {
  const modelId = useLab((s) => s.lab?.model?.modelId);
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<LabLensHit[] | null>(null);
  const [trying, setTrying] = useState<{ key: string; since: number } | null>(null);
  const [shown, setShown] = useState<LabScreenResult | null>(null);
  useEffect(() => {
    const word = q.trim();
    setShown(null);
    if (!modelId || word.length < 3) return setHits(null);
    const t = setTimeout(() => void lensLookup(modelId, word).then(setHits), 200);
    return () => clearTimeout(t);
  }, [q, modelId]);
  const word = q.trim().toLowerCase();
  return (
      <div className="word-search">
        <div className="ask-line">
          <Search size={14} className="dim2" />
          <input className="input" value={q} placeholder="A word: surprise, paint, trains" aria-label="A word" onChange={(e) => setQ(e.target.value)} autoComplete="off" spellCheck={false} />
        </div>
        {hits?.length === 0 && <p className="dim2">No neuron found for "{q.trim()}".</p>}
        {hits && hits.length > 0 && !shown && (
          <ul className="words-list">
            {hits.map((h) => {
              const key = `${h.layer}:${h.neuron}`;
              return (
                <li key={key}>
                  <code className="num">
                    L{h.layer}N{h.neuron}
                    {h.sign > 0 ? "+" : "-"}
                  </code>
                  <TokChips tokens={h.tokens} max={5} />
                  <span className="blk-spacer" />
                  <button
                    className="btn sm"
                    disabled={trying != null}
                    title="Tries doses on 16 replies each. Takes 1 to 3 minutes."
                    onClick={() => {
                      setTrying({ key, since: Date.now() });
                      void screenHit(h, word)
                        .then((r) => r && setShown(r))
                        .finally(() => setTrying(null));
                    }}
                  >
                    {trying?.key === key ? <Busy since={trying.since}>Trying doses</Busy> : "Try it"}
                  </button>
                  {trying?.key === key && (
                    <button className="btn sm" onClick={stopScreen}>
                      <Square /> Stop
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        {shown && <Screened r={shown} onBack={() => setShown(null)} />}
      </div>
  );
}

function Screened({ r, onBack }: { r: LabScreenResult; onBack: () => void }) {
  const best = r.pick ?? [...r.screens].sort((a, b) => b.hit - a.hit)[0];
  return (
    <div className="words-result">
      {r.pick ? (
        <p>
          <Check size={13} /> At {r.pick.dose > 0 ? "+" : ""}
          {r.pick.dose}: "{r.word}" in {Math.round(r.pick.hit * r.pick.n)} of {r.pick.n} replies.
        </p>
      ) : (
        <p>
          <X size={13} /> {best ? `Best: ${Math.round(best.hit * best.n)} of ${best.n} replies at ${best.dose > 0 ? "+" : ""}${best.dose}.` : "No dose worked."}
        </p>
      )}
      {best && (
        <figure className="spec-reply">
          <blockquote className="selectable">{plain(best.sample.reply)}</blockquote>
          <figcaption className="dim2">{best.sample.prompt}</figcaption>
        </figure>
      )}
      <div className="grow-acts">
        {r.pick && (
          <button className="btn sm primary" onClick={() => screenToMix(r)}>
            <Plus /> Add to the mix
          </button>
        )}
        <button className="btn sm ghost" onClick={onBack}>
          Back to the list
        </button>
      </div>
    </div>
  );
}
