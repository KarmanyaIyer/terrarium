import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, Check, Loader2, Minus, Play, RotateCw, Square, X } from "lucide-react";
import type { EvalCase, EvalCellStatus, EvalCheck, EvalResult, EvalRunDetail, EvalRunSummary, EvalSuite, HarnessProfile, ModelInfo, StartEvalRunRequest } from "@terrarium/shared";
import { act, loadEvalRun, loadSuites, openEnv, openSession, openView, useStore } from "../state/store";
import { CONTEXT_CHOICES, estimate } from "../lib/memory";
import { fmtCtx, fmtInt, fmtMs, fmtPct, plural } from "../lib/format";
import { ChartTip, ConfirmButton, Expander, Segmented, Switch, Time, type TipState } from "../components/ui";
import { CodeView } from "../components/CodeView";
import { EnvChip, NetIcon } from "../components/Sidebar";
import { fitLabel, modelName } from "../components/ModelPicker";
import { HARNESS } from "./SessionView";

export default function EvalsView() {
  const view = useStore((s) => s.view);
  const runs = useStore((s) => s.evalRuns);
  const suites = useStore((s) => s.suites);
  const v = view.kind === "evals" ? view : { kind: "evals" as const };

  useEffect(() => {
    if (!suites) void loadSuites();
  }, [suites]);

  // default: the newest run
  const runId = v.runId ?? (!v.suiteId ? runs[0]?.id : undefined);
  const suiteId = runId ? undefined : (v.suiteId ?? suites?.[0]?.id);

  return (
    <div className="evals">
      <aside className="ev-rail">
        <div className="ev-rail-head">
          <h2>Runs</h2>
          <span className="dim num">{runs.length}</span>
        </div>
        <div className="ev-list">
          {runs.length === 0 && <div className="ev-empty dim">No runs yet</div>}
          {runs.map((r) => (
            <RunRow key={r.id} r={r} on={r.id === runId} />
          ))}
        </div>
        <div className="ev-rail-head">
          <h2>Suites</h2>
          <span className="dim num">{suites?.length ?? ""}</span>
        </div>
        <div className="ev-list">
          {suites == null && <Loader2 size={13} className="spin dim ev-empty" />}
          {suites?.map((s) => (
            <button key={s.id} className={`ev-row${s.id === suiteId ? " on" : ""}`} onClick={() => openView({ kind: "evals", suiteId: s.id })}>
              <span className="ev-row-main">
                <span className="truncate">{s.title}</span>
                <span className="ev-row-meta dim">
                  {s.source ? `${s.source.dataset}${s.source.total ? `, ${fmtInt(s.source.total)} total` : ""}` : plural(s.cases.length, "case")}
                </span>
              </span>
              <SuiteEnv t={s.envType} />
            </button>
          ))}
        </div>
      </aside>
      <div className="ev-main">
        {runId ? (
          <RunView key={runId} runId={runId} />
        ) : suiteId && suites ? (
          <SuiteView key={suiteId} suite={suites.find((s) => s.id === suiteId)!} />
        ) : (
          <div className="empty">No eval suites found</div>
        )}
      </div>
    </div>
  );
}

function SuiteEnv({ t }: { t: EvalSuite["envType"] | EvalCase["envType"] }) {
  if (t === "vm" || t === "sim") return <EnvChip type={t} />;
  return (
    <span className="chip" title={t === "none" ? "No environment: answer-only" : "Cases use different environment types"}>
      {t === "none" ? "no env" : "mixed"}
    </span>
  );
}

function totalsOf(r: EvalRunSummary) {
  return Object.values(r.totals).reduce(
    (a, t) => ({ pass: a.pass + t.pass, fail: a.fail + t.fail, error: a.error + t.error, total: a.total + t.total }),
    { pass: 0, fail: 0, error: 0, total: 0 },
  );
}

function RunRow({ r, on }: { r: EvalRunSummary; on: boolean }) {
  const t = totalsOf(r);
  const done = t.pass + t.fail + t.error;
  return (
    <button className={`ev-row${on ? " on" : ""}`} onClick={() => openView({ kind: "evals", runId: r.id })}>
      <span className={`dot ${r.status === "running" ? "live" : r.status === "error" ? "error" : r.status === "done" ? "ready" : ""}`} />
      <span className="ev-row-main">
        <span className="truncate">{r.suiteTitle}</span>
        <span className="ev-row-meta dim">
          {plural(r.config.modelIds.length, "model")}, <Time ts={r.startedAt} />
        </span>
      </span>
      <span className="ev-row-score num" title={`${t.pass} passed of ${done} finished (${t.total} cells)`}>
        {done ? fmtPct((t.pass / done) * 100) : "–"}
      </span>
    </button>
  );
}

// ---------- run ----------

const STATUS_LABEL: Record<EvalCellStatus, string> = {
  pass: "Passed",
  fail: "Failed",
  error: "Error",
  running: "Running",
  pending: "Pending",
  skipped: "Skipped",
};

function CellGlyph({ s }: { s: EvalCellStatus }) {
  if (s === "pass") return <Check size={12} strokeWidth={2.5} />;
  if (s === "fail") return <X size={12} strokeWidth={2.5} />;
  if (s === "error") return <AlertTriangle size={11} strokeWidth={2.25} />;
  if (s === "running") return <Loader2 size={12} className="spin" />;
  if (s === "skipped") return <Minus size={12} />;
  return null;
}

/** Run models whose native context is below the run's: the backend runs their cases at their own maximum. */
function cappedAt(models: ModelInfo[], ids: string[], ctx: number): ModelInfo[] {
  return models.filter((m) => ids.includes(m.id) && m.nativeContext < ctx);
}

function checkSummary(c: EvalCheck): string {
  switch (c.type) {
    case "answer":
      return `${c.mode} ${c.expected}${c.tolerance != null ? ` ±${c.tolerance}` : ""}`;
    case "command":
      return c.command;
    case "tests":
      return `hidden tests ${c.file}`;
    case "file":
      return `${c.path}${c.equals != null ? " equals" : c.contains != null ? ` contains "${c.contains}"` : " exists"}`;
    case "isolation":
      return `escape blocked: ${c.probe}`;
    case "speed":
      return "timing only";
  }
}

function RunView({ runId }: { runId: string }) {
  const detail = useStore((s) => s.evalDetails[runId]);
  const summary = useStore((s) => s.evalRuns.find((r) => r.id === runId));
  const models = useStore((s) => s.models);
  const [caseSel, setCaseSel] = useState<string | null>(null);
  const [tip, setTip] = useState<TipState | null>(null);

  useEffect(() => {
    void loadEvalRun(runId);
  }, [runId]);

  const run: EvalRunDetail | undefined = detail ? { ...detail, ...(summary ?? {}) } : undefined;
  const byCell = useMemo(() => {
    const m = new Map<string, EvalResult>();
    for (const r of run?.results ?? []) m.set(`${r.caseId}\u0000${r.modelId}`, r);
    return m;
  }, [run?.results]);

  if (!run) return <div className="empty">{summary ? "Loading run" : "Run not found"}</div>;
  const cfg = run.config;
  const t = totalsOf(run);
  const finished = run.results.filter((r) => r.status === "pass" || r.status === "fail" || r.status === "error").length;
  const remaining = run.results.filter((r) => r.status === "pending" || r.status === "running").length;
  const selCase = run.cases.find((c) => c.id === caseSel);
  const dur = (run.finishedAt ?? Date.now()) - run.startedAt;

  return (
    <div className="ev-run">
      <div className="view-head">
        <h1>
          <button className="title-link" title="Open suite" onClick={() => openView({ kind: "evals", suiteId: run.suiteId })}>
            {run.suiteTitle}
          </button>
        </h1>
        <span className={`chip ${run.status === "running" ? "accent" : run.status === "done" ? "" : run.status === "error" ? "err" : "warn"}`}>
          {run.status === "running" && <Loader2 size={10} className="spin" />} {run.status}
        </span>
        <span className="dim num">
          {finished}/{run.results.length} cells, {fmtMs(dur)}
        </span>
        <span className="blk-spacer" />
        {run.status === "running" ? (
          <ConfirmButton
            small
            icon={<Square />}
            label="Stop run"
            confirmLabel={`Stop, skip ${remaining} remaining`}
            onConfirm={() => act("Stop run", (b) => b.stopEvalRun(run.id))}
          />
        ) : (
          <button
            className="btn sm"
            onClick={async () => {
              const r = await act("Start run", (b) => b.startEvalRun(cfg));
              if (r) openView({ kind: "evals", runId: r.id });
            }}
          >
            <RotateCw /> Run again
          </button>
        )}
      </div>
      <div className="ev-config">
        <span>
          <span className="dim">Harness</span> {cfg.harness}
        </span>
        <span>
          <span className="dim">Thinking</span> {cfg.thinking ? "on" : "off"}
        </span>
        {cfg.contextWindow ? (
          <span>
            <span className="dim">Context</span> {fmtCtx(cfg.contextWindow)}
            {cappedAt(models, cfg.modelIds, cfg.contextWindow).map((m) => (
              <span key={m.id} className="dim" title={`${m.name} supports at most ${fmtCtx(m.nativeContext)}; its cases ran at that`}>
                , {m.name} at {fmtCtx(m.nativeContext)}
              </span>
            ))}
          </span>
        ) : null}
        {cfg.sampleSize ? (
          <span>
            <span className="dim">{cfg.seed != null ? "Sample" : "First"}</span> {plural(cfg.sampleSize, "case")}
            {cfg.seed != null ? <span className="dim"> seed {cfg.seed}</span> : null}
          </span>
        ) : null}
        <span>
          <span className="dim">Started</span> <Time ts={run.startedAt} />
        </span>
        <span className="num">
          <span className="ok-text">{t.pass} pass</span> <span className="err-text">{t.fail} fail</span>{" "}
          <span className="warn-text">{t.error} error</span>
        </span>
      </div>

      <div className="ev-matrix-wrap">
        <table className="ev-matrix">
          <thead>
            <tr>
              <th className="ev-case-h">Case</th>
              <th className="ev-check-h">Check</th>
              {cfg.modelIds.map((id) => {
                const tt = run.totals[id] ?? { pass: 0, fail: 0, error: 0, total: 0 };
                const done = tt.pass + tt.fail + tt.error;
                return (
                  <th key={id} className="ev-model-h">
                    <button className="cell-link strong" title="Open in Models" onClick={() => openView({ kind: "models" })}>
                      {modelName(models, id)}
                    </button>
                    <div className="ev-score" title={`${tt.pass} passed of ${done} finished; ${tt.total} cases`}>
                      <span className="num">
                        {tt.pass}/{done} passed
                      </span>
                      <span className="dim num">{done ? fmtPct((tt.pass / done) * 100) : ""}</span>
                      {done < tt.total && <span className="dim2 num">{tt.total - done} left</span>}
                    </div>
                    <div className="ev-bar" title={`${tt.pass} pass, ${tt.fail} fail, ${tt.error} error, ${tt.total - done} not finished`}>
                      <span className="pass" style={{ flexGrow: tt.pass }} />
                      <span className="fail" style={{ flexGrow: tt.fail }} />
                      <span className="error" style={{ flexGrow: tt.error }} />
                      <span className="rest" style={{ flexGrow: tt.total - done }} />
                    </div>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {run.cases.map((c) => (
              <tr key={c.id} className={c.id === caseSel ? "sel" : undefined}>
                <td
                  className="ev-case"
                  tabIndex={0}
                  aria-expanded={c.id === caseSel}
                  onClick={() => setCaseSel(c.id === caseSel ? null : c.id)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      setCaseSel(c.id === caseSel ? null : c.id);
                    }
                  }}
                >
                  <div className="truncate">{c.title}</div>
                  <div className="mono dim2 ev-case-id">{c.id}</div>
                </td>
                <td className="ev-check" onClick={() => setCaseSel(c.id === caseSel ? null : c.id)}>
                  <span className="dim">{c.check.type}</span> <SuiteEnv t={c.envType} />
                </td>
                {cfg.modelIds.map((m) => {
                  const r = byCell.get(`${c.id}\u0000${m}`);
                  const st = r?.status ?? "pending";
                  return (
                    <td key={m} className="ev-cell-td">
                      <button
                        className={`ev-cell ${st}`}
                        disabled={!r?.sessionId}
                        aria-label={`${c.title}, ${modelName(models, m)}: ${STATUS_LABEL[st]}`}
                        onClick={() => r?.sessionId && openSession(r.sessionId)}
                        onMouseMove={(e) =>
                          setTip({
                            x: e.clientX,
                            y: e.clientY,
                            content: (
                              <>
                                <div className="tip-title">
                                  {STATUS_LABEL[st]} <span className="dim">{modelName(models, m)}</span>
                                </div>
                                {r?.detail && <div className="tip-detail mono">{r.detail}</div>}
                                {r?.durationMs != null && (
                                  <div className="tip-row">
                                    <span>Duration</span>
                                    <span>{fmtMs(r.durationMs)}</span>
                                  </div>
                                )}
                                {r?.tokens && (
                                  <div className="tip-row">
                                    <span>Tokens</span>
                                    <span>
                                      {fmtInt(r.tokens.prompt)} in, {fmtInt(r.tokens.completion)} out
                                    </span>
                                  </div>
                                )}
                              </>
                            ),
                          })
                        }
                        onMouseLeave={() => setTip(null)}
                      >
                        <CellGlyph s={st} />
                        {c.check.type === "speed" && r?.score != null ? (
                          <span className="num">{r.score} tok/s</span>
                        ) : (
                          r?.durationMs != null && <span className="num">{fmtMs(r.durationMs)}</span>
                        )}
                      </button>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
        <ChartTip tip={tip} />
      </div>
      {selCase && <CaseDetail c={selCase} results={run.results.filter((r) => r.caseId === selCase.id)} onClose={() => setCaseSel(null)} />}
    </div>
  );
}

function CaseDetail({ c, results, onClose }: { c: EvalCase; results?: EvalResult[]; onClose: () => void }) {
  const models = useStore((s) => s.models);
  // A result can name an env that never came to be (a failed fork, before that cleared it): no Files for those.
  const envs = useStore((s) => s.envs);
  return (
    <div className="ev-casepanel">
      <div className="ev-casepanel-head">
        <b className="truncate">{c.title}</b>
        <span className="mono dim2">{c.id}</span>
        <SuiteEnv t={c.envType} />
        {c.envType !== "none" && <NetIcon mode={c.network ?? "off"} />}
        <span className="dim num">
          max {plural(c.maxTurns, "turn")}, {c.timeoutSec}s
        </span>
        <span className="blk-spacer" />
        <button className="icon-btn" title="Close" onClick={onClose}>
          <X size={13} />
        </button>
      </div>
      <div className="ev-casepanel-body">
        <section>
          <h3>Prompt</h3>
          <pre className="well selectable">{c.prompt}</pre>
        </section>
        <section>
          <h3>Check</h3>
          <dl className="kv">
            <dt>Type</dt>
            <dd>{c.check.type}</dd>
            <CheckFields c={c.check} />
          </dl>
          {results && results.length > 0 && (
            <>
              <h3>Results</h3>
              <div className="ev-case-results">
                {results.map((r) => (
                  <div key={r.modelId} className="ev-case-result">
                    <span className={`ev-cell sm ${r.status}`}>
                      <CellGlyph s={r.status} />
                    </span>
                    <button className="cell-link" title="Open in Models" onClick={() => openView({ kind: "models" })}>
                      {modelName(models, r.modelId)}
                    </button>
                    <span className="dim mono truncate ev-case-result-detail" title={r.detail}>
                      {r.detail ?? ""}
                    </span>
                    {r.envId && envs[r.envId] && envs[r.envId].status !== "error" && (
                      <button
                        className="btn sm ghost"
                        title="Workspace after this run"
                        onClick={() => {
                          if (r.sessionId) openSession(r.sessionId);
                          openEnv(r.envId!, "files");
                        }}
                      >
                        Files
                      </button>
                    )}
                    {r.sessionId && (
                      <button className="btn sm ghost" onClick={() => openSession(r.sessionId!)}>
                        Transcript
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </>
          )}
        </section>
        {c.setupFiles?.length ? (
          <section className="wide">
            <h3>Setup files</h3>
            {c.setupFiles.map((f) => (
              <FileBox key={f.path} path={f.path} content={f.content} />
            ))}
          </section>
        ) : null}
        {c.hiddenFiles?.length ? (
          <section className="wide">
            <h3 title="Root-owned, unreadable to the agent; used only by the grader">Grader-only files</h3>
            {c.hiddenFiles.map((f) => (
              <FileBox key={f.path} path={f.path} content={f.content} />
            ))}
          </section>
        ) : null}
      </div>
    </div>
  );
}

function CheckFields({ c }: { c: EvalCheck }) {
  switch (c.type) {
    case "answer":
      return (
        <>
          <dt>Mode</dt>
          <dd>{c.mode}</dd>
          <dt>Expected</dt>
          <dd className="mono">{c.expected}</dd>
          {c.tolerance != null && (
            <>
              <dt>Tolerance</dt>
              <dd className="num">{c.tolerance}</dd>
            </>
          )}
        </>
      );
    case "command":
      return (
        <>
          <dt title="Run in the env after the agent finishes; passes on exit 0">Command</dt>
          <dd className="mono">{c.command}</dd>
        </>
      );
    case "tests":
      return (
        <>
          <dt title="Candidate code and the hidden tests run in separate processes and users; passes only when every test passed">Hidden tests</dt>
          <dd className="mono">{c.file}</dd>
          {c.timeoutSec != null && (
            <>
              <dt>Timeout</dt>
              <dd className="num">{c.timeoutSec}s</dd>
            </>
          )}
        </>
      );
    case "file":
      return (
        <>
          <dt>Path</dt>
          <dd className="mono">{c.path}</dd>
          {c.equals != null && (
            <>
              <dt>Equals</dt>
              <dd className="mono pre">{c.equals}</dd>
            </>
          )}
          {c.contains != null && (
            <>
              <dt>Contains</dt>
              <dd className="mono">{c.contains}</dd>
            </>
          )}
        </>
      );
    case "isolation":
      return (
        <>
          <dt title="Passes when this escape attempt is blocked">Probe</dt>
          <dd className="mono">{c.probe}</dd>
        </>
      );
    case "speed":
      return null;
  }
}

function FileBox({ path, content }: { path: string; content: string }) {
  const lines = content.split("\n").length;
  return (
    <div className="ev-file">
      <div className="ev-file-head mono">{path}</div>
      <Expander lines={lines} limit={12}>
        {(collapsed) => <CodeView code={collapsed ? content.split("\n").slice(0, 12).join("\n") : content} path={path} />}
      </Expander>
    </div>
  );
}

// ---------- suite ----------

function SuiteView({ suite }: { suite: EvalSuite }) {
  const models = useStore((s) => s.models);
  const allRuns = useStore((s) => s.evalRuns);
  const runs = useMemo(() => allRuns.filter((r) => r.suiteId === suite.id), [allRuns, suite.id]);
  const samples = useStore((s) => s.samples);
  const budget = useStore((s) => s.budget);
  const sample = samples[samples.length - 1];
  const [picked, setPicked] = useState<string[]>(() => models.filter((m) => m.loaded).map((m) => m.id));
  const [harness, setHarness] = useState<HarnessProfile>(suite.envType === "none" ? "chat" : "terrarium");
  const [thinking, setThinking] = useState(false);
  const [ctx, setCtx] = useState(16384);
  const [sampleSize, setSampleSize] = useState(String(Math.min(20, suite.source?.total ?? suite.cases.length)));
  const [firstN, setFirstN] = useState(String(suite.cases.length));
  const [seed, setSeed] = useState("1");
  const [caseSel, setCaseSel] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const sampleable = !!suite.source?.sampleable;
  // Hand-written suites run their first N cases (all by default), in file order.
  const firstCount = Math.min(suite.cases.length, Math.max(1, Math.floor(Number(firstN)) || suite.cases.length));
  const n = sampleable ? Math.max(1, Number(sampleSize) || 0) : firstCount;
  const cells = n * picked.length;
  const selCase = suite.cases.find((c) => c.id === caseSel);

  const start = async () => {
    const req: StartEvalRunRequest = {
      suiteId: suite.id,
      modelIds: picked,
      harness,
      thinking,
      contextWindow: ctx,
      sampleSize: sampleable || firstCount < suite.cases.length ? n : undefined,
      seed: sampleable ? Number(seed) || 0 : undefined,
    };
    setBusy(true);
    const r = await act("Start run", (b) => b.startEvalRun(req));
    setBusy(false);
    if (r) openView({ kind: "evals", runId: r.id });
  };

  return (
    <div className="ev-suite">
      <div className="view-head">
        <h1 title={suite.description}>{suite.title}</h1>
        <SuiteEnv t={suite.envType} />
      </div>
      {suite.source && (
        <div className="ev-config">
          <span>
            <span className="dim">Dataset</span> {suite.source.dataset}
          </span>
          {suite.source.total != null && (
            <span className="num">
              <span className="dim">Total</span> {fmtInt(suite.source.total)}
            </span>
          )}
          {suite.source.license && (
            <span>
              <span className="dim">License</span> {suite.source.license}
            </span>
          )}
          <span className="mono dim truncate selectable">{suite.source.url}</span>
        </div>
      )}
      <div className="ev-suite-body">
        <div className="ev-runcfg">
          <h3>Run</h3>
          <div className="ev-models">
            {models.map((m) => {
              const on = picked.includes(m.id);
              // the backend runs a model at most at its native context
              const e = estimate(m, Math.min(ctx, m.nativeContext), sample, budget, models);
              const fit = fitLabel(e, sample?.system.freeBytes);
              return (
                <label key={m.id} className={`ev-model${on ? " on" : ""}`}>
                  <input type="checkbox" checked={on} onChange={() => setPicked((p) => (on ? p.filter((x) => x !== m.id) : [...p, m.id]))} />
                  <span className={`dot ${m.loaded ? "ready" : ""}`} title={m.loaded ? "Loaded" : "Not loaded; loads when its first case starts"} />
                  <span className="truncate">{m.name}</span>
                  <span className="dim num">
                    {m.params}
                    {ctx > m.nativeContext && (
                      <span className="warn-text" title={`${m.name} supports at most ${fmtCtx(m.nativeContext)}; its cases run at that`}>
                        {" "}
                        runs at {fmtCtx(m.nativeContext)}
                      </span>
                    )}
                  </span>
                  <span className={`fit ${m.loaded ? "ok" : fit.cls}`}>{m.loaded ? "loaded" : fit.text}</span>
                </label>
              );
            })}
          </div>
          <div className="md-grid">
            <span>Harness</span>
            <Segmented<HarnessProfile>
              small
              value={harness}
              onChange={setHarness}
              options={HARNESS.map((h) => ({ value: h.id, label: h.label, title: h.title }))}
            />
            <span>Thinking</span>
            <Switch on={thinking} onChange={setThinking} label={thinking ? "on" : "off"} />
            <span>Context</span>
            <Segmented
              small
              value={String(ctx)}
              onChange={(v) => setCtx(Number(v))}
              options={CONTEXT_CHOICES.map((c) => ({ value: String(c), label: fmtCtx(c) }))}
            />
            {sampleable && (
              <>
                <span>Sample</span>
                <div className="form-row">
                  <input className="input num ev-num" value={sampleSize} onChange={(e) => setSampleSize(e.target.value)} aria-label="Sample size" />
                  <span className="dim">seed</span>
                  <input className="input num ev-num" value={seed} onChange={(e) => setSeed(e.target.value)} aria-label="Seed" />
                </div>
              </>
            )}
            {!sampleable && suite.cases.length > 1 && (
              <>
                <span>Cases</span>
                <div className="form-row">
                  <span className="dim">first</span>
                  <input className="input num ev-num" value={firstN} onChange={(e) => setFirstN(e.target.value)} aria-label="Run the first N cases" />
                  <span className="dim">of {suite.cases.length}</span>
                </div>
              </>
            )}
          </div>
          <div className="md-actions">
            <button className="btn primary" disabled={!picked.length || busy} onClick={() => void start()}>
              {busy ? <Loader2 className="spin" /> : <Play />} Run {plural(n, "case")} × {plural(picked.length, "model")}
            </button>
            <span className="dim num">{plural(cells, "cell")}</span>
          </div>
          {runs.length > 0 && (
            <>
              <h3>Past runs</h3>
              <div className="ev-list">
                {runs.map((r) => (
                  <RunRow key={r.id} r={r} on={false} />
                ))}
              </div>
            </>
          )}
        </div>
        <div className="ev-cases">
          <table className="table">
            <thead>
              <tr>
                <th>Case</th>
                <th>Env</th>
                <th>Check</th>
                <th className="r">Turns</th>
                <th className="r">Timeout</th>
              </tr>
            </thead>
            <tbody>
              {suite.cases.map((c, i) => (
                <tr
                  key={c.id}
                  className={`click${c.id === caseSel ? " sel" : ""}${!sampleable && i >= firstCount ? " dim" : ""}`}
                  title={!sampleable && i >= firstCount ? "Not in this run (beyond the first N cases)" : undefined}
                  tabIndex={0}
                  aria-expanded={c.id === caseSel}
                  onClick={() => setCaseSel(c.id === caseSel ? null : c.id)}
                  onKeyDown={(e) => {
                    if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) {
                      e.preventDefault();
                      setCaseSel(c.id === caseSel ? null : c.id);
                    }
                  }}
                >
                  <td>
                    <div className="truncate">{c.title}</div>
                    <div className="mono dim2 ev-case-id">{c.id}</div>
                  </td>
                  <td className="nowrap">
                    <SuiteEnv t={c.envType} /> {c.envType !== "none" && <NetIcon mode={c.network ?? "off"} />}
                  </td>
                  <td className="ev-check-sum">
                    <span className="dim">{c.check.type}</span> <span className="mono truncate">{checkSummary(c.check)}</span>
                  </td>
                  <td className="r num">{c.maxTurns}</td>
                  <td className="r num">{c.timeoutSec}s</td>
                </tr>
              ))}
            </tbody>
          </table>        </div>
      </div>
      {selCase && <CaseDetail c={selCase} onClose={() => setCaseSel(null)} />}
    </div>
  );
}
