import { useEffect, type ReactNode } from "react";
import { Sparkles } from "lucide-react";
import { ensureLab, runExample, useLab, type LabTab } from "../../state/lab";
import { useStore } from "../../state/store";
import { Hint } from "../../components/ui";
import { Term } from "../../lib/labExplain";
import { Bench, SpecimenHead } from "./Specimen";
import { Find } from "./Find";
import { Probe } from "./Probe";
import { Steer } from "./Steer";
import { Strains } from "./Strains";
import { Trace } from "./Trace";
import { NeuronCard } from "./NeuronCard";
import { Busy, ErrLine } from "./bits";

const TABS: { id: LabTab; label: string; lede: ReactNode }[] = [
  {
    id: "find",
    label: "Find",
    lede: (
      <>
        Give texts with a concept and matched texts without it. Every <Term k="neuron">neuron</Term> gets scored on how much it tells them apart and how much it pushes the concept.
      </>
    ),
  },
  {
    id: "probe",
    label: "Probe",
    lede: (
      <>
        Run any text through the model and see which neurons fire on which tokens, as <Term k="typical">x typical</Term>.
      </>
    ),
  },
  {
    id: "steer",
    label: "Steer",
    lede: (
      <>
        Push neurons while the model writes. Compare the same prompt and seed with and without the <Term k="mix">mix</Term>, or sweep the dose to see where it breaks.
      </>
    ),
  },
  {
    id: "strains",
    label: "Strains",
    lede: (
      <>
        Saved mixes. A <Term k="strain">strain</Term> works like a model: it shows up in the model pickers, and chats and evals with it run on the Lab.
      </>
    ),
  },
  {
    id: "trace",
    label: "Trace an answer",
    lede: (
      <>
        Pick the next token of an answer and see which neurons voted for it over another. <Term k="attribute">How it's measured</Term>
      </>
    ),
  },
];

export default function LabView() {
  const lab = useLab((s) => s.lab);
  const missing = useLab((s) => s.missing);
  const tab = useLab((s) => s.tab);
  const mixN = useLab((s) => s.mix.length);
  const strainsN = useLab((s) => s.strains?.length ?? 0);
  const example = useLab((s) => s.example);
  const card = useLab((s) => s.card);
  const loadErr = useLab((s) => s.loadErr);
  const hydrated = useStore((s) => s.ready);

  useEffect(() => {
    if (hydrated) void ensureLab();
  }, [hydrated]);

  const ready = lab?.status === "ready";
  const cur = TABS.find((t) => t.id === tab) ?? TABS[0];
  const needsBench = !ready && cur.id !== "strains";

  if (missing && !lab)
    return (
      <div className="lab-view">
        <div className="view-head lab-head">
          <h1>Lab</h1>
        </div>
        <div className="lab-bench">
          <div className="bench-card">
            <ErrLine err={missing} />
            <div className="dim2">The Lab needs the Python sidecar from this repo's backend. Start the backend with Lab support, then reopen this page.</div>
          </div>
        </div>
      </div>
    );

  return (
    <div className="lab-view">
      <SpecimenHead />
      {/* a refused swap or example while a model is open: the bench that shows it isn't on screen */}
      {ready && loadErr && (
        <div className="lab-head-err">
          <ErrLine err={loadErr}>
            <button className="btn sm ghost" onClick={() => useLab.setState({ loadErr: null })}>
              Dismiss
            </button>
          </ErrLine>
        </div>
      )}
      <div className="lab-tabs" role="tablist" aria-label="Lab">
        {TABS.map((t) => (
          <button key={t.id} role="tab" aria-selected={t.id === cur.id} className={`lab-tab${t.id === cur.id ? " on" : ""}`} onClick={() => useLab.setState({ tab: t.id })}>
            {t.label}
            {t.id === "steer" && mixN > 0 && <span className="lab-tab-n num">{mixN}</span>}
            {t.id === "strains" && strainsN > 0 && <span className="lab-tab-n num">{strainsN}</span>}
          </button>
        ))}
        <span className="blk-spacer" />
        {example ? (
          <span className="lab-example-step">
            <Busy since={example.since}>{example.step}</Busy>
          </span>
        ) : (
          ready && (
            <Hint tip="Loads the 4B model if needed, finds neurons for the aliens probe set, adds the top one at +0.8 and compares replies to 'Who are you?'.">
              <button className="btn sm ghost" onClick={() => void runExample()}>
                <Sparkles /> Try the example
              </button>
            </Hint>
          )
        )}
      </div>
      {!needsBench && <div className="lab-lede dim2">{cur.lede}</div>}
      <div className={`lab-main${card ? " with-card" : ""}`}>
        <div className="lab-pane" role="tabpanel" aria-label={cur.label}>
          {needsBench ? (
            <Bench />
          ) : cur.id === "find" ? (
            <Find />
          ) : cur.id === "probe" ? (
            <Probe />
          ) : cur.id === "steer" ? (
            <Steer />
          ) : cur.id === "strains" ? (
            <Strains />
          ) : (
            <Trace />
          )}
        </div>
        <NeuronCard />
      </div>
    </div>
  );
}
