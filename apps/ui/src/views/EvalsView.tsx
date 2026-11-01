import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, Check, LayoutList, Loader2, Minus, Play, RotateCw, Square, X } from "lucide-react";
import type { EvalCase, EvalCellStatus, EvalCheck, EvalResult, EvalRunDetail, EvalRunSummary, EvalSuite, HarnessProfile, ModelInfo, StartEvalRunRequest } from "@terrarium/shared";
import { act, loadEvalRun, loadSuites, openEnv, openSession, openView, useStore } from "../state/store";
import { CONTEXT_CHOICES, estimate } from "../lib/memory";
import { fmtCtx, fmtInt, fmtMs, fmtPct, plural } from "../lib/format";
import { ConfirmButton, Expander, Hint, Segmented, Switch, Time } from "../components/ui";
import { CodeView } from "../components/CodeView";
import { EnvChip, NetIcon } from "../components/Sidebar";
import { fitLabel, modelName } from "../components/ModelPicker";
import { HARNESS, HarnessTip, harnessLabel } from "../lib/explain";

export default function EvalsView() {
  const view = useStore((s) => s.view);
  const runs = useStore((s) => s.evalRuns);
  const suites = useStore((s) => s.suites);
  const v = view.kind === "evals" ? view : { kind: "evals" as const };

  useEffect(() => {
    if (!suites) void loadSuites();
  }, [suites]);

  const runId = v.runId;
  const suiteId = runId ? runs.find((r) => r.id === runId)?.suiteId : v.suiteId;
  const suite = !runId && suiteId ? suites?.find((s) => s.id === suiteId) : undefined;

  return (
    <div className="evals">
      <aside className="ev-rail">
        <div className="ev-list ev-list-top">
          <button className={`ev-row${!runId && !suiteId ? " on" : ""}`} onClick={() => openView({ kind: "evals" })}>
            <LayoutList size={13} className="dim" />
            <span className="ev-row-main">Overview</span>
            <span className="dim num">{runs.length ? plural(runs.length, "run") : ""}</span>
          </button>
        </div>
        <div className="ev-rail-head">
          <h2>Suites</h2>
          <span className="dim num">{suites?.length ?? ""}</span>
        </div>
        <div className="ev-list">
          {suites == null && <Loader2 size={13} className="spin dim ev-empty" />}
          {suites?.map((s) => {
            const last = runs.find((r) => r.suiteId === s.id);
            return (
              <button key={s.id} className={`ev-row${s.id === suiteId ? " on" : ""}`} onClick={() => openView({ kind: "evals", suiteId: s.id })}>
                <span className="ev-row-main">
                  <span className="truncate">{s.title}</span>
                  <span className="ev-row-meta dim">
                    {plural(s.cases.length, "case")}
                    {s.source?.total ? ` of ${fmtInt(s.source.total)}` : ""}
                  </span>
                </span>
                {last && <RailScore r={last} />}
                <SuiteEnv t={s.envType} />
              </button>
            );
          })}
        </div>
      </aside>
      <div className="ev-main">
        {runId ? (
          <RunView key={runId} runId={runId} />
        ) : suite ? (
          <SuiteView key={suite.id} suite={suite} />
        ) : suiteId && suites ? (
          <div className="empty">Suite not found</div>
        ) : (
          <Overview suites={suites} runs={runs} />
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

type Totals = { pass: number; fail: number; error: number; total: number };
const ZERO: Totals = { pass: 0, fail: 0, error: 0, total: 0 };

function totalsOf(r: EvalRunSummary): Totals {
  return Object.values(r.totals).reduce(
    (a, t) => ({ pass: a.pass + t.pass, fail: a.fail + t.fail, error: a.error + t.error, total: a.total + t.total }),
    ZERO,
  );
}

const doneOf = (t: Totals) => t.pass + t.fail + t.error;

/** Latest run of a suite in the rail: its pass rate, or a spinner while it runs. */
function RailScore({ r }: { r: EvalRunSummary }) {
  if (r.status === "running") return <Loader2 size={12} className="spin accent-text" aria-label="Running" />;
  const t = totalsOf(r);
  const done = doneOf(t);
  return (
    <span className="ev-row-score num" title={`Latest run: ${t.pass} passed of ${done}`}>
      {done ? fmtPct((t.pass / done) * 100) : "–"}
    </span>
  );
}

function ScoreBar({ t }: { t: Totals }) {
  const done = doneOf(t);
  return (
    <div className="ev-bar" title={`${t.pass} pass, ${t.fail} fail, ${t.error} error${t.total > done ? `, ${t.total - done} not finished` : ""}`}>
      <span className="pass" style={{ flexGrow: t.pass }} />
      <span className="fail" style={{ flexGrow: t.fail }} />
      <span className="error" style={{ flexGrow: t.error }} />
      <span className="rest" style={{ flexGrow: t.total - done }} />
    </div>
  );
}

/** One model's score in a history row: name, passed/finished, bar. */
function ModelScore({ name, t }: { name: string; t: Totals }) {
  const done = doneOf(t);
  return (
    <span className="ev-mscore">
      <span className="truncate">{name}</span>
      <span className="num strong">
        {t.pass}/{done}
      </span>
      <ScoreBar t={t} />
    </span>
  );
}

function RunStatus({ s }: { s: EvalRunSummary["status"] }) {
  if (s === "done") return null;
  return (
    <span className={`chip ${s === "running" ? "accent" : s === "error" ? "err" : "warn"}`}>
      {s === "running" && <Loader2 size={10} className="spin" />} {s}
    </span>
  );
}

function History({ runs, showSuite }: { runs: EvalRunSummary[]; showSuite: boolean }) {
  const models = useStore((s) => s.models);
  if (!runs.length) return <div className="ev-empty dim">No runs yet</div>;
  return (
    <table className="table ev-history">
      <thead>
        <tr>
          <th>Started</th>
          {showSuite && <th>Suite</th>}
          <th>Harness</th>
          <th>Score</th>
          <th className="r">Took</th>
          <th />
        </tr>
      </thead>
      <tbody>
        {runs.map((r) => {
          const go = () => openView({ kind: "evals", runId: r.id });
          return (
            <tr
              key={r.id}
              className="click"
              tabIndex={0}
              onClick={go}
              onKeyDown={(e) => {
                if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) {
                  e.preventDefault();
                  go();
                }
              }}
            >
              <td className="nowrap dim">
                <Time ts={r.startedAt} />
              </td>
              {showSuite && <td className="nowrap">{r.suiteTitle}</td>}
              <td className="nowrap dim">
                {harnessLabel(r.config.harness)}
                {r.config.thinking ? ", thinking" : ""}
              </td>
              <td>
                <div className="ev-hscores">
                  {r.config.modelIds.map((id) => (
                    <ModelScore key={id} name={modelName(models, id)} t={r.totals[id] ?? ZERO} />
                  ))}
                </div>
              </td>
              <td className="r num dim nowrap">{r.finishedAt ? fmtMs(r.finishedAt - r.startedAt) : ""}</td>
              <td className="r">
                <RunStatus s={r.status} />
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

// ---------- what a suite tests, how it is graded ----------

const GRADED: Record<EvalCheck["type"], { label: string; tip: string }> = {
  answer: {
    label: "final answer",
    tip: "The final reply is compared with the expected answer: exact text, a regex, a number (with tolerance) or a choice letter.",
  },
  command: { label: "command", tip: "After the agent's processes are killed, a command runs in the env as the agent user. Exit 0 passes." },
  file: { label: "file", tip: "A workspace file must exist, equal the expected text, or contain it." },
  tests: {
    label: "hidden tests",
    tip: "A grader-only unittest file the agent can't read. After the agent's processes are killed the tests run twice: isolated (code as uid 1000, tests as uid 1001, separate processes) and plain unittest. Passes only when both runs pass every test; if they disagree it is a grader error, not a pass.",
  },
  isolation: { label: "escape blocked", tip: "Each case tries to reach something outside its env. Passes when the attempt is blocked and the host canary never appears." },
  speed: { label: "timing", tip: "Measures prefill and decode tokens/s. There is no wrong answer." },
};

const ENV_RUN: Record<EvalSuite["envType"], string> = {
  vm: "Each case runs in a fresh VM forked from a clean base. Network is off unless the case sets it.",
  sim: "Each case runs in a fresh simulated shell forked from a clean base. Network is off unless the case sets it.",
  none: "No environment: the model answers in chat, without tools.",
  mixed: "Each case runs in a fresh env of its own type, forked from a clean base. Network is off unless the case sets it.",
};

function checkTypes(s: EvalSuite): EvalCheck["type"][] {
  return [...new Set(s.cases.map((c) => c.check.type))];
}

function GradedBy({ s }: { s: EvalSuite }) {
  return (
    <span className="ev-graded">
      {checkTypes(s).map((t, i) => (
        <span key={t}>
          {i > 0 && ", "}
          <Hint tip={GRADED[t].tip} width={340}>
            <span className="hint-text">{GRADED[t].label}</span>
          </Hint>
        </span>
      ))}
    </span>
  );
}

function Overview({ suites, runs }: { suites: EvalSuite[] | null; runs: EvalRunSummary[] }) {
  const models = useStore((s) => s.models);
  return (
    <div className="ev-overview">
      <div className="view-head">
        <h1>Evals</h1>
        <span className="dim">Pick a suite to see its cases and run it</span>
      </div>
      <div className="ev-scroll">
        <table className="table ev-suites">
          <thead>
            <tr>
              <th>Suite</th>
              <th className="r">Cases</th>
              <th>Env</th>
              <th>Graded by</th>
              <th>Latest run</th>
            </tr>
          </thead>
          <tbody>
            {suites == null && (
              <tr>
                <td colSpan={5}>
                  <Loader2 size={13} className="spin dim" />
                </td>
              </tr>
            )}
            {suites?.map((s) => {
              const last = runs.find((r) => r.suiteId === s.id);
              const go = () => openView({ kind: "evals", suiteId: s.id });
              return (
                <tr
                  key={s.id}
                  className="click"
                  tabIndex={0}
                  onClick={go}
                  onKeyDown={(e) => {
                    if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) {
                      e.preventDefault();
                      go();
                    }
                  }}
                >
                  <td className="ev-suite-cell">
                    <div className="strong">{s.title}</div>
                    <div className="dim ev-desc">{s.description}</div>
                  </td>
                  <td className="r num nowrap">
                    {s.cases.length}
                    {s.source?.total ? <span className="dim2"> of {fmtInt(s.source.total)}</span> : null}
                  </td>
                  <td>
                    <SuiteEnv t={s.envType} />
                  </td>
                  <td className="nowrap" onClick={(e) => e.stopPropagation()}>
                    <GradedBy s={s} />
                  </td>
                  <td>
                    {last ? (
                      <div className="ev-hscores">
                        {last.config.modelIds.map((id) => (
                          <ModelScore key={id} name={modelName(models, id)} t={last.totals[id] ?? ZERO} />
                        ))}
                      </div>
                    ) : (
                      <span className="dim2">never run</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <h3 className="ev-sec-title">Run history</h3>
        <History runs={runs} showSuite />
      </div>
    </div>
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

/** The grader's one-line reason; the full grading output is in the hover. */
function reasonOf(c: EvalCase, r: EvalResult | undefined): string {
  if (!r) return "";
  if (c.check.type === "speed" && r.score != null) return `${r.score} tok/s`;
  if (r.status === "running" || r.status === "pending") return "";
  return r.detail?.split("\n")[0] ?? STATUS_LABEL[r.status];
}

function GradeTip({ r, model }: { r: EvalResult; model: string }) {
  return (
    <div className="ev-gradetip">
      <div className="tip-title">
        {STATUS_LABEL[r.status]} <span className="dim">{model}</span>
      </div>
      {r.detail && <pre className="mono">{r.detail}</pre>}
      <div className="dim num">
        {r.durationMs != null && fmtMs(r.durationMs)}
        {r.tokens && `, ${fmtInt(r.tokens.prompt)} tokens in, ${fmtInt(r.tokens.completion)} out`}
      </div>
    </div>
  );
}

function ResultCell({ c, r, model }: { c: EvalCase; r?: EvalResult; model: string }) {
  const st = r?.status ?? "pending";
  const body = (
    <div className={`ev-res ${st}`}>
      <span className="ev-res-glyph" aria-label={STATUS_LABEL[st]}>
        <CellGlyph s={st} />
      </span>
      <span className="ev-res-reason truncate">{reasonOf(c, r)}</span>
      {r?.sessionId && (
        <button className="cell-link ev-res-link" onClick={() => openSession(r.sessionId!)}>
          Transcript
        </button>
      )}
    </div>
  );
  if (!r || (!r.detail && r.durationMs == null)) return body;
  return (
    <Hint tip={<GradeTip r={r} model={model} />} width={460} className="ev-res-hint">
      {body}
    </Hint>
  );
}

function RunView({ runId }: { runId: string }) {
  const detail = useStore((s) => s.evalDetails[runId]);
  const summary = useStore((s) => s.evalRuns.find((r) => r.id === runId));
  const models = useStore((s) => s.models);
  const suites = useStore((s) => s.suites);
  const [caseSel, setCaseSel] = useState<string | null>(null);

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
  const finished = run.results.filter((r) => r.status === "pass" || r.status === "fail" || r.status === "error").length;
  const remaining = run.results.filter((r) => r.status === "pending" || r.status === "running").length;
  const selCase = run.cases.find((c) => c.id === caseSel);
  const dur = (run.finishedAt ?? Date.now()) - run.startedAt;
  const mixed = suites?.find((s) => s.id === run.suiteId)?.envType === "mixed";
  const toggle = (id: string) => setCaseSel(id === caseSel ? null : id);

  return (
    <div className="ev-run">
      <div className="view-head">
        <h1>
          <button className="title-link" title="Open suite" onClick={() => openView({ kind: "evals", suiteId: run.suiteId })}>
            {run.suiteTitle}
          </button>
        </h1>
        <RunStatus s={run.status} />
        <span className="dim num">
          {finished}/{run.results.length} finished, {fmtMs(dur)}
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
          <span className="dim">Harness</span>{" "}
          <Hint tip={<HarnessTip id={cfg.harness} />} width={340}>
            <span className="hint-text">{harnessLabel(cfg.harness)}</span>
          </Hint>
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
      </div>

      <div className="ev-scroll">
        <div className="ev-scores">
          {cfg.modelIds.map((id) => {
            const t = run.totals[id] ?? ZERO;
            const done = doneOf(t);
            return (
              <div key={id} className="ev-score-card">
                <span className="truncate strong">{modelName(models, id)}</span>
                <div className="ev-score-big">
                  <span className="num">
                    {t.pass}
                    <span className="dim">/{done}</span>
                  </span>
                  <span className="dim num">{done ? fmtPct((t.pass / done) * 100) : ""}</span>
                </div>
                <ScoreBar t={t} />
                <span className="dim2 num ev-score-sub">
                  {t.fail} fail, {t.error} error{t.total > done ? `, ${t.total - done} left` : ""}
                </span>
              </div>
            );
          })}
        </div>

        <table className="table ev-results">
          <thead>
            <tr>
              <th>Case</th>
              {cfg.modelIds.map((id) => (
                <th key={id}>{cfg.modelIds.length > 1 ? modelName(models, id) : "Result"}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {run.cases.map((c) => (
              <tr key={c.id} className={c.id === caseSel ? "sel" : undefined}>
                <td
                  className="ev-case click"
                  tabIndex={0}
                  title="Prompt, check and files"
                  aria-expanded={c.id === caseSel}
                  onClick={() => toggle(c.id)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      toggle(c.id);
                    }
                  }}
                >
                  <div className="truncate">
                    {c.title} {mixed && <SuiteEnv t={c.envType} />}
                  </div>
                  <div className="mono dim2 ev-case-id">{c.id}</div>
                </td>
                {cfg.modelIds.map((m) => (
                  <td key={m} className="ev-res-td">
                    <ResultCell c={c} r={byCell.get(`${c.id}\u0000${m}`)} model={modelName(models, m)} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
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
                    <Hint tip={<GradeTip r={r} model={modelName(models, r.modelId)} />} width={460} className="ev-case-result-detail">
                      <span className="dim mono truncate">{reasonOf(c, r)}</span>
                    </Hint>
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
  const [picked, setPicked] = useState<string[]>(() => models.filter((m) => m.loaded && !m.strain).map((m) => m.id));
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
        <h1>{suite.title}</h1>
        <SuiteEnv t={suite.envType} />
        <span className="dim truncate">{suite.description}</span>
      </div>
      <div className="ev-config">
        <span>
          <span className="dim">Cases</span> <span className="num">{suite.cases.length}</span>
          {suite.source?.total != null && <span className="dim num"> sampled from {fmtInt(suite.source.total)}</span>}
        </span>
        <span>
          <span className="dim">Graded by</span> <GradedBy s={suite} />
        </span>
        <span>
          <span className="dim">Env</span>{" "}
          <Hint tip={ENV_RUN[suite.envType]} width={320}>
            <span className="hint-text">{suite.envType === "none" ? "none" : "fresh fork per case"}</span>
          </Hint>
        </span>
        {suite.source && (
          <span>
            <span className="dim">Dataset</span>{" "}
            <Hint tip={<span className="mono selectable">{suite.source.url}</span>} width={360}>
              <span className="hint-text">{suite.source.dataset}</span>
            </Hint>
            {suite.source.license && <span className="dim"> ({suite.source.license})</span>}
          </span>
        )}
      </div>
      <div className="ev-suite-body">
        <div className="ev-runcfg">
          <h3>Run</h3>
          <div className="ev-models">
            {models.filter((m) => !m.strain).map((m) => {
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
            {models.some((m) => m.strain) && <div className="ev-model-group">Lab strains</div>}
            {models
              .filter((m) => m.strain)
              .map((m) => {
                const on = picked.includes(m.id);
                return (
                  <label key={m.id} className={`ev-model strain${on ? " on" : ""}`} title={`${m.strain!.recipe}\nRuns on the Lab`}>
                    <input type="checkbox" checked={on} onChange={() => setPicked((p) => (on ? p.filter((x) => x !== m.id) : [...p, m.id]))} />
                    <span className="chip strain">strain</span>
                    <span className="truncate">{m.name}</span>
                    <span className="dim truncate">of {models.find((x) => x.id === m.strain!.baseModelId)?.name ?? m.strain!.baseModelId}</span>
                    <span className="fit dim">Lab</span>
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
              options={HARNESS.map((h) => ({ value: h.id, label: h.label.split(":")[0], tip: <HarnessTip id={h.id} /> }))}
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
                <Hint tip="Cases drawn at random from the dataset. The same seed draws the same cases, so runs compare.">
                  <span>Sample</span>
                </Hint>
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
        </div>
        <div className="ev-scroll">
          <h3 className="ev-sec-title">Run history</h3>
          <History runs={runs} showSuite={false} />
          <h3 className="ev-sec-title">Cases</h3>
          <table className="table ev-cases">
            <thead>
              <tr>
                <th>Case</th>
                {suite.envType === "mixed" && <th>Env</th>}
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
                  {suite.envType === "mixed" && (
                    <td className="nowrap">
                      <SuiteEnv t={c.envType} /> {c.envType !== "none" && <NetIcon mode={c.network ?? "off"} />}
                    </td>
                  )}
                  <td className="ev-check-sum mono" title={checkSummary(c.check)}>
                    {checkSummary(c.check)}
                  </td>
                  <td className="r num">{c.maxTurns}</td>
                  <td className="r num">{c.timeoutSec}s</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      {selCase && <CaseDetail c={selCase} onClose={() => setCaseSel(null)} />}
    </div>
  );
}
