import { useMemo, useState } from "react";
import { Plus, Search, Trash2 } from "lucide-react";
import type { LabCandidate, LabFindResult } from "@terrarium/shared";
import { addToMix, deleteSet, editSet, fromLines, pickSet, runFind, saveSet, useLab, type FindSort } from "../../state/lab";
import { nid, sameRef } from "../../lib/recipe";
import { fmtInt } from "../../lib/format";
import { ConfirmButton, Hint, Popover, Segmented, usePop } from "../../components/ui";
import { LAB_TIP, Term } from "../../lib/labExplain";
import { Busy, ErrLine, fmtPct0, fmtSecs, LayerKind, NeuronLink, ShadedText, TokChips } from "./bits";

export function Find() {
  const findRes = useLab((s) => s.findRes);
  const findErr = useLab((s) => s.findErr);
  const findBusy = useLab((s) => s.findBusy);
  return (
    <div className="find">
      <SetEditor />
      <div className="find-results lab-scroll">
        {findErr && <ErrLine err={findErr} />}
        {findRes ? (
          <div className={findBusy != null ? "stale" : undefined}>
            <Results res={findRes} />
          </div>
        ) : findBusy != null ? (
          <div className="lab-empty">
            <Busy since={findBusy}>Comparing every neuron on the concept and control texts</Busy>
            <div className="dim2">Usually 10 to 15 s on a 4B model.</div>
          </div>
        ) : (
          !findErr && <div className="lab-empty">Pick a probe set or write your own, then Find. Neurons that fire on the concept and push it come first.</div>
        )}
      </div>
    </div>
  );
}

function SaveAs() {
  const pop = usePop();
  const setName = useLab((s) => s.setName);
  const [name, setNameIn] = useState("");
  return (
    <>
      <button ref={pop.ref} className="btn sm ghost" onClick={() => (setNameIn(`${setName} copy`), pop.toggle())}>
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
            Save probe set
          </button>
        </form>
      </Popover>
    </>
  );
}

function SetEditor() {
  const sets = useLab((s) => s.sets);
  const setId = useLab((s) => s.setId);
  const concept = useLab((s) => s.concept);
  const control = useLab((s) => s.control);
  const testPrompt = useLab((s) => s.testPrompt);
  const dirty = useLab((s) => s.dirty);
  const findBusy = useLab((s) => s.findBusy);
  const cur = sets?.find((x) => x.id === setId);
  const nC = fromLines(concept).length;
  const nK = fromLines(control).length;
  const starters = sets?.filter((x) => x.builtin) ?? [];
  const mine = sets?.filter((x) => !x.builtin) ?? [];
  return (
    <div className="find-config lab-scroll">
      <div className="find-set">
        <Term k="probeSet">Probe set</Term>
        <select className="input select" value={setId ?? ""} onChange={(e) => pickSet(e.target.value)} aria-label="Probe set">
          {!cur && <option value="">{dirty ? "Unsaved" : "None"}</option>}
          {starters.length > 0 && (
            <optgroup label="Starter sets">
              {starters.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.name}
                </option>
              ))}
            </optgroup>
          )}
          {mine.length > 0 && (
            <optgroup label="Yours">
              {mine.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.name}
                </option>
              ))}
            </optgroup>
          )}
        </select>
        {dirty && <span className="chip warn">edited</span>}
      </div>
      <div className="find-set-acts">
        {cur && !cur.builtin && (
          <button className="btn sm ghost" disabled={!dirty} onClick={() => void saveSet()}>
            Save
          </button>
        )}
        <SaveAs />
        {cur && !cur.builtin && <ConfirmButton small className="ghost" icon={<Trash2 />} label="Delete" confirmLabel={`Delete "${cur.name}"`} onConfirm={deleteSet} />}
        {cur?.builtin && <span className="dim2">starter set: Save as to keep your edits</span>}
      </div>
      <label className="find-list">
        <span className="find-list-head">
          <b>Concept</b> <span className="dim num">{nC} texts</span>
          <span className="dim2">have the thing, one per line</span>
        </span>
        <textarea className="textarea lab-text" rows={8} value={concept} onChange={(e) => editSet({ concept: e.target.value })} spellCheck={false} />
      </label>
      <label className="find-list">
        <span className="find-list-head">
          <b>Control</b> <span className="dim num">{nK} texts</span>
          <span className="dim2">same texts without it</span>
        </span>
        <textarea className="textarea lab-text" rows={8} value={control} onChange={(e) => editSet({ control: e.target.value })} spellCheck={false} />
      </label>
      <div className="lab-note dim2">Controls should match the concept texts in everything except the concept: length, tone, structure.</div>
      <label className="lab-field wide">
        <Term k="testPrompt">Test prompt</Term>
        <input className="input" value={testPrompt} placeholder="Who are you?" onChange={(e) => editSet({ testPrompt: e.target.value })} />
      </label>
      <button className="btn primary find-go" disabled={findBusy != null || !nC || !nK} onClick={() => void runFind()}>
        {findBusy != null ? <Busy since={findBusy}>Finding</Busy> : <><Search /> Find</>}
      </button>
    </div>
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
          Compared {fmtInt(res.scanned)} neurons on {res.texts.concept} concept and {res.texts.control} control texts ({fmtInt(res.texts.tokens)} tokens) in{" "}
          {fmtSecs(res.ms)}
        </span>
        {res.conceptTokens.length > 0 && (
          <span className="find-cw">
            <Term k="conceptTokens">Concept words</Term>
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
            <Term k="conceptVsControl">Concept vs control</Term>
          </span>
          <span className="r cand-beats">
            <Term k="beatsAll">Beats all</Term>
          </span>
          <span />
        </div>
        {list.map((c, i) => (
          <Candidate key={nid(c)} c={c} i={i} maxMean={maxMean} kind={kinds?.[c.layer]} sort={sort} />
        ))}
      </div>
    </>
  );
}

function Candidate({ c, i, maxMean, kind, sort }: { c: LabCandidate; i: number; maxMean: number; kind?: string; sort: FindSort }) {
  const mixed = useLab((s) => s.mix.some((p) => sameRef(p, c)));
  const breaks = c.preview && c.preview.repetition > 0.3;
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
      <span className="cvk" title={`concept ${c.conceptMean.toFixed(2)}× typical, control ${c.controlMean.toFixed(2)}×`}>
        <span className="cvk-bars" aria-hidden>
          <span className="c" style={{ width: pct(c.conceptMean) }} />
          <span className="k" style={{ width: pct(c.controlMean) }} />
        </span>
        <span className="num dim2">
          {c.conceptMean.toFixed(1)} / {c.controlMean.toFixed(1)}
        </span>
      </span>
      <span className="r num cand-beats">{fmtPct0(c.beatsAll)}</span>
      <span className="r">
        <button className="btn sm" disabled={mixed} onClick={() => addToMix(c)} title={mixed ? "Already in the mix" : "Add to the mix at dose +0.8"}>
          <Plus /> mix
        </button>
      </span>
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
        {c.preview && (
          <span className="cand-line preview">
            <Term k="preview">at +{c.preview.dose}</Term>
            <span className="selectable preview-text">{c.preview.text}</span>
            {breaks && (
              <Hint tip={LAB_TIP.repetition}>
                <span className="chip err">breaks: {fmtPct0(c.preview.repetition)} repeated</span>
              </Hint>
            )}
          </span>
        )}
      </div>
    </div>
  );
}

