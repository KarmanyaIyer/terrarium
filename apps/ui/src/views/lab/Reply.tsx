// A reply wherever it shows up: how it reads in plain words, the exact recipe it ran with, every word clickable, and the
// same next steps everywhere. Neurons get theirs from NeuronActions.

import { useMemo, type ReactNode } from "react";
import { BarChart3, Crosshair, FlaskRound, Grid3x3, Plus, SlidersHorizontal, Waypoints } from "lucide-react";
import type { LabQuality, LabReply, NeuronRef } from "@terrarium/shared";
import { addToMix, compareNeuron, saveAsStrain, seedsFor, seedsNeuron, settingsOf, sweepNeuron, traceAnswer, traceWord, useLab, useRecipe, type Recipe } from "../../state/lab";
import { pickPiece } from "../../lib/labGrid";
import { findPush, fmtDose, isVector, nid, pushKey } from "../../lib/recipe";
import { fmtPct0, fmtSecs, NeuronLink } from "./bits";

export const QUALITY: Record<LabQuality, { word: string; what: string }> = {
  ok: { word: "Normal", what: "Ordinary text." },
  odd: { word: "Unusual", what: "Word choices the unsteered model would rarely make." },
  loop: { word: "Loop", what: "Stuck repeating itself." },
  broken: { word: "Garbled", what: "Far from anything the unsteered model would write." },
  empty: { word: "Empty", what: "Stopped almost at once." },
};

/** Says something only when a reply went wrong. A normal reply needs no label. */
export function QualityChip({ r }: { r: LabReply }) {
  if (r.quality === "ok" || r.quality === "odd") return null;
  const q = QUALITY[r.quality];
  return (
    <span className={`q q-${r.quality}`} title={q.what}>
      {q.word}
    </span>
  );
}

const fmtSigned = (v: number) => `${v > 0 ? "+" : v < 0 ? "-" : ""}${fmtDose(Math.abs(v))}`;

/** Exactly what ran. Stays with the result when the controls change. */
export function RecipeLine({ r, prompt, traceOnly }: { r: Recipe; prompt?: boolean; traceOnly?: boolean }) {
  return (
    <div className="recipe-line">
      {r.pushes.length === 0 && <span className="rl-none">No steering</span>}
      {r.pushes.map((p) => (
        <span key={pushKey(p)} className="rl-push" title={isVector(p) ? `Layer ${p.layer}, strength ${fmtDose(p.strength)}` : undefined}>
          {isVector(p) ? (
            <>
              <span className="rl-vector">{p.name}</span>
              <span>L{p.layer} vector</span>
              <b className={p.strength < 0 ? "neg" : "pos"}>×{fmtDose(p.strength)}</b>
            </>
          ) : (
            <>
              <NeuronLink r={p} />
              <b className={p.mode === "clamp" ? undefined : p.value < 0 ? "neg" : "pos"}>{p.mode === "clamp" ? `=${fmtDose(p.value)}` : fmtSigned(p.value)}</b>
            </>
          )}
        </span>
      ))}
      {!traceOnly && (
        <>
          <span>seed {r.seed}</span>
          <span>temp {r.temperature}</span>
          <span>max {r.maxTokens}</span>
          {r.repeat ? <span>repeat {r.repeat}</span> : null}
          {r.thinking && <span>thinking</span>}
        </>
      )}
      {prompt && <span className="rl-prompt truncate">{r.prompt}</span>}
    </div>
  );
}

const stemOf = (w: string) =>
  w
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, "")
    .replace(/s$/, "");

/**
 * Replies are markdown cut at token boundaries. Shows them as a reader would: no ** or ### marks, those runs in bold, a
 * bullet for * or - at the start of a line. Returns what to show for each piece, so a click still knows its token.
 */
function readable(pieces: string[]): { text: string; bold: boolean }[][] {
  let bold = false;
  let heading = false;
  let lineStart = true;
  return pieces.map((piece) => {
    const out: { text: string; bold: boolean }[] = [];
    let rest = piece;
    if (lineStart) {
      const lead = /^\s*/.exec(rest)![0];
      const after = rest.slice(lead.length);
      if (/^#{1,6}(\s|$)/.test(after)) {
        heading = true;
        rest = lead + after.replace(/^#{1,6}\s*/, "");
      } else if (/^[*-](\s|$)/.test(after)) rest = `${lead}\u2022${after.slice(1)}`;
    }
    for (const part of rest.split("**")) {
      if (part) out.push({ text: part, bold: bold || heading });
      bold = !bold;
    }
    bold = !bold; // split makes one more part than it has marks
    for (const ch of rest) {
      if (ch === "\n") {
        heading = false;
        lineStart = true;
      } else if (ch.trim()) lineStart = false;
    }
    return out;
  });
}

/** Reply text cut at tokens. Clicking a word asks why it's there; dragging still selects. */
export function WordsText({ reply, words, onPick }: { reply: LabReply; words?: string[]; onPick?: (i: number) => void }) {
  const stems = useMemo(() => [...new Set((words ?? []).map(stemOf).filter((w) => w.length >= 3))], [words]);
  const marked = (piece: string) => {
    const p = stemOf(piece);
    return p.length >= 3 && stems.some((s) => p.startsWith(s));
  };
  const pieces = reply.pieces;
  if (!pieces?.length) return <div className="reply selectable">{readable([reply.text])[0].map((x, j) => (x.bold ? <b key={j}>{x.text}</b> : x.text))}</div>;
  const shown = readable(pieces);
  return (
    <div className={`reply selectable${onPick ? " words" : ""}`}>
      {pieces.map((t, i) => {
        const parts = shown[i];
        if (!parts.length) return null;
        return (
          <span
            key={i}
            className={marked(t) ? "w cw" : "w"}
            onClick={
              onPick &&
              (() => {
                const sel = window.getSelection();
                if (!sel || sel.isCollapsed) onPick(i);
              })
            }
          >
            {parts.map((x, j) => (x.bold ? <b key={j}>{x.text}</b> : x.text))}
          </span>
        );
      })}
    </div>
  );
}

/** The next steps from a reply. Each one fills what it needs; nothing to copy. */
export function ReplyActions({ recipe, reply, baseline, extra }: { recipe: Recipe; reply: LabReply; baseline?: LabReply; extra?: ReactNode }) {
  const steered = recipe.pushes.length > 0;
  return (
    <div className="slip-acts">
      <button className="btn sm ghost" disabled={!reply.pieces?.length} onClick={() => traceAnswer(recipe, reply, baseline)} title="Which neurons make it write this? Starts at the first word the mix changed">
        <Crosshair /> Trace this answer
      </button>
      {steered && (
        <button className="btn sm ghost" onClick={() => seedsFor(recipe)} title="Run this recipe over many seeds and prompts">
          <Grid3x3 /> Test across seeds
        </button>
      )}
      {steered && (
        <button className="btn sm ghost" onClick={() => useRecipe(recipe)} title="Load this recipe's mix, seed and prompt">
          <SlidersHorizontal /> Use this recipe
        </button>
      )}
      {steered && (
        <button className="btn sm ghost" onClick={() => saveAsStrain(recipe.pushes, undefined, settingsOf(recipe))}>
          <FlaskRound /> Save as strain
        </button>
      )}
      {extra}
    </div>
  );
}

/** Numbers for one reply. */
function ReplyStats({ reply }: { reply: LabReply }) {
  return (
    <div className="reply-stats num">
      <span title="Tokens written, and how long it took">
        {reply.tokens} tokens, {fmtSecs(reply.ms)}
      </span>
      <span title="Mean log-probability of each word under the unsteered model. Near -1 is ordinary. Steered text is often lower.">fluency {reply.fluency.toFixed(2)}</span>
      <span title="Share of repeated 3-word runs">repetition {fmtPct0(reply.repetition)}</span>
    </div>
  );
}

/** A reply: the text, whether it was cut off, what ran, and where to go next. */
export function ReplySlip({ title, reply, recipe, words, baseline, tag, actions, hideActions }: { title: ReactNode; reply: LabReply; recipe: Recipe; words?: string[]; baseline?: LabReply; tag?: ReactNode; actions?: ReactNode; hideActions?: boolean }) {
  return (
    <article className="slip">
      <header className="slip-head">
        <h4>{title}</h4>
        {tag}
        <QualityChip r={reply} />
      </header>
      <WordsText reply={reply} words={words} onPick={(i) => traceWord(recipe, pickPiece(reply.pieces, i))} />
      {reply.finish === "length" && <div className="slip-cut">Cut off at the {reply.tokens}-token limit</div>}
      <RecipeLine r={recipe} />
      <ReplyStats reply={reply} />
      {!hideActions && <ReplyActions recipe={recipe} reply={reply} baseline={baseline} extra={actions} />}
    </article>
  );
}

/** The next steps from a neuron, at a signed dose. The same from Find, Trace, Probe and its card. */
export function NeuronActions({ r, dose: given, primary }: { r: NeuronRef; dose?: number; primary?: boolean }) {
  const typical = useLab((s) => s.lab?.model?.tryDose ?? 0.8);
  const dose = given ?? typical;
  const push = useLab((s) => findPush(s.mix, r));
  const same = push?.mode === "dose" && push.value === dose;
  return (
    <div className="slip-acts">
      <button className={`btn sm${primary ? " primary" : ""}`} disabled={same} onClick={() => addToMix(r, dose)} title={same ? "Already in the mix at this dose" : push ? `In the mix at ${fmtDose(push.value)}: this moves it` : "Add to the mix at this dose"}>
        <Plus /> {same ? "In the mix" : `Add at ${fmtSigned(dose)}`}
      </button>
      <button className="btn sm ghost" onClick={() => compareNeuron(r, dose)} title={`Write with only ${nid(r)} at ${fmtSigned(dose)}, next to the unsteered reply`}>
        <Waypoints /> Compare alone
      </button>
      <button className="btn sm ghost" onClick={() => sweepNeuron(r, dose)} title={`Replies at doses from negative to positive`}>
        <BarChart3 /> Sweep doses
      </button>
      <button className="btn sm ghost" onClick={() => seedsNeuron(r, dose)} title="Run it over many seeds and prompts">
        <Grid3x3 /> Test across seeds
      </button>
    </div>
  );
}
