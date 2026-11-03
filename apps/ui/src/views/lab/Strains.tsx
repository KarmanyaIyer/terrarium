import { useState, type KeyboardEvent } from "react";
import { FlaskConical, MessageSquare, Pencil, SlidersHorizontal, Trash2, Upload } from "lucide-react";
import type { LabStrain, LabStrainSettings } from "@terrarium/shared";
import { chatWithStrain, deleteStrain, importStrain, knownVectors, loadStrainIntoMix, saveStrain, strainsInEvals, updateStrain, useLab } from "../../state/lab";
import { format, isVector, parse, vectorRepeat } from "../../lib/recipe";
import { RecipeTable } from "./RecipeTable";
import { CopyButton, Dialog, Hint, Time } from "../../components/ui";
import { LAB_TIP } from "../../lib/labExplain";

/** Lines starting with # are comments, so "Export all" text pastes back in. */
const stripComments = (s: string) =>
  s
    .split("\n")
    .filter((l) => !l.trim().startsWith("#"))
    .join("\n");

function exportAll(strains: LabStrain[], name: (id: string) => string): string {
  return strains.map((s) => [`# ${s.name} (${name(s.baseModelId)})`, ...(s.notes ? s.notes.split("\n").map((l) => `# ${l}`) : []), format(s.pushes)].join("\n")).join("\n\n");
}

export function Strains() {
  const strains = useLab((s) => s.strains);
  const support = useLab((s) => s.lab?.support);
  const serving = useLab((s) => s.lab?.servingStrains);
  const loaded = useLab((s) => (s.lab?.status === "ready" ? s.lab.model?.modelId : undefined));
  const name = (id: string) => support?.find((x) => x.modelId === id)?.name ?? id;
  return (
    <div className="strains lab-scroll">
      <div className="strains-bar">
        <ImportStrain />
        {!!strains?.length && <CopyButton text={() => exportAll(strains, name)} label="Export all" />}
      </div>
      {strains == null && <div className="lab-empty dim2">Loading strains</div>}
      {strains?.length === 0 && (
        <div className="lab-empty">
          No strains yet.
        </div>
      )}
      {!!strains?.length && (
        <div className="strain-list">
          {strains.map((st) => (
            <StrainRow key={st.id} st={st} base={name(st.baseModelId)} serving={!!serving?.includes(st.id)} onBench={loaded === st.baseModelId} />
          ))}
        </div>
      )}
    </div>
  );
}

/** How a strain replies, in a line. */
const settingsLine = (s: LabStrainSettings) => `Temperature ${s.temperature}, repeat penalty ${s.repeat ?? "off"}, max tokens ${s.maxTokens ?? "none"}`;

function StrainRow({ st, base, serving, onBench }: { st: LabStrain; base: string; serving: boolean; onBench: boolean }) {
  const [edit, setEdit] = useState(false);
  const [nm, setNm] = useState(st.name);
  const [notes, setNotes] = useState(st.notes);
  const cancel = () => {
    setNm(st.name);
    setNotes(st.notes);
    setEdit(false);
  };
  const save = async () => {
    if (nm.trim() && (await updateStrain(st.id, { name: nm.trim(), notes: notes.trim() }))) setEdit(false);
  };
  // Escape cancels from either field or a button in the card; Enter in the name and Cmd+Enter anywhere save
  const editKeys = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!edit) return;
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      cancel();
    } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey || (e.target as HTMLElement).tagName === "INPUT")) {
      e.preventDefault();
      void save();
    }
  };
  return (
    <div className="strain-card" onKeyDown={editKeys}>
      <div className="strain-head">
        {edit ? (
          <input className="input strain-name-in" value={nm} onChange={(e) => setNm(e.target.value)} aria-label="Strain name" autoFocus />
        ) : (
          <b className="strain-name">{st.name}</b>
        )}
        <span className="dim2">{base}</span>
        {serving && <span className="dim2" title="A running chat or eval uses this strain">In use</span>}
        <span className="blk-spacer" />
        <span className="dim2 num">
          <Time ts={st.updatedAt} />
        </span>
      </div>
      <RecipeTable pushes={st.pushes} modelId={st.baseModelId} />
      <div className="dim2 strain-settings num">{settingsLine(st.settings)}</div>
      {edit ? (
        <textarea className="textarea strain-notes-in" rows={3} value={notes} placeholder="Notes" onChange={(e) => setNotes(e.target.value)} aria-label="Notes" />
      ) : (
        st.notes && <div className="strain-notes">{st.notes}</div>
      )}
      <div className="strain-acts">
        {edit ? (
          <>
            <button
              className="btn sm primary"
              disabled={!nm.trim()}
              onClick={() => void save()}
            >
              Save
            </button>
            <button className="btn sm ghost" onClick={cancel}>
              Cancel
            </button>
          </>
        ) : (
          <>
            <button className="btn sm" onClick={() => void chatWithStrain(st)} title={onBench ? undefined : `The Lab loads ${base} for it`}>
              <MessageSquare /> Open a chat
            </button>
            <button className="btn sm" onClick={strainsInEvals} title="Evals list strains under Lab strains">
              Use in evals
            </button>
            <button className="btn sm ghost" onClick={() => void loadStrainIntoMix(st)} title={onBench ? "Replace the mix with this recipe" : `Replace the mix with this recipe. The bench has another model loaded; ids are per model.`}>
              <SlidersHorizontal /> Load into mix
            </button>
            <button className="btn sm ghost" onClick={() => setEdit(true)}>
              <Pencil /> Edit
            </button>
            <button className="btn sm ghost" disabled={serving} title={serving ? "In use by a running chat or eval" : "Cmd+Z brings it back"} onClick={() => void deleteStrain(st.id)}>
              <Trash2 /> Delete
            </button>
          </>
        )}
      </div>
    </div>
  );
}

function ImportStrain() {
  const support = useLab((s) => s.lab?.support);
  const loaded = useLab((s) => s.lab?.model?.modelId);
  const ok = support?.filter((x) => x.supported) ?? [];
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [nm, setNm] = useState("");
  const [base, setBase] = useState("");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const p = parse(stripComments(text), knownVectors());
  const baseId = base || loaded || ok[0]?.modelId || "";
  const can = p.pushes.length > 0 && !!nm.trim() && !!baseId && !busy;
  const submit = async () => {
    if (!can) return;
    setBusy(true);
    const st = await importStrain(nm.trim(), baseId, p.pushes, notes.trim());
    setBusy(false);
    if (st) {
      setOpen(false);
      setText("");
      setNm("");
      setNotes("");
    }
  };
  return (
    <>
      <button className="btn sm" onClick={() => setOpen(true)}>
        <Upload /> Import
      </button>
      {open && (
        <Dialog
          title="Import a strain"
          onClose={() => setOpen(false)}
          onSubmit={() => void submit()}
          foot={
            <>
              <span className="blk-spacer" />
              <button type="button" className="btn ghost" onClick={() => setOpen(false)}>
                Cancel
              </button>
              <button className="btn primary" disabled={!can}>
                Import strain
              </button>
            </>
          }
        >
          <label className="lab-field wide">
            <Hint tip={LAB_TIP.recipe}>
              <span className="hint-text">Recipe</span>
            </Hint>
            <textarea className="textarea mono" rows={3} autoFocus spellCheck={false} value={text} placeholder="L22N2742+0.8 L8N344=25" onChange={(e) => setText(e.target.value)} />
            {text.trim() && (
              <span className="dim2 num">
                {p.pushes.length} push{p.pushes.length === 1 ? "" : "es"}
                {p.errors.map((er, i) => (
                  <span key={i} className="warn-text recipe-err">
                    {er}
                  </span>
                ))}
              </span>
            )}
          </label>
          <label className="lab-field wide">
            <span>Base model</span>
            <select className="input select" value={baseId} onChange={(e) => setBase(e.target.value)}>
              {ok.map((x) => (
                <option key={x.modelId} value={x.modelId}>
                  {x.name}
                </option>
              ))}
            </select>
          </label>
          <label className="lab-field wide">
            <span>Name</span>
            <input className="input" value={nm} onChange={(e) => setNm(e.target.value)} />
          </label>
          <label className="lab-field wide">
            <span>Notes</span>
            <textarea className="textarea" rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} />
          </label>
        </Dialog>
      )}
    </>
  );
}

/** Saving a recipe as a strain, from wherever the Save as strain button was. */
export function SaveStrainDialog() {
  const dlg = useLab((s) => s.strainDialog);
  const base = useLab((s) => s.lab?.model);
  const [name, setName] = useState("");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  if (!dlg) return null;
  const close = () => {
    useLab.setState({ strainDialog: null });
    setName("");
    setNotes("");
  };
  const can = !!name.trim() && !busy && !!base;
  const submit = async () => {
    if (!can) return;
    setBusy(true);
    const st = await saveStrain(name.trim(), notes.trim(), dlg.pushes, dlg.settings);
    setBusy(false);
    if (st) close();
  };
  return (
    <Dialog
      title="Save as strain"
      onClose={close}
      onSubmit={() => void submit()}
      foot={
        <>
          <span className="blk-spacer" />
          <button type="button" className="btn ghost" onClick={close}>
            Cancel
          </button>
          <button className="btn primary" disabled={!can}>
            <FlaskConical /> Save strain
          </button>
        </>
      }
    >
      <div className="lab-field wide">
        <span>Recipe on {base?.name}</span>
        <RecipeTable pushes={dlg.pushes} modelId={base?.modelId ?? ""} />
        <span className="dim2 num">{settingsLine(dlg.settings)}</span>
        {dlg.pushes.some(isVector) && dlg.settings.repeat !== vectorRepeat(base?.modelId ?? "") && <span className="warn-text">Tested with repeat penalty {vectorRepeat(base?.modelId ?? "") ?? "off"}. This saves {dlg.settings.repeat ?? "off"}.</span>}
      </div>
      <label className="lab-field wide">
        <span>Name</span>
        <input className="input" autoFocus value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <label className="lab-field wide">
        <span>Notes</span>
        <textarea className="textarea strain-notes-in" rows={5} value={notes} onChange={(e) => setNotes(e.target.value)} />
      </label>
    </Dialog>
  );
}
