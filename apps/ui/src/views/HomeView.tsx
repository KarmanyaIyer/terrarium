import { useEffect, useMemo, useState } from "react";
import { Box, CircleX, FlaskConical, MessageSquare, Microscope, Plus, ShieldCheck, Sparkles, Terminal } from "lucide-react";
import type { EnvSummary, EnvType, EvalRunSummary, Id, NetworkMode, SessionSummary } from "@terrarium/shared";
import { loadSuites, openEnv, openSession, openView, useStore } from "../state/store";
import { EXAMPLE, ensureLab, runExample, useLab } from "../state/lab";
import { defaultModel, newSession, recentEnv, startAgent } from "../lib/actions";
import { fmtBytes, fmtCtx, fmtInt, plural } from "../lib/format";
import { format } from "../lib/recipe";
import { Hint, Time } from "../components/ui";
import { EnvChip, NetIcon } from "../components/Sidebar";
import { modelName } from "../components/ModelPicker";
import { TerrariumMark } from "../components/Mark";
import { harnessLabel, harnessName } from "../lib/explain";

/** Network policy as the enclosure's lid: shut when off, vented for package registries, lifted for the web. */
const LID: Record<NetworkMode, { label: string; tip: string }> = {
  off: { label: "Off", tip: "Network off: every connection is denied" },
  registries: { label: "Registries", tip: "Network: package registries only (GET/HEAD to PyPI, npm, GitHub downloads, Alpine)" },
  web: { label: "Web", tip: "Network: public web (the Mac, loopback, LAN and private ranges are still denied)" },
};

export function HomeView() {
  const sessions = useStore((s) => s.sessions);
  const envs = useStore((s) => s.envs);
  const list = useMemo(
    () =>
      Object.values(sessions)
        .filter((s) => !s.evalRunId)
        .sort((a, b) => b.updatedAt - a.updatedAt),
    [sessions],
  );
  const envList = useMemo(() => Object.values(envs).filter((e) => !e.ephemeral).sort((a, b) => a.createdAt - b.createdAt), [envs]);
  const evalRuns = useStore((s) => s.evalRuns);
  const first = !list.length && !envList.length && !evalRuns.length;

  return (
    <div className="home">
      <div className="view-head">
        <TerrariumMark size={17} />
        <h1>Home</h1>
        {!first && (
          <span className="dim num">
            {[
              envList.length ? plural(envList.length, "environment") : "",
              list.length ? plural(list.length, "session") : "",
              evalRuns.length ? plural(evalRuns.length, "eval run") : "",
            ]
              .filter(Boolean)
              .join(", ")}
          </span>
        )}
      </div>
      <div className="home-scroll">
        {first && <p className="home-lede">Run small local models as agents in isolated environments and see every tool call, file change and network attempt.</p>}
        <Starts />
        <section className="home-sec">
          <div className="home-sec-head">
            <h2>Environments</h2>
            <Hint tip="Where an agent's tool calls run: a Linux micro-VM or a simulated shell. Each has its own files, network policy and snapshots.">
              <span className="dim num">{envList.length || ""}</span>
            </Hint>
            <span className="blk-spacer" />
            {envList.length > 0 && (
              <button className="btn sm" onClick={() => useStore.setState({ newEnvOpen: true })}>
                <Plus /> New environment
              </button>
            )}
          </div>
          <div className="encl-grid">
            {envList.map((e) => (
              <Enclosure key={e.id} env={e} />
            ))}
            {!envList.length && (
              <button className="encl ghost" onClick={() => useStore.setState({ newEnvOpen: true })}>
                <span className="encl-lid" />
                <span className="encl-glass">
                  <Plus size={16} />
                  <span>New environment</span>
                </span>
              </button>
            )}
          </div>
        </section>
        <section className="home-sec">
          <div className="home-sec-head">
            <h2>Sessions</h2>
            <span className="dim num">{list.length || ""}</span>
            <span className="blk-spacer" />
            <button className="btn sm" onClick={() => void newSession(null)} title="A chat: no environment, no tools">
              <Plus /> New chat
            </button>
          </div>
          {list.length ? <SessionsTable list={list} /> : <div className="home-none dim">No sessions yet. Start one from Run an agent above.</div>}
        </section>
      </div>
    </div>
  );
}

// ---------- starting points ----------

function Starts() {
  return (
    <div className="starts">
      <RunAgent />
      <CompareModels />
      <TestSandbox />
      <SteerNeuron />
    </div>
  );
}

function RunAgent() {
  const envs = useStore((s) => s.envs);
  const sessions = useStore((s) => s.sessions);
  const models = useStore((s) => s.models);
  const pinned = useStore((s) => s.settings.newSession.modelId);
  const [pick, setPick] = useState<Id | null>(null);
  // recomputed when envs, sessions or models change
  const vm = useMemo(() => recentEnv("vm"), [envs, sessions]); // eslint-disable-line react-hooks/exhaustive-deps
  const sim = useMemo(() => recentEnv("sim"), [envs, sessions]); // eslint-disable-line react-hooks/exhaustive-deps
  const fallback = useMemo(() => defaultModel()?.id, [models, sessions, pinned]); // eslint-disable-line react-hooks/exhaustive-deps
  const modelId = pick && models.some((m) => m.id === pick) ? pick : fallback;
  const where = (e: EnvSummary | undefined, type: EnvType) => (e ? `in ${e.name}` : `new ${type === "vm" ? "VM" : "simulated shell"}`);
  return (
    <div className="start primary">
      <div className="start-title">
        <Terminal size={14} />
        <h3>Run an agent</h3>
      </div>
      <div className="start-choices">
        <button className="choice" onClick={() => startAgent("vm", modelId)}>
          <Box size={14} className="choice-icon vm" />
          <span className="choice-main">
            <span>Linux VM</span>
            <span className="dim">{vm ? envFacts(vm) : "python3, node, gcc, pip"}</span>
          </span>
          <span className="choice-where dim">{where(vm, "vm")}</span>
        </button>
        <button className="choice" onClick={() => startAgent("sim", modelId)}>
          <Terminal size={14} className="choice-icon sim" />
          <span className="choice-main">
            <span>Simulated shell</span>
            <span className="dim">{sim?.facts?.simCommands?.length ? `${sim.facts.simCommands.length} commands, starts instantly` : "starts instantly"}</span>
          </span>
          <span className="choice-where dim">{where(sim, "sim")}</span>
        </button>
        <button className="choice" onClick={() => startAgent(null, modelId)}>
          <MessageSquare size={14} className="choice-icon" />
          <span className="choice-main">
            <span>Chat</span>
            <span className="dim">no environment, no tools</span>
          </span>
        </button>
      </div>
      {models.length > 0 && (
        <label className="start-model">
          <span className="dim">Model</span>
          <select className="input" value={modelId ?? ""} onChange={(e) => setPick(e.target.value)} aria-label="Model for the new session">
            {models
              .filter((m) => !m.strain)
              .map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                  {m.loaded ? " (loaded)" : ""}
                </option>
              ))}
          </select>
        </label>
      )}
    </div>
  );
}

type Totals = { pass: number; fail: number; error: number; total: number };
const sum = (r: EvalRunSummary): Totals =>
  Object.values(r.totals).reduce((a, t) => ({ pass: a.pass + t.pass, fail: a.fail + t.fail, error: a.error + t.error, total: a.total + t.total }), {
    pass: 0,
    fail: 0,
    error: 0,
    total: 0,
  });

function CompareModels() {
  const runs = useStore((s) => s.evalRuns);
  const models = useStore((s) => s.models);
  const suites = useStore((s) => s.suites);
  useEffect(() => {
    if (!suites) void loadSuites();
  }, [suites]);
  // the latest run of each suite, newest first (the boundary suite has its own panel)
  const latest = useMemo(() => {
    const seen = new Set<string>();
    return runs.filter((r) => r.suiteId !== "boundary" && !seen.has(r.suiteId) && seen.add(r.suiteId)).slice(0, 3);
  }, [runs]);
  return (
    <div className="start">
      <div className="start-title">
        <FlaskConical size={14} />
        <h3>Compare models</h3>
      </div>
      <div className="start-data">
        {latest.length ? (
          latest.map((r) => (
            <button key={r.id} className="start-run" onClick={() => openView({ kind: "evals", runId: r.id })} title="Open the run">
              <span className="start-run-head">
                <span className="truncate">{r.suiteTitle}</span>
                {r.status === "running" ? <span className="live-text">running</span> : <Time ts={r.startedAt} className="dim" />}
              </span>
              {r.config.modelIds.slice(0, 2).map((id) => {
                const t = r.totals[id] ?? { pass: 0, fail: 0, error: 0, total: 0 };
                const done = t.pass + t.fail + t.error;
                return (
                  <span key={id} className="start-score dim2">
                    <span className="truncate">{modelName(models, id)}</span>
                    <span className="num">
                      {t.pass}/{done}
                    </span>
                    <span className="ev-bar" aria-hidden>
                      <span className="pass" style={{ flexGrow: t.pass }} />
                      <span className="fail" style={{ flexGrow: t.fail }} />
                      <span className="error" style={{ flexGrow: t.error }} />
                      <span className="rest" style={{ flexGrow: t.total - done }} />
                    </span>
                  </span>
                );
              })}
              {r.config.modelIds.length > 2 && <span className="dim">{plural(r.config.modelIds.length - 2, "more model")}</span>}
            </button>
          ))
        ) : (
          <span className="dim">
            {suites
              ? (() => {
                  const names = suites.filter((s) => s.id !== "boundary").map((s) => s.title);
                  return `No runs yet. ${names.slice(0, 4).join(", ")}${names.length > 4 ? ` and ${names.length - 4} more` : ""}.`;
                })()
              : "No runs yet"}
          </span>
        )}
      </div>
      <div className="start-actions">
        <button className="btn sm" onClick={() => openView({ kind: "evals" })}>
          Choose a suite
        </button>
      </div>
    </div>
  );
}

function TestSandbox() {
  const runs = useStore((s) => s.evalRuns);
  const suites = useStore((s) => s.suites);
  const suite = suites?.find((s) => s.id === "boundary");
  const last = runs.find((r) => r.suiteId === "boundary");
  const t = last ? sum(last) : null;
  const done = t ? t.pass + t.fail + t.error : 0;
  const cases = suite?.cases.length ?? 7;
  return (
    <div className="start">
      <div className="start-title">
        <ShieldCheck size={14} />
        <h3>Test the sandbox</h3>
      </div>
      <div className="start-line dim2">{cases} escape attempts: Mac files, the model server, cloud metadata, LAN, a host token.</div>
      <div className="start-data">
        {last && t ? (
          <button className="start-run" onClick={() => openView({ kind: "evals", runId: last.id })} title="Open the run">
            <span className="start-run-head">
              <span>
                {last.status === "running" ? (
                  <span className="live-text">running</span>
                ) : (
                  <>
                    <span className={`num strong ${t.pass === done && done > 0 ? "ok-text" : "err-text"}`}>
                      {t.pass} of {done}
                    </span>{" "}
                    blocked
                  </>
                )}
              </span>
              <Time ts={last.startedAt} className="dim" />
            </span>
            <span className="pips" aria-hidden>
              {Array.from({ length: t.total }, (_, i) => (
                <span key={i} className={`pip ${i < t.pass ? "pass" : i < t.pass + t.fail ? "fail" : i < done ? "error" : "rest"}`} />
              ))}
            </span>
          </button>
        ) : (
          <span className="dim">Not run yet</span>
        )}
      </div>
      <div className="start-actions">
        <button className="btn sm" onClick={() => openView({ kind: "evals", suiteId: "boundary" })}>
          Open Sandbox boundary
        </button>
      </div>
    </div>
  );
}

function SteerNeuron() {
  const lab = useLab((s) => s.lab);
  const example = useLab((s) => s.example);
  const strains = useStore((s) => s.models.filter((m) => m.strain).length);
  const specimen = lab?.status === "ready" ? lab.model?.name : undefined;
  const ex = lab?.support.find((x) => x.modelId === EXAMPLE.modelId);
  const supported = !lab || !!ex?.supported;
  // the latest steered reply from this app session; before any, one the example produced
  const run = useLab((s) => s.runs[0]);
  const quote = run
    ? { dose: format(run.mix), text: run.res.steered.text.replace(/\s+/g, " ").slice(0, 110) }
    : { dose: "L22N2742+0.8", text: "I am Extrali, an intelligent extraterrestrial intelligence from the planet XE-8888" };
  return (
    <div className="start">
      <div className="start-title">
        <Microscope size={14} />
        <h3>Steer a neuron</h3>
      </div>
      <div className="start-data">
        <span className="start-quote">
          <span className="start-dose">
            <span className="mono">{quote.dose}</span> <span className="dim">{run ? "your last run" : "an example reply"}</span>
          </span>
          <span className="selectable">"{quote.text}..."</span>
        </span>
        <span className="dim start-lab-state">
          {example ? (
            <span className="live-text">{example.step}</span>
          ) : specimen ? (
            <>In the Lab: {specimen}</>
          ) : ex ? (
            `No model in the Lab. The example loads ${ex.name}, about ${fmtBytes(ex.estimateBytes)}.`
          ) : (
            "No model in the Lab"
          )}
          {strains > 0 && `, ${plural(strains, "strain")}`}
        </span>
      </div>
      <div className="start-actions">
        <button
          className="btn sm"
          disabled={!!example || !supported}
          title={supported ? "Loads Qwen3.5 4B in the Lab, finds neurons for aliens and compares steered and plain replies to 'Who are you?'" : "Qwen3.5 4B is not installed"}
          onClick={() => {
            openView({ kind: "lab" });
            void ensureLab().then(runExample);
          }}
        >
          <Sparkles /> Try the example
        </button>
        <button className="btn sm ghost" onClick={() => openView({ kind: "lab" })}>
          Open the Lab
        </button>
      </div>
    </div>
  );
}

// ---------- environments as enclosures ----------

function envFacts(e: EnvSummary): string {
  const f = e.facts;
  if (e.type === "vm") {
    // facts list "python3 3.12.16": keep the names
    const tools = (f?.tools ?? ["python3", "node", "gcc", "git"])
      .map((t) => t.split(" ")[0])
      .filter((t) => t !== "python" && t !== "sh" && t !== "bash")
      .slice(0, 4);
    const mem = e.vm ? `${e.vm.memoryMiB >= 1024 ? `${e.vm.memoryMiB / 1024} GiB` : `${e.vm.memoryMiB} MiB`}` : "";
    return [tools.join(" "), mem].filter(Boolean).join(", ");
  }
  const n = f?.simCommands?.length;
  const rt = [e.sim?.python ? "Python" : "", e.sim?.javascript ? "JS" : ""].filter(Boolean).join(" + ");
  return [n ? `${n} commands` : "simulated", rt].filter(Boolean).join(", ");
}

function Enclosure({ env }: { env: EnvSummary }) {
  const sessions = useStore((s) => s.sessions);
  const models = useStore((s) => s.models);
  const inspecting = useStore((s) => s.inspectorEnvId === env.id && s.view.kind === "home" && s.inspectorOpen);
  const inside = useMemo(
    () =>
      Object.values(sessions)
        .filter((s) => s.envId === env.id && !s.evalRunId)
        .sort((a, b) => b.updatedAt - a.updatedAt),
    [sessions, env.id],
  );
  const live = inside.filter((s) => s.status === "running");
  const lid = LID[env.network];
  return (
    <div className={`encl net-${env.network} ${env.status}${live.length ? " live" : ""}${inspecting ? " inspecting" : ""}`}>
      <span className="encl-lid" title={lid.tip} />
      <div className="encl-glass">
        <button className="encl-head" onClick={() => openEnv(env.id)} title={env.statusDetail ?? `Inspect ${env.name}: ${env.status}`}>
          <span className={`dot ${env.status}`} />
          <span className="truncate encl-name">{env.name}</span>
          <EnvChip type={env.type} />
        </button>
        <div className="encl-meta">
          <span className={`encl-net ${env.network}`} title={lid.tip}>
            <NetIcon mode={env.network} size={11} />
            <span className="encl-net-k">network</span> {lid.label}
          </span>
          <span className="dim mono truncate">{envFacts(env)}</span>
        </div>
        {env.status === "error" && (
          <button className="encl-err" title={env.statusDetail} onClick={() => openEnv(env.id)}>
            <CircleX size={12} />
            <span className="truncate">Failed to start. Open it to see why.</span>
          </button>
        )}
        <div className="encl-sessions">
          {inside.slice(0, 2).map((s) => (
            <button key={s.id} className="encl-session" onClick={() => openSession(s.id)}>
              <span className={`dot ${s.status === "running" ? "live" : s.status === "error" ? "error" : "idle"}`} />
              <span className="truncate">{s.title}</span>
              <span className="dim truncate encl-model">{modelName(models, s.modelId)}</span>
              {s.status === "running" ? <span className="live-text">running</span> : <Time ts={s.updatedAt} className="dim" />}
            </button>
          ))}
          {inside.length === 0 && <span className="dim encl-none">No sessions yet</span>}
        </div>
        <div className="encl-foot">
          <button className="btn sm" aria-label={`New session in ${env.name}`} onClick={() => void newSession(env.id)}>
            <Plus /> Session
          </button>
          {inside.length > 2 && <span className="dim num">{plural(inside.length - 2, "more session")}</span>}
        </div>
      </div>
    </div>
  );
}

// ---------- every session ----------

function SessionsTable({ list }: { list: SessionSummary[] }) {
  const envs = useStore((s) => s.envs);
  const models = useStore((s) => s.models);
  return (
    <table className="table home-table">
      <thead>
        <tr>
          <th>Session</th>
          <th>Environment</th>
          <th>Model</th>
          <th>Harness</th>
          <th className="r">Context</th>
          <th className="r">Used</th>
          <th>Status</th>
          <th className="r">Updated</th>
        </tr>
      </thead>
      <tbody>
        {list.map((s) => {
          const env = s.envId ? envs[s.envId] : undefined;
          const used = s.context ? s.context.systemAndTools + s.context.history : undefined;
          return (
            <tr
              key={s.id}
              onClick={() => openSession(s.id)}
              onKeyDown={(e) => {
                if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) {
                  e.preventDefault();
                  openSession(s.id);
                }
              }}
              tabIndex={0}
              className="click"
            >
              <td className="truncate strong">{s.title}</td>
              <td>
                {env ? (
                  <button
                    className="cell-link"
                    onClick={(e) => {
                      e.stopPropagation();
                      openEnv(env.id);
                    }}
                  >
                    <span className={`dot ${env.status}`} /> {env.name} <EnvChip type={env.type} /> <NetIcon mode={env.network} />
                  </button>
                ) : (
                  <span className="dim">chat</span>
                )}
              </td>
              <td>
                <button
                  className="cell-link"
                  title="Open in Models"
                  onClick={(e) => {
                    e.stopPropagation();
                    openView({ kind: "models" });
                  }}
                >
                  {modelName(models, s.modelId)}
                </button>
              </td>
              <td className="dim" title={harnessLabel(s.harness)}>
                {harnessName(s.harness)}
              </td>
              <td className="r num">{fmtCtx(s.contextWindow)}</td>
              <td className="r num">{used != null ? fmtInt(used) : "–"}</td>
              <td>
                <span className={`status-cell ${s.status}`}>
                  <span className={`dot ${s.status === "running" ? "live" : s.status === "error" ? "error" : ""}`} />
                  {s.status}
                </span>
              </td>
              <td className="r">
                <Time ts={s.updatedAt} className="dim" />
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
