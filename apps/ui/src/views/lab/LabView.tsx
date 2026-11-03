import { useEffect } from "react";
import { ensureLab, useLab, type LabTab } from "../../state/lab";
import { useStore } from "../../state/store";
import { Bench, SpecimenHead } from "./Specimen";
import { Find } from "./Find";
import { Guide } from "./Guide";
import { History } from "./History";
import { Probe } from "./Probe";
import { Steer } from "./Steer";
import { SaveStrainDialog, Strains } from "./Strains";
import { Trace } from "./Trace";
import { NeuronCard } from "./NeuronCard";
import { Busy, ErrLine } from "./bits";

const TABS: { id: LabTab; label: string }[] = [
  { id: "guide", label: "Examples" },
  { id: "find", label: "Find" },
  { id: "steer", label: "Steer" },
  { id: "trace", label: "Trace" },
  { id: "probe", label: "Probe" },
  { id: "strains", label: "Strains" },
  { id: "history", label: "History" },
];

export default function LabView() {
  const lab = useLab((s) => s.lab);
  const missing = useLab((s) => s.missing);
  const tab = useLab((s) => s.tab);
  const overCeiling = useLab((s) => s.lab?.overCeiling);
  const mixN = useLab((s) => s.mix.length);
  const strainsN = useLab((s) => s.strains?.length ?? 0);
  const example = useLab((s) => s.example);
  const historyN = useLab((s) => s.history?.length ?? 0);
  const card = useLab((s) => s.card);
  const loadErr = useLab((s) => s.loadErr);
  const hydrated = useStore((s) => s.ready);

  useEffect(() => {
    if (hydrated) void ensureLab();
  }, [hydrated]);

  const ready = lab?.status === "ready";
  const cur = TABS.find((t) => t.id === tab) ?? TABS[0];
  const needsBench = !ready && cur.id !== "strains" && cur.id !== "history" && cur.id !== "guide";

  if (missing && !lab)
    return (
      <div className="lab-view">
        <div className="view-head lab-head">
          <h1>Lab</h1>
        </div>
        <div className="lab-bench">
          <div className="bench-card">
            <ErrLine err={missing} />
          </div>
        </div>
      </div>
    );

  return (
    <div className="lab-view">
      <SpecimenHead />
      {overCeiling && (
        <div className="lab-head-err warn-text" role="status">
          {overCeiling}
        </div>
      )}
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
            {t.id === "history" && historyN > 0 && <span className="lab-tab-n num">{historyN}</span>}
          </button>
        ))}
        <span className="blk-spacer" />
        {example && (
          <span className="lab-example-step">
            <Busy since={example.since}>{example.step}</Busy>
          </span>
        )}
      </div>
      <div className={`lab-main${card ? " with-card" : ""}`}>
        <div className="lab-pane" role="tabpanel" aria-label={cur.label}>
          {needsBench ? (
            <Bench />
          ) : cur.id === "guide" ? (
            <Guide />
          ) : cur.id === "find" ? (
            <Find />
          ) : cur.id === "probe" ? (
            <Probe />
          ) : cur.id === "steer" ? (
            <Steer />
          ) : cur.id === "strains" ? (
            <Strains />
          ) : cur.id === "history" ? (
            <History />
          ) : (
            <Trace />
          )}
        </div>
        <NeuronCard />
      </div>
      <SaveStrainDialog />
    </div>
  );
}
