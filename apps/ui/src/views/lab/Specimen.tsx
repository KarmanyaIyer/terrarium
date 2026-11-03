import { Check, ChevronDown, Loader2, Microscope, Power, Redo2, Sparkles, Undo2 } from "lucide-react";
import type { LabMemoryCheck, LabState } from "@terrarium/shared";
import { openView, useStore } from "../../state/store";
import { runRedo, runUndo, useUndoLabels } from "../../state/undo";
import { checkMemory, exampleSpecimen, freeMemory, loadSpecimen, pickTarget, runExample, unloadSpecimen, useLab } from "../../state/lab";
import { exactBytes, fmtBytes, fmtInt, fmtMs } from "../../lib/format";
import { Hint, Popover, usePop } from "../../components/ui";
import { LAB_TIP, Term } from "../../lib/labExplain";
import { GetExampleModel, ModelSuggestions } from "../ModelSuggestions";
import { Busy, ErrLine } from "./bits";

const modelName = (lab: LabState | null, id: string | null | undefined) => lab?.support.find((s) => s.modelId === id)?.name ?? id ?? "";

/** Picker over the models the Lab can open; unsupported ones say why. */
function SpecimenPicker() {
  const lab = useLab((s) => s.lab);
  const target = useLab((s) => s.target);
  const pop = usePop();
  const loaded = lab?.model?.modelId ?? lab?.loadingModelId;
  const st = lab?.status ?? "stopped";
  return (
    <>
      <button ref={pop.ref} className="hdr-btn lab-picker" onClick={pop.toggle} aria-haspopup="listbox">
        <span className="strong truncate">{modelName(lab, target ?? loaded) || (lab?.support.length ? "Pick a model" : "No models yet")}</span>
        <ChevronDown size={12} className="dim" />
      </button>
      <Popover anchor={pop.ref} open={pop.open} onClose={pop.close} width={430} className="lab-pick-pop">
        <div className="menu-label lab-pick-label">
          <span>Model</span>
          <span className="dim2">Memory</span>
        </div>
        <div className="menu" role="listbox">
          {(lab?.support ?? []).map((s) => (
            <button
              key={s.modelId}
              role="option"
              aria-selected={s.modelId === target}
              className={`lab-pick-row${s.modelId === target ? " on" : ""}`}
              disabled={!s.supported}
              onClick={() => {
                pop.close();
                pickTarget(s.modelId);
              }}
            >
              {s.modelId === target ? <Check size={12} className="mp-check" /> : <span className="mp-check" />}
              <span className="lab-pick-main">
                <span className="lab-pick-name">
                  <span className="truncate">{s.name}</span>
                  {s.modelId === loaded && <span className="dim2">{st === "ready" ? "loaded" : st}</span>}
                </span>
                {!s.supported && <span className="lab-pick-why">{s.reason}</span>}
              </span>
              <span className="num dim">{s.supported ? fmtBytes(s.estimateBytes) : "unsupported"}</span>
            </button>
          ))}
          {!lab?.support.length && <div className="empty">No models in models/</div>}
        </div>
        {lab && (lab.status === "ready" || lab.status === "loading" || lab.status === "starting") && (
          <div className="lab-pick-foot">
            {lab.status === "ready" && <Facts lab={lab} />}
            <MemoryLine />
            {lab.status === "ready" && (
              <button
                className="btn sm"
                disabled={(lab.servingStrains ?? []).length > 0}
                title={(lab.servingStrains ?? []).length ? "Strains are serving sessions: stop them first" : "Frees the Lab's memory"}
                onClick={() => {
                  pop.close();
                  void unloadSpecimen();
                }}
              >
                <Power /> Unload
              </button>
            )}
          </div>
        )}
      </Popover>
    </>
  );
}

/** What the model is, from the loaded model itself. */
function Facts({ lab }: { lab: LabState }) {
  const m = lab.model;
  if (!m) return null;
  const width = m.neuronsPerLayer.every((n) => n === m.neuronsPerLayer[0]) ? fmtInt(m.neuronsPerLayer[0]) : `${fmtInt(Math.min(...m.neuronsPerLayer))} to ${fmtInt(Math.max(...m.neuronsPerLayer))}`;
  const full = m.layerKinds?.map((k, i) => (k === "full" ? i : -1)).filter((i) => i >= 0);
  const rest = [...new Set(m.layerKinds?.filter((k) => k !== "full"))].map((k) => (k === "linear" ? "linear attention" : k === "sliding" ? "sliding window" : k)).join(" and ");
  return (
    <Hint
      width={340}
      tip={
        <>
          <span className="hint-title">{m.name}</span>
          <div className="hint-rows">
            <span>Architecture</span>
            <span className="mono">{m.arch}</span>
            <span>Layers</span>
            <span>
              {m.layers}, {width} neurons each
            </span>
            {full && (
              <>
                <span>Full attention</span>
                <span>
                  layers {full.join(", ")}
                  {rest ? `; the rest ${rest}` : ""}
                </span>
              </>
            )}
            <span>Residual width</span>
            <span className="num">{fmtInt(m.dModel)}</span>
            <span>MLP</span>
            <span>{m.activation}</span>
            <span>Weights</span>
            <span>{m.quant}</span>
            <span>Calibration</span>
            <span>{fmtInt(m.calibrationTokens)} tokens (typical peaks, dose scale)</span>
            <span>Resident</span>
            <span className="num">{fmtBytes(m.residentBytes)}</span>
            <span>Loaded in</span>
            <span className="num">{fmtMs(m.loadMs)}</span>
          </div>
        </>
      }
    >
      <span className="lab-facts num">
        {m.layers} layers × {width} = <b>{fmtInt(m.totalNeurons)}</b> neurons
      </span>
    </Hint>
  );
}

/** Lab + oMLX against the ceiling, live from the resource samples. */
function MemoryLine() {
  const sample = useStore((s) => s.samples[s.samples.length - 1]);
  const ceiling = useStore((s) => s.settings.memoryBudgetBytes || s.budget.budgetBytes);
  const lab = useLab((s) => s.lab);
  const rss = sample?.lab?.rssBytes;
  const onBench = lab?.model?.modelId ?? lab?.loadingModelId;
  // The ceiling counts the Lab's estimate for its model, as the load refusals do; resident pages drop under memory pressure
  const labBytes = lab?.support.find((s) => s.modelId === onBench)?.estimateBytes ?? rss ?? 0;
  const omlx = sample?.inference?.rssBytes ?? 0;
  const over = ceiling > 0 && labBytes + omlx > ceiling;
  return (
    <Hint tip={LAB_TIP.memory}>
      <span className="lab-memline num" title={`Lab ${exactBytes(labBytes)} counted${rss != null ? `, ${exactBytes(rss)} resident now` : ""}\noMLX ${exactBytes(omlx)}\nceiling ${exactBytes(ceiling)}`}>
        <span className="lab-membar" aria-hidden>
          <span className="omlx" style={{ width: `${Math.min(100, (omlx / (ceiling || 1)) * 100)}%` }} />
          <span className="lab" style={{ width: `${Math.min(100, (labBytes / (ceiling || 1)) * 100)}%` }} />
        </span>
        <span>
          <span className="dim">Lab</span> {fmtBytes(labBytes)} <span className="dim">+ oMLX</span> {fmtBytes(omlx)}{" "}
          <span className={over ? "err-text" : "dim"}>of {fmtBytes(ceiling)}</span>
        </span>
      </span>
    </Hint>
  );
}

const BUSY: Record<string, string> = { probe: "probing", find: "finding", generate: "writing", sweep: "sweeping", attribute: "tracing", neuron: "reading a neuron", session: "serving a session", examples: "writing examples", explore: "trying neurons" };

/** Cmd+Z and Cmd+Shift+Z, where you can see what they'd do. */
function UndoButtons() {
  const { undo, redo } = useUndoLabels();
  return (
    <span className="undo-btns">
      <button className="icon-btn sm" disabled={!undo} title={undo ? `Undo: ${undo} (Cmd+Z)` : "Nothing to undo"} aria-label="Undo" onClick={() => void runUndo()}>
        <Undo2 />
      </button>
      <button className="icon-btn sm" disabled={!redo} title={redo ? `Redo: ${redo} (Cmd+Shift+Z)` : "Nothing to redo"} aria-label="Redo" onClick={() => void runRedo()}>
        <Redo2 />
      </button>
    </span>
  );
}

export function SpecimenHead() {
  const lab = useLab((s) => s.lab);
  const onStrains = useLab((s) => s.tab === "strains");
  const target = useLab((s) => s.target);
  const loadSince = useLab((s) => s.loadSince);
  const strains = useLab((s) => s.strains);
  const st = lab?.status ?? "stopped";
  const onBench = lab?.model?.modelId ?? lab?.loadingModelId;
  const serving = lab?.servingStrains ?? [];
  const loading = st === "loading" || st === "starting";
  const swap = st === "ready" && !!target && target !== onBench;
  const servingNames = serving.map((id) => strains?.find((x) => x.id === id)?.name ?? id);

  return (
    <div className="view-head lab-head">
      <Microscope size={15} className="dim2" />
      <h1>Lab</h1>
      <SpecimenPicker />
      {lab && st !== "stopped" && (
        <span className={`lab-status ${st}`}>
          {loading ? (
            <Busy since={loadSince ?? Date.now()}>loading</Busy>
          ) : st === "ready" && lab.busy ? (
            <>
              <Loader2 size={12} className="spin" /> {BUSY[lab.busy] ?? lab.busy}
            </>
          ) : st === "ready" && target && target !== lab.model?.modelId ? (
            `${modelName(lab, lab.model?.modelId)} still loaded`
          ) : st === "ready" ? null : (
            st
          )}
        </span>
      )}
      {serving.length > 0 && (
        <Hint tip={LAB_TIP.strainUse}>
          <span className="dim2">In use by {servingNames.join(", ")}</span>
        </Hint>
      )}
      <span className="blk-spacer" />
      <UndoButtons />
      {swap ? (
        <button className="btn sm" disabled={serving.length > 0} title={serving.length ? "Strains are serving sessions: stop them first" : undefined} onClick={() => void loadSpecimen()}>
          Load {modelName(lab, target)}
        </button>
      ) : null}
      {(st === "stopped" || st === "error") && onStrains && (
        <button className="btn sm" onClick={() => useLab.setState({ tab: "find" })} >
          Load a model
        </button>
      )}
    </div>
  );
}

// ---------- empty bench ----------

function MemoryFit({ m }: { m: LabMemoryCheck }) {
  const models = useStore((s) => s.models);
  const freeing = useLab((s) => s.freeing);
  const held = m.omlx.reduce((a, x) => a + x.bytes, 0);
  const short = held + m.needBytes - m.ceilingBytes;
  const scale = Math.max(m.ceilingBytes, held + m.needBytes) || 1;
  const pct = (b: number) => `${(b / scale) * 100}%`;
  const name = (id: string) => models.find((x) => x.id === id)?.name ?? id;
  const busy = m.omlx.filter((x) => x.busy);
  const stillShort = short - m.freeableBytes;
  return (
    <div className={`memfit${m.fits ? " fits" : " short"}`}>
      <div className="memfit-head">
        <Term k="memory">Memory</Term>
        <span className="num">
          needs <b>{fmtBytes(m.needBytes)}</b>
          <span className="dim">, oMLX holds </span>
          {fmtBytes(held)}
          <span className="dim"> of the </span>
          {fmtBytes(m.ceilingBytes)}
          <span className="dim"> ceiling</span>
        </span>
        <span className={`fit ${m.fits ? "ok" : "err"}`}>{m.fits ? "fits" : `${fmtBytes(short)} short`}</span>
      </div>
      <div className="memfit-bar" role="img" aria-label={`oMLX ${fmtBytes(held)}, Lab needs ${fmtBytes(m.needBytes)}, ceiling ${fmtBytes(m.ceilingBytes)}`}>
        {m.omlx.map((x, i) => (
          <span
            key={x.modelId}
            className={`mseg omlx${x.busy ? " busy" : ""}`}
            style={{ left: pct(m.omlx.slice(0, i).reduce((a, y) => a + y.bytes, 0)), width: pct(x.bytes) }}
            title={`${name(x.modelId)} in oMLX: ${fmtBytes(x.bytes)}${x.busy ? `, used by ${x.busy}` : ", idle"}`}
          />
        ))}
        <span className="mseg need" style={{ left: pct(held), width: pct(m.needBytes) }} title={`Lab: ${fmtBytes(m.needBytes)}`} />
        <span className="ceil" style={{ left: pct(m.ceilingBytes) }} title={`Ceiling ${fmtBytes(m.ceilingBytes)}`} />
      </div>
      {m.omlx.length > 0 && (
        <ul className="memfit-list">
          {m.omlx.map((x) => (
            <li key={x.modelId}>
              <span className={`sw omlx${x.busy ? " busy" : ""}`} />
              <span className="truncate">{name(x.modelId)}</span>
              <span className="num dim">{fmtBytes(x.bytes)}</span>
              <span className={x.busy ? "warn-text truncate" : "dim2"}>{x.busy ? `can't free: used by ${x.busy}` : "idle in oMLX, can be freed"}</span>
            </li>
          ))}
          <li>
            <span className="sw need" />
            <span>Lab: this model</span>
            <span className="num dim">{fmtBytes(m.needBytes)}</span>
            <span />
          </li>
        </ul>
      )}
      {!m.fits && (
        <div className="memfit-act">
          {m.freeableBytes > 0 && (
            <Hint tip="Unloads oMLX models no running session or eval uses. They load again on their next request.">
              <button className="btn sm primary" disabled={freeing != null} onClick={() => void freeMemory()}>
                {freeing != null ? <Busy since={freeing}>Freeing</Busy> : <>Free {fmtBytes(m.freeableBytes)}</>}
              </button>
            </Hint>
          )}
          {stillShort > 0 && (
            <span className="dim2">
              {m.freeableBytes > 0 ? `Still ${fmtBytes(stillShort)} short after that: ` : ""}
              {busy.length ? `stop ${busy.map((b) => b.busy).join(", ")}, or ` : ""}
              <button className="cell-link" onClick={() => openView({ kind: "settings" })}>
                raise the ceiling in Settings
              </button>
            </span>
          )}
        </div>
      )}
    </div>
  );
}

/** No model loaded (or loading, or failed): the memory check, Load and the example. */
export function Bench() {
  const lab = useLab((s) => s.lab);
  const target = useLab((s) => s.target);
  const mem = useLab((s) => s.mem);
  const memBusy = useLab((s) => s.memBusy);
  const loadErr = useLab((s) => s.loadErr);
  const loadSince = useLab((s) => s.loadSince);
  const example = useLab((s) => s.example);
  const st = lab?.status ?? "stopped";
  const loading = st === "loading" || st === "starting";
  const name = modelName(lab, loading ? lab?.loadingModelId : target);
  const memFor = mem?.modelId === target ? mem : null;
  const sup = lab?.support.find((s) => s.modelId === target);
  const noModels = !!lab && lab.support.length === 0;
  const ex = useLab(() => exampleSpecimen());
  const exampleReady = !!lab?.support.find((s) => s.modelId === ex?.modelId)?.supported;
  return (
    <div className="lab-bench">
      <div className="bench-card">
        <h2>{loading ? `Loading ${name}` : st === "error" ? "The Lab stopped" : noModels ? "No models yet" : "No model loaded"}</h2>
        {st === "error" && lab?.detail && <ErrLine err={{ error: lab.detail }} />}
        {loading ? (
          <div className="bench-loading dim2">
            <Busy since={loadSince ?? Date.now()}>Loading weights and calibrating doses</Busy>
          </div>
        ) : null}
        {!loading && target && sup?.supported && (memFor ? <MemoryFit m={memFor} /> : memBusy ? <div className="dim2 memfit">Checking memory…</div> : null)}
        {loadErr && !loading && <ErrLine err={loadErr} />}
        {!loading && noModels && <ModelSuggestions limit={1} />}
        {!loading && !noModels && (
          <div className="bench-actions">
            <button className="btn primary" disabled={!target || !sup?.supported || (memFor ? !memFor.fits : false) || example != null} onClick={() => void loadSpecimen()}>
              Load {name}
            </button>
            {!memFor && target && sup?.supported && (
              <button className="btn ghost" onClick={() => void checkMemory()}>
                Check memory
              </button>
            )}
            <span className="blk-spacer" />
            {!exampleReady && <GetExampleModel />}
            {exampleReady && (
              <button className="btn" disabled={example != null} onClick={() => void runExample()} title={`Loads ${modelName(lab, ex?.modelId)} and runs ${ex?.name}`}>
                {example ? <Busy since={example.since}>{example.step}</Busy> : <><Sparkles /> Try the example</>}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
