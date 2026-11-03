import { useMemo, useState } from "react";
import { RotateCcw, Trash2 } from "lucide-react";
import type { LabGrow, LabHistoryEntry, LabMixItem } from "@terrarium/shared";
import { deleteHistory, restoreHistory, useLab, type FindFlow, type GridRun, type SteerRun, type TraceRun } from "../../state/lab";
import { summarize } from "../../lib/labGrid";
import { pushText } from "./RecipeTable";
import { Time } from "../../components/ui";
import { QualityChip } from "./Reply";

const KIND: Record<LabHistoryEntry["kind"], string> = { compare: "Compare", sweep: "Sweep", seeds: "Seeds", trace: "Trace", find: "Find", grow: "Grow" };

const pushesOf = (e: LabHistoryEntry): LabMixItem[] => {
  if (e.kind === "compare") return (e.data as SteerRun).recipe.pushes;
  if (e.kind === "sweep" || e.kind === "seeds") return (e.data as GridRun).mix;
  if (e.kind === "trace") return (e.data as TraceRun).pushes;
  if (e.kind === "grow") {
    const v = (e.data as LabGrow).result?.vector;
    return v ? [v] : [];
  }
  return [];
};

function Detail({ e }: { e: LabHistoryEntry }) {
  if (e.kind === "compare") {
    const r = e.data as SteerRun;
    return (
      <>
        <QualityChip r={r.steered} />
        <span className="truncate dim2">{r.steered.text}</span>
      </>
    );
  }
  if (e.kind === "sweep" || e.kind === "seeds") {
    const r = e.data as GridRun;
    const s = summarize(r.cells.map((c) => c.reply));
    const lo = Math.min(...r.doses);
    const hi = Math.max(...r.doses);
    return (
      <span className="dim2 num">
        {e.kind === "sweep" ? `${r.doses.length} doses from ${lo} to ${hi}, ${r.seeds.length} seed${r.seeds.length === 1 ? "" : "s"}` : `${r.seeds.length} seeds, ${r.prompts.length} prompt${r.prompts.length === 1 ? "" : "s"}`}: {s.ok + s.odd} of {s.n} normal
        {r.state === "stopped" ? " (stopped early)" : ""}
      </span>
    );
  }
  if (e.kind === "grow") {
    const r = (e.data as LabGrow).result;
    return <span className="dim2 num">{r ? `${r.inCharacter} of ${r.n} in character at strength ${r.vector.strength}` : ""}</span>;
  }
  if (e.kind === "trace") {
    const r = e.data as TraceRun;
    const top = r.res.nodes.find((n) => n.best);
    return <span className="dim2 num">{top?.best ? `best: L${top.layer}N${top.neuron} at ${top.best.dose > 0 ? "+" : ""}${top.best.dose}, now writes "${top.best.top}"` : `gap ${r.res.metric.toFixed(1)}`}</span>;
  }
  const f = e.data as FindFlow;
  return <span className="dim2 truncate">Tried {f.tried?.length ?? 0} neurons</span>;
}

export function History() {
  const history = useLab((s) => s.history);
  const support = useLab((s) => s.lab?.support);
  const loaded = useLab((s) => (s.lab?.status === "ready" ? s.lab.model?.modelId : undefined));
  const [kind, setKind] = useState<LabHistoryEntry["kind"] | "all">("all");
  const kinds = useMemo(() => [...new Set(history?.map((e) => e.kind) ?? [])], [history]);
  const list = (history ?? []).filter((e) => kind === "all" || e.kind === kind);
  const name = (id: string) => support?.find((x) => x.modelId === id)?.name ?? id;
  return (
    <div className="history lab-scroll">
      {history == null && <div className="lab-empty dim2">Loading history</div>}
      {history?.length === 0 && <div className="lab-empty">No results yet.</div>}
      {kinds.length > 1 && (
        <div className="hist-kinds">
          {(["all", ...kinds] as const).map((k) => (
            <button key={k} className={`preset${k === kind ? " on" : ""}`} onClick={() => setKind(k)}>
              {k === "all" ? "All" : KIND[k]}
            </button>
          ))}
        </div>
      )}
      <div className="hist-list" role="list">
        {list.map((e) => {
          const pushes = pushesOf(e);
          const here = !loaded || e.modelId === loaded;
          return (
            <div key={e.id} role="listitem" className="hist-row">
              <span className="hist-kind">{KIND[e.kind]}</span>
              <div className="hist-main">
                <div className="hist-title">
                  <span className="truncate">{e.title || "(untitled)"}</span>
                </div>
                <div className="hist-sub">
                  {pushes.length > 0 && <code className="mono truncate">{pushes.map(pushText).join(", ")}</code>}
                  <Detail e={e} />
                </div>
              </div>
              {!loaded && <span className="dim2 truncate hist-model">{name(e.modelId)}</span>}
              <span className="dim2 num">
                <Time ts={e.at} />
              </span>
              <button className="btn sm" disabled={!here} title={here ? "Bring back this result, with its mix, doses, seed and prompt" : `Ran on ${name(e.modelId)}: load it to restore this`} onClick={() => restoreHistory(e)}>
                <RotateCcw /> Restore
              </button>
              <button className="icon-btn sm" aria-label="Delete from history" title="Delete (Cmd+Z brings it back)" onClick={() => void deleteHistory(e)}>
                <Trash2 />
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
