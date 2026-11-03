// The Field Guide: recipes the persona search tested, each with what its numbers mean and real replies. A page of a
// field guide rather than a shop shelf: the name, what it does, and a reply in its own words are what you read.

import { useEffect, useState } from "react";
import { Download, FlaskConical, Loader2, MessageSquare, Play } from "lucide-react";
import type { LabFieldGuide, LabSpecimen } from "@terrarium/shared";
import { chatWithStrain, ensureGuide, keepSpecimen, trySpecimen, useLab } from "../../state/lab";
import { useDownload, useSuggestions } from "../ModelSuggestions";
import { format, isVector } from "../../lib/recipe";
import { fmtBytes } from "../../lib/format";
import { Hint } from "../../components/ui";
import { Busy, ErrLine } from "./bits";

const isWord = (s: LabSpecimen) => s.mix.length === 1 && !isVector(s.mix[0]);
const shortQuote = (t: string) => {
  const one = t.replace(/\*\*/g, "").replace(/\s+/g, " ").trim();
  if (one.length <= 240) return one;
  const cut = one.slice(0, 240);
  return `${cut.slice(0, cut.lastIndexOf(" "))}...`;
};

export function Guide() {
  const guide = useLab((s) => s.guide);
  const err = useLab((s) => s.guideErr);
  const support = useLab((s) => s.lab?.support);
  useEffect(() => {
    void ensureGuide();
  }, []);
  if (err) return <ErrLine err={err} />;
  if (!guide) return <div className="lab-empty">Opening the Field Guide</div>;
  const usable = new Set(support?.filter((x) => x.supported).map((x) => x.modelId));
  const yours = guide.specimens.filter((s) => usable.has(s.modelId));
  const others = guide.models.filter((m) => !usable.has(m.modelId));
  const many = new Set(yours.map((s) => s.modelId)).size > 1;
  const nameOf = (id: string) => guide.models.find((m) => m.modelId === id)?.name ?? id;
  const lead = yours.filter((s) => s.featured);
  const rest = yours.filter((s) => !s.featured);
  const entry = (s: LabSpecimen) => <Entry key={s.id} s={s} model={many ? nameOf(s.modelId) : undefined} />;
  return (
    <div className="guide lab-scroll">
      {!yours.length && <div className="lab-empty">None of the models here has a specimen yet. Get one below and they'll show up.</div>}
      {lead.some((s) => !isWord(s)) && (
        <section className="guide-sec">
          <h2>Characters</h2>
          <p className="dim2">A whole direction in the model, pushed at every word.</p>
          <div className="guide-page">{lead.filter((s) => !isWord(s)).map(entry)}</div>
        </section>
      )}
      {lead.some(isWord) && (
        <section className="guide-sec">
          <h2>One neuron, one obsession</h2>
          <p className="dim2">A single neuron pushed. The model answers normally and can't stop bringing it up.</p>
          <div className="guide-page">{lead.filter(isWord).map(entry)}</div>
        </section>
      )}
      {rest.length > 0 && (
        <details className="lab-more guide-rest">
          <summary>{rest.length} more, weaker in a chat or not yet confirmed</summary>
          <div className="guide-page">{rest.map(entry)}</div>
        </details>
      )}
      {others.map((m) => (
        <MoreOn key={m.modelId} model={m} guide={guide} />
      ))}
      <p className="dim2 guide-how">
        Two numbers, because they differ. In Compare is short replies on prompts the search never saw. In a chat is replies up to 300 tokens, where some recipes start repeating themselves. Replies were judged for staying in character and reading as real text. A strain you keep runs with these settings.
      </p>
    </div>
  );
}

function Entry({ s, model }: { s: LabSpecimen; model?: string }) {
  const trying = useLab((x) => x.guideTrying);
  const kept = useLab((x) => x.strains?.find((st) => st.baseModelId === s.modelId && st.name === s.name));
  const [i, setI] = useState(0);
  const sample = s.samples[i] ?? s.samples[0];
  const joint = Math.round(s.measured.joint * s.measured.n);
  const chat = s.measured.chat;
  return (
    <article className="spec">
      <header className="spec-head">
        <h3>{s.name}</h3>
        {model && <span className="dim2 spec-model">{model}</span>}
      </header>
      <p className="spec-line">{s.line}</p>
      <figure className="spec-reply">
        <blockquote className="selectable">{shortQuote(sample.reply)}</blockquote>
        <figcaption className="dim2">
          {s.samples.length > 1 ? (
            s.samples.map((x, j) => (
              <button key={x.prompt} className={`spec-ask${j === i ? " on" : ""}`} aria-pressed={j === i} onClick={() => setI(j)}>
                {x.prompt}
              </button>
            ))
          ) : (
            <span>{sample.prompt}</span>
          )}
        </figcaption>
      </figure>
      <Hint tip={s.rate}>
        <div className="spec-rate num" tabIndex={0}>
          {chat ? <span>In a chat: {Math.round(chat.joint * chat.n)} of {chat.n} replies in character</span> : <span>Not measured in a chat yet</span>}
          <span className="dim2">In Compare: {joint} of {s.measured.n}</span>
          {s.unconfirmed && <span className="chip warn">not confirmed yet</span>}
          {!s.measured.second && <span className="chip">one judge</span>}
        </div>
      </Hint>
      <details className="spec-more">
        <summary>The numbers and the recipe</summary>
        <p>{s.rate}</p>
        <code className="recipe-peek selectable">{s.mix.length > 8 ? `${s.mix.length} neurons` : format(s.mix)}</code>
        <p className="dim2 num">
          Temperature {s.settings.temperature}, {s.settings.repeat ? `repeat ${s.settings.repeat}` : "no repeat control"}
        </p>
      </details>
      <div className="spec-acts">
        <button className="btn sm primary" disabled={trying != null} onClick={() => void trySpecimen(s)} title="Puts it in the mix and writes a reply next to the unsteered one">
          {trying?.id === s.id ? <Busy since={trying.since}>{trying.step}</Busy> : <><Play /> Try in Compare</>}
        </button>
        {kept ? (
          <button className="btn sm" onClick={() => void chatWithStrain(kept)} title="You kept this one. It's in Strains and the model pickers">
            <MessageSquare /> Chat with it
          </button>
        ) : (
          <button className="btn sm" onClick={() => void keepSpecimen(s)} title="Saves it as a strain: a model you can chat with or run evals on">
            <FlaskConical /> Keep as strain
          </button>
        )}
      </div>
    </article>
  );
}

/** Specimens on a model you don't have: what you'd get, and the download. */
function MoreOn({ model, guide }: { model: LabFieldGuide["models"][number]; guide: LabFieldGuide }) {
  const list = guide.specimens.filter((s) => s.modelId === model.modelId);
  const suggestion = useSuggestions().find((s) => s.repo === model.repo);
  const { starting, running, start } = useDownload(model.repo);
  if (!list.length) return null;
  const pct = running?.bytesTotal ? Math.round((running.bytesDone / running.bytesTotal) * 100) : 0;
  return (
    <section className="guide-more">
      <div>
        <b>
          {list.length} more on {model.name}
        </b>
        <div className="dim2">{list.slice(0, 5).map((s) => s.name).join(", ")}{list.length > 5 ? ", and others" : ""}</div>
      </div>
      {running ? (
        <span className="dim num">Downloading {model.name}, {pct}%</span>
      ) : (
        <button className="btn sm" disabled={starting} onClick={() => void start()}>
          {starting ? <Loader2 className="spin" /> : <Download />} Get {model.name}{suggestion?.sizeBytes ? `, ${fmtBytes(suggestion.sizeBytes)}` : ""}
        </button>
      )}
    </section>
  );
}
