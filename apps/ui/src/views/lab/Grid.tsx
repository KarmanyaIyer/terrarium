// The dose ruler and sample grid: replies as cells coloured by how they read, filling in as they finish. Sweep lays doses
// out left to right around zero with seeds down the side. Test across seeds lays seeds out with prompts down the side.

import { useEffect, useMemo, useState } from "react";
import { ZoomIn } from "lucide-react";
import type { LabReply } from "@terrarium/shared";
import { cellRecipe, type GridCell, type GridRun } from "../../state/lab";
import { hasWord } from "../../lib/labGrid";
import { nid } from "../../lib/recipe";
import { QUALITY, ReplySlip } from "./Reply";

const cellId = (c: Pick<GridCell, "dose" | "seed" | "prompt">) => `${c.dose}|${c.seed}|${c.prompt}`;
const fmtDoseLabel = (d: number) => `${d > 0 ? "+" : ""}${Math.round(d * 1000) / 1000}`;

export function useCells(run: GridRun) {
  return useMemo(() => new Map(run.cells.map((c) => [cellId(c), c])), [run.cells]);
}

function tipFor(c: GridCell | undefined, head: string): string {
  if (!c) return `${head}: not run yet`;
  const q = QUALITY[c.reply.quality]?.word ?? c.reply.quality;
  return `${head}: ${q}\n${c.reply.text.slice(0, 200)}`;
}

function Cell({ c, label, on, inRange, hit, onDown, onEnter }: { c?: GridCell; label: string; on: boolean; inRange: boolean; hit?: boolean; onDown: (e: React.PointerEvent) => void; onEnter: (e: React.PointerEvent) => void }) {
  return (
    <button
      type="button"
      className={`gcell${c ? ` q-${c.reply.quality}` : " pending"}${on ? " on" : ""}${inRange ? " in" : ""}${hit ? " hit" : ""}`}
      title={tipFor(c, label)}
      aria-label={c ? `${label}: ${QUALITY[c.reply.quality]?.word}` : `${label}: not run yet`}
      disabled={!c}
      onPointerDown={onDown}
      onPointerEnter={onEnter}
    />
  );
}

/** The reds and blues of the scale, zero in the middle: negative doses on the violet side, positive on the orange. */
function Axis({ doses }: { doses: number[] }) {
  const lo = doses[0];
  const hi = doses[doses.length - 1];
  const n = doses.length;
  const zero = doses.indexOf(0);
  const at = (i: number) => `${((i + 0.5) / n) * 100}%`;
  const crosses = lo < 0 && hi > 0;
  const stop = zero >= 0 ? ((zero + 0.5) / n) * 100 : 50;
  const ticks = [0, zero, n - 1].filter((v, i, a) => v >= 0 && a.indexOf(v) === i);
  return (
    <div className="gaxis">
      <div
        className="gaxis-bar"
        style={{
          background: crosses
            ? `linear-gradient(90deg, var(--act-neg), color-mix(in srgb, var(--act-neg) 10%, transparent) ${stop}%, color-mix(in srgb, var(--act-pos) 10%, transparent) ${stop}%, var(--act-pos))`
            : hi <= 0
              ? "linear-gradient(90deg, var(--act-neg), color-mix(in srgb, var(--act-neg) 25%, transparent))"
              : "linear-gradient(90deg, color-mix(in srgb, var(--act-pos) 25%, transparent), var(--act-pos))",
        }}
      />
      {ticks.map((i) => (
        <span key={i} className={`gtick num${doses[i] === 0 ? " zero" : ""}${i === 0 ? " first" : i === n - 1 ? " last" : ""}`} style={{ left: at(i) }}>
          {fmtDoseLabel(doses[i])}
        </span>
      ))}
    </div>
  );
}

function Legend({ hits }: { hits?: boolean }) {
  return (
    <div className="glegend">
      {(["ok", "odd", "loop", "broken", "empty"] as const).map((q) => (
        <span key={q}>
          <i className={`gswatch q-${q}`} />
          {QUALITY[q].word}
        </span>
      ))}
      {hits && (
        <span>
          <i className="gswatch q-ok hit" />
          Has your words
        </span>
      )}
    </div>
  );
}

/** Sweep results: the ruler, then the replies to read. */
export function DoseRuler({ run, words, onZoom }: { run: GridRun; words: string[]; onZoom: (a: number, b: number) => void }) {
  const cells = useCells(run);
  const doses = useMemo(() => [...run.doses].sort((a, b) => a - b), [run.doses]);
  const prompt = run.prompts[0] ?? "";
  const [sel, setSel] = useState<{ dose: number; seed: number } | null>(null);
  const [range, setRange] = useState<[number, number] | null>(null);
  const [drag, setDrag] = useState<number | null>(null);
  useEffect(() => {
    const up = () => setDrag(null);
    window.addEventListener("pointerup", up);
    return () => window.removeEventListener("pointerup", up);
  }, []);
  useEffect(() => {
    setSel(null);
    setRange(null);
  }, [run.id]);
  // follows the first finished reply until something's picked
  const shown = sel ?? (run.cells[0] ? { dose: run.cells[0].dose, seed: run.cells[0].seed } : null);
  const cur = shown ? cells.get(cellId({ ...shown, prompt })) : undefined;
  const low = range ? Math.min(...range) : null;
  const high = range ? Math.max(...range) : null;
  const down = (dose: number, seed: number) => (e: React.PointerEvent) => {
    (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
    if (e.shiftKey && shown) {
      setRange([shown.dose, dose]);
      return;
    }
    setSel({ dose, seed });
    setRange(null);
    setDrag(dose);
  };
  const enter = (dose: number) => (e: React.PointerEvent) => {
    if (drag == null || e.buttons !== 1 || dose === drag) return;
    setRange([drag, dose]);
  };
  const move = (dx: number, dy: number) => {
    if (!shown) return;
    const col = doses.indexOf(shown.dose) + dx;
    const row = run.seeds.indexOf(shown.seed) + dy;
    if (doses[col] != null && run.seeds[row] != null) setSel({ dose: doses[col], seed: run.seeds[row] });
  };
  return (
    <>
      <div
        className="ruler"
        tabIndex={0}
        aria-label="Replies by dose. Arrow keys move between them."
        onKeyDown={(e) => {
          const d = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
          if (!d) return;
          e.preventDefault();
          move(d[0], d[1]);
        }}
      >
        <div className="ruler-rows" style={{ "--cols": doses.length } as React.CSSProperties}>
          {run.seeds.map((seed) => (
            <div key={seed} className="grow-row">
              {run.seeds.length > 1 && <span className="grow-label num">seed {seed}</span>}
              <div className="gcells">
                {doses.map((dose) => {
                  const c = cells.get(cellId({ dose, seed, prompt }));
                  return <Cell key={dose} c={c} label={`Dose ${fmtDoseLabel(dose)}, seed ${seed}`} on={shown?.dose === dose && shown.seed === seed} inRange={low != null && dose >= low && dose <= high!} hit={!!c && hasWord(c.reply.text, words)} onDown={down(dose, seed)} onEnter={enter(dose)} />;
                })}
              </div>
            </div>
          ))}
          <div className="grow-row">
            {run.seeds.length > 1 && <span className="grow-label" />}
            <Axis doses={doses} />
          </div>
        </div>
      </div>
      <div className="ruler-foot">
        <Legend hits={words.length > 0} />
        <span className="blk-spacer" />
        {low != null && high != null && low !== high ? (
          <button className="btn sm primary" onClick={() => onZoom(low, high)}>
            <ZoomIn /> Zoom in between {fmtDoseLabel(low)} and {fmtDoseLabel(high)}
          </button>
        ) : (
          <span className="dim2">Drag across cells to zoom in between two doses.</span>
        )}
      </div>
      {cur && <CellSlip run={run} c={cur} words={words} title={`${run.target ? `${nid(run.target)} at` : "Mix at"} ${run.target ? fmtDoseLabel(cur.dose) : `×${fmtDoseLabel(cur.dose).replace("+", "")}`}`} />}
      <ReplyRows run={run} words={words} doses={doses} seed={shown?.seed ?? run.seeds[0]} pick={shown?.dose} onPick={(dose) => setSel({ dose, seed: shown?.seed ?? run.seeds[0] })} cells={cells} />
    </>
  );
}

function CellSlip({ run, c, words, title }: { run: GridRun; c: GridCell; words: string[]; title: string }) {
  return <ReplySlip title={title} reply={c.reply} recipe={cellRecipe(run, c)} words={words} />;
}

/** One line per dose, for scanning: click to read it above. */
function ReplyRows({ run, words, doses, seed, pick, onPick, cells }: { run: GridRun; words: string[]; doses: number[]; seed: number; pick?: number; onPick: (d: number) => void; cells: Map<string, GridCell> }) {
  const prompt = run.prompts[0] ?? "";
  return (
    <div className="grows" role="list">
      {doses.map((dose) => {
        const c = cells.get(cellId({ dose, seed, prompt }));
        if (!c) return null;
        return (
          <button key={dose} role="listitem" className={`grow${pick === dose ? " on" : ""}`} onClick={() => onPick(dose)}>
            <span className={`num grow-dose ${dose < 0 ? "neg" : dose > 0 ? "pos" : ""}`}>{fmtDoseLabel(dose)}</span>
            <i className={`gswatch q-${c.reply.quality}${hasWord(c.reply.text, words) ? " hit" : ""}`} title={QUALITY[c.reply.quality]?.word} />
            <span className="truncate">{c.reply.text || "(nothing)"}</span>
          </button>
        );
      })}
    </div>
  );
}

const rate = (a: number, n: number) => (n ? `${Math.round((a / n) * 100)}%` : "");

function Stat({ tone, label, a, n }: { tone: string; label: string; a: number; n: number }) {
  return (
    <div className={`gstat q-${tone}`}>
      <b className="num">{rate(a, n)}</b>
      <span>{label}</span>
      <span className="dim2 num">
        {a} of {n}
      </span>
    </div>
  );
}

export interface SeedSummary {
  n: number;
  ok: number;
  odd: number;
  loop: number;
  broken: number;
  hits: number | null;
}

/** Test across seeds results: the rates, the grid, and whichever sample you pick. */
export function SeedGrid({ run, summary }: { run: GridRun; summary: SeedSummary }) {
  const cells = useCells(run);
  const [sel, setSel] = useState<{ seed: number; prompt: string } | null>(null);
  useEffect(() => setSel(null), [run.id]);
  const dose = run.doses[0] ?? 1;
  const shown = sel ?? (run.cells[0] ? { seed: run.cells[0].seed, prompt: run.cells[0].prompt } : null);
  const cur = shown ? cells.get(cellId({ dose, ...shown })) : undefined;
  const reads = summary.ok + summary.odd;
  const verdict = !summary.n ? "" : run.state === "running" ? `So far, ${summary.n} of ${run.seeds.length * run.prompts.length} replies.` : reads / summary.n >= 0.8 ? "Holds up across seeds." : reads / summary.n >= 0.5 ? "Depends on the seed: some runs break." : "Mostly breaks. Try a smaller dose.";
  return (
    <>
      <div className="gstats">
        <div className="gverdict">{verdict}</div>
        <Stat tone="ok" label="read fine" a={summary.ok} n={summary.n} />
        {summary.odd > 0 && <Stat tone="odd" label="unusual" a={summary.odd} n={summary.n} />}
        <Stat tone="loop" label="loop" a={summary.loop} n={summary.n} />
        <Stat tone="broken" label="garbled or empty" a={summary.broken} n={summary.n} />
        {summary.hits != null && <Stat tone="hit" label="have your words" a={summary.hits} n={summary.n} />}
      </div>
      <div className="ruler seedgrid" style={{ "--cols": run.seeds.length } as React.CSSProperties}>
        {run.prompts.map((prompt) => (
          <div key={prompt} className="grow-row wide">
            <span className="grow-label truncate" title={prompt}>
              {prompt}
            </span>
            <div className="gcells">
              {run.seeds.map((seed) => {
                const c = cells.get(cellId({ dose, seed, prompt }));
                return <Cell key={seed} c={c} label={`Seed ${seed}`} on={shown?.seed === seed && shown.prompt === prompt} inRange={false} hit={!!c && hasWord(c.reply.text, run.words)} onDown={() => setSel({ seed, prompt })} onEnter={() => {}} />;
              })}
            </div>
          </div>
        ))}
      </div>
      <Legend hits={run.words.length > 0} />
      {cur && <ReplySlip title={cur.prompt} reply={cur.reply as LabReply} recipe={cellRecipe(run, cur)} words={run.words} />}
    </>
  );
}
