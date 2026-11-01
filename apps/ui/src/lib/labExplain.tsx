// Hover-card copy for the Lab: what each term means, in short plain lines. Facts come from the Lab sidecar
// (dose unit, typical peak, score, writes, fluency) and packages/shared (Lab section); keep them in sync.

import type { ReactNode } from "react";
import { Hint } from "../components/ui";

const card = (title: ReactNode, ...lines: ReactNode[]) => (
  <>
    <span className="hint-title">{title}</span>
    {lines.map((l, i) => (
      <div key={i} className="hint-line">
        {l}
      </div>
    ))}
  </>
);

export const LAB_TIP = {
  specimen: card(
    "Specimen",
    "The model on the Lab bench. The Lab runs its own copy in a separate process, with hooks on every MLP neuron, so it can read and push them.",
    "One specimen at a time. Bonsai packs can't be opened: their neurons are mixed together on disk.",
  ),
  memory: card(
    "Memory",
    "oMLX and the Lab together stay under the memory ceiling from Settings. The Lab counts its estimate for the model: weights plus room for long probes.",
    "Free memory unloads oMLX models that no running session or eval uses; they load again on their next request.",
  ),
  neuron: card(
    "Neuron",
    "One number inside a layer's MLP: the gate times the up projection, just before down_proj adds it back into the model's running state (the residual stream). Every token gets its own value.",
    <>
      Written <span className="mono">L15N4041</span>: layer 15, neuron 4041. Same ids as neuronary.org.
    </>,
  ),
  activation: card(
    "Activation",
    "A neuron's value on one token. Most neurons sit near zero on most tokens; a few fire hard on what they track. Values can be negative.",
    "Raw values don't compare across neurons, so the Lab also shows them as x typical.",
  ),
  typical: card(
    "x typical",
    "Activation divided by the neuron's typical peak: the 99th percentile of its size over ordinary calibration text.",
    "1× is a strong but normal firing. 3× and up is rare: the text has something this neuron cares about.",
  ),
  standout: card(
    "Standouts",
    "Neurons whose peak on this text is largest relative to their typical peak.",
    "The first token is skipped: models park huge values there (an attention sink), which says nothing about the text.",
  ),
  layer: card(
    "Layer",
    "The model is a stack of layers. Each reads the residual stream, adds to it and passes it on.",
    "Roughly: early layers track spelling and syntax, middle layers topics and concepts, late layers the exact next word.",
  ),
  layerKinds: card(
    "Layer kinds",
    "Full attention layers look back at every earlier token. Qwen3.5's linear attention layers (3 of every 4) keep a fixed-size running summary instead; Gemma 4's sliding layers look back over a recent window only.",
    "The MLP neurons work the same way in every kind.",
  ),
  template: card(
    "Template tokens",
    <>
      Chat markup the model sees around your message: <span className="mono">{"<|im_start|>"}</span>, role names, the empty think block. You
      didn't type them, but neurons fire on them too.
    </>,
  ),
  heatmap: card("Layer heatmap", "This layer's strongest neurons on each token. Darker orange is higher x typical, violet is negative. Click a column to open the neuron."),
  watch: card("Watch list", "Neurons traced on every token of each probe. Click one to shade the tokens by it."),
  probeSet: card(
    "Probe set",
    "Two lists of texts: concept texts that have the thing you want, control texts that don't. Find compares how every neuron fires on the two.",
    "Make each control match a concept text in everything except the concept: same length, tone and structure. \"The barn owl hunted\" against \"The barn cat hunted\" isolates owl; controls about taxes would also turn up neurons for animals and stories.",
  ),
  testPrompt: card("Test prompt", "A message that gives the concept room to show when steering, like \"Who are you?\". Find's previews and Steer use it."),
  score: card(
    "Fires on it",
    "How much higher the neuron peaks on concept texts than on control texts, in standard deviations. Peaks are in x typical.",
    "Above 3 is a clear detector. It says the neuron reads the concept, not that it writes it.",
  ),
  writes: card(
    "Pushes it",
    "The Lab adds the neuron at dose +0.8 on a few open prompts and measures how much more likely the concept's own words become as the next token, in nats (log-probability).",
    "Above 1 is a strong push. The tokens listed are the ones it raises most.",
  ),
  both: card("Both", "Fires on it and pushes it: the square root of the two multiplied. Results sort by this by default, because steering needs both."),
  readWrite: card(
    "Reading is not writing",
    "A neuron can fire on a concept without producing it. Detectors light up on \"alien\" texts, but pushing them barely changes the reply.",
    "Late-layer writers push one word hard, and the text often turns into that word over and over.",
    "The neurons worth steering do both. Check the preview reply before trusting a high score.",
  ),
  preview: card("Preview", "A short greedy reply (32 tokens) to the test prompt with this neuron at +0.8. The quickest check that it writes the concept."),
  beatsAll: card("Beats all", "Share of concept texts where the neuron peaks higher than it does on every control text. 100%: no control text ever got as high."),
  conceptVsControl: card("Concept vs control", "Mean peak over the concept texts against the control texts, in x typical."),
  conceptTokens: card("Concept words", "Tokens in several concept texts and no control text. \"Pushes it\" measures how much a neuron raises these."),
  lens: card(
    "Pushes toward, away from",
    "Words the neuron makes more (or less) likely when it fires: its down_proj column projected through the final norm onto the vocabulary (the logit lens).",
    "A rough guide: later layers can still change what it means by the time the model picks a word.",
  ),
  firesOn: card("Fires on", "Its strongest texts from a small field guide, plus any text you try here. Darker tokens are higher."),
  range: card("Typical range", "Over ordinary calibration text: mean, spread (std), the 99th percentile used as its typical peak, and the largest value seen."),
  doseUnit: card(
    "Dose unit",
    "Raw activation that dose 1.0 adds: the typical size of the residual stream after this layer divided by the length of the neuron's down_proj column.",
    "Usually tens of times its typical peak, which is why doses around 1 are already strong.",
  ),
  dose: card(
    "Dose",
    "How much a push adds to the neuron on every token, in neuronary's relative unit: dose 1.0 adds a vector as long as the usual residual stream at that layer.",
    "0.5 to 1.0 is the normal range. Around 3 wrecks the text. Negative doses push the other way.",
  ),
  clamp: card(
    "Clamp",
    <>
      Sets the neuron to a fixed raw activation on every token instead of adding to it. Written <span className="mono">L8N344=25</span>.
      Compare the value with the typical range on the neuron's card.
    </>,
  ),
  mix: card("Mix", "The pushes applied together while the model writes, on every token of prompt and reply. Saved, a mix becomes a strain you can chat with or evaluate."),
  recipe: card(
    "Recipe",
    <>
      The mix as text, the way neuronary.org writes it: <span className="mono">L22N2742+0.8</span> is dose +0.8, <span className="mono">L8N344=25</span>{" "}
      a clamp. Paste one to import it.
    </>,
  ),
  scale: card("Scale", "Multiplies every dose in the mix; clamps stay as set. Turns the whole mix up or down at once. Saving a strain bakes the scale into its doses."),
  seed: card("Seed", "Fixes the random choices while sampling. The unsteered and steered replies share it, so differences come from the mix, not luck. Lock it to compare runs fairly."),
  temperature: card("Temperature", "0 always takes the most likely token: same reply every time. 0.7 is the usual setting; higher is more varied."),
  thinking: card("Thinking", "Off by default here: a think block delays the part of the reply where steering shows."),
  compare: card("Compare", "Unsteered and steered replies to the same prompt with the same seed."),
  sweep: card("Sweep", "The same prompt and seed at several doses of one push (or several scales of the whole mix): where the concept appears, and where the text breaks."),
  fluency: card(
    "Fluency",
    "Mean log-probability of the reply's tokens under the unsteered model, per token. Ordinary replies sit around -1.",
    "It drops as steering pushes the model off course; below about -2 the text is usually broken.",
  ),
  repetition: card("Repetition", "Share of three-token runs that repeat an earlier one. Ordinary text is under 5%. Above 30% the model is looping."),
  breaks: card("Breaks", "The first dose where fluency falls more than 0.8 below the lowest dose's, or repetition passes 30%. A rule of thumb, not a measured boundary."),
  strain: card("Strain", "A saved mix: a base model plus pushes, like a bred variant of a specimen. It shows up in the model pickers as a model of its own."),
  strainUse: card(
    "Using a strain",
    "Chats and evals with a strain run on the Lab's copy of the base model, not on oMLX, with the mix applied to every token.",
    "Slower than oMLX. The Lab holds one specimen at a time, so while a strain serves a session the bench can't be swapped or unloaded.",
  ),
  attribute: card(
    "Trace an answer",
    "For the next token after the prompt (and the start of the answer), which neurons push it toward the target over the foil.",
    "Share is a neuron's estimated part of the gap between target and foil, counted at the last token only, so shares don't add up to 100%. It is an estimate from gradients: confirm the top ones by steering them.",
  ),
  metric: card("Target vs foil", "Logit of the target minus logit of the foil at the next token. Positive: the model already prefers the target."),
} satisfies Record<string, ReactNode>;

export type LabTerm = keyof typeof LAB_TIP;

/** A term with a dotted underline and its hover card. */
export function Term({ k, children, width }: { k: LabTerm; children: ReactNode; width?: number }) {
  return (
    <Hint tip={LAB_TIP[k]} width={width}>
      <span className="hint-text">{children}</span>
    </Hint>
  );
}

/** The small help icon with a term's card. */
export function TermIcon({ k, width }: { k: LabTerm; width?: number }) {
  return <Hint tip={LAB_TIP[k]} width={width} label={`About ${k}`} />;
}
