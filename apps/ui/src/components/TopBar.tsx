import { useMemo, useState, type MouseEvent as RME } from "react";
import { Command, Loader2, Play, Square } from "lucide-react";
import type { ResourceSample } from "@terrarium/shared";
import { openEnv, openView, act, useStore } from "../state/store";
import { exactBytes, fmtBytes, fmtPct, plural } from "../lib/format";
import { ChartTip, ConfirmButton, Popover, usePop, type TipState } from "./ui";
import { forgetConnection } from "../api/connect";

interface Seg {
  key: string;
  label: string;
  group: string;
  bytes: number;
  color: string;
  pattern?: boolean;
  onClick?: () => void;
}

const MODEL_SHADES = ["var(--c-model)", "color-mix(in srgb, var(--c-model) 62%, var(--bg-0))", "color-mix(in srgb, var(--c-model) 40%, var(--bg-0))"];

function segments(sample: ResourceSample, names: Record<string, string>, envNames: Record<string, { name: string; type: string }>): Seg[] {
  const segs: Seg[] = [];
  const inf = sample.inference;
  if (inf) {
    let modelSum = 0;
    inf.loaded.forEach((m, i) => {
      const b = m.bytes ?? 0;
      modelSum += b;
      segs.push({
        key: `m:${m.modelId}`,
        label: names[m.modelId] ?? m.modelId,
        group: "oMLX model (weights + KV)",
        bytes: b,
        color: MODEL_SHADES[Math.min(i, MODEL_SHADES.length - 1)],
        onClick: () => openView({ kind: "models" }),
      });
    });
    const rest = Math.max(0, inf.rssBytes - modelSum);
    if (rest > 0)
      segs.push({ key: "omlx", label: "oMLX server", group: "oMLX process overhead", bytes: rest, color: "var(--c-model-pre)", onClick: () => openView({ kind: "models" }) });
  }
  sample.envs.forEach((e, i) => {
    const info = envNames[e.envId];
    segs.push({
      key: `e:${e.envId}`,
      label: info?.name ?? e.envId,
      group: info?.type === "sim" ? "Simulated env (child process)" : "VM",
      bytes: e.rssBytes,
      color: info?.type === "sim" ? "var(--c-sim)" : i % 2 ? "var(--c-vm-2)" : "var(--c-vm)",
      onClick: () => openEnv(e.envId),
    });
  });
  segs.push({ key: "backend", label: "Terrarium backend", group: "Node process", bytes: sample.backendRssBytes, color: "var(--c-backend)" });
  const accounted = segs.reduce((a, s) => a + s.bytes, 0);
  segs.push({
    key: "other",
    label: "Other apps + macOS",
    group: "Used by everything else",
    bytes: Math.max(0, sample.system.usedBytes - accounted),
    color: "var(--c-other-mem)",
    pattern: true,
  });
  return segs;
}

function MemoryBar() {
  const samples = useStore((s) => s.samples);
  const budget = useStore((s) => s.budget);
  const models = useStore((s) => s.models);
  const envs = useStore((s) => s.envs);
  const [tip, setTip] = useState<TipState | null>(null);
  const sample = samples[samples.length - 1];

  const names = useMemo(() => Object.fromEntries(models.map((m) => [m.id, m.name])), [models]);
  const envNames = useMemo(() => Object.fromEntries(Object.values(envs).map((e) => [e.id, { name: e.name, type: e.type }])), [envs]);

  if (!sample) return <div className="membar-wrap" />;
  const total = sample.system.totalBytes;
  const segs = segments(sample, names, envNames);
  const used = sample.system.usedBytes;
  const free = sample.system.freeBytes;
  const infBytes = sample.inference?.rssBytes ?? 0;
  const budgetX = budget.budgetBytes ? (budget.budgetBytes / total) * 100 : null;
  const overBudget = budget.budgetBytes > 0 && infBytes > budget.budgetBytes;

  const showTip = (e: RME, seg?: Seg) => {
    setTip({
      x: e.clientX,
      y: e.clientY,
      content: (
        <>
          <div className="tip-head">Memory</div>
          {segs.map((s) => (
            <div key={s.key} className="tip-row" style={seg?.key === s.key ? { fontWeight: 600 } : undefined}>
              <span>
                <span className="key" style={{ background: s.color }} />
                {s.label}
              </span>
              <span>{fmtBytes(s.bytes)}</span>
            </div>
          ))}
          <div className="tip-row">
            <span>
              <span className="key" style={{ background: "var(--c-free)", boxShadow: "inset 0 0 0 0.5px var(--line-3)" }} />
              Free
            </span>
            <span>{fmtBytes(free)}</span>
          </div>
          <div className="tip-row" style={{ marginTop: 4 }}>
            <span>oMLX vs budget</span>
            <span className={overBudget ? "err-text" : undefined}>
              {fmtBytes(infBytes)} / {fmtBytes(budget.budgetBytes, 0)}
            </span>
          </div>
          <div className="tip-row">
            <span>Pressure</span>
            <span className={sample.system.pressure !== "normal" ? "warn-text" : undefined}>{sample.system.pressure}</span>
          </div>
        </>
      ),
    });
  };

  let x = 0;
  return (
    <div className="membar-wrap">
      <div className="membar" onMouseLeave={() => setTip(null)} role="img" aria-label={`Memory: ${fmtBytes(used)} used of ${fmtBytes(total)}`}>
        <div className="membar-track">
          {segs.map((s) => {
            const w = (s.bytes / total) * 100;
            const left = x;
            x += w;
            if (w <= 0) return null;
            return (
              <button
                key={s.key}
                className={`membar-seg${s.pattern ? " pattern" : ""}${s.onClick ? "" : " static"}`}
                style={{ left: `${left}%`, width: `${w}%`, background: s.pattern ? undefined : s.color, ["--seg" as string]: s.color }}
                onMouseMove={(e) => showTip(e, s)}
                onClick={s.onClick}
                tabIndex={s.onClick ? 0 : -1}
                aria-label={`${s.label} ${fmtBytes(s.bytes)}`}
              />
            );
          })}
        </div>
        {budgetX != null && (
          <div className={`membar-budget${overBudget ? " over" : ""}`} style={{ left: `${budgetX}%` }} title={`oMLX budget ${fmtBytes(budget.budgetBytes, 0)}`} />
        )}
      </div>
      <div className="membar-text num" title={`${exactBytes(used)} used of ${exactBytes(total)}`}>
        <span className={sample.system.pressure !== "normal" ? "warn-text" : undefined}>{fmtBytes(used)}</span>
        <span className="dim"> / {fmtBytes(total, 0)}</span>
        <span className="dim membar-free">{fmtBytes(free)} free</span>
      </div>
      <ChartTip tip={tip} />
    </div>
  );
}

/** Start/stop oMLX. Stopping confirms inline when it would unload models or interrupt runs. */
export function ServerButton({ small }: { small?: boolean }) {
  const inf = useStore((s) => s.inference);
  const models = useStore((s) => s.models);
  const sessions = useStore((s) => s.sessions);
  const evalRuns = useStore((s) => s.evalRuns);
  const busy = inf.status === "starting" || inf.status === "stopping";
  const sm = small ? " sm" : "";
  if (inf.status !== "ready" && inf.status !== "starting")
    return (
      <button type="button" className={`btn${sm} primary`} disabled={busy} onClick={() => void act("Start inference", (b) => b.startInference())}>
        {busy ? <Loader2 className="spin" /> : <Play />} Start server
      </button>
    );
  const loaded = models.filter((m) => m.loaded).length;
  const running = Object.values(sessions).filter((s) => s.status === "running").length;
  const evals = evalRuns.filter((r) => r.status === "running").length;
  const stop = () => act("Stop inference", (b) => b.stopInference());
  if (!loaded && !running && !evals)
    return (
      <button type="button" className={`btn${sm}`} disabled={busy} onClick={() => void stop()}>
        {busy ? <Loader2 className="spin" /> : <Square />} Stop server
      </button>
    );
  const hits = [running ? plural(running, "running session") : "", evals ? plural(evals, "eval run") : ""].filter(Boolean).join(" and ");
  return (
    <ConfirmButton
      small={small}
      icon={<Square />}
      label="Stop server"
      confirmLabel={hits ? `Stop, interrupts ${hits}` : `Stop, unloads ${plural(loaded, "model")}`}
      disabled={busy}
      onConfirm={stop}
    />
  );
}

function InferenceControl() {
  const inf = useStore((s) => s.inference);
  const models = useStore((s) => s.models);
  const pop = usePop();
  const loaded = models.filter((m) => m.loaded);
  const busy = inf.status === "starting" || inf.status === "stopping";
  return (
    <>
      <button ref={pop.ref} className="topbar-btn infer" onClick={pop.toggle} title="Inference server (oMLX)">
        {busy ? <Loader2 className="spin" size={12} /> : <span className={`dot ${inf.status === "ready" ? "ready" : inf.status === "error" ? "error" : ""}`} />}
        <span>oMLX</span>
        <span className="dim">{inf.status}</span>
        {inf.status === "ready" && <span className="dim2 num">{loaded.length ? `${loaded.length} loaded` : "none loaded"}</span>}
      </button>
      <Popover anchor={pop.ref} open={pop.open} onClose={pop.close} align="end" width={290}>
        <div className="pop-pad">
          <dl className="kv">
            <dt>Status</dt>
            <dd>
              {inf.status}
              {inf.detail ? <span className="dim"> {inf.detail}</span> : null}
            </dd>
            <dt>Version</dt>
            <dd>{inf.version ?? "–"}</dd>
            <dt>PID</dt>
            <dd className="num">{inf.pid ?? "–"}</dd>
            <dt>RSS</dt>
            <dd className="num">{fmtBytes(inf.rssBytes)}</dd>
            <dt title="oMLX memory ceiling setting">Ceiling</dt>
            <dd className="num">{fmtBytes(inf.memoryCeilingBytes)}</dd>
            <dt>Loaded</dt>
            <dd>
              {loaded.length
                ? loaded.map((m) => (
                    <div key={m.id}>
                      <button
                        type="button"
                        className="cell-link"
                        onClick={() => {
                          pop.close();
                          openView({ kind: "models" });
                        }}
                      >
                        {m.name}
                      </button>{" "}
                      <span className="dim num">{fmtBytes(m.residentBytes)}</span>
                    </div>
                  ))
                : "–"}
            </dd>
          </dl>
          <div className="pop-actions">
            <ServerButton />
            <button
              className="btn ghost"
              onClick={() => {
                pop.close();
                openView({ kind: "models" });
              }}
            >
              Models
            </button>
          </div>
        </div>
      </Popover>
    </>
  );
}

function ConnControl() {
  const conn = useStore((s) => s.conn);
  const connDetail = useStore((s) => s.connDetail);
  const backend = useStore((s) => s.backend);
  const pop = usePop();
  const fixtures = backend?.kind === "fixtures";
  return (
    <>
      <button ref={pop.ref} className="topbar-btn" onClick={pop.toggle} title="Backend connection">
        <span className={`dot ${conn === "open" ? (fixtures ? "busy" : "ready") : conn === "connecting" ? "starting" : "error"}`} />
        <span className="dim2">{fixtures ? "fixtures" : conn === "open" ? backend?.label : conn}</span>
      </button>
      <Popover anchor={pop.ref} open={pop.open} onClose={pop.close} align="end" width={300}>
        <div className="pop-pad">
          <dl className="kv">
            <dt>Backend</dt>
            <dd className={fixtures ? undefined : "mono"}>{fixtures ? "In-memory fixtures" : (backend?.label ?? "none")}</dd>
            <dt>Status</dt>
            <dd>
              {conn}
              {connDetail ? <span className="dim"> {connDetail}</span> : null}
            </dd>
          </dl>
          <div className="pop-actions">
            {fixtures && (
              <button type="button" className="btn" title="Restart the scripted sessions from the beginning" onClick={() => location.reload()}>
                Restart fixtures
              </button>
            )}
            {!(fixtures && import.meta.env.VITE_FIXTURES === "1") && (
              <button type="button" className="btn ghost" onClick={forgetConnection}>
                {fixtures ? "Connect to a backend" : "Change backend"}
              </button>
            )}
          </div>
        </div>
      </Popover>
    </>
  );
}

export function TopBar() {
  const samples = useStore((s) => s.samples);
  const last = samples[samples.length - 1];
  const cpu = last ? last.envs.reduce((a, e) => a + e.cpuPct, 0) : null;
  return (
    <header className="topbar" data-tauri-drag-region>
      <div className="brand" data-tauri-drag-region>
        <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden>
          <path d="M3 6.5 8 2l5 4.5V13a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z" fill="none" stroke="currentColor" strokeWidth="1.3" />
          <path d="M8 13.5V9.2M8 10.6c-1.6 0-2.6-1-2.6-2.4 1.6 0 2.6 1 2.6 2.4Zm0-.8c0-1.3.9-2.2 2.4-2.2 0 1.3-.9 2.2-2.4 2.2Z" fill="currentColor" />
        </svg>
        Terrarium
      </div>
      <MemoryBar />
      {cpu != null && (
        <div className="topbar-stat num" title="CPU used by all running environments (100% = one core)">
          <span className="dim">env CPU</span> {fmtPct(cpu)}
        </div>
      )}
      <div className="topbar-spacer" data-tauri-drag-region />
      <InferenceControl />
      <ConnControl />
      <button className="topbar-btn" onClick={() => useStore.setState({ paletteOpen: true })} title="Jump to session or env">
        <Command size={12} />
        <span>K</span>
      </button>
    </header>
  );
}
