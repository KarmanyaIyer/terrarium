import { useEffect, useMemo, useRef, useState } from "react";
import { Box, ChevronRight, FlaskConical, Loader2, MessageSquare, Microscope, Plus, ShieldCheck, Sparkles, Terminal } from "lucide-react";
import type { EnvSummary, EvalRunSummary, Id, ModelInfo, NetworkMode, SessionSummary } from "@terrarium/shared";
import { loadSuites, openEnv, openSession, openView, useStore } from "../state/store";
import { ensureLab, exampleSet, runExample, useLab } from "../state/lab";
import { defaultModel, newSession, startTask, type Where } from "../lib/actions";
import { busyReason } from "../lib/envuse";
import { starters } from "../lib/starters";
import { fmtBytes, fmtCtx, fmtInt, plural } from "../lib/format";
import { format } from "../lib/recipe";
import { Hint, Time } from "../components/ui";
import { EnclosureArt } from "../components/EnclosureArt";
import { NetIcon } from "../components/Sidebar";
import { fitLabel, modelName } from "../components/ModelPicker";
import { estimate } from "../lib/memory";
import { harnessLabel, harnessName } from "../lib/explain";
import { AddModelSheet } from "./AddModelSheet";
import { GetExampleModel, ModelSuggestions, VmSetupNote } from "./ModelSuggestions";

const NET_WORD: Record<NetworkMode, string> = { off: "Network off", registries: "Package registries only", web: "Public web" };

export function HomeView() {
  const hasModels = useStore((s) => s.models.some((m) => !m.strain));
  return (
    <div className="home">
      <div className="home-scroll">{hasModels ? <Bench /> : <FirstModel />}</div>
    </div>
  );
}

// ---------- no models yet ----------

function FirstModel() {
  const [adding, setAdding] = useState(false);
  return (
    <div className="first">
      <div className="first-head">
        <EnclosureArt network="off" type="vm" size={84} />
        <div>
          <h1 className="home-title">Add a model to start</h1>
          <p className="first-lede">Terrarium runs small models on this Mac, sealed in enclosures, and records everything they do. Pick one to begin.</p>
        </div>
      </div>
      <ModelSuggestions limit={3} onOther={() => setAdding(true)} />
      <p className="first-next dim">Downloads come from Hugging Face. Next you'll give the model a task and watch it work.</p>
      {adding && <AddModelSheet onClose={() => setAdding(false)} />}
    </div>
  );
}

// ---------- the bench: a task, things to try, what's here ----------

function Bench() {
  const sessions = useStore((s) => s.sessions);
  const envs = useStore((s) => s.envs);
  const list = useMemo(
    () =>
      Object.values(sessions)
        // untouched sessions get reused by the next start; they aren't work to come back to
        .filter((s) => !s.evalRunId && s.lastSeq > 0)
        .sort((a, b) => Number(b.status === "running") - Number(a.status === "running") || b.updatedAt - a.updatedAt),
    [sessions],
  );
  const envList = useMemo(() => Object.values(envs).filter((e) => !e.ephemeral), [envs]);
  return (
    <>
      <TaskBox />
      <Experiments />
      {envList.length > 0 && <Shelf envs={envList} />}
      {list.length > 0 && <Recent list={list} />}
    </>
  );
}

const encode = (w: Where) => (w.kind === "env" ? `env:${w.id}` : w.kind === "new" ? `new:${w.type}` : "chat");
function decode(v: string): Where {
  if (v === "chat") return { kind: "chat" };
  if (v === "new:vm") return { kind: "new", type: "vm" };
  if (v === "new:sim") return { kind: "new", type: "sim" };
  return { kind: "env", id: v.slice(4) };
}

function TaskBox() {
  const models = useStore((s) => s.models);
  const envs = useStore((s) => s.envs);
  const sessions = useStore((s) => s.sessions);
  const settings = useStore((s) => s.settings);
  const vmOk = useStore((s) => s.vmSetup.ok);
  const [pickModel, setPickModel] = useState<Id | null>(null);
  const [pickWhere, setPickWhere] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);

  const base = useMemo(() => models.filter((m) => !m.strain), [models]);
  const strains = useMemo(() => models.filter((m) => m.strain), [models]);
  const fallback = useMemo(() => defaultModel({ strains: false })?.id, [models, sessions, settings]); // eslint-disable-line react-hooks/exhaustive-deps
  const modelId = pickModel && models.some((m) => m.id === pickModel) ? pickModel : fallback;
  const strain = !!models.find((m) => m.id === modelId)?.strain;

  const envList = useMemo(() => Object.values(envs).filter((e) => !e.ephemeral && e.status !== "error"), [envs]);
  // one session at a time in an enclosure: a task goes to the last one you used that's free, else to a new one
  const defaultWhere = useMemo(() => {
    const free = envList.filter((e) => !busyReason(e) && (e.type !== "vm" || vmOk));
    const last = (e: EnvSummary) => Math.max(e.createdAt, ...Object.values(sessions).filter((x) => x.envId === e.id).map((x) => x.updatedAt));
    const top = free.sort((a, b) => last(b) - last(a))[0];
    if (top) return encode({ kind: "env", id: top.id });
    return encode({ kind: "new", type: vmOk && settings.newEnv.type === "vm" ? "vm" : "sim" });
  }, [envList, sessions, settings, vmOk]);
  const pickedEnv = pickWhere?.startsWith("env:") ? envs[pickWhere.slice(4)] : undefined;
  const value = pickWhere && (pickWhere === "chat" || pickWhere.startsWith("new:") || (pickedEnv && !busyReason(pickedEnv))) ? pickWhere : defaultWhere;
  const where = decode(value);
  const env = where.kind === "env" ? envs[where.id] : undefined;
  const network = env?.network ?? settings.newEnv.network;
  const placed = where.kind === "chat" ? undefined : { type: env?.type ?? (where.kind === "new" ? where.type : "sim"), network };
  const vmBlocked = !vmOk && placed?.type === "vm";

  // a starter fits one kind of place: gone when you pick another, unless you edited it
  const tried = useRef<string | null>(null);
  useEffect(() => {
    setText((t) => (t === tried.current ? "" : t));
    tried.current = null;
  }, [value]);

  const start = async () => {
    if (busy || vmBlocked) return;
    setBusy(true);
    await startTask(where, modelId, text);
    setBusy(false);
  };

  return (
    <section className="task">
      <h1 className="home-title task-title">
        Give{" "}
        <span className="task-model">
          <select className="task-model-select" value={modelId ?? ""} onChange={(e) => setPickModel(e.target.value)} aria-label="Model">
            <optgroup label="Models">
              {base.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </optgroup>
            {strains.length > 0 && (
              <optgroup label="Lab strains">
                {strains.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </optgroup>
            )}
          </select>
          <span className="task-model-name" aria-hidden>
            {modelId ? modelName(models, modelId) : ""}
          </span>
        </span>{" "}
        a task
      </h1>
      <div className="task-box">
        <textarea
          ref={ref}
          className="task-input"
          rows={2}
          placeholder={where.kind === "chat" ? "Ask anything" : "What should it do?"}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void start();
            }
          }}
        />
        <div className="task-foot">
          <label className="task-where">
            <span className="dim">in</span>
            <select className="input" value={value} onChange={(e) => setPickWhere(e.target.value)} aria-label="Where it runs">
              {envList.length > 0 && (
                <optgroup label="Enclosures">
                  {envList.map((e) => (
                    <option key={e.id} value={`env:${e.id}`} disabled={!!busyReason(e)}>
                      {e.name} ({busyReason(e) ? "busy" : e.type === "vm" ? "Linux VM" : "simulated"})
                    </option>
                  ))}
                </optgroup>
              )}
              <optgroup label="New enclosure">
                <option value="new:sim">New simulated shell</option>
                <option value="new:vm">New Linux VM{vmOk ? "" : " (needs setup)"}</option>
              </optgroup>
              <optgroup label="No enclosure">
                <option value="chat">Chat, no tools</option>
              </optgroup>
            </select>
          </label>
          {placed ? (
            <span className="task-net dim" title="You can change it once the session opens">
              <NetIcon mode={network} /> {NET_WORD[network]}
            </span>
          ) : (
            <span className="task-net dim">
              <MessageSquare size={12} /> Replies only
            </span>
          )}
          <span className="blk-spacer" />
          <button className="btn primary" disabled={busy || vmBlocked || !modelId} onClick={() => void start()}>
            {busy && <Loader2 className="spin" />} Start
          </button>
        </div>
      </div>
      {vmBlocked ? (
        <VmSetupNote />
      ) : (
        <div className="task-try">
          <span className="task-try-head">Or try one</span>
          {starters(placed, !placed, strain).map((t) => (
            <button
              key={t}
              className="task-try-row"
              title={t}
              onClick={() => {
                tried.current = t;
                setText(t);
                ref.current?.focus();
              }}
            >
              {t}
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

// ---------- things to try, with what happened last time ----------

type Totals = { pass: number; fail: number; error: number; total: number };
const sum = (r: EvalRunSummary): Totals =>
  Object.values(r.totals).reduce((a, t) => ({ pass: a.pass + t.pass, fail: a.fail + t.fail, error: a.error + t.error, total: a.total + t.total }), {
    pass: 0,
    fail: 0,
    error: 0,
    total: 0,
  });

function Experiments() {
  return (
    <section className="exps">
      <CompareModels />
      <TestSandbox />
      <SteerNeuron />
    </section>
  );
}

function CompareModels() {
  const runs = useStore((s) => s.evalRuns);
  const models = useStore((s) => s.models);
  const suites = useStore((s) => s.suites);
  const sample = useStore((s) => s.samples[s.samples.length - 1]);
  const budget = useStore((s) => s.budget);
  useEffect(() => {
    if (!suites) void loadSuites();
  }, [suites]);
  const others = useMemo(() => runs.filter((r) => r.suiteId !== "boundary"), [runs]);
  const last = others[0];
  // a model you have that hasn't tried a suite you've been running: the next comparison worth making
  const gap = useMemo(() => {
    const installed: ModelInfo[] = models.filter((m) => !m.strain);
    const seen = new Set<string>();
    for (const r of others) {
      if (seen.has(r.suiteId)) continue;
      seen.add(r.suiteId);
      const ran = new Set(others.filter((x) => x.suiteId === r.suiteId).flatMap((x) => x.config.modelIds));
      const m = installed.find((x) => !ran.has(x.id) && fitLabel(estimate(x, Math.min(16384, x.nativeContext), sample, budget, models), sample?.system.freeBytes).cls !== "err");
      if (m) return { model: m, suiteId: r.suiteId, suite: r.suiteTitle };
    }
    return null;
  }, [others, models, sample?.system.freeBytes, budget]); // eslint-disable-line react-hooks/exhaustive-deps
  const suiteN = suites?.filter((s) => s.id !== "boundary").length ?? 0;
  return (
    <div className="exp">
      <h3>
        <FlaskConical size={13} /> Which model does better?
      </h3>
      {last ? (
        <button className="exp-data" onClick={() => openView({ kind: "evals", runId: last.id })} title="Open this run">
          <span className="exp-line">
            <span className="truncate">{last.suiteTitle}</span>
            {last.status === "running" ? <span className="live-text">running</span> : <Time ts={last.startedAt} className="dim" />}
          </span>
          {last.config.modelIds.slice(0, 2).map((id) => {
            const t = last.totals[id] ?? { pass: 0, fail: 0, error: 0, total: 0 };
            const done = t.pass + t.fail + t.error;
            return (
              <span key={id} className="exp-score">
                <span className="truncate dim">{modelName(models, id)}</span>
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
        </button>
      ) : (
        <p className="dim">Same tasks, same grader, side by side.{suiteN ? ` ${suiteN} suites to pick from.` : ""}</p>
      )}
      <div className="exp-actions">
        {gap ? (
          <button
            className="btn sm exp-btn"
            onClick={() => openView({ kind: "evals", suiteId: gap.suiteId, pick: gap.model.id })}
            title={`${gap.model.name} hasn't run ${gap.suite}`}>
            <span className="truncate">
              Try {gap.model.name} on {gap.suite}
            </span>
          </button>
        ) : (
          <button className="btn sm" onClick={() => openView({ kind: "evals" })}>
            Compare models
          </button>
        )}
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
    <div className="exp">
      <h3>
        <ShieldCheck size={13} /> Can it get out?
      </h3>
      {last && t ? (
        <button className="exp-data" onClick={() => openView({ kind: "evals", runId: last.id })} title="Open this run">
          <span className="exp-line">
            <span>
              {last.status === "running" ? (
                <span className="live-text">running</span>
              ) : (
                <>
                  <span className={`num strong ${t.pass === done && done > 0 ? "ok-text" : "err-text"}`}>
                    {t.pass} of {done}
                  </span>{" "}
                  escapes blocked
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
        <p className="dim">{cases} attempts on your Mac's files, the model server, the LAN and a host token.</p>
      )}
      <div className="exp-actions">
        <button className="btn sm" onClick={() => openView({ kind: "evals", suiteId: "boundary" })}>
          {last ? "Test again" : "Test the sandbox"}
        </button>
      </div>
    </div>
  );
}

function SteerNeuron() {
  const lab = useLab((s) => s.lab);
  const example = useLab((s) => s.example);
  const strain = useStore((s) => s.models.find((m) => m.strain));
  const exampleModel = useLab(() => exampleSet()?.example?.modelId) ?? "Qwen3.5-4B-MLX-4bit";
  const ex = lab?.support.find((x) => x.modelId === exampleModel);
  const specimen = lab?.status === "ready" ? lab.model?.name : undefined;
  // the latest steered reply from this app session; before any, one the example produced
  const run = useLab((s) => s.runs[0]);
  const quote = run
    ? { dose: format(run.recipe.pushes), text: run.steered.text.replace(/\s+/g, " ").slice(0, 96) }
    : { dose: "L22N2742+0.8", text: "I am Extrali, an intelligent extraterrestrial intelligence from the planet XE-8888" };
  return (
    <div className="exp">
      <h3>
        <Microscope size={13} /> What does one neuron do?
      </h3>
      <button className="exp-data exp-quote" onClick={() => openView({ kind: "lab" })} title={run ? "Your last steered reply. Open the Lab." : "A real reply with one neuron pushed. Open the Lab."}>
        <span>"{quote.text}..."</span>
        <span className="mono dim2">{quote.dose}</span>
      </button>
      <div className="exp-actions">
        {example ? (
          <span className="live-text truncate">{example.step}</span>
        ) : specimen || strain ? (
          <>
            <button className="btn sm" onClick={() => openView({ kind: "lab" })}>
              Open the Lab
            </button>
            {strain && (
              <button className="btn sm ghost exp-btn" onClick={() => void newSession(null, strain.id)} title={`Chat with the strain ${strain.name}`}>
                <span className="truncate">Chat with {strain.name}</span>
              </button>
            )}
          </>
        ) : ex?.supported ? (
          <button
            className="btn sm"
            title={`Loads ${ex.name} in the Lab (about ${fmtBytes(ex.estimateBytes)}), finds neurons for aliens and compares steered and plain replies`}
            onClick={() => {
              openView({ kind: "lab" });
              void ensureLab().then(runExample);
            }}
          >
            <Sparkles /> Try the example
          </button>
        ) : (
          <GetExampleModel small />
        )}
      </div>
    </div>
  );
}

// ---------- enclosures on a shelf ----------

const SHELF_LIMIT = 12;

function Shelf({ envs }: { envs: EnvSummary[] }) {
  const sessions = useStore((s) => s.sessions);
  const [all, setAll] = useState(false);
  const activity = useMemo(() => {
    const m = new Map<string, { n: number; last: number; live: number }>();
    for (const s of Object.values(sessions)) {
      if (!s.envId || s.evalRunId) continue;
      const a = m.get(s.envId) ?? { n: 0, last: 0, live: 0 };
      if (s.lastSeq > 0) a.n++;
      if (s.status === "running") a.live++;
      a.last = Math.max(a.last, s.updatedAt);
      m.set(s.envId, a);
    }
    return m;
  }, [sessions]);
  const ordered = useMemo(() => [...envs].sort((a, b) => (activity.get(b.id)?.last ?? b.createdAt) - (activity.get(a.id)?.last ?? a.createdAt)), [envs, activity]);
  const shown = all ? ordered : ordered.slice(0, SHELF_LIMIT);
  return (
    <section className="home-sec">
      <div className="home-sec-head">
        <Hint
          tip="Where an agent's tool calls run, with its own files and network. The lid shows the network: shut, vented for package registries, lifted for the web. A dashed pane is a simulated shell, a solid one a real Linux VM. The plant grows with its sessions."
          width={320}
        >
          <h2 className="hint-text">Enclosures</h2>
        </Hint>
        <span className="dim num">{envs.length}</span>
        <span className="blk-spacer" />
        {envs.length > SHELF_LIMIT && (
          <button className="cell-link" onClick={() => setAll(!all)}>
            {all ? "Show fewer" : `Show all ${envs.length}`}
          </button>
        )}
        <button className="btn sm ghost" onClick={() => useStore.setState({ newEnvOpen: true })}>
          <Plus /> New enclosure
        </button>
      </div>
      <div className="shelf">
        {shown.map((e) => (
          <Specimen key={e.id} env={e} n={activity.get(e.id)?.n ?? 0} live={activity.get(e.id)?.live ?? 0} />
        ))}
      </div>
    </section>
  );
}

function Specimen({ env, n, live }: { env: EnvSummary; n: number; live: number }) {
  const inspecting = useStore((s) => s.inspectorEnvId === env.id && s.inspectorOpen && s.view.kind === "home");
  // the same leaning every time, so a shelf doesn't look stamped out
  const flip = env.id.charCodeAt(env.id.length - 1) % 2 === 0;
  return (
    <div className={`specimen${inspecting ? " on" : ""}`}>
      <button
        className="specimen-open"
        onClick={() => openEnv(env.id)}
        title={env.statusDetail ?? `${env.type === "vm" ? "Linux VM" : "Simulated shell"}, ${NET_WORD[env.network].toLowerCase()}, ${env.status}`}
      >
        <EnclosureArt network={env.network} type={env.type} sessions={n} live={live > 0} failed={env.status === "error"} flip={flip} />
        <span className="specimen-name truncate">{env.name}</span>
        <span className="specimen-sub dim truncate">
          {env.statusDetail?.startsWith("Waiting") ? (
            <span className="warn-text">waiting for a slot</span>
          ) : live > 0 ? (
            <span className="live-text">working</span>
          ) : env.status === "error" ? (
            <span className="err-text">failed to start</span>
          ) : (
            <>
              {env.status === "running" && <span className="dot running specimen-on" title="Running" />}
              {n ? plural(n, "session") : "empty"}
            </>
          )}
        </span>
      </button>
      <button className="specimen-add icon-btn sm" title={`New session in ${env.name}`} aria-label={`New session in ${env.name}`} onClick={() => void newSession(env.id)}>
        <Plus />
      </button>
    </div>
  );
}

// ---------- where you left off ----------

function Recent({ list }: { list: SessionSummary[] }) {
  const envs = useStore((s) => s.envs);
  const models = useStore((s) => s.models);
  const [all, setAll] = useState(false);
  return (
    <section className="home-sec">
      <div className="home-sec-head">
        <h2>Recent</h2>
        <span className="blk-spacer" />
        {list.length > 5 && (
          <button className="cell-link recent-more" aria-expanded={all} onClick={() => setAll(!all)}>
            <ChevronRight size={12} className={`tw${all ? " open" : ""}`} /> {all ? "Show fewer" : `All ${list.length}, with details`}
          </button>
        )}
      </div>
      {all ? (
        <SessionsTable list={list} />
      ) : (
        <div className="recent">
          {list.slice(0, 5).map((s) => {
            const env = s.envId ? envs[s.envId] : undefined;
            return (
              <button key={s.id} className="recent-row" onClick={() => openSession(s.id)}>
                <span className={`dot ${s.status === "running" ? "live" : s.status === "error" ? "error" : "idle"}`} />
                <span className="truncate recent-title">{s.title}</span>
                <span className="truncate dim recent-where">
                  {env ? env.type === "vm" ? <Box size={11} /> : <Terminal size={11} /> : <MessageSquare size={11} />} {env?.name ?? "chat"}
                </span>
                <span className="truncate dim recent-model">{modelName(models, s.modelId)}</span>
                {s.status === "running" ? <span className="live-text">running</span> : <Time ts={s.updatedAt} className="dim" />}
              </button>
            );
          })}
        </div>
      )}
    </section>
  );
}

function SessionsTable({ list }: { list: SessionSummary[] }) {
  const envs = useStore((s) => s.envs);
  const models = useStore((s) => s.models);
  return (
    <table className="table home-table">
      <thead>
        <tr>
          <th>Session</th>
          <th>Enclosure</th>
          <th>Model</th>
          <th>Prompt</th>
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
                    {env.name}
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
              <td className="r num">{used != null ? fmtInt(used) : ""}</td>
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
