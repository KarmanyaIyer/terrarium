import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { Dices, FlaskRound, Lock, LockOpen, Play, Plus, Save, X } from "lucide-react";
import type { LabPush, LabReply } from "@terrarium/shared";
import { parseDoses, removePush, runCompare, runSweep, saveStrain, setPush, useLab, DEFAULT_DOSES, type SteerRun } from "../../state/lab";
import { format, nid, outOfRange, parse, parseRef, sameRef } from "../../lib/recipe";
import { clockTime, fmtInt, fmtMs } from "../../lib/format";
import { ChartTip, CopyButton, Hint, Popover, Segmented, Switch, usePop, type TipState } from "../../components/ui";
import { LAB_TIP, Term } from "../../lib/labExplain";
import { Busy, ErrLine, FluencyMeter, NeuronLink, RepetitionMeter, ReplyText, TokChips, fmtPct0 } from "./bits";

export function Steer() {
  const [view, setView] = useState<"compare" | "sweep">("compare");
  const sweepBusy = useLab((s) => s.sweepBusy);
  const compareBusy = useLab((s) => s.compareBusy);
  // a run started elsewhere (the example) shows its result
  useEffect(() => {
    if (compareBusy != null) setView("compare");
  }, [compareBusy]);
  useEffect(() => {
    if (sweepBusy != null) setView("sweep");
  }, [sweepBusy]);
  return (
    <div className="steer">
      <div className="steer-left lab-scroll">
        <MixEditor />
        <RunSettings />
      </div>
      <div className="steer-right lab-scroll">
        <div className="steer-tabs">
          <Segmented
            value={view}
            onChange={setView}
            options={[
              { value: "compare", label: "Compare", tip: LAB_TIP.compare },
              { value: "sweep", label: "Sweep", tip: LAB_TIP.sweep },
            ]}
            ariaLabel="Results"
          />
        </div>
        {view === "compare" ? <CompareView /> : <SweepView />}
      </div>
    </div>
  );
}

// ---------- mix ----------

const DOSE_MIN = -2;
const DOSE_MAX = 3;

function DoseSlider({ p, onChange }: { p: LabPush; onChange: (v: number) => void }) {
  const clamp = p.mode === "clamp";
  const min = clamp ? Math.min(-20, Math.floor(p.value)) : DOSE_MIN;
  const max = clamp ? Math.max(60, Math.ceil(p.value)) : DOSE_MAX;
  // the thumb (12px) travels inside the track, so marks sit on (100% - 12px)
  const frac = (v: number) => (v - min) / (max - min);
  const at = (v: number) => `calc(6px + (100% - 12px) * ${frac(v)})`;
  const span = (a: number, b: number) => `calc((100% - 12px) * ${frac(b) - frac(a)})`;
  return (
    <span className="dose-slider">
      {!clamp && (
        <>
          <span className="dose-band" style={{ left: at(0.5), width: span(0.5, 1) }} title="Normal range: 0.5 to 1.0" />
          <span className="dose-band" style={{ left: at(-1), width: span(-1, -0.5) }} />
          <span className="dose-zero" style={{ left: at(0) }} />
        </>
      )}
      <input
        type="range"
        min={min}
        max={max}
        step={clamp ? 0.5 : 0.05}
        title={clamp ? "Raw activation value" : "Normal doses sit in the green band, 0.5 to 1.0"}
        value={p.value}
        onChange={(e) => onChange(Number(e.target.value))}
        aria-label={`${nid(p)} ${p.mode}`}
      />
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

function MixRow({ p, i }: { p: LabPush; i: number }) {
  const kind = useLab((s) => s.lab?.model?.layerKinds?.[p.layer]);
  const words = useLab((s) => s.words[nid(p)]);
  const v = p.value;
  const tone = p.mode === "clamp" ? "" : Math.abs(v) >= 2.5 ? " err" : Math.abs(v) > 1.2 ? " warn" : "";
  return (
    <div className="mix-row">
      <span className="mix-id" title={kind ? `layer ${p.layer}, ${kind} attention` : `layer ${p.layer}`}>
        <NeuronLink r={p} />
      </span>
      <Segmented<LabPush["mode"]>
        small
        value={p.mode}
        onChange={(mode) => setPush(i, { mode, value: mode === "dose" ? 0.8 : 10 })}
        options={[
          { value: "dose", label: "dose", tip: LAB_TIP.dose },
          { value: "clamp", label: "clamp", tip: LAB_TIP.clamp },
        ]}
        ariaLabel={`${nid(p)} mode`}
      />
      <DoseSlider p={p} onChange={(value) => setPush(i, { value })} />
      <NumIn value={v} step={p.mode === "dose" ? 0.05 : 0.5} className={`mix-val${tone}`} label={`${nid(p)} value`} onChange={(value) => setPush(i, { value })} />
      <button className="icon-btn sm" aria-label={`Remove ${nid(p)}`} title="Remove" onClick={() => removePush(i)}>
        <X />
      </button>
      {words && (
        <span className="mix-words">
          <TokChips tokens={words} max={5} />
        </span>
      )}
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
  const parsed = draft != null ? parse(draft) : null;
  const range = facts ? outOfRange(mix, facts.layers, facts.neuronsPerLayer) : [];
  const set = useLab.setState;

  return (
    <section className="lab-sec mix">
      <div className="lab-sec-head">
        <h3>
          <Term k="mix">Mix</Term>
        </h3>
        <span className="dim num">{mix.length}</span>
        <span className="blk-spacer" />
        <Term k="scale">scale ×</Term>
        <NumIn value={scale} step={0.1} min={0} className="mix-scale" label="Scale every dose" onChange={(v) => set({ scale: v })} />
        <input className="mix-scale-range" type="range" min={0} max={3} step={0.05} value={scale} onChange={(e) => set({ scale: Number(e.target.value) })} aria-label="Scale every dose" />
      </div>
      {!mix.length && <div className="lab-note dim2">Empty. Add neurons from Find, Probe or a neuron card, type an id below, or paste a recipe.</div>}
      {mix.map((p, i) => (
        <MixRow key={nid(p)} p={p} i={i} />
      ))}
      {range.length > 0 && <ErrLine err={{ error: "Not in this model", detail: range.join("; ") }} />}
      <form
        className="mix-add"
        onSubmit={(e) => {
          e.preventDefault();
          if (!addRef) return;
          if (!mix.some((p) => sameRef(p, addRef))) set({ mix: [...mix, { ...addRef, mode: "dose", value: 0.8 }] });
          setAdd("");
        }}
      >
        <input className={`input mono${add && !addRef ? " bad" : ""}`} placeholder="L22N2742" value={add} onChange={(e) => setAdd(e.target.value)} aria-label="Neuron to add" />
        <button className="btn sm" disabled={!addRef}>
          <Plus /> Add
        </button>
      </form>
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
        <textarea
          className="textarea mono recipe-text"
          rows={2}
          spellCheck={false}
          value={draft ?? recipe}
          placeholder="Paste a recipe: L22N2742+0.8 L8N344=25"
          onChange={(e) => setDraft(e.target.value)}
          aria-label="Recipe"
        />
        {parsed && parsed.errors.length > 0 && (
          <ul className="recipe-errs">
            {parsed.errors.map((e, i) => (
              <li key={i} className="warn-text">
                {e}
              </li>
            ))}
          </ul>
        )}
        {scale !== 1 && draft == null && mix.some((p) => p.mode === "dose") && (
          <div className="lab-note dim2">
            Scale ×{scale} applies on top of these doses.{" "}
            <button className="cell-link" onClick={() => set({ mix: mix.map((p) => (p.mode === "dose" ? { ...p, value: Math.round(p.value * scale * 1000) / 1000 } : p)), scale: 1 })}>
              Bake it in
            </button>
          </div>
        )}
      </div>
    </section>
  );
}

// ---------- run settings ----------

function SaveStrain() {
  const pop = usePop();
  const mix = useLab((s) => s.mix);
  const scale = useLab((s) => s.scale);
  const base = useLab((s) => s.lab?.model);
  const [name, setName] = useState("");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const baked = mix.map((p) => (p.mode === "dose" ? { ...p, value: Math.round(p.value * scale * 1000) / 1000 } : p));
  return (
    <>
      <button ref={pop.ref} className="btn" disabled={!mix.length || !base} onClick={pop.toggle}>
        <Save /> Save as strain
      </button>
      <Popover anchor={pop.ref} open={pop.open} onClose={pop.close} width={320}>
        <form
          className="pop-pad lab-form"
          onSubmit={async (e) => {
            e.preventDefault();
            if (!name.trim()) return;
            setBusy(true);
            const st = await saveStrain(name.trim(), notes.trim());
            setBusy(false);
            if (st) {
              pop.close();
              setName("");
              setNotes("");
            }
          }}
        >
          <div className="dim2">
            <Term k="strain">Strain</Term> of {base?.name}
          </div>
          <code className="recipe-peek">{format(baked)}</code>
          <label>
            <span>Name</span>
            <input className="input" autoFocus value={name} placeholder="Extrali" onChange={(e) => setName(e.target.value)} />
          </label>
          <label>
            <span>Notes</span>
            <textarea className="textarea" rows={3} value={notes} placeholder="What it does, where it breaks" onChange={(e) => setNotes(e.target.value)} />
          </label>
          <button className="btn sm primary" disabled={!name.trim() || busy}>
            <FlaskRound /> Save strain
          </button>
          <div className="dim2 lab-note">Shows up in the model pickers. Chats and evals with it run on the Lab.</div>
        </form>
      </Popover>
    </>
  );
}

function RunSettings() {
  const s = useLab(useShallow((x) => ({ prompt: x.prompt, seed: x.seed, lockSeed: x.lockSeed, temperature: x.temperature, maxTokens: x.maxTokens, thinking: x.thinking })));
  const mix = useLab((x) => x.mix);
  const busy = useLab((x) => x.compareBusy);
  const facts = useLab((x) => x.lab?.model);
  const bad = facts ? outOfRange(mix, facts.layers, facts.neuronsPerLayer).length > 0 : false;
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
              void runCompare();
            }
          }}
          aria-label="Prompt"
        />
      </label>
      <div className="run-grid">
        <Term k="seed">Seed</Term>
        <span className="form-row">
          <NumIn value={s.seed} step={1} min={0} className="run-num wide" label="Seed" onChange={(v) => set({ seed: Math.max(0, Math.floor(v)) })} />
          <button className="icon-btn sm" title="New random seed" aria-label="New random seed" onClick={() => set({ seed: Math.floor(Math.random() * 1_000_000) })}>
            <Dices />
          </button>
          <button
            className={`icon-btn sm${s.lockSeed ? " on" : ""}`}
            aria-pressed={s.lockSeed}
            title={s.lockSeed ? "Seed locked: every run uses it" : "Each run draws a new seed"}
            aria-label="Lock the seed"
            onClick={() => set({ lockSeed: !s.lockSeed })}
          >
            {s.lockSeed ? <Lock /> : <LockOpen />}
          </button>
        </span>
        <Term k="temperature">Temperature</Term>
        <NumIn value={s.temperature} step={0.1} min={0} max={2} className="run-num" label="Temperature" onChange={(v) => set({ temperature: Math.max(0, v) })} />
        <span>Max tokens</span>
        <NumIn value={s.maxTokens} step={16} min={8} max={2048} className="run-num" label="Max tokens" onChange={(v) => set({ maxTokens: Math.max(8, Math.floor(v)) })} />
        <Term k="thinking">Thinking</Term>
        <Switch on={s.thinking} onChange={(v) => set({ thinking: v })} label={s.thinking ? "on" : "off"} />
      </div>
      <div className="run-acts">
        <button className="btn primary" disabled={busy != null || !mix.length || !s.prompt.trim() || bad} onClick={() => void runCompare()} title="Cmd+Enter in the prompt">
          {busy != null ? <Busy since={busy}>Comparing</Busy> : <><Play /> Compare</>}
        </button>
        <SaveStrain />
      </div>
    </section>
  );
}

// ---------- compare ----------

/** Scrolls a new result into view only when it starts below the window (the stacked, narrow layout). */
function reveal(el: HTMLElement | null) {
  if (el && el.getBoundingClientRect().top > window.innerHeight - 120) el.scrollIntoView({ block: "start", behavior: "smooth" });
}

function mixWords(words: Record<string, string[]>, mix: LabPush[]): string[] {
  return mix.flatMap((p) => words[nid(p)] ?? []);
}

function ReplyCard({ title, r, words, base }: { title: React.ReactNode; r: LabReply; words: string[]; base?: number }) {
  return (
    <div className="cmp-col">
      <h4>{title}</h4>
      <ReplyText text={r.text} words={words} />
      <div className="cmp-meters">
        <FluencyMeter v={r.fluency} base={base} />
        <RepetitionMeter v={r.repetition} />
      </div>
      <div className="dim2 num cmp-meta">
        {fmtInt(r.tokens)} tokens, {fmtMs(r.ms)}
        {r.finish === "length" && <span className="warn-text"> cut at max tokens</span>}
      </div>
    </div>
  );
}

function CompareView() {
  const runs = useLab((s) => s.runs);
  const busy = useLab((s) => s.compareBusy);
  const err = useLab((s) => s.compareErr);
  const words = useLab((s) => s.words);
  const [pick, setPick] = useState<number | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const latest = runs[0]?.id;
  useEffect(() => {
    setPick(null);
    // stacked (narrow) layout: bring a fresh result into view
    if (latest != null) reveal(box.current);
  }, [latest]);
  const run = runs.find((r) => r.id === pick) ?? runs[0];
  return (
    <>
      {err && <ErrLine err={err} />}
      {busy != null && <div className="lab-note dim2"><Busy since={busy}>Writing both replies with the same seed</Busy></div>}
      {!run && busy == null && !err && <div className="lab-empty">Compare writes the unsteered and the steered reply to the prompt, with the same seed.</div>}
      {run && (
        <div ref={box} className={busy != null ? "stale" : undefined}>
          <RunHead run={run} />
          <div className="cmp-pair">
            {run.res.baseline && <ReplyCard title="Unsteered" r={run.res.baseline} words={mixWords(words, run.mix)} />}
            <ReplyCard
              title={
                <>
                  Steered <span className="mono dim2">{format(run.mix)}</span>
                  {run.scale !== 1 && <span className="dim2"> ×{run.scale}</span>}
                </>
              }
              r={run.res.steered}
              words={mixWords(words, run.mix)}
              base={run.res.baseline?.fluency}
            />
          </div>
        </div>
      )}
      {runs.length > 1 && (
        <section className="lab-sec">
          <div className="lab-sec-head">
            <h3>Earlier runs</h3>
            <span className="dim num">{runs.length}</span>
          </div>
          <div className="runs">
            {runs.map((r) => (
              <button key={r.id} className={`run-row${r === run ? " on" : ""}`} onClick={() => setPick(r.id)}>
                <span className="num dim">{clockTime(r.at)}</span>
                <span className="mono truncate">
                  {format(r.mix)}
                  {r.scale !== 1 ? ` ×${r.scale}` : ""}
                </span>
                <span className="truncate dim2">{r.res.steered.text}</span>
                <span className="num">{r.res.steered.fluency.toFixed(2)}</span>
              </button>
            ))}
          </div>
        </section>
      )}
    </>
  );
}

function RunHead({ run }: { run: SteerRun }) {
  return (
    <div className="cmp-head dim2">
      <span className="truncate">
        <span className="dim">Prompt</span> <span className="selectable">{run.prompt}</span>
      </span>
      <span className="num">
        <Term k="seed">seed</Term> {run.res.seed}
      </span>
      <span className="num">temp {run.temperature}</span>
    </div>
  );
}

// ---------- sweep ----------

/** First dose where fluency falls 0.8 below the lowest dose's, or 30% of 3-grams repeat. */
export function breakAt(rows: { dose: number; reply: LabReply }[]): number | null {
  if (!rows.length) return null;
  const sorted = [...rows].sort((a, b) => a.dose - b.dose);
  const base = sorted[0].reply.fluency;
  return sorted.find((r) => r.reply.fluency < base - 0.8 || r.reply.repetition > 0.3)?.dose ?? null;
}

function SweepView() {
  const mix = useLab((s) => s.mix);
  const target = useLab((s) => s.sweepTarget);
  const doses = useLab((s) => s.doses);
  const sweep = useLab((s) => s.sweep);
  const busy = useLab((s) => s.sweepBusy);
  const err = useLab((s) => s.sweepErr);
  const prompt = useLab((s) => s.prompt);
  const words = useLab((s) => s.words);
  const set = useLab.setState;
  const list = parseDoses(doses);
  const tgt = target === "mix" ? null : mix.find((p) => nid(p) === target);
  const brk = sweep ? breakAt(sweep.res.rows) : null;
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (sweep) reveal(box.current);
  }, [sweep]);
  const ws = sweep ? (sweep.req.target ? (words[nid(sweep.req.target)] ?? []) : mixWords(words, sweep.req.mix)) : [];
  const appears = useMemo(() => {
    const keep = ws.map((w) => w.trim().replace(/[^A-Za-z0-9]/g, "")).filter((w) => w.length >= 3);
    if (!sweep || !keep.length) return null;
    const re = new RegExp(`\\b(${keep.join("|")})`, "i");
    return [...sweep.res.rows].sort((a, b) => a.dose - b.dose).find((r) => re.test(r.reply.text))?.dose ?? null;
  }, [sweep, ws]);

  return (
    <>
      <div className="sweep-cfg">
        <label className="lab-field">
          <span>Push</span>
          <select className="input select" value={tgt ? target : "mix"} onChange={(e) => set({ sweepTarget: e.target.value })} aria-label="What to sweep">
            <option value="mix">whole mix (as a scale)</option>
            {mix
              .filter((p) => p.mode === "dose")
              .map((p) => (
                <option key={nid(p)} value={nid(p)}>
                  {nid(p)} (dose)
                </option>
              ))}
          </select>
        </label>
        <label className="lab-field grow">
          <span>{tgt ? "Doses" : "Scales"}</span>
          <input className="input mono" value={doses} onChange={(e) => set({ doses: e.target.value })} aria-label="Doses" />
        </label>
        {doses !== DEFAULT_DOSES && (
          <button className="btn sm ghost" onClick={() => set({ doses: DEFAULT_DOSES })}>
            Reset
          </button>
        )}
        <button className="btn primary" disabled={busy != null || !mix.length || !list.length || !prompt.trim()} onClick={() => void runSweep()}>
          {busy != null ? <Busy since={busy}>Sweeping {list.length}</Busy> : <><Play /> Sweep {list.length}</>}
        </button>
      </div>
      {err && <ErrLine err={err} />}
      {!sweep && busy == null && !err && (
        <div className="lab-empty">One reply per dose, same prompt and seed: where the concept shows up, and where the text breaks.</div>
      )}
      {sweep && (
        <div ref={box} className={busy != null ? "stale" : undefined}>
          <div className="cmp-head dim2">
            <span className="truncate">
              <span className="dim">Sweeping</span> <span className="mono">{sweep.label}</span> <span className="dim">on</span> <span className="selectable">{sweep.req.prompt}</span>
            </span>
            <span className="num">seed {sweep.res.seed}</span>
            {appears != null && <span className="ok-text">concept from {appears}</span>}
            <Hint tip={LAB_TIP.breaks}>
              <span className={brk != null ? "err-text" : "dim2"}>{brk != null ? `breaks at ${brk}` : "doesn't break"}</span>
            </Hint>
          </div>
          <SweepCharts rows={sweep.res.rows} brk={brk} unit={sweep.req.target ? "dose" : "scale"} />
          <table className="table lab-table sweep-rows">
            <thead>
              <tr>
                <th className="r">{sweep.req.target ? "Dose" : "Scale"}</th>
                <th>Reply</th>
                <th>
                  <Term k="fluency">Fluency</Term>
                </th>
                <th>
                  <Term k="repetition">Repetition</Term>
                </th>
              </tr>
            </thead>
            <tbody>
              {[...sweep.res.rows]
                .sort((a, b) => a.dose - b.dose)
                .map((r) => (
                  <tr key={r.dose} className={r.dose === brk ? "brk" : r.dose === appears ? "appears" : undefined}>
                    <td className="r num strong">
                      {r.dose}
                      {r.dose === brk && <span className="chip err">breaks</span>}
                    </td>
                    <td className="sweep-reply">
                      <ReplyText text={r.reply.text} words={ws} />
                    </td>
                    <td>
                      <FluencyMeter v={r.reply.fluency} base={sweep.res.rows.reduce((a, x) => (x.dose < a.dose ? x : a)).reply.fluency} />
                    </td>
                    <td>
                      <RepetitionMeter v={r.reply.repetition} />
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

function useWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [w, setW] = useState(480);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setW(el.clientWidth));
    ro.observe(el);
    setW(el.clientWidth);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

/** Fluency and repetition by dose: two small charts on one dose axis (never two scales on one chart). */
function SweepCharts({ rows, brk, unit }: { rows: { dose: number; reply: LabReply }[]; brk: number | null; unit: string }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const [tip, setTip] = useState<TipState | null>(null);
  const pts = [...rows].sort((a, b) => a.dose - b.dose);
  const d0 = pts[0]?.dose ?? 0;
  const d1 = pts[pts.length - 1]?.dose ?? 1;
  const padL = 38;
  const padR = 12;
  const W = Math.max(200, width);
  const x = (d: number) => padL + ((d - d0) / (d1 - d0 || 1)) * (W - padL - padR);
  const flu = pts.map((p) => p.reply.fluency);
  const fMin = Math.min(-2.5, ...flu) - 0.1;
  const fMax = Math.max(-0.5, ...flu);
  const rMax = Math.max(0.5, ...pts.map((p) => p.reply.repetition));
  const H = 64;
  const chart = (label: React.ReactNode, vals: number[], lo: number, hi: number, fmt: (v: number) => string, ticks: number[]) => {
    const y = (v: number) => 6 + (1 - (v - lo) / (hi - lo || 1)) * (H - 14);
    const d = vals.map((v, i) => `${i ? "L" : "M"}${x(pts[i].dose).toFixed(1)},${y(v).toFixed(1)}`).join("");
    return (
      <div className="sw-chart">
        <div className="sw-title">{label}</div>
        <svg width={W} height={H} role="img" aria-label="chart">
          {ticks.map((t) => (
            <g key={t}>
              <line x1={padL} x2={W - padR} y1={y(t)} y2={y(t)} className="sw-grid" />
              <text x={padL - 5} y={y(t) + 3} className="sw-tick" textAnchor="end">
                {fmt(t)}
              </text>
            </g>
          ))}
          {brk != null && <line x1={x(brk)} x2={x(brk)} y1={2} y2={H - 4} className="sw-brk" />}
          {hover != null && <line x1={x(pts[hover].dose)} x2={x(pts[hover].dose)} y1={2} y2={H - 4} className="sw-cross" />}
          <path d={d} className="sw-line" />
          {vals.map((v, i) => (
            <circle key={i} cx={x(pts[i].dose)} cy={y(v)} r={hover === i ? 4.5 : 3.5} className="sw-dot" />
          ))}
        </svg>
      </div>
    );
  };
  return (
    <div
      ref={ref}
      className="sw-charts"
      onMouseMove={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        const mx = e.clientX - r.left;
        let bi = 0;
        pts.forEach((p, i) => {
          if (Math.abs(x(p.dose) - mx) < Math.abs(x(pts[bi].dose) - mx)) bi = i;
        });
        setHover(bi);
        const p = pts[bi];
        setTip({
          x: e.clientX,
          y: e.clientY,
          content: (
            <>
              <div className="tip-head">
                {unit} {p.dose}
                {p.dose === brk && <span className="err-text">breaks</span>}
              </div>
              <div className="tip-row">
                <span>Fluency</span>
                <span>{p.reply.fluency.toFixed(2)}</span>
              </div>
              <div className="tip-row">
                <span>Repetition</span>
                <span>{fmtPct0(p.reply.repetition)}</span>
              </div>
            </>
          ),
        });
      }}
      onMouseLeave={() => {
        setHover(null);
        setTip(null);
      }}
    >
      {chart(
        <>
          <Term k="fluency">Fluency</Term> <span className="dim2">higher is better</span>
        </>,
        flu,
        fMin,
        fMax,
        (v) => v.toFixed(1),
        [-1, -2, -3].filter((t) => t >= fMin && t <= fMax),
      )}
      {chart(
        <>
          <Term k="repetition">Repetition</Term> <span className="dim2">lower is better</span>
        </>,
        pts.map((p) => p.reply.repetition),
        0,
        rMax,
        (v) => fmtPct0(v),
        [0, 0.3].filter((t) => t <= rMax),
      )}
      <div className="sw-axis num" style={{ paddingLeft: padL, paddingRight: padR }}>
        {pts.map((p) => (
          <span key={p.dose} style={{ left: x(p.dose) }}>
            {p.dose}
          </span>
        ))}
      </div>
      <ChartTip tip={tip} />
    </div>
  );
}

