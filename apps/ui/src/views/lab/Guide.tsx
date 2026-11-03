// Examples: tested recipes for one model at a time. A list on the left (name, what's steered, how often it held), the
// picked one on the right: its exact recipe, real replies, and what to do with it.

import { useEffect, useState } from "react";
import { Download, FlaskConical, Loader2, MessageSquare, Play } from "lucide-react";
import type { LabFieldGuide, LabSpecimen } from "@terrarium/shared";
import { chatWithStrain, ensureGuide, keepSpecimen, noteWords, trySpecimen, useLab } from "../../state/lab";
import { useDownload, useSuggestions } from "../ModelSuggestions";
import { isNeuron, isVector } from "../../lib/recipe";
import { fmtBytes } from "../../lib/format";
import { Segmented } from "../../components/ui";
import { Busy, ErrLine } from "./bits";
import { PushLabel, RecipeTable } from "./RecipeTable";

const pct = (s: LabSpecimen) => Math.round((s.measured.chat?.joint ?? s.measured.joint) * 100);
const isCharacter = (s: LabSpecimen) => s.mix.some(isVector);

export function Guide() {
  const guide = useLab((s) => s.guide);
  const err = useLab((s) => s.guideErr);
  const support = useLab((s) => s.lab?.support);
  const ready = useLab((s) => (s.lab?.status === "ready" ? s.lab.model?.modelId : undefined));
  const loaded = useLab((s) => (s.lab?.status === "ready" ? s.lab.model?.modelId : (s.lab?.loadingModelId ?? s.target ?? undefined)));
  const [picked, setPicked] = useState<string | null>(null);
  const [pickedModel, setPickedModel] = useState<string | null>(null);
  useEffect(() => {
    void ensureGuide();
  }, []);
  // Follows the loaded model: another model's neuron ids mean nothing on this one.
  useEffect(() => {
    setPickedModel(null);
    setPicked(null);
  }, [loaded]);
  if (err) return <ErrLine err={err} />;
  if (!guide) return <div className="lab-empty">Loading examples</div>;
  const usable = new Set(support?.filter((x) => x.supported).map((x) => x.modelId));
  const have = guide.models.filter((m) => usable.has(m.modelId));
  const missing = guide.models.filter((m) => !usable.has(m.modelId));
  const modelId = pickedModel ?? (loaded && guide.models.some((m) => m.modelId === loaded) ? loaded : (have[0]?.modelId ?? guide.models[0]?.modelId));
  const list = guide.specimens.filter((s) => s.modelId === modelId);
  const byRate = (a: LabSpecimen, b: LabSpecimen) => pct(b) - pct(a);
  const characters = list.filter(isCharacter).sort(byRate);
  const neurons = list.filter((s) => !isCharacter(s)).sort(byRate);
  const cur = list.find((s) => s.id === picked) ?? characters[0] ?? neurons[0];
  const model = guide.models.find((m) => m.modelId === modelId);
  const onBench = modelId === ready;
  return (
    <div className="guide">
      <div className="guide-list lab-scroll">
        {guide.models.length > 1 && (
          <div className="guide-models">
            <Segmented<string> small value={modelId} onChange={setPickedModel} options={guide.models.map((m) => ({ value: m.modelId, label: m.name }))} ariaLabel="Model" />
          </div>
        )}
        <Group title="Characters" list={characters} cur={cur} onPick={setPicked} />
        <Group title="Single neurons" list={neurons} cur={cur} onPick={setPicked} />
      </div>
      <div className="guide-detail lab-scroll">
        {cur && <Detail key={cur.id} s={cur} modelName={model?.name ?? cur.modelId} onBench={onBench} available={usable.has(cur.modelId)} />}
        {missing.some((m) => m.modelId === modelId) && model && <GetModel model={model} />}
      </div>
    </div>
  );
}

function Group({ title, list, cur, onPick }: { title: string; list: LabSpecimen[]; cur?: LabSpecimen; onPick: (id: string) => void }) {
  if (!list.length) return null;
  return (
    <section className="guide-group">
      <h3>
        {title} <span className="dim num">{list.length}</span>
      </h3>
      <ul>
        {list.map((s) => (
          <li key={s.id}>
            <button className={`guide-row${s.id === cur?.id ? " on" : ""}`} aria-current={s.id === cur?.id ? "true" : undefined} onClick={() => onPick(s.id)}>
              <span className="guide-name truncate">{s.name}</span>
              <span className="guide-recipe mono truncate">
                {s.mix.slice(0, 1).map((p, i) => (
                  <PushLabel key={i} p={p} />
                ))}
                {s.mix.length > 1 ? ` +${s.mix.length - 1}` : ""}
              </span>
              <span className="guide-pct num" title={s.rate}>
                {pct(s)}%
              </span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Detail({ s, modelName, onBench, available }: { s: LabSpecimen; modelName: string; onBench: boolean; available: boolean }) {
  const trying = useLab((x) => x.guideTrying);
  const kept = useLab((x) => x.strains?.find((st) => st.baseModelId === s.modelId && st.name === s.name));
  const [i, setI] = useState(0);
  const sample = s.samples[i] ?? s.samples[0];
  const neuron = s.mix.find(isNeuron);
  // the words a single neuron writes are known without loading it: its table, as the search built it
  useEffect(() => {
    if (neuron && s.tokens?.length) noteWords(neuron, s.tokens);
  }, [neuron, s.tokens]);
  return (
    <article className="guide-card">
      <header>
        <h2>{s.name}</h2>
        <p>{s.line}</p>
      </header>
      <div className="guide-acts">
        <button className="btn primary" disabled={trying != null || !available} onClick={() => void trySpecimen(s)} title={onBench ? "Write a reply with it next to the unsteered one" : `Loads ${modelName}, then writes a reply with it next to the unsteered one`}>
          {trying?.id === s.id ? <Busy since={trying.since}>{trying.step}</Busy> : <><Play /> {onBench ? "Try in Compare" : `Load ${modelName} and try`}</>}
        </button>
        {kept ? (
          <button className="btn" onClick={() => void chatWithStrain(kept)}>
            <MessageSquare /> Chat with strain
          </button>
        ) : (
          <button className="btn" disabled={!available} onClick={() => void keepSpecimen(s)} title="Adds it to Strains and the model pickers">
            <FlaskConical /> Save as strain
          </button>
        )}
      </div>
      <section>
        <h3>Recipe</h3>
        <RecipeTable pushes={s.mix} tokens={s.tokens} modelId={s.modelId} />
        <dl className="guide-facts num">
          <dt>Model</dt>
          <dd>{modelName}</dd>
          <dt>Temperature</dt>
          <dd>{s.settings.temperature}</dd>
          <dt>Repeat penalty</dt>
          <dd>{s.settings.repeat ?? "off"}</dd>
          <dt>Max tokens</dt>
          <dd>{s.settings.maxTokens ?? "none"}</dd>
          <dt>In character</dt>
          <dd>
            {pct(s)}% <span className="dim2">{s.rate}</span>
          </dd>
        </dl>
      </section>
      <section>
        <h3>Sample replies</h3>
        {s.samples.length > 1 && (
          <div className="guide-prompts" role="tablist" aria-label="Prompt">
            {s.samples.map((x, j) => (
              <button key={x.prompt} role="tab" aria-selected={j === i} className={`guide-prompt${j === i ? " on" : ""}`} onClick={() => setI(j)}>
                {x.prompt}
              </button>
            ))}
          </div>
        )}
        {s.samples.length === 1 && <div className="guide-prompt-one">{sample.prompt}</div>}
        <p className="guide-reply selectable">{sample.reply}</p>
      </section>
    </article>
  );
}

/** Examples for a model you don't have: the download. */
function GetModel({ model }: { model: LabFieldGuide["models"][number] }) {
  const suggestion = useSuggestions().find((s) => s.repo === model.repo);
  const { starting, running, start } = useDownload(model.repo);
  const done = running?.bytesTotal ? Math.round((running.bytesDone / running.bytesTotal) * 100) : 0;
  return (
    <div className="guide-get">
      {running ? (
        <span className="dim num">Downloading {model.name}: {done}%</span>
      ) : (
        <button className="btn" disabled={starting} onClick={() => void start()}>
          {starting ? <Loader2 className="spin" /> : <Download />} Download {model.name}{suggestion?.sizeBytes ? ` (${fmtBytes(suggestion.sizeBytes)})` : ""}
        </button>
      )}
    </div>
  );
}
