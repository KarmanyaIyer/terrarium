import { useMemo } from "react";
import { Check, ChevronDown } from "lucide-react";
import type { ModelInfo, SessionSummary } from "@terrarium/shared";
import { act, openView, useStore } from "../state/store";
import { CONTEXT_CHOICES, estimate, type Estimate } from "../lib/memory";
import { fmtBytes, fmtCtx, fmtInt } from "../lib/format";
import { Popover, usePop } from "./ui";

const OUTPUT_CHOICES = [512, 1024, 2048, 4096, 8192, 16384];

/** Budget bar: other loaded models (gray), then this model's estimate, against the budget tick. */
export function MemBar({ e, cls, scaleMax, budget }: { e: Estimate; cls: string; scaleMax: number; budget: number }) {
  const pct = (b: number) => `${(b / scaleMax) * 100}%`;
  return (
    <span className="mp-bar">
      {e.otherLoaded > 0 && <span className="mp-base" style={{ width: pct(e.otherLoaded) }} />}
      <span className={`mp-fill ${cls}`} style={{ left: pct(e.otherLoaded), width: pct(e.bytes) }} />
      {budget > 0 && <span className="mp-budget" style={{ left: pct(budget) }} />}
    </span>
  );
}

export function memTitle(e: Estimate, budget: number): string {
  const parts = `weights ${fmtBytes(e.weights)} + KV ${fmtBytes(e.kv)} + fixed ${fmtBytes(e.fixed)} + runtime ${fmtBytes(e.overhead)}`;
  if (!e.otherLoaded) return `${parts}\nbudget ${fmtBytes(budget, 0)}`;
  return `${parts}\nother loaded models ${fmtBytes(e.otherLoaded)} + this ${fmtBytes(e.bytes)} = ${fmtBytes(e.otherLoaded + e.bytes)} of ${fmtBytes(budget, 0)} budget`;
}

export function fitLabel(e: ReturnType<typeof estimate>, free: number | undefined) {
  if (!e.fitsFree) return { cls: "err", text: free != null ? `${fmtBytes(e.added - free)} short` : "won't fit" };
  if (!e.fitsBudget) return { cls: "warn", text: "over budget" };
  return { cls: "ok", text: "fits" };
}

export function ModelPicker({ session }: { session: SessionSummary }) {
  const models = useStore((s) => s.models);
  const samples = useStore((s) => s.samples);
  const budget = useStore((s) => s.budget);
  const pop = usePop();
  const sample = samples[samples.length - 1];
  const current = models.find((m) => m.id === session.modelId);
  const running = session.status === "running";
  const ctx = session.contextWindow;

  const rows = useMemo(
    () =>
      models.filter((m) => !m.strain).map((m) => ({ m, e: estimate(m, ctx, sample, budget, models) })).sort((a, b) => Number(b.m.loaded) - Number(a.m.loaded) || a.e.bytes - b.e.bytes),
    [models, ctx, sample, budget],
  );
  const scaleMax = Math.max(budget.budgetBytes, ...rows.map((r) => r.e.otherLoaded + r.e.bytes)) || 1;
  const strains = models.filter((m) => m.strain);

  const patch = (p: Parameters<NonNullable<ReturnType<typeof useStore.getState>["backend"]>["updateSession"]>[1]) =>
    void act("Update session", (b) => b.updateSession(session.id, p)).then((s) => {
      if (s) useStore.setState((st) => ({ sessions: { ...st.sessions, [s.id]: s } }));
    });

  // an eval case keeps the model and settings it was graded with
  if (session.evalRunId)
    return (
      <span className="hdr-btn static" title={`${current ? `${current.id}\n${current.params} ${current.quant}` : session.modelId}\noutput cap ${fmtInt(session.maxOutputTokens)}`}>
        <span className={`dot ${current?.loaded ? "ready" : ""}`} />
        <span className="hdr-model-name">{current?.name ?? session.modelId}</span>
        <span className="dim">{current?.quant}</span>
        <span className="dim num">{fmtCtx(ctx)}</span>
      </span>
    );

  return (
    <>
      <button ref={pop.ref} className="hdr-btn model" onClick={pop.toggle} title={current ? `${current.id}\n${current.params} ${current.quant}` : session.modelId}>
        <span className={`dot ${current?.loaded ? "ready" : ""}`} title={current?.loaded ? "Loaded in oMLX" : "Not loaded: first call loads it"} />
        {current?.strain && <span className="chip strain">strain</span>}
        <span className="hdr-model-name">{current?.name ?? session.modelId}</span>
        <span className="dim">{current?.quant}</span>
        <span className="dim num">{fmtCtx(ctx)}</span>
        <ChevronDown size={12} className="dim" />
      </button>
      <Popover anchor={pop.ref} open={pop.open} onClose={pop.close} width={580} className="model-pop">
        <div className="mp-controls">
          <label title="Context window for this session (prompt + output). Memory estimates below use it.">
            <span>Context</span>
            <div className="seg sm">
              {CONTEXT_CHOICES.filter((c) => !current || c <= current.nativeContext).map((c) => (
                <button key={c} className={c === ctx ? "on" : ""} disabled={running} onClick={() => patch({ contextWindow: c, maxOutputTokens: Math.min(session.maxOutputTokens, c / 2) })}>
                  {fmtCtx(c)}
                </button>
              ))}
            </div>
          </label>
          <label title="Max tokens per reply, thinking included. Reserved out of the context window.">
            <span>Output cap</span>
            <div className="seg sm">
              {OUTPUT_CHOICES.filter((c) => c <= ctx / 2).map((c) => (
                <button key={c} className={c === session.maxOutputTokens ? "on" : ""} disabled={running} onClick={() => patch({ maxOutputTokens: c })}>
                  {fmtCtx(c)}
                </button>
              ))}
            </div>
          </label>
        </div>
        <div className="mp-head">
          <span>Model</span>
          <span>Size</span>
          <span title={`weights + ${fmtCtx(ctx)} × KV bytes/token + fixed + 1 GiB overhead`}>Memory at {fmtCtx(ctx)}</span>
          <span />
        </div>
        <div className="menu mp-list">
          {rows.map(({ m, e }) => {
            const fit = fitLabel(e, sample?.system.freeBytes);
            const on = m.id === session.modelId;
            return (
              <button
                key={m.id}
                className={`mp-row${on ? " on" : ""}`}
                disabled={running}
                title={running ? "Stop the run to switch models" : `${m.id}\n${m.toolFormat} tool calls\nthinking: ${m.thinking}`}
                onClick={() => {
                  pop.close();
                  if (!on) patch({ modelId: m.id, thinking: m.thinking === "none" ? false : session.thinking });
                }}
              >
                <span className="mp-name">
                  {on ? <Check size={12} className="mp-check" /> : <span className="mp-check" />}
                  <span className={`dot ${m.loaded ? "ready" : ""}`} />
                  <span className="truncate">{m.name}</span>
                  <span className="dim">{m.params}</span>
                </span>
                <span className="mp-size num">
                  <span>{m.quant}</span>
                  <span className="dim">{fmtBytes(m.diskBytes)}</span>
                </span>
                <span className="mp-mem num" title={memTitle(e, budget.budgetBytes)}>
                  <MemBar e={e} cls={fit.cls} scaleMax={scaleMax} budget={budget.budgetBytes} />
                  <span>{fmtBytes(e.bytes)}</span>
                </span>
                <span className={`mp-fit ${fit.cls}`}>{m.loaded ? (m.loadedContext && m.loadedContext < ctx ? `loaded at ${fmtCtx(m.loadedContext)}` : "loaded") : fit.text}</span>
              </button>
            );
          })}
          {strains.length > 0 && (
            <>
              <div className="menu-label mp-group">
                Lab strains <span className="dim2">a base model with a neuron mix, served by the Lab</span>
              </div>
              {strains.map((m) => {
                const on = m.id === session.modelId;
                return (
                  <button
                    key={m.id}
                    className={`mp-row strain${on ? " on" : ""}`}
                    disabled={running}
                    title={running ? "Stop the run to switch models" : `${m.strain!.name}: ${m.strain!.recipe}`}
                    onClick={() => {
                      pop.close();
                      if (!on) patch({ modelId: m.id, thinking: false });
                    }}
                  >
                    <span className="mp-name">
                      {on ? <Check size={12} className="mp-check" /> : <span className="mp-check" />}
                      <span className="chip strain">strain</span>
                      <span className="truncate">{m.name}</span>
                    </span>
                    <span className="mp-size truncate dim">of {modelName(models, m.strain!.baseModelId)}</span>
                    <span className="mp-mem mono truncate dim2">{m.strain!.recipe}</span>
                    <span className="mp-fit dim">Lab</span>
                  </button>
                );
              })}
            </>
          )}
        </div>
        <div className="mp-foot">
          <span className="dim num">
            Free {fmtBytes(sample?.system.freeBytes)}  budget {fmtBytes(budget.budgetBytes, 0)}  output cap {fmtInt(session.maxOutputTokens)}
          </span>
          <button
            className="btn sm ghost"
            onClick={() => {
              pop.close();
              openView({ kind: "models" });
            }}
          >
            Manage models
          </button>
        </div>
      </Popover>
    </>
  );
}

export function modelName(models: ModelInfo[], id: string): string {
  return models.find((m) => m.id === id)?.name ?? id;
}
