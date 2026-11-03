// Grow: one sentence becomes a character. The job runs in the backend, so this only draws what LabState.grow says:
// the stages, what the model writes as the fit improves, then real replies and a plain answer on whether it took.

import { useEffect, useState } from "react";
import { Check, Circle, FlaskConical, Loader2, MessageSquare, Plus, Search, Sprout, Square, Target, X } from "lucide-react";
import type { LabGrow, LabGrowResult, LabGrowStage, LabLensHit, LabScreenResult } from "@terrarium/shared";
import { cancelGrow, chatWithStrain, dismissGrow, growToMix, growSeeds, keepGrown, lensLookup, screenHit, screenToMix, startGrow, stopScreen, useLab } from "../../state/lab";
import { isVector } from "../../lib/recipe";
import { Busy, ErrLine, Elapsed, fmtSecs, TokChips } from "./bits";

const STAGES: { id: LabGrowStage; label: string }[] = [
  { id: "text", label: "The model plays the part" },
  { id: "fit", label: "Fitting a direction to what it wrote" },
  { id: "strength", label: "Finding the strongest push that still reads as text" },
  { id: "replies", label: "Writing replies" },
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
        <label htmlFor="grow-text">Who should the model become?</label>
        <div className="ask-line">
          <input id="grow-text" className="input ask-input" value={text} placeholder="a lighthouse keeper" onChange={(e) => useLab.setState({ growText: e.target.value })} autoComplete="off" spellCheck={false} />
          <button className="btn primary" disabled={!text.trim() || running}>
            <Sprout /> Grow it
          </button>
        </div>
        <p className="dim2 ask-how">
          One sentence is enough. {/LFM|Bonsai-2-2B/.test(facts?.modelId ?? "") ? "A few minutes on this model" : "About 10 minutes on this model, longer if the Mac is busy"}, and the rest of the Lab keeps working while it runs. Things and creatures take best: a very sleepy cat, a retired sea captain.
        </p>
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
      {grow.status === "cancelled" ? <p className="dim2">Stopped. Nothing was kept.</p> : <ErrLine err={{ error: grow.error ?? "The grow failed." }} />}
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
                  {s.id === "fit" && grow.loss != null && grow.firstLoss != null ? `, how unlike the character: ${grow.firstLoss.toFixed(2)} down to ${grow.loss.toFixed(2)}` : ""}
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
        <button className="btn sm primary" disabled={busy} onClick={() => (setBusy(true), void growSeeds(grow).finally(() => setBusy(false)))} title="Puts it in the mix and runs several seeds on your prompts">
          <Target /> Test across seeds
        </button>
        {kept ? (
          <button className="btn sm" onClick={() => void chatWithStrain(kept)} title="You kept this one. It's in Strains and the model pickers">
            <MessageSquare /> Chat with it
          </button>
        ) : (
          <button className="btn sm" onClick={() => void keepGrown(grow)} title="Saves it as a strain: a model you can chat with or run evals on">
            <FlaskConical /> Keep as strain
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
              {!x.coherent ? <span>stopped reading as text</span> : !x.inCharacter && <span>out of character</span>}
            </figcaption>
          </figure>
        ))}
      </div>
      <details className="spec-more">
        <summary>How it picked strength {r.vector.strength}</summary>
        <table className="grow-rungs num">
          <thead>
            <tr>
              <th>Strength</th>
              <th>Read as text</th>
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
              <td>No push</td>
              <td />
              <td>
                {r.baseline.inCharacter} of {r.baseline.n}
              </td>
            </tr>
          </tbody>
        </table>
        <p className="dim2 num">
          Layer {r.vector.layer}. {r.named ? "The first text came back generic, so the model wrote it again naming the character outright. " : ""}Took {fmtSecs(r.ms)}.
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
    <details className="lab-more find-words">
      <summary>Search for a word a single neuron can't stop saying</summary>
      <div className="word-search">
        <div className="ask-line">
          <Search size={14} className="dim2" />
          <input className="input" value={q} placeholder="surprise, paint, trains" aria-label="A word" onChange={(e) => setQ(e.target.value)} autoComplete="off" spellCheck={false} />
        </div>
        {hits?.length === 0 && <p className="dim2">No neuron in this model's table writes "{q.trim()}". Grow a character about it instead.</p>}
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
                    title="Tries falling doses on 16 replies each until one writes the word nearly every time. A minute or three."
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
    </details>
  );
}

function Screened({ r, onBack }: { r: LabScreenResult; onBack: () => void }) {
  const best = r.pick ?? [...r.screens].sort((a, b) => b.hit - a.hit)[0];
  return (
    <div className="words-result">
      {r.pick ? (
        <p>
          <Check size={13} /> At {r.pick.dose > 0 ? "+" : ""}
          {r.pick.dose} it wrote "{r.word}" in {Math.round(r.pick.hit * r.pick.n)} of {r.pick.n} replies, and they read as text.
        </p>
      ) : (
        <p>
          <X size={13} /> It didn't hold. {best ? `Best was ${Math.round(best.hit * best.n)} of ${best.n} replies at ${best.dose > 0 ? "+" : ""}${best.dose}. ` : ""}Most word neurons don't, about 3 in 20 do. Grow a character about it instead.
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
