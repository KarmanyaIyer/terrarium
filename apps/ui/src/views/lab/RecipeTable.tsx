// A recipe as numbers: which neuron or vector, on which layer, at what dose. Used wherever one is shown, so a strain, an
// example and a saved result all read the same way.

import { useEffect } from "react";
import type { LabMixItem, LabVector, NeuronRef } from "@terrarium/shared";
import { loadNeuronWords, useLab } from "../../state/lab";
import { isVector, nid, pushKey, shownDose, signedDose, vectorLength } from "../../lib/recipe";
import { fmtInt } from "../../lib/format";
import { CopyButton } from "../../components/ui";
import { NeuronLink, TokChips } from "./bits";

/** The push on one line: `L22N4296 +0.6`, `L8 vector ×1`. */
export function PushLabel({ p }: { p: LabMixItem }) {
  if (isVector(p)) return <>L{p.layer} vector ×{shownDose(p.strength)}</>;
  return (
    <>
      {nid(p)} {p.mode === "clamp" ? `=${shownDose(p.value)}` : signedDose(p.value)}
    </>
  );
}

export function vectorValues(p: LabVector): string {
  const raw = Uint8Array.from(atob(p.u), (c) => c.charCodeAt(0));
  return [...new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4)].map((v) => String(Math.round(v * 1e6) / 1e6)).join(", ");
}

function NeuronRow({ r, value, clamp, tokens, modelId }: { r: NeuronRef; value: number; clamp: boolean; tokens?: string[]; modelId: string }) {
  const known = useLab((s) => s.words[nid(r)]);
  const onBench = useLab((s) => s.lab?.status === "ready" && s.lab.model?.modelId === modelId);
  useEffect(() => {
    if (!tokens?.length && !known && onBench) void loadNeuronWords(r);
  }, [r, tokens, known, onBench]);
  const words = tokens?.length ? tokens : known;
  return (
    <tr>
      <td className="mono">
        {onBench ? <NeuronLink r={r} /> : nid(r)}
      </td>
      <td className="num r">{r.layer}</td>
      <td className="num r">{fmtInt(r.neuron)}</td>
      <td className="num r strong">{clamp ? `=${shownDose(value)}` : signedDose(value)}</td>
      <td className="rt-words">{words?.length ? <TokChips tokens={words} max={6} /> : <span className="dim2">{onBench ? "" : "Load the model for its words"}</span>}</td>
    </tr>
  );
}

function VectorRow({ p }: { p: LabVector }) {
  const n = vectorLength(p.u);
  return (
    <tr>
      <td>Vector</td>
      <td className="num r">{p.layer}</td>
      <td className="num r">{fmtInt(n)} values</td>
      <td className="num r strong">×{shownDose(p.strength)}</td>
      <td className="rt-words">
        <CopyButton text={() => vectorValues(p)} label="Copy values" />
      </td>
    </tr>
  );
}

/** Each push, with its layer, neuron, dose and the words it writes. A vector isn't a neuron, so it says what it is instead. */
export function RecipeTable({ pushes, tokens, modelId }: { pushes: LabMixItem[]; tokens?: string[]; modelId: string }) {
  const hasVector = pushes.some(isVector);
  const hasNeuron = pushes.some((p) => !isVector(p));
  return (
    <div className="recipe-table">
      <table>
        <thead>
          <tr>
            <th>{hasVector && !hasNeuron ? "Type" : "Neuron"}</th>
            <th className="r">Layer</th>
            <th className="r">{hasVector && !hasNeuron ? "Size" : "Index"}</th>
            <th className="r">{hasVector && !hasNeuron ? "Strength" : "Dose"}</th>
            <th>{hasVector && !hasNeuron ? "" : "Pushes toward"}</th>
          </tr>
        </thead>
        <tbody>
          {pushes.map((p) => (isVector(p) ? <VectorRow key={pushKey(p)} p={p} /> : <NeuronRow key={pushKey(p)} r={p} value={p.value} clamp={p.mode === "clamp"} tokens={pushes.length === 1 ? tokens : undefined} modelId={modelId} />))}
        </tbody>
      </table>
      {hasVector && <p className="dim2 rt-note">Adds these values to the layer's output at every token. Not individual neurons.</p>}
    </div>
  );
}
