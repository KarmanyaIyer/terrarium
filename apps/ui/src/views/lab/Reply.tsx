// A reply wherever it shows up: how it reads in plain words, the exact recipe it ran with, every word clickable, and the
// same next steps everywhere. Neurons get theirs from NeuronActions.

import { useMemo, type ReactNode } from "react";
import { BarChart3, Crosshair, FlaskRound, Grid3x3, Plus, SlidersHorizontal, Waypoints } from "lucide-react";
import type { LabQuality, LabReply, NeuronRef } from "@terrarium/shared";
import { addToMix, compareNeuron, saveAsStrain, seedsFor, seedsNeuron, settingsOf, sweepNeuron, traceAnswer, traceWord, useLab, useRecipe, type Recipe } from "../../state/lab";
import { pickPiece } from "../../lib/labGrid";
import { findPush, format, fmtDose, isVector, nid, pushKey } from "../../lib/recipe";
import { CopyButton, Hint } from "../../components/ui";
import { fmtPct0, NeuronLink } from "./bits";

export const QUALITY: Record<LabQuality, { word: string; what: string }> = {
  ok: { word: "Reads fine", what: "Ordinary text, whatever it's about." },
  odd: { word: "Unusual", what: "Still text, but with many word choices the unsteered model would rarely make." },
  loop: { word: "Loop", what: "Stuck repeating itself." },
  broken: { word: "Garbled", what: "Word by word, far from anything the unsteered model would write." },
  empty: { word: "Empty", what: "Stopped almost at once." },
};

/** How a reply reads, with the numbers behind the word on hover. */
export function QualityChip({ r }: { r: LabReply }) {
  const q = QUALITY[r.quality] ?? QUALITY.ok;
  return (
    <Hint
      width={300}
      tip={
        <>
          <span className="hint-title">{q.word}</span>
          <div className="hint-line">{q.what}</div>
          <div className="hint-line">
            Word-by-word likelihood <b className="num">{r.fluency.toFixed(2)}</b>: how expected each word was to the unsteered model. Ordinary replies sit near -1. Steered text often sits at -2 and reads fine, because
            surprising is what steering is for, so this isn't a grade.
          </div>
          <div className="hint-line">
            Repeated runs of words: <b className="num">{fmtPct0(r.repetition)}</b>
          </div>
        </>
      }
    >
      <span className={`q q-${r.quality}`}>{q.word}</span>
    </Hint>
  );
}

const fmtSigned = (v: number) => `${v >= 0 ? "+" : "-"}${fmtDose(Math.abs(v))}`;

/** Exactly what ran. Stays with the result when the controls change. */
export function RecipeLine({ r, prompt, traceOnly }: { r: Recipe; prompt?: boolean; traceOnly?: boolean }) {
  return (
    <div className="recipe-line">
      {r.pushes.length === 0 && <span className="rl-none">no steering</span>}
      {r.pushes.map((p) => (
        <span key={pushKey(p)} className="rl-push" title={isVector(p) ? `Layer ${p.layer}, strength ${fmtDose(p.strength)}` : undefined}>
          {isVector(p) ? (
            <>
              <span className="rl-vector">{p.name}</span>
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
          <span>{r.maxTokens} tokens</span>
          {r.repeat ? <span>repeat {r.repeat}</span> : null}
          {r.thinking && <span>thinking</span>}
        </>
      )}
      {r.pushes.length > 0 && <CopyButton text={format(r.pushes)} label="Copy recipe" />}
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

/** Reply text cut at tokens. Clicking a word asks why it's there; dragging still selects. */
export function WordsText({ reply, words, onPick }: { reply: LabReply; words?: string[]; onPick?: (i: number) => void }) {
  const stems = useMemo(() => [...new Set((words ?? []).map(stemOf).filter((w) => w.length >= 3))], [words]);
  const marked = (piece: string) => {
    const p = stemOf(piece);
    return p.length >= 3 && stems.some((s) => p.startsWith(s));
  };
  const pieces = reply.pieces;
  if (!pieces?.length || !onPick) return <div className="reply selectable">{reply.text}</div>;
  return (
    <div className="reply selectable words">
      {pieces.map((t, i) => (
        <span
          key={i}
          className={marked(t) ? "w cw" : "w"}
          onClick={() => {
            const sel = window.getSelection();
            if (!sel || sel.isCollapsed) onPick(i);
          }}
        >
          {t}
        </span>
      ))}
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
        <button className="btn sm ghost" onClick={() => useRecipe(recipe)} title="Put this recipe's mix, seed and prompt back on the bench">
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

/** A reply as a slip: what it is, how it reads, the text, what ran, and where to go next. */
export function ReplySlip({ title, reply, recipe, words, baseline, tag, actions, hideActions }: { title: ReactNode; reply: LabReply; recipe: Recipe; words?: string[]; baseline?: LabReply; tag?: ReactNode; actions?: ReactNode; hideActions?: boolean }) {
  return (
    <article className={`slip slip-${reply.quality}`}>
      <header className="slip-head">
        <h4>{title}</h4>
        {tag}
        <QualityChip r={reply} />
        {reply.finish === "length" && <span className="dim2 slip-cut">cut at {reply.tokens} tokens</span>}
      </header>
      <WordsText reply={reply} words={words} onPick={(i) => traceWord(recipe, pickPiece(reply.pieces, i))} />
      <RecipeLine r={recipe} />
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
