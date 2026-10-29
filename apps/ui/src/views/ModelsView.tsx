import { Fragment, useMemo, useState } from "react";
import { ChevronRight, Loader2 } from "lucide-react";
import type { ModelInfo, UpdateModelRequest } from "@terrarium/shared";
import { act, openSession, useStore } from "../state/store";
import { CONTEXT_CHOICES, estimate } from "../lib/memory";
import { exactBytes, fmtBytes, fmtCtx } from "../lib/format";
import { ConfirmButton, Segmented } from "../components/ui";
import { fitLabel, MemBar, memTitle } from "../components/ModelPicker";
import { ServerButton } from "../components/TopBar";

const OUTPUT_CHOICES = [512, 1024, 2048, 4096, 8192, 16384];

export default function ModelsView() {
  const models = useStore((s) => s.models);
  const inf = useStore((s) => s.inference);
  const budget = useStore((s) => s.budget);
  const samples = useStore((s) => s.samples);
  const sessions = useStore((s) => s.sessions);
  const [open, setOpen] = useState<string | null>(null);
  const [pending, setPending] = useState<Record<string, "load" | "unload">>({});
  const sample = samples[samples.length - 1];
  const free = sample?.system.freeBytes;
  const ready = inf.status === "ready";

  const rows = useMemo(
    () =>
      models.map((m) => {
        const e = estimate(m, m.defaultContext, sample, budget, models);
        return { m, e, fit: fitLabel(e, free) };
      }),
    [models, sample, budget, free],
  );
  const scaleMax = Math.max(budget.budgetBytes, ...rows.map((r) => r.e.otherLoaded + r.e.bytes)) || 1;
  const loaded = models.filter((m) => m.loaded);
  const resident = loaded.reduce((a, m) => a + (m.residentBytes ?? 0), 0);

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
        <h1>Models</h1>
        <span className={`dot ${ready ? "ready" : inf.status === "error" ? "error" : ""}`} />
        <span>
          oMLX <span className="dim">{inf.status}</span>
          {inf.version ? <span className="dim2"> {inf.version}</span> : null}
        </span>
        <ServerButton small />
        <span className="blk-spacer" />
        <span className="dim num">
          {loaded.length} loaded, {fmtBytes(resident)} resident
        </span>
        <span className="num" title="Memory budget for models, set in settings; total physical RAM in parentheses">
          <span className="dim">Budget</span> {fmtBytes(budget.budgetBytes)} <span className="dim">of {fmtBytes(budget.totalBytes)}</span>
        </span>
      </div>
      <div className="table-wrap">
        <table className="table models-table">
          <thead>
            <tr>
              <th className="tw-col" />
              <th>Model</th>
              <th className="r">Params</th>
              <th>Quant</th>
              <th className="r">Disk</th>
              <th title="Tool-call format the chat template emits">Tool format</th>
              <th>Thinking</th>
              <th className="r" title="Native context length">Native</th>
              <th className="r" title="Default context window for new sessions">Context</th>
              <th className="r" title="Default output cap (max_tokens)">Output</th>
              <th title="weights + context x KV bytes/token + fixed state + 1 GiB runtime, at the default context">Memory at default</th>
              <th>State</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map(({ m, e, fit }) => {
              const isOpen = open === m.id;
              const p = pending[m.id];
              const users = usedBy(m.id);
              const busyUsers = users.filter((s) => s.status === "running");
              return (
                <Fragment key={m.id}>
                  <tr
                    className={`click${isOpen ? " open" : ""}`}
                    onClick={() => setOpen(isOpen ? null : m.id)}
                    onKeyDown={(ev) => {
                      if (ev.target === ev.currentTarget && (ev.key === "Enter" || ev.key === " ")) {
                        ev.preventDefault();
                        setOpen(isOpen ? null : m.id);
                      }
                    }}
                    tabIndex={0}
                    aria-expanded={isOpen}
                  >
                    <td className="tw-col">
                      <ChevronRight size={12} className={`tw${isOpen ? " open" : ""}`} />
                    </td>
                    <td>
                      <div className="strong">{m.name}</div>
                      <div className="mono dim2 model-id truncate" title={m.id}>
                        {m.id}
                      </div>
                    </td>
                    <td className="r num">{m.params}</td>
                    <td>{m.quant}</td>
                    <td className="r num" title={exactBytes(m.diskBytes)}>
                      {fmtBytes(m.diskBytes)}
                    </td>
                    <td className="mono dim">{m.toolFormat}</td>
                    <td className="dim">{m.thinking}</td>
                    <td className="r num dim">{fmtCtx(m.nativeContext)}</td>
                    <td className="r num">{fmtCtx(m.defaultContext)}</td>
                    <td className="r num">{fmtCtx(m.defaultMaxOutput)}</td>
                    <td>
                      <div className="est-cell" title={memTitle(e, budget.budgetBytes)}>
                        <MemBar e={e} cls={m.loaded ? "ok" : fit.cls} scaleMax={scaleMax} budget={budget.budgetBytes} />
                        <span className="num">{fmtBytes(e.bytes)}</span>
                        {!m.loaded && <span className={`fit ${fit.cls}`}>{fit.text}</span>}
                      </div>
                    </td>
                    <td className="nowrap">
                      {p ? (
                        <span className="dim">
                          <Loader2 size={12} className="spin" /> {p === "load" ? "Loading" : "Unloading"}
                        </span>
                      ) : m.loaded ? (
                        <span>
                          <span className="dot ready" /> {fmtCtx(m.loadedContext)} <span className="dim num">{fmtBytes(m.residentBytes)}</span>
                        </span>
                      ) : (
                        <span className="dim2">not loaded</span>
                      )}
                    </td>
                    <td className="r nowrap" onClick={(ev) => ev.stopPropagation()}>
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
                          disabled={!!p || !ready}
                          title={ready ? `Load at ${fmtCtx(m.defaultContext)} context` : "Start the oMLX server first"}
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
                      <td colSpan={12}>
                        <ModelDefaults m={m} users={users.map((s) => ({ id: s.id, title: s.title, running: s.status === "running" }))} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
        {!models.length && <div className="empty">No models found in the oMLX model directory</div>}
      </div>
    </div>
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

  const save = async () => {
    const req: UpdateModelRequest = {
      defaultContext: ctx,
      defaultMaxOutput: Math.min(out, ctx / 2),
      sampling: { temperature: num(temp) ?? m.sampling.temperature, topP: num(topP) ?? m.sampling.topP, topK: num(topK), presencePenalty: num(pres) },
    };
    setSaving(true);
    const r = await act("Save model defaults", (b) => b.updateModel(m.id, req));
    setSaving(false);
    if (r) useStore.setState((s) => ({ models: s.models.map((x) => (x.id === r.id ? r : x)) }));
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
        <span title="max_tokens sent with each request">Output cap</span>
        <Segmented small value={String(out)} onChange={(v) => setOut(Number(v))} options={outOpts.map((c) => ({ value: String(c), label: fmtCtx(c) }))} />
        <span>Sampling</span>
        <div className="md-sampling">
          <label>
            temperature <input className="input num" value={temp} onChange={(e) => setTemp(e.target.value)} />
          </label>
          <label>
            top_p <input className="input num" value={topP} onChange={(e) => setTopP(e.target.value)} />
          </label>
          <label>
            top_k <input className="input num" value={topK} placeholder="–" onChange={(e) => setTopK(e.target.value)} />
          </label>
          <label title="presence_penalty">
            presence <input className="input num" value={pres} placeholder="–" onChange={(e) => setPres(e.target.value)} />
          </label>
        </div>
        <span>Model</span>
        <div className="md-facts num">
          <span>
            <span className="dim">quant</span> {m.quant}
          </span>
          <span>
            <span className="dim">disk</span> {fmtBytes(m.diskBytes)}
          </span>
          <span>
            <span className="dim">tool calls</span> <span className="mono">{m.toolFormat}</span>
          </span>
          <span>
            <span className="dim">thinking</span> {m.thinking}
          </span>
          <span>
            <span className="dim">native context</span> {fmtCtx(m.nativeContext)}
          </span>
        </div>
        <span>Sessions</span>
        <div className="md-users">
          {users.length
            ? users.map((u) => (
                <button key={u.id} className="cell-link" onClick={() => openSession(u.id)}>
                  {u.running && <span className="dot live" />} {u.title}
                </button>
              ))
            : <span className="dim2">none</span>}
        </div>
      </div>
      <div className="md-actions">
        <button className="btn sm primary" disabled={!dirty || bad || saving} onClick={() => void save()}>
          {saving && <Loader2 className="spin" />} Save defaults
        </button>
        {bad && <span className="err-text">Sampling values must be numbers</span>}
      </div>
    </div>
  );
}
