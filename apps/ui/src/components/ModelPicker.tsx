import { useMemo } from "react";
import { Check, ChevronDown } from "lucide-react";
import type { ModelInfo, SessionSummary } from "@terrarium/shared";
import { act, openView, useStore } from "../state/store";
import { CONTEXT_CHOICES, estimate } from "../lib/memory";
import { fmtBytes, fmtCtx, fmtInt } from "../lib/format";
import { Popover, usePop } from "./ui";

const OUTPUT_CHOICES = [512, 1024, 2048, 4096, 8192, 16384];

export function fitLabel(e: ReturnType<typeof estimate>, free: number | undefined) {
  if (!e.fitsFree) return { cls: "err", text: free != null ? `needs ${fmtBytes(e.added - free)} more free` : "won't fit" };
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
      models.map((m) => ({ m, e: estimate(m, ctx, sample, budget, models) })).sort((a, b) => Number(b.m.loaded) - Number(a.m.loaded) || a.e.bytes - b.e.bytes),
    [models, ctx, sample, budget],
  );
  const scaleMax = Math.max(budget.budgetBytes, ...rows.map((r) => r.e.bytes));

  const patch = (p: Parameters<NonNullable<ReturnType<typeof useStore.getState>["backend"]>["updateSession"]>[1]) =>
    void act("Update session", (b) => b.updateSession(session.id, p)).then((s) => {
      if (s) useStore.setState((st) => ({ sessions: { ...st.sessions, [s.id]: s } }));
    });

  return (
    <>
      <button ref={pop.ref} className="hdr-btn model" onClick={pop.toggle} title={current ? `${current.id}\n${current.params} ${current.quant}` : session.modelId}>
        <span className={`dot ${current?.loaded ? "ready" : ""}`} title={current?.loaded ? "Loaded in oMLX" : "Not loaded: first call loads it"} />
        <span className="hdr-model-name">{current?.name ?? session.modelId}</span>
        <span className="dim">{current?.quant}</span>
        <span className="dim num">{fmtCtx(ctx)}</span>
        <ChevronDown size={12} className="dim" />
      </button>
      <Popover anchor={pop.ref} open={pop.open} onClose={pop.close} width={500} className="model-pop">
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
                <span className="mp-mem num" title={`weights ${fmtBytes(e.weights)} + KV ${fmtBytes(e.kv)} + fixed ${fmtBytes(e.fixed)} + overhead ${fmtBytes(e.overhead)}`}>
                  <span className="mp-bar">
                    <span className={`mp-fill ${fit.cls}`} style={{ width: `${(e.bytes / scaleMax) * 100}%` }} />
                    <span className="mp-budget" style={{ left: `${(budget.budgetBytes / scaleMax) * 100}%` }} />
                  </span>
                  <span>{fmtBytes(e.bytes)}</span>
                </span>
                <span className={`mp-fit ${fit.cls}`}>{m.loaded ? (m.loadedContext && m.loadedContext < ctx ? `loaded at ${fmtCtx(m.loadedContext)}` : "loaded") : fit.text}</span>
              </button>
            );
          })}
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
