import { useEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { Dices, FlaskRound, Lock, LockOpen, Play, Plus, Square, Sprout, Trash2, X } from "lucide-react";
import type { LabMixItem, LabPush, LabVector } from "@terrarium/shared";
import { clearResults, knownVectors, removePush, runCompare, runNextUp, runSeeds, runSweep, saveAsStrain, setPush, stopGrid, sweepDoses, sweepPush, useLab, zoomSweep, type LabStore, type SteerRun, type SteerView, tryDose } from "../../state/lab";
import { etaMs, scaled, suggestWords, summarize } from "../../lib/labGrid";
import { findPush, format, fmtDose, isNeuron, isVector, nid, outOfRange, parse, parseRef, pushKey, pushName } from "../../lib/recipe";
import { clockTime } from "../../lib/format";
import { CopyButton, Segmented, Switch } from "../../components/ui";
import { LAB_TIP, Term } from "../../lib/labExplain";
import { Busy, ErrLine, fmtSecs, NeuronLink, TokChips } from "./bits";
import { DoseRuler, SeedGrid } from "./Grid";
import { QualityChip, RecipeLine, ReplySlip } from "./Reply";

export function Steer() {
  const view = useLab((s) => s.steerView);
  const set = useLab.setState;
  return (
    <div className="steer">
      <div className="steer-left lab-scroll">
        <MixEditor />
        <RunSettings />
      </div>
      <div className="steer-right lab-scroll">
        <div className="steer-tabs">
          <Segmented<SteerView>
            value={view}
            onChange={(v) => set({ steerView: v })}
            options={[
              { value: "compare", label: "Compare", tip: LAB_TIP.compare },
              { value: "sweep", label: "Sweep", tip: LAB_TIP.sweep },
              { value: "seeds", label: "Test across seeds", tip: LAB_TIP.seeds },
            ]}
            ariaLabel="Results"
          />
        </div>
        {view === "compare" ? <CompareView /> : view === "sweep" ? <SweepView /> : <SeedsView />}
      </div>
    </div>
  );
}

// ---------- mix ----------

function DoseSlider({ p, onChange }: { p: LabPush; onChange: (v: number) => void }) {
  const clamp = p.mode === "clamp";
  const typical = useLab((s) => s.lab?.model?.tryDose ?? 0.8);
  const [bandLow, bandHigh] = [typical * 0.625, typical * 1.25];
  // centred on zero; a dose past the ends widens the track around it
  const reach = clamp ? 0 : Math.max(Math.ceil(typical * 2.5), Math.ceil(Math.abs(p.value)));
  const min = clamp ? Math.min(-20, Math.floor(p.value)) : -reach;
  const max = clamp ? Math.max(60, Math.ceil(p.value)) : reach;
  // the thumb (12px) travels inside the track, so marks sit on (100% - 12px)
  const frac = (v: number) => (v - min) / (max - min);
  const at = (v: number) => `calc(6px + (100% - 12px) * ${frac(v)})`;
  const span = (a: number, b: number) => `calc((100% - 12px) * ${frac(b) - frac(a)})`;
  return (
    <span className="dose-slider">
      {!clamp && (
        <>
          <span className="dose-band" style={{ left: at(bandLow), width: span(bandLow, bandHigh) }} title={`Where most working doses sit on this model: ${bandLow} to ${bandHigh}`} />
          <span className="dose-band neg" style={{ left: at(-bandHigh), width: span(-bandHigh, -bandLow) }} />
          <span className="dose-zero" style={{ left: at(0) }} />
        </>
      )}
      <input type="range" min={min} max={max} step={clamp ? 0.5 : 0.01} title={clamp ? "Raw activation value" : "Negative pushes it the other way. Small changes matter: this moves in steps of 0.01"} value={p.value} onChange={(e) => onChange(Number(e.target.value))} aria-label={`${nid(p)} ${p.mode}`} />
    </span>
  );
}

function NumIn({ value, onChange, step, className, label, min, max }: { value: number; onChange: (v: number) => void; step: number; className?: string; label: string; min?: number; max?: number }) {
  const [text, setText] = useState(String(value));
  const [focus, setFocus] = useState(false);
  useEffect(() => {
    if (!focus) setText(String(Math.round(value * 1000) / 1000));
  }, [value, focus]);
  return (
    <input
      className={`input num ${className ?? ""}`}
      type="number"
      step={step}
      min={min}
      max={max}
      value={text}
      aria-label={label}
      onFocus={() => setFocus(true)}
      onBlur={() => setFocus(false)}
      onChange={(e) => {
        setText(e.target.value);
        const v = Number(e.target.value);
        if (e.target.value.trim() !== "" && Number.isFinite(v)) onChange(v);
      }}
    />
  );
}

/** A character in the mix: its name, layer and strength. The numbers behind it stay out of sight. */
function VectorRow({ p, i }: { p: LabVector; i: number }) {
  const v = p.strength;
  const reach = Math.max(3, Math.ceil(Math.abs(v) * 2));
  return (
    <div className="mix-row mix-vector">
      <span className="mix-id" title={`One direction in layer ${p.layer}, added at every token. Strength 1 is about as far as a dose of 1.`}>
        <Sprout size={12} aria-hidden /> <b className="mix-name truncate">{p.name}</b>
      </span>
      <span className="dose-slider">
        <span className="dose-zero" style={{ left: `calc(6px + (100% - 12px) * 0.5)` }} />
        <input type="range" min={-reach} max={reach} step={0.01} title="Its strength. Negative pushes the opposite way, which is rarely the opposite character" value={v} onChange={(e) => setPush(i, { strength: Number(e.target.value) })} aria-label={`${p.name} strength`} />
      </span>
      <NumIn value={v} step={0.05} className="mix-val" label={`${p.name} strength`} onChange={(strength) => setPush(i, { strength })} />
      <button className="icon-btn sm" aria-label={`Remove ${p.name}`} title="Remove (Cmd+Z brings it back)" onClick={() => removePush(i)}>
        <X />
      </button>
      <span className="mix-words">
        <span className="dim2">layer {p.layer}, strength</span>
      </span>
    </div>
  );
}

function MixRow({ p, i }: { p: LabPush; i: number }) {
  const kind = useLab((s) => s.lab?.model?.layerKinds?.[p.layer]);
  const words = useLab((s) => s.words[nid(p)]);
  const typical = useLab((s) => s.lab?.model?.tryDose ?? 0.8);
  const v = p.value;
  const tone = p.mode === "clamp" ? "" : Math.abs(v) >= typical * 3.2 ? " err" : Math.abs(v) > typical * 1.5 ? " warn" : "";
  return (
    <div className="mix-row">
      <span className="mix-id" title={kind ? `layer ${p.layer}, ${kind} attention` : `layer ${p.layer}`}>
        <NeuronLink r={p} />
      </span>
      <DoseSlider p={p} onChange={(value) => setPush(i, { value })} />
      <NumIn value={v} step={p.mode === "dose" ? 0.01 : 0.5} className={`mix-val${tone}`} label={`${nid(p)} value`} onChange={(value) => setPush(i, { value })} />
      <button className="icon-btn sm" aria-label={`Remove ${nid(p)}`} title="Remove (Cmd+Z brings it back)" onClick={() => removePush(i)}>
        <X />
      </button>
      <span className="mix-words">
        {words && <TokChips tokens={words} max={4} />}
        <button className="cell-link mix-mode" title={p.mode === "dose" ? "Adds to the neuron. Click to set it to a fixed value instead" : "Sets the neuron to a fixed value. Click to add a dose instead"} onClick={() => setPush(i, p.mode === "dose" ? { mode: "clamp", value: 10 } : { mode: "dose", value: tryDose() })}>
          {p.mode === "dose" ? "dose" : "clamp"}
        </button>
      </span>
    </div>
  );
}

function MixEditor() {
  const mix = useLab((s) => s.mix);
  const scale = useLab((s) => s.scale);
  const facts = useLab((s) => s.lab?.model);
  const [add, setAdd] = useState("");
  const [draft, setDraft] = useState<string | null>(null);
  const addRef = parseRef(add);
  const recipe = format(mix);
  const parsed = draft != null ? parse(draft, knownVectors()) : null;
  const range = facts ? outOfRange(mix, facts.layers, facts.neuronsPerLayer, facts.dModel) : [];
  const set = useLab.setState;

  return (
    <section className="lab-sec mix">
      <div className="lab-sec-head">
        <h3>
          <Term k="mix">Mix</Term>
        </h3>
        {mix.length > 0 && <span className="dim num">{mix.length}</span>}
        {scale !== 1 && <span className="chip warn num">×{scale}</span>}
        <span className="blk-spacer" />
        <button className="btn sm ghost" disabled={!mix.length || !facts} onClick={() => saveAsStrain(scaled(mix, scale))} title="Keep this mix as a model you can chat with">
          <FlaskRound /> Save as strain
        </button>
      </div>
      {!mix.length && <div className="lab-note dim2">Empty. Pick a specimen from the Field Guide, grow one in the Grow tab, or type a neuron's id below.</div>}
      {mix.map((p, i) => (isVector(p) ? <VectorRow key={pushKey(p)} p={p} i={i} /> : <MixRow key={pushKey(p)} p={p} i={i} />))}
      {range.length > 0 && <ErrLine err={{ error: "Not in this model", detail: range.join("; ") }} />}
      <form
        className="mix-add"
        onSubmit={(e) => {
          e.preventDefault();
          if (!addRef) return;
          if (!findPush(mix, addRef)) set({ mix: [...mix, { ...addRef, mode: "dose", value: tryDose() }] });
          setAdd("");
        }}
      >
        <input className={`input mono${add && !addRef ? " bad" : ""}`} placeholder="Add by id: L22N2742" value={add} onChange={(e) => setAdd(e.target.value)} aria-label="Neuron to add" />
        <button className="btn sm" disabled={!addRef}>
          <Plus /> Add
        </button>
      </form>
      <details className="lab-more">
        <summary>Recipe as text</summary>
        <div className="recipe">
          <div className="recipe-head">
            <Term k="recipe">Recipe</Term>
            <span className="blk-spacer" />
            {draft == null ? (
              <CopyButton text={recipe} label="Copy" />
            ) : (
              <>
                <button className="btn sm ghost" onClick={() => setDraft(null)}>
                  Revert
                </button>
                <button
                  className="btn sm primary"
                  disabled={!parsed?.pushes.length}
                  onClick={() => {
                    set({ mix: parsed!.pushes });
                    setDraft(null);
                  }}
                >
                  Apply {parsed?.pushes.length ?? 0}
                </button>
              </>
            )}
          </div>
          <textarea className="textarea mono recipe-text" rows={2} spellCheck={false} value={draft ?? recipe} placeholder="Paste a recipe: L22N2742+0.8 L8N344=25" onChange={(e) => setDraft(e.target.value)} aria-label="Recipe" />
          {parsed && parsed.errors.length > 0 && (
            <ul className="recipe-errs">
              {parsed.errors.map((e, i) => (
                <li key={i} className="warn-text">
                  {e}
                </li>
              ))}
            </ul>
          )}
        </div>
      </details>
    </section>
  );
}

// ---------- run settings ----------

const REPEATS = [
  { value: 1, label: "Off" },
  { value: 1.1, label: "1.1" },
  { value: 1.2, label: "1.2" },
  { value: 1.3, label: "1.3" },
];

/** What Cmd+Enter in the prompt does: the view you're looking at. */
const runView = (v: SteerView) => (v === "compare" ? runCompare() : v === "sweep" ? runSweep() : runSeeds());

function RunSettings() {
  const s = useLab(useShallow((x) => ({ prompt: x.prompt, seed: x.seed, lockSeed: x.lockSeed, temperature: x.temperature, maxTokens: x.maxTokens, thinking: x.thinking, repeat: x.repeat, scale: x.scale, view: x.steerView })));
  const mix = useLab((x) => x.mix);
  const set = useLab.setState;
  return (
    <section className="lab-sec run">
      <label className="lab-field wide">
        <span>Prompt</span>
        <textarea
          className="textarea"
          rows={2}
          value={s.prompt}
          onChange={(e) => set({ prompt: e.target.value })}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              void runView(s.view);
            }
          }}
          aria-label="Prompt"
        />
      </label>
      <details className="lab-more">
        <summary>
          Settings <span className="dim2 num">seed {s.lockSeed ? s.seed : "new each run"}, temp {s.temperature}{s.repeat > 1 ? `, repeat ${s.repeat}` : ""}</span>
        </summary>
        <div className="run-grid">
          <Term k="seed">Seed</Term>
          <span className="form-row">
            <NumIn value={s.seed} step={1} min={0} className="run-num wide" label="Seed" onChange={(v) => set({ seed: Math.max(0, Math.floor(v)) })} />
            <button className="icon-btn sm" title="New random seed" aria-label="New random seed" onClick={() => set({ seed: Math.floor(Math.random() * 1_000_000) })}>
              <Dices />
            </button>
            <button className={`icon-btn sm${s.lockSeed ? " on" : ""}`} aria-pressed={s.lockSeed} title={s.lockSeed ? "Seed locked: every run uses it" : "Each run draws a new seed"} aria-label="Lock the seed" onClick={() => set({ lockSeed: !s.lockSeed })}>
              {s.lockSeed ? <Lock /> : <LockOpen />}
            </button>
          </span>
          <Term k="temperature">Temperature</Term>
          <NumIn value={s.temperature} step={0.1} min={0} max={2} className="run-num" label="Temperature" onChange={(v) => set({ temperature: Math.max(0, v) })} />
          <span>Reply length</span>
          <NumIn value={s.maxTokens} step={16} min={8} max={2048} className="run-num" label="Reply length in tokens" onChange={(v) => set({ maxTokens: Math.max(8, Math.floor(v)) })} />
          <Term k="repeat">Repeat control</Term>
          <Segmented<number> small value={s.repeat} onChange={(v) => set({ repeat: v })} options={REPEATS} ariaLabel="Repeat control" />
          <Term k="scale">Scale every dose</Term>
          <span className="form-row">
            <NumIn value={s.scale} step={0.05} min={0} className="run-num" label="Scale every dose" onChange={(v) => set({ scale: v })} />
            {s.scale !== 1 && mix.some((p) => isVector(p) || p.mode === "dose") && (
              <button className="cell-link" onClick={() => set({ mix: scaled(mix, s.scale), scale: 1 })}>
                Bake it in
              </button>
            )}
          </span>
          <Term k="thinking">Thinking</Term>
          <Switch on={s.thinking} onChange={(v) => set({ thinking: v })} label={s.thinking ? "on" : "off"} />
        </div>
      </details>
    </section>
  );
}

function useRunBlocked(): string | null {
  const mix = useLab((x) => x.mix);
  const prompt = useLab((x) => x.prompt);
  const facts = useLab((x) => x.lab?.model);
  if (!mix.length) return "Add something to the mix first";
  if (!prompt.trim()) return "Write a prompt first";
  if (facts && outOfRange(mix, facts.layers, facts.neuronsPerLayer, facts.dModel).length) return "The mix has entries this model doesn't";
  return null;
}

// ---------- compare ----------

/** Scrolls a new result into view only when it starts below the window (the stacked, narrow layout). */
function reveal(el: HTMLElement | null) {
  if (el && el.getBoundingClientRect().top > window.innerHeight - 120) el.scrollIntoView({ block: "start", behavior: "smooth" });
}

function pushWords(words: Record<string, string[]>, pushes: LabMixItem[]): string[] {
  return pushes.filter(isNeuron).flatMap((p) => words[nid(p)] ?? []);
}

/** After the example's one neuron: what a whole character looks like. */
function NextUp() {
  const next = useLab((s) => s.nextUp);
  const guide = useLab((s) => s.guide);
  const busy = useLab((s) => s.compareBusy ?? s.guideTrying);
  const spec = guide?.specimens.find((x) => x.id === next?.id);
  if (!next || !spec || busy != null) return null;
  return (
    <div className="next-up">
      <span>
        That was one neuron out of about 300,000: {next.from} can't stop bringing it up, and otherwise answers as usual. A character takes a whole direction: <i>{spec.line}</i>
      </span>
      <button className="btn sm primary" onClick={() => void runNextUp()}>
        <Play /> Try {spec.name}
      </button>
      <button className="cell-link" onClick={() => useLab.setState({ nextUp: null })}>
        Not now
      </button>
    </div>
  );
}

function CompareView() {
  const runs = useLab((s) => s.runs);
  const pick = useLab((s) => s.runPick);
  const busy = useLab((s) => s.compareBusy);
  const err = useLab((s) => s.compareErr);
  const words = useLab((s) => s.words);
  const blocked = useRunBlocked();
  const box = useRef<HTMLDivElement>(null);
  const latest = runs[0]?.id;
  useEffect(() => {
    // stacked (narrow) layout: bring a fresh result into view
    if (latest != null) reveal(box.current);
  }, [latest]);
  const run = runs.find((r) => r.id === pick) ?? runs[0];
  return (
    <>
      <div className="view-bar">
        <button className="btn primary" disabled={busy != null || !!blocked} title={blocked ?? "Cmd+Enter in the prompt"} onClick={() => void runCompare()}>
          {busy != null ? <Busy since={busy}>Writing both replies</Busy> : <><Play /> Compare</>}
        </button>
        <span className="dim2">Writes the reply with and without the mix, from the same seed.</span>
        <span className="blk-spacer" />
        {runs.length > 0 && (
          <button className="btn sm ghost" onClick={clearResults} title="Cmd+Z brings them back">
            <Trash2 /> Clear
          </button>
        )}
      </div>
      {err && <ErrLine err={err} />}
      <NextUp />
      {!run && busy == null && !err && <div className="lab-empty">{blocked ? `${blocked}. Then compare the two replies here.` : "Press Compare to see what the mix changes. Click any word in a reply to ask why it's there."}</div>}
      {run && (
        <div ref={box} className={busy != null ? "stale" : undefined}>
          <div className="cmp-prompt selectable">{run.recipe.prompt}</div>
          <div className="cmp-pair">
            {run.baseline && <ReplySlip title="Unsteered" reply={run.baseline} recipe={{ ...run.recipe, pushes: [] }} words={pushWords(words, run.recipe.pushes)} />}
            <ReplySlip title={run.scale ? `Steered, mix ×${run.scale}` : "Steered"} reply={run.steered} recipe={run.recipe} baseline={run.baseline} words={pushWords(words, run.recipe.pushes)} />
          </div>
        </div>
      )}
      {runs.length > 1 && (
        <section className="lab-sec earlier">
          <div className="lab-sec-head">
            <h3>Earlier in this sitting</h3>
            <span className="dim2">Older ones are in History.</span>
          </div>
          <div className="runs">
            {runs.map((r) => (
              <RunRow key={r.id} r={r} on={r === run} />
            ))}
          </div>
        </section>
      )}
    </>
  );
}

function RunRow({ r, on }: { r: SteerRun; on: boolean }) {
  return (
    <button className={`run-row${on ? " on" : ""}`} onClick={() => useLab.setState({ runPick: r.id })}>
      <span className="num dim">{clockTime(r.at)}</span>
      <span className="mono truncate">{format(r.recipe.pushes)}</span>
      <span className="truncate dim2">{r.steered.text}</span>
      <QualityChip r={r.steered} />
    </button>
  );
}

// ---------- sweep ----------

const RANGES = [0.5, 1, 2, 4, 8];
const COUNTS = [12, 24, 48, 96, 192, 384];
const SEED_COUNTS = [1, 2, 4, 8];
const LENGTHS = [32, 64, 128, 256];

function Choice<T extends number | string>({ label, value, options, onChange, fmt, tip }: { label: React.ReactNode; value: T; options: T[]; onChange: (v: T) => void; fmt?: (v: T) => string; tip?: string }) {
  return (
    <div className="dchoice" title={tip}>
      <span className="dchoice-l">{label}</span>
      <Segmented<T> small value={value} onChange={onChange} options={options.map((o) => ({ value: o, label: fmt ? fmt(o) : String(o) }))} ariaLabel={typeof label === "string" ? label : "Choice"} />
    </div>
  );
}

function Progress({ done, total, since, ms, onStop, what }: { done: number; total: number; since: number; ms: number[]; onStop: () => void; what: string }) {
  const eta = etaMs(ms, total - done);
  return (
    <div className="grid-progress">
      <Busy since={since}>
        {what} {done} of {total}
      </Busy>
      {eta != null && total > done && <span className="dim2 num">about {fmtSecs(eta)} left</span>}
      <span className="gprog-track" aria-hidden>
        <span style={{ width: `${(done / Math.max(1, total)) * 100}%` }} />
      </span>
      <button className="btn sm" onClick={onStop}>
        <Square /> Stop
      </button>
    </div>
  );
}

const sweepInputs = (x: LabStore) => ({ sweepTarget: x.sweepTarget, sweepRange: x.sweepRange, sweepLow: x.sweepLow, sweepHigh: x.sweepHigh, sweepCount: x.sweepCount, sweepSeeds: x.sweepSeeds, sweepTokens: x.sweepTokens });

function SweepView() {
  const mix = useLab((s) => s.mix);
  const c = useLab(useShallow(sweepInputs));
  const sweep = useLab((s) => s.sweep);
  const busy = useLab((s) => s.gridBusy);
  const words = useLab((s) => s.words);
  const blocked = useRunBlocked();
  const set = useLab.setState;
  const doses = useMemo(() => sweepDoses(c), [c]);
  const tgt = sweepPush(mix, c.sweepTarget);
  const running = sweep?.state === "running" && busy != null;
  const total = doses.length * c.sweepSeeds;
  const step = doses.length > 1 ? Math.min(...doses.slice(1).map((d, i) => d - doses[i])) : 0;
  const showWords = sweep ? (sweep.target && !("vectorId" in sweep.target) ? (words[nid(sweep.target)] ?? []) : pushWords(words, sweep.mix)) : [];
  return (
    <>
      <div className="sweep-cfg">
        <div className="sweep-line">
          {mix.length > 1 && (
            <label className="dchoice">
              <span className="dchoice-l">Push</span>
              <select className="input select" value={tgt ? c.sweepTarget : "mix"} onChange={(e) => set({ sweepTarget: e.target.value })} aria-label="What to sweep">
                <option value="mix">whole mix, as a multiple</option>
                {mix
                  .filter((p) => isVector(p) || p.mode === "dose")
                  .map((p) => (
                    <option key={pushKey(p)} value={pushKey(p)}>
                      {pushName(p)} alone
                    </option>
                  ))}
              </select>
            </label>
          )}
          <Choice<number | "custom"> label="Range" value={c.sweepRange} options={[...RANGES, "custom"]} fmt={(v) => (v === "custom" ? "Custom" : `±${v}`)} onChange={(v) => (v === "custom" ? set({ sweepRange: v, sweepLow: doses[0], sweepHigh: doses[doses.length - 1] }) : set({ sweepRange: v }))} />
          {c.sweepRange === "custom" && (
            <span className="form-row sweep-custom">
              <NumIn value={c.sweepLow} step={0.01} className="run-num" label="Lowest dose" onChange={(v) => set({ sweepLow: v })} />
              <span className="dim2">to</span>
              <NumIn value={c.sweepHigh} step={0.01} className="run-num" label="Highest dose" onChange={(v) => set({ sweepHigh: v })} />
            </span>
          )}
          <Choice<number> label="Steps" value={c.sweepCount} options={COUNTS} onChange={(v) => set({ sweepCount: v })} />
          <Choice<number> label="Seeds" value={c.sweepSeeds} options={SEED_COUNTS} onChange={(v) => set({ sweepSeeds: v })} tip="More than one lays seeds down the side: doses by seeds." />
          <Choice<number> label="Reply length" value={c.sweepTokens} options={LENGTHS} onChange={(v) => set({ sweepTokens: v })} />
        </div>
        <div className="view-bar">
          {running ? (
            <Progress done={sweep.cells.length} total={sweep.doses.length * sweep.seeds.length * sweep.prompts.length} since={busy} ms={sweep.cells.map((x) => x.reply.ms)} onStop={stopGrid} what="Wrote" />
          ) : (
            <>
              <button className="btn primary" disabled={!!blocked || !doses.length} title={blocked ?? undefined} onClick={() => void runSweep()}>
                <Play /> Sweep {total}
              </button>
              <span className="dim2 num">
                {doses.length} dose{doses.length === 1 ? "" : "s"} from {fmtDose(doses[0])} to {fmtDose(doses[doses.length - 1])}
                {step ? `, ${fmtDose(step)} apart` : ""}
                {tgt ? ` on ${pushName(tgt)}` : mix.length > 1 ? ", as multiples of the mix" : ""}. Zero is the unsteered model.
              </span>
            </>
          )}
        </div>
      </div>
      {sweep?.err && <ErrLine err={sweep.err} />}
      {sweep?.state === "stopped" && <div className="lab-note dim2">Stopped at {sweep.cells.length} of {sweep.doses.length * sweep.seeds.length}. The doses nearest zero ran first.</div>}
      {!sweep && <div className="lab-empty">{blocked ? `${blocked}. Then sweep it here from negative to positive.` : "One reply per dose, from pushing it down to pushing it up. Small changes can matter a lot: pick more steps, then drag across a good stretch to zoom in."}</div>}
      {sweep && <DoseRuler run={sweep} words={showWords} onZoom={zoomSweep} />}
    </>
  );
}

// ---------- test across seeds ----------

const SEED_N = [4, 8, 16, 32];

function SeedsView() {
  const mix = useLab((s) => s.mix);
  const prompt = useLab((s) => s.prompt);
  const n = useLab((s) => s.seedsN);
  const more = useLab((s) => s.seedsPrompts);
  const wordsIn = useLab((s) => s.seedsWords);
  const tokens = useLab((s) => s.seedsTokens);
  const run = useLab((s) => s.seeds);
  const busy = useLab((s) => s.gridBusy);
  const allWords = useLab((s) => s.words);
  const blocked = useRunBlocked();
  const set = useLab.setState;
  const running = run?.state === "running" && busy != null;
  const extra = more.split("\n").map((x) => x.trim()).filter(Boolean);
  const prompts = new Set([prompt.trim(), ...extra]).size;
  const suggest = useMemo(() => suggestWords(pushWords(allWords, mix)), [allWords, mix]);
  const typed = wordsIn.split(/[,;\n]+/).map((x) => x.trim().toLowerCase()).filter(Boolean);
  const summary = useMemo(() => summarize(run?.cells.map((c) => c.reply) ?? [], run?.words ?? []), [run]);
  return (
    <>
      <div className="sweep-cfg">
        <div className="sweep-line">
          <Choice<number> label="Seeds" value={n} options={SEED_N} onChange={(v) => set({ seedsN: v })} />
          <Choice<number> label="Reply length" value={tokens} options={LENGTHS} onChange={(v) => set({ seedsTokens: v })} />
        </div>
        <div className="seeds-fields">
          <label className="lab-field wide">
            <span>More prompts, one per line <span className="dim2">(after the one on the left)</span></span>
            <textarea className="textarea" rows={2} value={more} onChange={(e) => set({ seedsPrompts: e.target.value })} />
          </label>
          <label className="lab-field wide">
            <span>Words to count <span className="dim2">(optional)</span></span>
            <input className="input" value={wordsIn} placeholder="surprise, surprised, surprising" onChange={(e) => set({ seedsWords: e.target.value })} />
            {suggest.some((w) => !typed.includes(w.toLowerCase())) && (
              <span className="word-sugg">
                <span className="dim2">From the mix:</span>
                {suggest
                  .filter((w) => !typed.includes(w.toLowerCase()))
                  .map((w) => (
                    <button key={w} type="button" className="tokchip" onClick={() => set({ seedsWords: wordsIn.trim() ? `${wordsIn.trim().replace(/,$/, "")}, ${w}` : w })}>
                      {w}
                    </button>
                  ))}
              </span>
            )}
          </label>
        </div>
        <div className="view-bar">
          {running ? (
            <Progress done={run.cells.length} total={run.seeds.length * run.prompts.length} since={busy} ms={run.cells.map((x) => x.reply.ms)} onStop={stopGrid} what="Wrote" />
          ) : (
            <>
              <button className="btn primary" disabled={!!blocked} title={blocked ?? undefined} onClick={() => void runSeeds()}>
                <Play /> Test {n * prompts} replies
              </button>
              <span className="dim2 num">
                {n} seeds on {prompts} prompt{prompts === 1 ? "" : "s"}, with the mix as it is now.
              </span>
            </>
          )}
        </div>
      </div>
      {run?.err && <ErrLine err={run.err} />}
      {run?.state === "stopped" && <div className="lab-note dim2">Stopped at {run.cells.length} of {run.seeds.length * run.prompts.length}.</div>}
      {!run && <div className="lab-empty">{blocked ? `${blocked}. Then test it here.` : "A recipe that works on one seed can garble on the next. This runs it many times and counts how often it holds up."}</div>}
      {run && (
        <>
          <RecipeLine r={{ modelId: run.modelId, prompt: run.prompts[0] ?? "", pushes: run.mix, seed: run.seeds[0] ?? 0, temperature: run.temperature, maxTokens: run.maxTokens, thinking: run.thinking, repeat: run.repeat }} />
          <SeedGrid run={run} summary={summary} />
        </>
      )}
    </>
  );
}
