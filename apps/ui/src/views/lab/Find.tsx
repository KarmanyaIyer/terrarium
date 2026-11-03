import { useMemo, useState } from "react";
import { Check, Circle, Dices, Loader2, Search, Square, Trash2, X } from "lucide-react";
import type { LabCandidate, LabFindResult } from "@terrarium/shared";
import { deleteSet, editSet, exampleSpecimen, fromLines, pickSet, runDescribe, runExample, runFind, runPreset, runSurprise, saveSet, stopFlow, useLab, type FindFlow, type FindSort, type TriedNeuron } from "../../state/lab";
import { formatPush, nid } from "../../lib/recipe";
import { fmtInt } from "../../lib/format";
import { Hint, Popover, Segmented, usePop } from "../../components/ui";
import { LAB_TIP, Term } from "../../lib/labExplain";
import { Busy, ErrLine, fmtPct0, fmtSecs, LayerKind, NeuronLink, ShadedText, TokChips } from "./bits";
import { NeuronActions, ReplySlip } from "./Reply";
import { GrowBox, GrowPanel, WordSearch } from "./Grow";

export function Find() {
  const flow = useLab((s) => s.flow);
  const grow = useLab((s) => (s.lab?.grow?.status === "running" ? s.lab.grow : (s.growShown ?? s.lab?.grow)));
  return (
    <div className="find lab-scroll">
      <GrowBox />
      {grow && <GrowPanel grow={grow} />}
      <WordSearch />
      <details className="lab-more find-neurons" open={flow || !grow ? true : undefined}>
        <summary>Explore single neurons: Surprise me, ready-made sets, or search by description</summary>
        <Ask />
        {flow && <FlowResult flow={flow} />}
      </details>
      <Lists />
    </div>
  );
}

// ---------- the box ----------

function Ask() {
  const trait = useLab((s) => s.trait);
  const flow = useLab((s) => s.flow);
  const sets = useLab((s) => s.sets);
  const example = useLab((s) => s.example);
  const set = useLab.setState;
  const running = flow?.since != null;
  const presets = sets?.filter((x) => x.builtin) ?? [];
  const canExample = useLab(() => !!exampleSpecimen());
  return (
    <section className="ask">
      <form
        className="ask-box"
        onSubmit={(e) => {
          e.preventDefault();
          if (!running) void runDescribe();
        }}
      >
        <label htmlFor="ask-trait">What should the neurons be about?</label>
        <div className="ask-line">
          <input id="ask-trait" className="input ask-input" value={trait} placeholder="a tiger, talks like a pirate, obsessed with trains" onChange={(e) => set({ trait: e.target.value })} autoComplete="off" spellCheck={false} />
          <button className="btn primary" disabled={!trait.trim() || running}>
            <Search /> Find it
          </button>
          <button type="button" className="btn" disabled={running} onClick={() => void runSurprise()} title="No goal: try random neurons in one layer and see what they do">
            <Dices /> Surprise me
          </button>
        </div>
        <p className="dim2 ask-how">The model writes example lines with and without it, every neuron gets scored on those lines, and the best four get tried on a real reply. Takes about a minute.</p>
      </form>
      {presets.length > 0 && (
        <div className="ask-presets">
          <span className="dim2">Or try a prepared one:</span>
          {presets.map((p) => (
            <Hint key={p.id} tip={p.blurb ?? p.name}>
              <button className="preset" disabled={running} onClick={() => void runPreset(p.id)}>
                {p.name}
              </button>
            </Hint>
          ))}
          {canExample && !flow && (
            <button className="cell-link" disabled={example != null || running} onClick={() => void runExample()} title="Pushes one neuron and compares the replies">
              {example ? <Busy since={example.since}>{example.step}</Busy> : "or run the full example"}
            </button>
          )}
        </div>
      )}
    </section>
  );
}

// ---------- what came of it ----------

function FlowSteps({ flow }: { flow: FindFlow }) {
  return (
    <ol className="flow-steps">
      {flow.steps.map((s, i) => (
        <li key={i} className={`flow-step ${s.state}`}>
          {s.state === "run" ? <Loader2 size={13} className="spin" /> : s.state === "done" ? <Check size={13} /> : s.state === "failed" ? <X size={13} /> : <Circle size={9} />}
          <span>{s.label}</span>
        </li>
      ))}
    </ol>
  );
}

function Tried({ t, flow }: { t: TriedNeuron; flow: FindFlow }) {
  const kinds = useLab((s) => s.lab?.model?.layerKinds);
  const best = t.runs.find((r) => r.reply.quality === "ok" || r.reply.quality === "odd") ?? t.runs[0];
  const both = flow.kind === "surprise";
  const shown = both ? t.runs : [best];
  return (
    <section className="tried">
      <header className="tried-head">
        <NeuronLink r={t.ref} />
        <LayerKind kind={kinds?.[t.ref.layer]} />
        <span className="dim2">pushes toward</span>
        <TokChips tokens={t.words} max={5} />
        {!both && best.hit && <span className="chip ok">wrote about it</span>}
      </header>
      <div className={both ? "tried-pair" : undefined}>
        {shown.map((r) => (
          <div key={r.dose} className="tried-run">
            <ReplySlip title={`At ${r.dose > 0 ? "+" : ""}${r.dose}`} reply={r.reply} recipe={r.recipe} words={t.words} hideActions />
            <NeuronActions r={t.ref} dose={r.dose} primary={r === best} />
          </div>
        ))}
      </div>
      {!both && t.runs.length > 1 && <div className="lab-note dim2">At +{t.runs[t.runs.length - 1].dose} this one stopped reading as text, so this is the softer dose.</div>}
    </section>
  );
}

function Together({ flow }: { flow: FindFlow }) {
  const t = flow.together!;
  return (
    <section className="tried">
      <header className="tried-head">
        <span className="dim2">One neuron rarely carries a whole trait, so here are the four that fire on it most, together</span>
        {t.hit && <span className="chip ok">wrote about it</span>}
      </header>
      <ReplySlip title={`All four at ${formatPush(t.recipe.pushes[0]).replace(/^L\d+N\d+/, "")}`} reply={t.reply} recipe={t.recipe} />
    </section>
  );
}

function FlowResult({ flow }: { flow: FindFlow }) {
  const running = flow.since != null;
  const hits = flow.tried.some((t) => t.runs.some((r) => r.hit)) || !!flow.together?.hit;
  const done = !running && !flow.err;
  return (
    <section className="flow">
      <div className="flow-head">
        <h3>{flow.kind === "surprise" ? `${flow.title}: what its neurons do` : flow.title}</h3>
        <span className="blk-spacer" />
        {running && (
          <button className="btn sm" onClick={stopFlow}>
            <Square /> Stop
          </button>
        )}
      </div>
      {(running || flow.err) && <FlowSteps flow={flow} />}
      {flow.err && <ErrLine err={flow.err} />}
      {done && flow.tried.length > 0 && (
        <p className="flow-next">
          {flow.kind === "surprise"
            ? `Tried ${flow.sampled ?? "some"} random neurons in this layer and kept the three that move the next word most, pushed both ways. If one is interesting, add it to the mix or press Surprise me again.`
            : hits
              ? "These replies come from pushing one neuron. Add the one you like to the mix, then sweep its dose or test it across seeds to see how well it holds up."
              : "None of these wrote about it at this dose. Sweep one to look at other doses, try different wording, or open the full list below."}
        </p>
      )}
      {flow.baseline && <ReplySlip title="Unsteered, for comparison" reply={flow.baseline.reply} recipe={flow.baseline.recipe} hideActions />}
      {flow.together?.hit && <Together flow={flow} />}
      {flow.tried.map((t) => (
        <Tried key={nid(t.ref)} t={t} flow={flow} />
      ))}
      {flow.together && !flow.together.hit && <Together flow={flow} />}
    </section>
  );
}

// ---------- own texts, all candidates ----------

function SaveAs() {
  const pop = usePop();
  const setName = useLab((s) => s.setName);
  const [name, setNameIn] = useState("");
  return (
    <>
      <button ref={pop.ref} className="btn sm ghost" onClick={() => (setNameIn(setName ? `${setName} copy` : ""), pop.toggle())}>
        Save as
      </button>
      <Popover anchor={pop.ref} open={pop.open} onClose={pop.close} width={260}>
        <form
          className="pop-pad lab-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (!name.trim()) return;
            pop.close();
            void saveSet(name.trim());
          }}
        >
          <label>
            <span>Name</span>
            <input className="input" autoFocus value={name} onChange={(e) => setNameIn(e.target.value)} />
          </label>
          <button className="btn sm primary" disabled={!name.trim()}>
            Save these texts
          </button>
        </form>
      </Popover>
    </>
  );
}

function Lists() {
  const sets = useLab((s) => s.sets);
  const setId = useLab((s) => s.setId);
  const concept = useLab((s) => s.concept);
  const control = useLab((s) => s.control);
  const testPrompt = useLab((s) => s.testPrompt);
  const dirty = useLab((s) => s.dirty);
  const flow = useLab((s) => s.flow);
  const findRes = useLab((s) => s.findRes);
  const cur = sets?.find((x) => x.id === setId);
  const nC = fromLines(concept).length;
  const nK = fromLines(control).length;
  const mine = sets?.filter((x) => !x.builtin) ?? [];
  const running = flow?.since != null;
  return (
    <>
      {findRes && (
        <details className="lab-more find-all">
          <summary>
            All {findRes.candidates.length} candidates, with their scores <span className="dim2">({fmtInt(findRes.scanned)} neurons compared in {fmtSecs(findRes.ms)})</span>
          </summary>
          <Results res={findRes} />
        </details>
      )}
      <details className="lab-more find-own" open={nC > 0 && dirty ? true : undefined}>
        <summary>
          Use your own texts{nC > 0 ? <span className="dim2"> ({nC} with it, {nK} without it, editable)</span> : null}
        </summary>
        <div className="find-config">
          <p className="dim2">
            Give lines that have the thing and matched lines that don't: same length and tone, only the thing is different. Every neuron is compared on the two lists. <Term k="probeSet">Why matched?</Term>
          </p>
          <div className="find-set">
            {mine.length > 0 && (
              <select className="input select" value={cur && !cur.builtin ? cur.id : ""} onChange={(e) => e.target.value && pickSet(e.target.value)} aria-label="Your saved texts">
                <option value="">Your saved texts</option>
                {mine.map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.name}
                  </option>
                ))}
              </select>
            )}
            {cur && !cur.builtin && (
              <button className="btn sm ghost" disabled={!dirty} onClick={() => void saveSet()}>
                Save
              </button>
            )}
            <SaveAs />
            {cur && !cur.builtin && (
              <button className="btn sm ghost" title="Cmd+Z brings it back" onClick={() => void deleteSet()}>
                <Trash2 /> Delete
              </button>
            )}
          </div>
          <div className="find-lists">
            <label className="find-list">
              <span className="find-list-head">
                <b>With it</b> <span className="dim num">{nC}</span>
              </span>
              <textarea className="textarea lab-text" rows={8} value={concept} placeholder="The barn owl hunted at dusk." onChange={(e) => editSet({ concept: e.target.value })} spellCheck={false} />
            </label>
            <label className="find-list">
              <span className="find-list-head">
                <b>Without it</b> <span className="dim num">{nK}</span>
              </span>
              <textarea className="textarea lab-text" rows={8} value={control} placeholder="The barn cat hunted at dusk." onChange={(e) => editSet({ control: e.target.value })} spellCheck={false} />
            </label>
          </div>
          <div className="find-go">
            <label className="lab-field">
              <Term k="testPrompt">Prompt to try them on</Term>
              <input className="input" value={testPrompt} placeholder="Who are you?" onChange={(e) => editSet({ testPrompt: e.target.value })} />
            </label>
            <button className="btn" disabled={running || !nC || !nK} onClick={() => void runFind()}>
              <Search /> Find from these texts
            </button>
          </div>
        </div>
      </details>
    </>
  );
}

const SORT: Record<FindSort, (c: LabCandidate) => number> = {
  both: (c) => c.both,
  score: (c) => c.score,
  writes: (c) => c.writes.delta,
};

function Results({ res }: { res: LabFindResult }) {
  const sort = useLab((s) => s.findSort);
  const kinds = useLab((s) => s.lab?.model?.layerKinds);
  const list = useMemo(() => [...res.candidates].sort((a, b) => SORT[sort](b) - SORT[sort](a)), [res, sort]);
  const maxMean = Math.max(1, ...res.candidates.map((c) => Math.max(c.conceptMean, c.controlMean)));
  return (
    <>
      <div className="find-sum">
        <span className="num dim2">
          {res.texts.concept} lines with it, {res.texts.control} without ({fmtInt(res.texts.tokens)} tokens)
        </span>
        {res.conceptTokens.length > 0 && (
          <span className="find-cw">
            <Term k="conceptTokens">Its words</Term>
            <TokChips tokens={res.conceptTokens} max={10} />
          </span>
        )}
      </div>
      <div className="find-sort">
        <span className="dim2">Sort by</span>
        <Segmented<FindSort>
          small
          value={sort}
          onChange={(v) => useLab.setState({ findSort: v })}
          options={[
            { value: "both", label: "Both", tip: LAB_TIP.both },
            { value: "score", label: "Fires on it", tip: LAB_TIP.score },
            { value: "writes", label: "Pushes it", tip: LAB_TIP.writes },
          ]}
          ariaLabel="Sort candidates"
        />
        <Hint tip={LAB_TIP.readWrite} width={340}>
          <span className="hint-text dim2">Why two scores?</span>
        </Hint>
      </div>
      <div className="cands" role="list">
        <div className="cand cand-head" aria-hidden>
          <span>#</span>
          <span>Neuron</span>
          <span className="r">
            <Term k="both">Both</Term>
          </span>
          <span className="r">
            <Term k="score">Fires</Term>
          </span>
          <span className="r">
            <Term k="writes">Pushes</Term>
          </span>
          <span className="cvk">
            <Term k="conceptVsControl">With vs without</Term>
          </span>
          <span className="r cand-beats">
            <Term k="beatsAll">Beats all</Term>
          </span>
        </div>
        {list.map((c, i) => (
          <Candidate key={nid(c)} c={c} i={i} maxMean={maxMean} kind={kinds?.[c.layer]} sort={sort} />
        ))}
      </div>
    </>
  );
}

function Candidate({ c, i, maxMean, kind, sort }: { c: LabCandidate; i: number; maxMean: number; kind?: string; sort: FindSort }) {
  const snip = c.snippets[0];
  const pct = (v: number) => `${Math.max(0, (v / maxMean) * 100)}%`;
  return (
    <div className="cand" role="listitem">
      <span className="num dim">{i + 1}</span>
      <span className="cand-id">
        <NeuronLink r={c} />
        <LayerKind kind={kind} />
      </span>
      <span className={`r num${sort === "both" ? " strong" : ""}`}>{c.both.toFixed(2)}</span>
      <span className={`r num${sort === "score" ? " strong" : ""}`}>{c.score.toFixed(1)}</span>
      <span className={`r num${sort === "writes" ? " strong" : ""}`} title={`+${c.writes.delta.toFixed(2)} nats on the concept words; next-token distribution moved ${c.writes.kl.toFixed(2)} (KL)`}>
        {c.writes.delta.toFixed(2)}
      </span>
      <span className="cvk" title={`with it ${c.conceptMean.toFixed(2)}× typical, without it ${c.controlMean.toFixed(2)}×`}>
        <span className="cvk-bars" aria-hidden>
          <span className="c" style={{ width: pct(c.conceptMean) }} />
          <span className="k" style={{ width: pct(c.controlMean) }} />
        </span>
        <span className="num dim2">
          {c.conceptMean.toFixed(1)} / {c.controlMean.toFixed(1)}
        </span>
      </span>
      <span className="r num cand-beats">{fmtPct0(c.beatsAll)}</span>
      <div className="cand-detail">
        <span className="cand-line">
          <Term k="writes">pushes</Term>
          <TokChips tokens={c.writes.tokens} max={5} />
          {c.suppresses.length > 0 && (
            <>
              <Term k="lens">away from</Term>
              <TokChips tokens={c.suppresses} neg max={3} />
            </>
          )}
        </span>
        {snip && (
          <span className="cand-line">
            <Term k="firesOn">fires on</Term>
            <ShadedText s={snip} typical={c.typical} />
          </span>
        )}
        <NeuronActions r={c} />
      </div>
    </div>
  );
}
