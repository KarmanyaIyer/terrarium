import { saveModelDefaults } from "../state/appUndo";
import { Fragment, useMemo, useState } from "react";
import { Boxes, ChevronRight, Loader2, MessageSquare, Plus, Trash2 } from "lucide-react";
import type { ModelInfo, UpdateModelRequest } from "@terrarium/shared";
import { act, openSession, openView, toast, useStore } from "../state/store";
import { useLab } from "../state/lab";
import { CONTEXT_CHOICES, estimate } from "../lib/memory";
import { exactBytes, fmtBytes, fmtCtx } from "../lib/format";
import { ConfirmButton, Hint, Segmented } from "../components/ui";
import { fitLabel, MemBar, memTitle } from "../components/ModelPicker";
import { ServerButton } from "../components/TopBar";
import { AddModelSheet } from "./AddModelSheet";
import { DownloadRow, ModelSuggestions } from "./ModelSuggestions";
import { newSession } from "../lib/actions";

const OUTPUT_CHOICES = [512, 1024, 2048, 4096, 8192, 16384];

const THINKING: Record<ModelInfo["thinking"], { label: string; tip: string }> = {
  "default-on": { label: "on by default", tip: "Thinks before answering unless a session turns it off" },
  optional: { label: "optional", tip: "Thinks only when a session turns thinking on" },
  none: { label: "none", tip: "No thinking mode" },
};

/** "9.4B" -> 9.4, "E2B" -> 2; unknown sizes sort last. */
const paramsNum = (p: string) => Number(/([\d.]+)/.exec(p)?.[1] ?? Infinity);

export default function ModelsView() {
  const allModels = useStore((s) => s.models);
  // Lab strains are mixes on top of these models, listed on the Lab page
  const models = useMemo(() => allModels.filter((m) => !m.strain), [allModels]);
  const strainN = allModels.length - models.length;
  const inf = useStore((s) => s.inference);
  const budget = useStore((s) => s.budget);
  const samples = useStore((s) => s.samples);
  const sessions = useStore((s) => s.sessions);
  const downloads = useStore((s) => s.downloads);
  const [open, setOpen] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [pending, setPending] = useState<Record<string, "load" | "unload">>({});
  const sample = samples[samples.length - 1];
  const free = sample?.system.freeBytes;
  const ready = inf.status === "ready";

  const rows = useMemo(
    () =>
      [...models]
        .sort((a, b) => a.family.localeCompare(b.family) || paramsNum(a.params) - paramsNum(b.params) || a.id.localeCompare(b.id))
        .map((m) => {
          const e = estimate(m, m.defaultContext, sample, budget, models);
          return { m, e, fit: fitLabel(e, free) };
        }),
    [models, sample, budget, free],
  );
  const scaleMax = Math.max(budget.budgetBytes, ...rows.map((r) => r.e.otherLoaded + r.e.bytes)) || 1;
  const loaded = models.filter((m) => m.loaded);
  const resident = loaded.reduce((a, m) => a + (m.residentBytes ?? 0), 0);
  // Failed downloads stay until dismissed; canceled ones go at once.
  const [dismissed, setDismissed] = useState<Set<string>>(() => new Set());
  const active = Object.values(downloads)
    .filter((d) => d.status === "running" || (d.status === "error" && !dismissed.has(d.id)))
    .sort((a, b) => b.startedAt - a.startedAt);

  const usedBy = (id: string) => Object.values(sessions).filter((s) => s.modelId === id && !s.evalRunId);

  const run = async (m: ModelInfo, kind: "load" | "unload") => {
    setPending((p) => ({ ...p, [m.id]: kind }));
    await act(kind === "load" ? `Load ${m.name}` : `Unload ${m.name}`, (b) =>
      kind === "load" ? b.loadModel(m.id, { context: m.defaultContext }) : b.unloadModel(m.id),
    );
    setPending((p) => {
      const n = { ...p };
      delete n[m.id];
      return n;
    });
  };

  return (
    <div className="models-view">
      <div className="view-head">
        <Boxes size={15} />
        <h1>Models</h1>
        {models.length > 0 && inf.status !== "stopped" && (
          <>
            <span className={`dot ${ready ? "ready" : inf.status === "error" ? "error" : ""}`} />
            <span title={inf.version ? `oMLX ${inf.version}` : undefined}>
              Model server <span className="dim">{inf.status}</span>
            </span>
            <ServerButton small />
          </>
        )}
        <span className="blk-spacer" />
        {loaded.length > 0 && (
          <span className="dim num nowrap">
            {loaded.length} loaded, {fmtBytes(resident)}
          </span>
        )}
        <Hint className="vh-ceiling" tip={`Most memory oMLX and the Lab may use together, out of ${fmtBytes(budget.totalBytes)} RAM. Change it in Settings.`}>
          <button className="cell-link num nowrap" onClick={() => openView({ kind: "settings" })}>
            <span className="dim">Ceiling</span> {fmtBytes(budget.budgetBytes)}
          </button>
        </Hint>
        <button className="btn sm" onClick={() => setAdding(true)}>
          <Plus /> Add model
        </button>
      </div>
      {active.length > 0 && (
        <div className="dl-strip">
          {active.map((d) => (
            <DownloadRow key={d.id} d={d} onDismiss={() => setDismissed((x) => new Set(x).add(d.id))} />
          ))}
        </div>
      )}
      <div className="table-wrap">
        {models.length > 0 && <table className="table models-table">
          <thead>
            <tr>
              <th className="tw-col" />
              <th>Name</th>
              <th className="r">Size</th>
              <th className="r">
                <Hint tip="Context a new session starts with, of the longest the model supports. Click a row to change it.">Context</Hint>
              </th>
              <th>
                <Hint tip="Weights + context x KV bytes per token + fixed state + runtime, at the default context. Loaded models show what oMLX reports.">
                  Memory
                </Hint>
              </th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map(({ m, e, fit }) => {
              const isOpen = open === m.id;
              const p = pending[m.id];
              const users = usedBy(m.id);
              const busyUsers = users.filter((s) => s.status === "running");
              const toggle = () => setOpen(isOpen ? null : m.id);
              return (
                <Fragment key={m.id}>
                  <tr
                    className={`click${isOpen ? " open" : ""}${m.loaded ? " loaded" : ""}`}
                    onClick={toggle}
                    onKeyDown={(ev) => {
                      if (ev.target === ev.currentTarget && (ev.key === "Enter" || ev.key === " ")) {
                        ev.preventDefault();
                        toggle();
                      }
                    }}
                    tabIndex={0}
                    aria-expanded={isOpen}
                  >
                    <td className="tw-col">
                      <ChevronRight size={12} className={`tw${isOpen ? " open" : ""}`} />
                    </td>
                    <td className="mdl-name">
                      <div className="mdl-title">
                        <span className="strong">{m.name}</span>
                        {p ? (
                          <span className="chip">
                            <Loader2 size={10} className="spin" /> {p === "load" ? "loading" : "unloading"}
                          </span>
                        ) : m.loaded ? (
                          <span className="chip ok" title={`Loaded at ${fmtCtx(m.loadedContext)} context`}>
                            loaded {fmtCtx(m.loadedContext)}
                          </span>
                        ) : null}
                      </div>
                      <div className="mono dim2 model-id truncate" title={`${m.family}: ${m.id}`}>
                        {m.id}
                      </div>
                    </td>
                    <td className="r num" title={`${m.params} parameters, ${m.quant}, ${exactBytes(m.diskBytes)}`}>
                      {fmtBytes(m.diskBytes)}
                    </td>
                    <td className="r num nowrap">
                      {fmtCtx(m.defaultContext)} <span className="dim">of {fmtCtx(m.nativeContext)}</span>
                    </td>
                    <td>
                      {m.loaded ? (
                        <span className="num" title="Resident memory reported by oMLX">
                          {fmtBytes(m.residentBytes)} <span className="dim">resident</span>
                        </span>
                      ) : (
                        <div className="est-cell" title={memTitle(e, budget.budgetBytes)}>
                          <MemBar e={e} cls={fit.cls} scaleMax={scaleMax} budget={budget.budgetBytes} />
                          <span className="num">{fmtBytes(e.bytes)}</span>
                          <span className={`fit ${fit.cls}`}>{fit.text}</span>
                        </div>
                      )}
                    </td>
                    <td className="r nowrap mdl-actions" onClick={(ev) => ev.stopPropagation()}>
                      <button
                        className="btn sm ghost"
                        aria-label={`New chat with ${m.name}`}
                        title={`New chat with ${m.name}: no enclosure, no tools. Loads it on the first message.`}
                        onClick={() => void newSession(null, m.id)}
                      >
                        <MessageSquare />
                      </button>
                      {m.loaded ? (
                        busyUsers.length ? (
                          <ConfirmButton
                            small
                            label="Unload"
                            confirmLabel={`Unload, stops ${busyUsers.length} running`}
                            disabled={!!p}
                            onConfirm={() => run(m, "unload")}
                          />
                        ) : (
                          <button className="btn sm" disabled={!!p} onClick={() => void run(m, "unload")}>
                            Unload
                          </button>
                        )
                      ) : ready && fit.cls !== "ok" ? (
                        <ConfirmButton
                          small
                          label="Load"
                          title={`Load at ${fmtCtx(m.defaultContext)} context`}
                          confirmLabel={fit.cls === "err" ? `Load, ${fit.text}` : "Load, over budget"}
                          disabled={!!p}
                          onConfirm={() => run(m, "load")}
                        />
                      ) : (
                        <button
                          className="btn sm"
                          disabled={!!p}
                          title={ready ? `Load at ${fmtCtx(m.defaultContext)} context` : `Starts oMLX, then loads at ${fmtCtx(m.defaultContext)} context`}
                          onClick={() => void run(m, "load")}
                        >
                          Load
                        </button>
                      )}
                    </td>
                  </tr>
                  {isOpen && (
                    <tr className="detail-row">
                      <td />
                      <td colSpan={5}>
                        <ModelFacts m={m} />
                        <ModelDefaults m={m} users={users.map((s) => ({ id: s.id, title: s.title, running: s.status === "running" }))} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>}
        {!models.length && (
          <div className="models-empty">
            <h2 className="home-title">Download a first model</h2>
            <ModelSuggestions onOther={() => setAdding(true)} />
          </div>
        )}
        {strainN > 0 && (
          <div className="models-strains dim2">
            {strainN} Lab {strainN === 1 ? "strain" : "strains"} not listed: each is one of these models with a neuron mix.{" "}
            <button
              className="cell-link"
              onClick={() => {
                useLab.setState({ tab: "strains" });
                openView({ kind: "lab" });
              }}
            >
              Open Lab strains
            </button>
          </div>
        )}
      </div>
      {adding && <AddModelSheet onClose={() => setAdding(false)} />}
    </div>
  );
}

/** What the table leaves out: fixed facts about the model. */
function ModelFacts({ m }: { m: ModelInfo }) {
  return (
    <dl className="mdl-facts">
      <dt>Family</dt>
      <dd>{m.family}</dd>
      <dt>Params</dt>
      <dd className="num">{m.params}</dd>
      <dt>Quant</dt>
      <dd>{m.quant}</dd>
      <dt>
        <Hint tip="Format the model's chat template uses for tool calls">Tool calls</Hint>
      </dt>
      <dd className="mono">{m.toolFormat}</dd>
      <dt>Thinking</dt>
      <dd title={THINKING[m.thinking].tip}>{THINKING[m.thinking].label}</dd>
      <dt>
        <Hint tip="max_tokens sent with each request">Output</Hint>
      </dt>
      <dd className="num">{fmtCtx(m.defaultMaxOutput)}</dd>
    </dl>
  );
}

function ModelDefaults({ m, users }: { m: ModelInfo; users: { id: string; title: string; running: boolean }[] }) {
  const [ctx, setCtx] = useState(m.defaultContext);
  const [out, setOut] = useState(m.defaultMaxOutput);
  const [temp, setTemp] = useState(String(m.sampling.temperature));
  const [topP, setTopP] = useState(String(m.sampling.topP));
  const [topK, setTopK] = useState(m.sampling.topK != null ? String(m.sampling.topK) : "");
  const [pres, setPres] = useState(m.sampling.presencePenalty != null ? String(m.sampling.presencePenalty) : "");
  const [saving, setSaving] = useState(false);

  const ctxOpts = CONTEXT_CHOICES.filter((c) => c <= m.nativeContext);
  const outOpts = OUTPUT_CHOICES.filter((c) => c <= ctx / 2);
  const num = (s: string) => (s.trim() === "" ? undefined : Number(s));
  const bad = [temp, topP, topK, pres].some((s) => s.trim() !== "" && !Number.isFinite(Number(s)));
  const dirty =
    ctx !== m.defaultContext ||
    out !== m.defaultMaxOutput ||
    num(temp) !== m.sampling.temperature ||
    num(topP) !== m.sampling.topP ||
    num(topK) !== m.sampling.topK ||
    num(pres) !== m.sampling.presencePenalty;
  const running = users.filter((u) => u.running).length;

  const save = async () => {
    const req: UpdateModelRequest = {
      defaultContext: ctx,
      defaultMaxOutput: Math.min(out, ctx / 2),
      sampling: { temperature: num(temp) ?? m.sampling.temperature, topP: num(topP) ?? m.sampling.topP, topK: num(topK), presencePenalty: num(pres) },
    };
    setSaving(true);
    await saveModelDefaults(m, req);
    setSaving(false);
  };

  return (
    <div className="model-defaults">
      <div className="md-grid">
        <span>Context</span>
        <Segmented
          small
          value={String(ctx)}
          onChange={(v) => {
            const c = Number(v);
            setCtx(c);
            if (out > c / 2) setOut(OUTPUT_CHOICES.filter((x) => x <= c / 2).pop() ?? 512);
          }}
          options={ctxOpts.map((c) => ({ value: String(c), label: fmtCtx(c) }))}
        />
        <Hint tip="max_tokens sent with each request; thinking tokens count against it">
          <span>Output cap</span>
        </Hint>
        <Segmented small value={String(out)} onChange={(v) => setOut(Number(v))} options={outOpts.map((c) => ({ value: String(c), label: fmtCtx(c) }))} />
        <Hint tip="Sent with every request (MLX ignores generation_config.json). Defaults follow each family's model card.">
          <span>Sampling</span>
        </Hint>
        <div className="md-sampling">
          <label>
            temperature <input className="input num" value={temp} onChange={(e) => setTemp(e.target.value)} />
          </label>
          <label>
            top_p <input className="input num" value={topP} onChange={(e) => setTopP(e.target.value)} />
          </label>
          <label>
            top_k <input className="input num" value={topK} placeholder="-" onChange={(e) => setTopK(e.target.value)} />
          </label>
          <label title="presence_penalty">
            presence <input className="input num" value={pres} placeholder="-" onChange={(e) => setPres(e.target.value)} />
          </label>
        </div>
        <span>Sessions</span>
        <div className="md-users">
          {users.length ? (
            users.map((u) => (
              <button key={u.id} className="cell-link" onClick={() => openSession(u.id)}>
                {u.running && <span className="dot live" />} {u.title}
              </button>
            ))
          ) : (
            <span className="dim2">none</span>
          )}
        </div>
      </div>
      <div className="md-actions">
        <button className="btn sm primary" disabled={!dirty || bad || saving} onClick={() => void save()}>
          {saving && <Loader2 className="spin" />} Save defaults
        </button>
        {bad && <span className="err-text">Sampling values must be numbers</span>}
        <span className="blk-spacer" />
        <ConfirmButton
          small
          className="ghost"
          icon={<Trash2 />}
          label="Remove model"
          disabled={running > 0 || m.loaded}
          title={running ? "Stop its running sessions first" : m.loaded ? "Unload it first" : `Deletes models/${m.id}`}
          confirmLabel={`Delete models/${m.id}, frees ${fmtBytes(m.diskBytes)}`}
          onConfirm={async () => {
            const r = await act(`Remove ${m.name}`, (b) => b.removeModel(m.id));
            if (r) toast(`Removed ${m.name}, freed ${fmtBytes(r.freedBytes)}`, "info");
          }}
        />
      </div>
    </div>
  );
}
