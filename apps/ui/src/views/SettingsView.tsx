import { useCallback, useEffect, useState, type ReactNode } from "react";
import { FolderOpen, Loader2, RotateCw } from "lucide-react";
import type { AppSettings, EnvType, HarnessProfile, NetworkMode, PathKey, ResourceBudgetSettings, SettingsInfo, UpdateSettingsRequest } from "@terrarium/shared";
import { act, openView, useStore } from "../state/store";
import { CONTEXT_CHOICES } from "../lib/memory";
import { exactBytes, fmtBytes, fmtCtx } from "../lib/format";
import { ENV_TYPE_TIP, HARNESS, HarnessTip, NET_ALWAYS, NET_TIP, harnessLabel } from "../lib/explain";
import { CopyButton, Hint, Segmented } from "../components/ui";

const PATHS: { key: PathKey; label: string; tip: string }[] = [
  { key: "data", label: "Data", tip: "Database, trace blobs, environment disks, snapshots, VM images, oMLX cache" },
  { key: "models", label: "Models", tip: "One MLX model per folder; oMLX serves every folder here" },
  { key: "venv", label: "Python", tip: "Virtualenv with oMLX, mlx-lm, mlx-vlm and huggingface_hub" },
  { key: "logs", label: "Backend log", tip: "Written by the app; dev runs log to the terminal" },
  { key: "omlxLog", label: "oMLX log", tip: "oMLX server output" },
];

export default function SettingsView() {
  const settings = useStore((s) => s.settings);
  const inference = useStore((s) => s.inference);
  const [info, setInfo] = useState<SettingsInfo | null>(null);

  const refresh = useCallback(() => {
    void act("Settings", (b) => b.getSettings()).then((r) => r && setInfo(r));
  }, []);
  useEffect(refresh, [refresh]);

  const update = (req: UpdateSettingsRequest) =>
    void act("Save setting", (b) => b.updateSettings(req)).then((s) => s && useStore.setState({ settings: s }));

  return (
    <div className="settings-view">
      <div className="view-head">
        <h1>Settings</h1>
      </div>
      <div className="settings-body">
        <MemorySection settings={settings} totalBytes={useStore.getState().budget.totalBytes} running={inference} update={update} />
        <ResourceBudgetsSection settings={settings} update={update} />
        <NewSessionSection settings={settings} update={update} />
        <NewEnvSection settings={settings} update={update} />
        <PromptsSection settings={settings} update={update} />
        <StorageSection info={info} onRefresh={refresh} />
        <AboutSection info={info} />
      </div>
    </div>
  );
}

type BudgetField = {
  key: keyof ResourceBudgetSettings;
  label: string;
  help: string;
  unit: string;
  scale?: number;
  min: number;
  max: number;
};

const MiB = 1024 * 1024;
const GiB = 1024 * MiB;
const BUDGET_FIELDS: BudgetField[] = [
  { key: "maxSimWorkers", label: "Sim workers", help: "Maximum simulated environments that may run at once.", unit: "workers", min: 1, max: 32 },
  { key: "simWorkerRssBytes", label: "Sim memory", help: "A worker is stopped when host-measured RSS crosses this limit, including WASM and external memory.", unit: "MiB", scale: MiB, min: 256, max: 4096 },
  { key: "simWorkerCpuMs", label: "Sim CPU lifetime", help: "A worker is stopped after this much cumulative CPU time.", unit: "minutes", scale: 60_000, min: 1, max: 1440 },
  { key: "hostFreeDiskReserveBytes", label: "Free disk reserve", help: "Environment work stops before free space falls below this reserve.", unit: "GiB", scale: GiB, min: 1, max: 512 },
  { key: "sessionTraceBytes", label: "Trace data", help: "Maximum logical request, response, transcript, diff and manifest data per session.", unit: "MiB", scale: MiB, min: 32, max: 8192 },
  { key: "sessionCaptureBytes", label: "File captures", help: "Maximum changed file content captured per session; each tool call is also capped at 64 MiB.", unit: "MiB", scale: MiB, min: 16, max: 4096 },
  { key: "sessionSnapshotCount", label: "Filesystem history", help: "Maximum saved filesystem history points per session.", unit: "points", min: 10, max: 10_000 },
  { key: "sessionNetworkRows", label: "Network rows", help: "Maximum individual network log rows per session; overflow is aggregated.", unit: "rows", min: 100, max: 100_000 },
  { key: "sessionRequestCount", label: "Model requests", help: "Maximum inference requests across all turns in one session.", unit: "requests", min: 10, max: 10_000 },
  { key: "sessionNetworkBytes", label: "Network data", help: "Maximum request and response bytes transferred by one session.", unit: "MiB", scale: MiB, min: 16, max: 8192 },
  { key: "networkBurst", label: "Network burst", help: "HTTP attempts allowed immediately before rate limiting starts.", unit: "attempts", min: 10, max: 10_000 },
  { key: "networkRefillPerSecond", label: "Network refill", help: "HTTP attempt tokens restored each second after a burst.", unit: "per second", min: 1, max: 1000 },
];

function ResourceBudgetsSection({ settings, update }: { settings: AppSettings; update: Update }) {
  return (
    <Section title="Resource limits">
      {BUDGET_FIELDS.map((field) => (
        <BudgetInput key={field.key} field={field} stored={settings.resourceBudgets[field.key]} update={update} />
      ))}
    </Section>
  );
}

function BudgetInput({ field, stored, update }: { field: BudgetField; stored: number; update: Update }) {
  const scale = field.scale ?? 1;
  const shown = Math.round(stored / scale);
  const [value, setValue] = useState(String(shown));
  useEffect(() => setValue(String(shown)), [shown]);
  const save = () => {
    const n = Number(value);
    if (!Number.isInteger(n) || n < field.min || n > field.max) {
      setValue(String(shown));
      return;
    }
    const next = n * scale;
    if (next !== stored) update({ resourceBudgets: { [field.key]: next } });
  };
  return (
    <>
      <Label>{field.label}</Label>
      <div className="st-row">
        <input className="input num" type="number" min={field.min} max={field.max} step={1} value={value} onChange={(e) => setValue(e.target.value)} onBlur={save} onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()} />
        <span className="dim num">{field.unit}</span>
        <span className="dim">{field.help}</span>
      </div>
    </>
  );
}

function Section({ title, children, aside }: { title: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <section className="st-section">
      <div className="st-head">
        <h2>{title}</h2>
        {aside}
      </div>
      <div className="st-grid">{children}</div>
    </section>
  );
}

function Label({ children, tip }: { children: ReactNode; tip?: ReactNode }) {
  return <span className="st-label">{tip ? <Hint tip={tip}>{children}</Hint> : children}</span>;
}

type Update = (req: UpdateSettingsRequest) => void;

function MemorySection({ settings, totalBytes, running, update }: { settings: AppSettings; totalBytes: number; running: ReturnType<typeof useStore.getState>["inference"]; update: Update }) {
  const maxGb = Math.max(4, Math.floor(totalBytes / 1e9));
  const [gb, setGb] = useState(Math.round(settings.memoryBudgetBytes / 1e9));
  useEffect(() => setGb(Math.round(settings.memoryBudgetBytes / 1e9)), [settings.memoryBudgetBytes]);
  const applied = running.memoryCeilingBytes != null ? Math.round(running.memoryCeilingBytes / 1e9) : null;
  const stale = running.status === "ready" && applied != null && applied !== Math.max(4, Math.round(settings.memoryBudgetBytes / 1e9));
  const [restarting, setRestarting] = useState(false);
  // Stopping oMLX aborts in-flight model calls, so don't offer it mid-run.
  const busy = useStore((s) => Object.values(s.sessions).some((x) => x.status === "running") || s.evalRuns.some((r) => r.status === "running"));
  const restart = async () => {
    setRestarting(true);
    await act("Restart oMLX", async (b) => {
      await b.stopInference();
      // stop resolves before the process is gone; start waits for the stopped state
      for (let i = 0; i < 50 && useStore.getState().inference.status !== "stopped"; i++) await new Promise((r) => setTimeout(r, 200));
      return b.startInference();
    });
    setRestarting(false);
  };
  return (
    <Section title="Models">
      <Label
        tip={
          <>
            <span className="hint-title">Memory ceiling</span>
            <div className="hint-line">Most memory oMLX may use for model weights and context. Past it, oMLX refuses to load another model and evicts idle ones.</div>
            <div className="hint-line">Leave room for the VMs you run (their RAM) and for macOS. Takes effect when oMLX starts.</div>
          </>
        }
      >
        Memory ceiling
      </Label>
      <div className="st-row">
        <input
          type="range"
          className="st-range"
          min={4}
          max={maxGb}
          step={1}
          value={gb}
          aria-label="Memory ceiling in GB"
          onChange={(e) => setGb(Number(e.target.value))}
          onPointerUp={() => gb * 1e9 !== settings.memoryBudgetBytes && update({ memoryBudgetBytes: gb * 1e9 })}
          onKeyUp={() => gb * 1e9 !== settings.memoryBudgetBytes && update({ memoryBudgetBytes: gb * 1e9 })}
        />
        <span className="num strong" title={`${gb} GB, passed to oMLX as --memory-guard-gb`}>{fmtBytes(gb * 1e9)}</span>
        <span className="dim num">of {fmtBytes(totalBytes)} RAM</span>
        {stale && (
          <>
            <span className="warn-text">oMLX is running with {fmtBytes((applied ?? 0) * 1e9)}</span>
            <button className="btn sm" disabled={restarting || busy} title={busy ? "Stop running sessions and evals first: restarting aborts them" : undefined} onClick={() => void restart()}>
              {restarting ? <Loader2 className="spin" /> : <RotateCw />} Restart oMLX
            </button>
          </>
        )}
      </div>
      <Label>Per-model defaults</Label>
      <div className="st-row">
        <button className="cell-link" onClick={() => openView({ kind: "models" })}>
          Context, output cap and sampling are set per model in Models
        </button>
      </div>
    </Section>
  );
}

function NewSessionSection({ settings, update }: { settings: AppSettings; update: Update }) {
  const models = useStore((s) => s.models);
  const ns = settings.newSession;
  const missing = ns.modelId != null && !models.some((m) => m.id === ns.modelId);
  return (
    <Section title="New sessions">
      <Label tip="Model a new session starts with. You can switch per session at any time.">Model</Label>
      <div className="st-row">
        <select className="input" value={ns.modelId ?? ""} onChange={(e) => update({ newSession: { modelId: e.target.value || null } })} aria-label="Default model">
          <option value="">Last used loaded model</option>
          {models.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
          {missing && <option value={ns.modelId!}>{ns.modelId} (removed)</option>}
        </select>
      </div>
      <Label tip="Context window for new sessions. Model default uses each model's own default (Models page).">Context</Label>
      <Segmented
        small
        value={ns.contextWindow == null ? "model" : String(ns.contextWindow)}
        onChange={(v) => update({ newSession: { contextWindow: v === "model" ? null : Number(v) } })}
        options={[{ value: "model", label: "Model default" }, ...CONTEXT_CHOICES.map((c) => ({ value: String(c), label: fmtCtx(c) }))]}
      />
      <Label tip="enable_thinking for new sessions. Thinking tokens count against the output cap. Model default: on for models that think by default (Qwen3.5, Bonsai).">
        Thinking
      </Label>
      <Segmented<AppSettings["newSession"]["thinking"]>
        small
        value={ns.thinking}
        onChange={(v) => update({ newSession: { thinking: v } })}
        options={[
          { value: "model", label: "Model default" },
          { value: "on", label: "On" },
          { value: "off", label: "Off" },
        ]}
      />
      <Label tip="Harness for sessions in an environment. Chats without an environment always use Chat.">Harness</Label>
      <Segmented<HarnessProfile>
        small
        value={ns.harness}
        onChange={(v) => update({ newSession: { harness: v as Exclude<HarnessProfile, "chat"> } })}
        options={HARNESS.filter((h) => h.id !== "chat").map((h) => ({ value: h.id, label: h.label, tip: <HarnessTip id={h.id} /> }))}
      />
    </Section>
  );
}

function NewEnvSection({ settings, update }: { settings: AppSettings; update: Update }) {
  return (
    <Section title="New environments">
      <Label>Type</Label>
      <Segmented<EnvType>
        small
        value={settings.newEnv.type}
        onChange={(v) => update({ newEnv: { type: v } })}
        options={[
          { value: "vm", label: "Linux VM", tip: ENV_TYPE_TIP.vm },
          { value: "sim", label: "Simulated shell", tip: ENV_TYPE_TIP.sim },
        ]}
      />
      <Label tip={NET_ALWAYS}>Network</Label>
      <Segmented<NetworkMode>
        small
        value={settings.newEnv.network}
        onChange={(v) => update({ newEnv: { network: v } })}
        options={[
          { value: "off", label: "Off", tip: NET_TIP.off },
          { value: "registries", label: "Registries", tip: NET_TIP.registries },
          { value: "web", label: "Web", tip: NET_TIP.web },
        ]}
      />
    </Section>
  );
}

function PromptsSection({ settings, update }: { settings: AppSettings; update: Update }) {
  return (
    <Section title="System prompts" aside={<span className="dim st-aside">Edit from a session's Prompt tab</span>}>
      {HARNESS.map((h) => {
        const saved = settings.prompts[h.id];
        return (
          <PromptRow key={h.id} id={h.id} saved={saved} onReset={() => update({ prompts: { [h.id]: null } })} />
        );
      })}
    </Section>
  );
}

function PromptRow({ id, saved, onReset }: { id: HarnessProfile; saved?: string; onReset: () => void }) {
  return (
    <>
      <Label tip={<HarnessTip id={id} />}>{harnessLabel(id)}</Label>
      <div className="st-row">
        {saved != null ? (
          <>
            <Hint tip={<pre className="st-prompt-peek">{saved}</pre>} width={420}>
              <span className="chip accent">saved default</span>
            </Hint>
            <span className="dim num">{saved.length.toLocaleString("en-US")} characters</span>
            <button className="btn sm ghost" onClick={onReset}>
              Use built-in
            </button>
          </>
        ) : (
          <span className="dim">built-in</span>
        )}
      </div>
    </>
  );
}

function PathRow({ k, label, tip, path, bytes }: { k: PathKey; label: string; tip: string; path?: string; bytes?: number }) {
  return (
    <>
      <Label tip={tip}>{label}</Label>
      <div className="st-row">
        <span className="mono truncate selectable st-path" title={path}>
          {path ?? "…"}
        </span>
        {bytes != null && <span className="num dim">{fmtBytes(bytes)}</span>}
        <span className="blk-spacer" />
        {path && <CopyButton text={path} />}
        {path && (
          <button className="icon-btn sm" title="Show in Finder" onClick={() => void act("Show in Finder", (b) => b.reveal(k))}>
            <FolderOpen />
          </button>
        )}
      </div>
    </>
  );
}

function StorageSection({ info, onRefresh }: { info: SettingsInfo | null; onRefresh: () => void }) {
  const data = (info?.disk.filter((d) => d.key !== "models") ?? []).sort((a, b) => b.bytes - a.bytes); // bar and legend share one order
  const dataTotal = data.reduce((a, d) => a + d.bytes, 0);
  const models = info?.disk.find((d) => d.key === "models")?.bytes;
  return (
    <Section
      title="Storage"
      aside={
        <button className="icon-btn sm" title="Measure again" onClick={onRefresh}>
          <RotateCw />
        </button>
      }
    >
      <PathRow k="data" label="Data" tip={PATHS[0]!.tip} path={info?.paths.data} bytes={info ? dataTotal : undefined} />
      <span />
      <div className="st-disk">
        {info ? (
          <>
            <div className="st-disk-bar" aria-hidden>
              {data.map((d) => (
                <span key={d.key} className={`seg-${d.key}`} style={{ flexGrow: d.bytes }} title={`${d.label} ${fmtBytes(d.bytes)}`} />
              ))}
            </div>
            <div className="st-disk-legend">
              {data.map((d) => (
                  <span key={d.key} title={exactBytes(d.bytes)}>
                    <i className={`seg-${d.key}`} />
                    {d.label} <span className="num dim">{fmtBytes(d.bytes)}</span>
                  </span>
                ))}
            </div>
            <span className="dim num">{fmtBytes(info.freeDiskBytes)} free on this disk</span>
          </>
        ) : (
          <Loader2 size={13} className="spin dim" />
        )}
      </div>
      {PATHS.slice(1).map((p) => (
        <PathRow key={p.key} k={p.key} label={p.label} tip={p.tip} path={info?.paths[p.key]} bytes={p.key === "models" ? models : undefined} />
      ))}
    </Section>
  );
}

function AboutSection({ info }: { info: SettingsInfo | null }) {
  const versions = useStore((s) => s.versions);
  const inf = useStore((s) => s.inference);
  return (
    <Section title="About">
      <Label>Terrarium</Label>
      <span className="num">{versions?.app}</span>
      <Label tip="Local inference server, runs MLX models; loopback only, with a random API key">oMLX</Label>
      <span className="st-row">
        <span className="num">{inf.version ?? versions?.omlx}</span>
        <span className={`dot ${inf.status === "ready" ? "ready" : inf.status === "error" ? "error" : ""}`} />
        <span className="dim">{inf.status}</span>
        {inf.pid != null && <span className="dim num">pid {inf.pid}</span>}
      </span>
      <Label tip="Micro-VM library (libkrun, QEMU fallback)">Gondolin</Label>
      <span className="num">{versions?.gondolin}</span>
      <Label tip="Simulated bash used by simulated environments">just-bash</Label>
      <span className="num">{versions?.justBash}</span>
      <Label tip="Agent loop used by every harness profile">pi-agent-core</Label>
      <span className="num">{versions?.piAgentCore}</span>
      <Label tip="Fixed; each running VM reserves its RAM">VMs at once</Label>
      <span className="num">{info?.maxRunningVms ?? "…"}</span>
    </Section>
  );
}
