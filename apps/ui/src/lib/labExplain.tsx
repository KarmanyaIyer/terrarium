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
  memory: card(
    "Memory",
    "oMLX and the Lab together stay under the memory ceiling from Settings. The Lab counts its estimate for the model: weights plus room for long probes.",
    "Free memory unloads oMLX models that no running session or eval uses; they load again on their next request.",
  ),
  neuron: card(
    "Neuron",
    "One number inside a layer's MLP: the gate times the up projection, just before the projection out (down_proj, or w2 in LFM3) adds it back into the model's running state (the residual stream). Every token gets its own value.",
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
    "Full attention layers look back at every earlier token. Qwen3.5's linear attention layers (3 of every 4) keep a fixed-size running summary instead; sliding layers (Gemma 4, LFM3) look back over a recent window only, and LFM3's conv layers over the last few tokens.",
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
  testPrompt: card("Test prompt", "A message that gives the concept room to show when steering, like \"What should I make for dinner tonight?\". Find's previews and Steer use it."),
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
    "A neuron can fire on a concept without producing it. Detectors light up on texts about pirates, but pushing them barely changes the reply.",
    "Late-layer writers push one word hard, and the text often turns into that word over and over.",
    "The neurons worth steering do both. Check the preview reply before trusting a high score.",
  ),
  beatsAll: card("Beats all", "Share of concept texts where the neuron peaks higher than it does on every control text. 100%: no control text ever got as high."),
  conceptVsControl: card("Concept vs control", "Mean peak over the concept texts against the control texts, in x typical."),
  conceptTokens: card("Concept words", "Tokens in several concept texts and no control text. \"Pushes it\" measures how much a neuron raises these."),
  lens: card(
    "Pushes toward, away from",
    "Words the neuron makes more (or less) likely when it fires: its down_proj column projected through the final norm onto the vocabulary (the logit lens).",
    "A rough guide: later layers can still change what it means by the time the model picks a word.",
  ),
  firesOn: card("Fires on", "Its strongest texts from a small test set, plus any text you try here. Darker tokens are higher."),
  range: card("Typical range", "Over ordinary calibration text: mean, spread (std), the 99th percentile used as its typical peak, and the largest value seen."),
  doseUnit: card(
    "Dose unit",
    "Raw activation that dose 1.0 adds: the typical size of the residual stream after this layer divided by the length of the neuron's down_proj column.",
    "Usually tens of times its typical peak, which is why doses around 1 are already strong.",
  ),
  dose: card(
    "Dose",
    "How much a push adds to the neuron on every token, in neuronary's relative unit: dose 1.0 adds a vector as long as the usual residual stream at that layer.",
    "0.5 to 1.0 is the usual range on Qwen3.5, and small changes matter: 0.66 and 0.8 can write very different replies. Negative doses push the other way. Models with a norm after each MLP (LFM3) need larger doses for the same effect.",
  ),
  clamp: card(
    "Clamp",
    <>
      Sets the neuron to a fixed raw activation on every token instead of adding to it. Written <span className="mono">L8N344=25</span>.
      Compare the value with the typical range on the neuron's card.
    </>,
  ),
  mix: card("Mix", "The neurons and vectors applied together while the model writes, on every token of prompt and reply. Save a mix as a strain to chat with it or evaluate it."),
  recipe: card(
    "Recipe",
    <>
      The mix as text, the way neuronary.org writes it: <span className="mono">L22N2742+0.8</span> is dose +0.8, <span className="mono">L8N344=25</span>{" "}
      a clamp. Paste one to import it.
    </>,
  ),
  scale: card("Scale", "Multiplies every dose in the mix; clamps stay as set. Turns the whole mix up or down at once. Saving a strain bakes the scale into its doses."),
  seed: card("Seed", "Fixes the random choices while sampling. The unsteered and steered replies share it, so differences come from the mix, not luck. Steered text can swing a lot from seed to seed: use Test across seeds before trusting one."),
  temperature: card("Temperature", "0 always takes the most likely token: same reply every time. 0.7 is the usual setting; higher is more varied."),
  thinking: card("Thinking", "Off by default here: a think block delays the part of the reply where steering shows."),
  repeat: card("Repeat control", "Makes tokens from the last 64 less likely to come up again (mlx-lm's repetition penalty). It can hold off the loops pushes tend to cause, at the price of a less exact copy of what the mix alone does. 1.1 is light, 1.3 is strong."),
  compare: card("Compare", "Unsteered and steered replies to the same prompt with the same seed."),
  sweep: card("Sweep", "The same prompt at many doses of one push, from negative through zero to positive: where it starts to work, where it breaks. With several neurons, it can multiply the whole mix instead."),
  seeds: card("Test across seeds", "The same recipe over many seeds and several prompts, and how often it holds up. One good reply can be luck."),
  fluency: card(
    "Word-by-word likelihood",
    "How expected each word of a reply was to the unsteered model, as a mean log-probability. Ordinary replies sit near -1.",
    "It falls when steering works as well as when it breaks.",
  ),
  repetition: card("Repetition", "Share of three-token runs that repeat an earlier one. Ordinary text is under 5%. Above 30%, or a last stretch that cycles, is a loop."),
  strain: card("Strain", "A saved mix: a base model plus pushes. It shows up in the model pickers as a model of its own."),
  strainUse: card(
    "Using a strain",
    "Chats and evals with a strain run on the Lab's copy of the base model, not on oMLX, with the mix applied to every token.",
    "Slower than oMLX. The Lab holds one model at a time, so it can't be swapped or unloaded while a strain is in use.",
  ),
  attribute: card(
    "Trace",
    "Which neurons change the next word, by experiment. Gradients only say what to try: they tell how a small change moves the gap, not which way a real dose works, since their sign includes the neuron's current value.",
    "So each shortlisted neuron is really pushed at several sizes in both directions, and rows rank by what the logits did. The dose on a row is the smallest that makes the word the model's pick, or else the one that moved it most.",
  ),
  metric: card("Gap", "Logit of the word you asked about minus logit of the other word, at the next token. Positive: the model prefers yours. Logits are the model's raw scores: a gap of +5 is about 150 to 1 odds between the two."),
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
