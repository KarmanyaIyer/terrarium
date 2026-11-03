import { updateSettings } from "../state/appUndo";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { ChevronRight, FolderOpen, Loader2, RotateCw, Settings as SettingsIcon } from "lucide-react";
import type { AppSettings, EnvType, HarnessProfile, NetworkMode, PathKey, ResourceBudgetSettings, SettingsInfo, UpdateSettingsRequest } from "@terrarium/shared";
import { act, toast, useStore } from "../state/store";
import { useLab } from "../state/lab";
import { forgetConnection } from "../api/connect";
import { CONTEXT_CHOICES } from "../lib/memory";
import { exactBytes, fmtBytes, fmtCtx } from "../lib/format";
import { ENV_TYPE_TIP, HARNESS, HarnessTip, NET_ALWAYS, NET_TIP, harnessLabel } from "../lib/explain";
import { CopyButton, Hint, Segmented } from "../components/ui";

const PATHS: { key: PathKey; label: string; tip: string }[] = [
  { key: "data", label: "Data", tip: "Database, trace blobs, enclosure disks, snapshots, VM images, oMLX cache" },
  { key: "models", label: "Models", tip: "One MLX model per folder; oMLX serves every folder here" },
  { key: "venv", label: "Python", tip: "Virtualenv with oMLX, mlx-lm, mlx-vlm and huggingface_hub" },
  { key: "logs", label: "Backend log", tip: "Written by the app; dev runs log to the terminal" },
  { key: "omlxLog", label: "oMLX log", tip: "oMLX server output" },
];

export default function SettingsView() {
  const settings = useStore((s) => s.settings);
  const [info, setInfo] = useState<SettingsInfo | null>(null);

  const refresh = useCallback(() => {
    void act("Settings", (b) => b.getSettings()).then((r) => r && setInfo(r));
  }, []);
  useEffect(refresh, [refresh]);

  const update = (req: UpdateSettingsRequest) => void updateSettings(req);

  return (
    <div className="settings-view">
      <div className="view-head">
        <SettingsIcon size={15} />
        <h1>Settings</h1>
      </div>
      {/* what you change most first; limits and paths last */}
      <div className="settings-body">
        <MemorySection settings={settings} totalBytes={useStore.getState().budget.totalBytes} update={update} />
        <NewSessionSection settings={settings} update={update} />
        <NewEnvSection settings={settings} update={update} />
        <PromptsSection settings={settings} update={update} />
        <ResourceBudgetsSection settings={settings} update={update} />
        <StorageSection info={info} onInfo={setInfo} onRefresh={refresh} />
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
  { key: "maxSimWorkers", label: "Simulated shells at once", help: "Simulated enclosures that may run at once. Others wait for a free one, evals included.", unit: "workers", min: 1, max: 32 },
  { key: "simWorkerRssBytes", label: "Sim memory", help: "A worker is stopped when host-measured RSS crosses this limit, including WASM and external memory.", unit: "MiB", scale: MiB, min: 256, max: 4096 },
  { key: "simWorkerCpuMs", label: "Sim CPU lifetime", help: "A worker is stopped after this much cumulative CPU time.", unit: "minutes", scale: 60_000, min: 1, max: 1440 },
  { key: "hostFreeDiskReserveBytes", label: "Free disk reserve", help: "Enclosure work stops before free space falls below this reserve.", unit: "GiB", scale: GiB, min: 1, max: 512 },
  { key: "sessionTraceBytes", label: "Trace data", help: "Maximum logical request, response, transcript, diff and manifest data per session.", unit: "MiB", scale: MiB, min: 32, max: 8192 },
  { key: "sessionCaptureBytes", label: "File captures", help: "Maximum changed file content captured per session; each tool call is also capped at 64 MiB.", unit: "MiB", scale: MiB, min: 16, max: 4096 },
  { key: "sessionSnapshotCount", label: "Filesystem history", help: "Maximum saved filesystem history points per session.", unit: "points", min: 10, max: 10_000 },
  { key: "sessionNetworkRows", label: "Network rows", help: "Maximum individual network log rows per session; overflow is aggregated.", unit: "rows", min: 100, max: 100_000 },
  { key: "sessionRequestCount", label: "Model requests", help: "Maximum inference requests across all turns in one session.", unit: "requests", min: 10, max: 10_000 },
  { key: "sessionNetworkBytes", label: "Network data", help: "Maximum request and response bytes transferred by one session.", unit: "MiB", scale: MiB, min: 16, max: 8192 },
  { key: "networkBurst", label: "Network burst", help: "HTTP attempts allowed immediately before rate limiting starts.", unit: "attempts", min: 10, max: 10_000 },
  { key: "networkRefillPerSecond", label: "Network refill", help: "HTTP attempt tokens restored each second after a burst.", unit: "per second", min: 1, max: 1000 },
];

/** Rarely touched, so closed until asked for. */
function ResourceBudgetsSection({ settings, update }: { settings: AppSettings; update: Update }) {
  const [open, setOpen] = useState(false);
  return (
    <section className="st-section">
      <button className="st-head st-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
        <ChevronRight size={13} className={`tw${open ? " open" : ""}`} />
        <h2>Resource limits</h2>
      </button>
      {open && (
        <div className="st-grid">
          {BUDGET_FIELDS.map((field) => (
            <BudgetInput key={field.key} field={field} stored={settings.resourceBudgets[field.key]} update={update} />
          ))}
        </div>
      )}
    </section>
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
      <Label tip={field.help}>{field.label}</Label>
      <div className="st-row">
        <input className="input num" type="number" min={field.min} max={field.max} step={1} value={value} onChange={(e) => setValue(e.target.value)} onBlur={save} onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()} />
        <span className="dim num">{field.unit}</span>
      </div>
    </>
  );
}

function Section({ title, tip, children, aside }: { title: string; tip?: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <section className="st-section">
      <div className="st-head">
        {tip ? (
          <Hint tip={tip}>
            <h2>{title}</h2>
          </Hint>
        ) : (
          <h2>{title}</h2>
        )}
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

function MemorySection({ settings, totalBytes, update }: { settings: AppSettings; totalBytes: number; update: Update }) {
  const maxGb = Math.max(4, Math.floor(totalBytes / 1e9));
  const [gb, setGb] = useState(Math.round(settings.memoryBudgetBytes / 1e9));
  useEffect(() => setGb(Math.round(settings.memoryBudgetBytes / 1e9)), [settings.memoryBudgetBytes]);
  const over = useLab((s) => s.lab?.overCeiling);
  return (
    <Section title="Memory">
      <Label
        tip={
          <>
            <span className="hint-title">Memory ceiling</span>
            <div className="hint-line">Most memory oMLX and the Lab may use together for weights and context. Past it, a model won't load and idle ones are unloaded.</div>
            <div className="hint-line">Leave room for the VMs you run and for macOS. A change applies right away.</div>
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
        <span className="num strong">{fmtBytes(gb * 1e9)}</span>
        <span className="dim num">of {fmtBytes(totalBytes)} RAM</span>
      </div>
      {over && (
        <>
          <span />
          <span className="warn-text">{over}</span>
        </>
      )}
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
          <option value="">Last used model, loaded first</option>
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
      <Label tip="Harness for sessions in an enclosure. Chats without an enclosure always use Chat.">Prompt</Label>
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
    <Section title="New enclosures">
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
    <Section title="System prompts" tip="Edit from a session's Prompt tab">
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
              <span className="hint-text">Saved default</span>
            </Hint>
            <span className="num">{saved.length.toLocaleString("en-US")} characters</span>
            <button className="btn sm ghost" onClick={onReset}>
              Use built-in
            </button>
          </>
        ) : (
          <span>Built-in</span>
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
        {bytes != null && <span className="num">{fmtBytes(bytes)}</span>}
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

function ClearRow({ d, onInfo }: { d: SettingsInfo["disk"][number]; onInfo: (i: SettingsInfo) => void }) {
  const [busy, setBusy] = useState(false);
  return (
    <div className="st-clear">
      <Hint tip={d.clear}>
        <span>{d.label}</span>
      </Hint>
      <span className="num">{fmtBytes(d.bytes)}</span>
      <button
        className="btn sm"
        disabled={busy || !!d.clearBlocked || d.bytes === 0}
        title={d.clearBlocked ?? (d.bytes === 0 ? "Already empty" : undefined)}
        onClick={async () => {
          setBusy(true);
          const r = await act(`Clear ${d.label}`, (b) => b.clearCache(d.key));
          setBusy(false);
          if (r) {
            onInfo(r);
            toast(`Cleared ${d.label}, ${fmtBytes(d.bytes)} freed`);
          }
        }}
      >
        {busy && <Loader2 className="spin" />} Clear
      </button>
    </div>
  );
}

function StorageSection({ info, onInfo, onRefresh }: { info: SettingsInfo | null; onInfo: (i: SettingsInfo) => void; onRefresh: () => void }) {
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
                    {d.label} <span className="num">{fmtBytes(d.bytes)}</span>
                  </span>
                ))}
            </div>
            <span className="num">{fmtBytes(info.freeDiskBytes)} free on this disk</span>
            {data
              .filter((d) => d.clear)
              .map((d) => (
                <ClearRow key={d.key} d={d} onInfo={onInfo} />
              ))}
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
  const backend = useStore((s) => s.backend);
  return (
    <Section title="About">
      <Label>Terrarium</Label>
      <span className="num">{versions?.app}</span>
      <Label tip="The local process that runs sessions, evals and the Lab">Backend</Label>
      <span className="st-row">
        <span className="mono">{backend?.kind === "fixtures" ? "in-memory fixtures" : (backend?.label ?? "none")}</span>
        {!(backend?.kind === "fixtures" && import.meta.env.VITE_FIXTURES === "1") && (
          <button className="btn sm ghost" onClick={forgetConnection}>
            Change
          </button>
        )}
      </span>
      <Label tip="Local inference server, runs MLX models; loopback only, with a random API key">oMLX</Label>
      <span className="st-row">
        <span className="num">{inf.version ?? versions?.omlx}</span>
        <span className={inf.status === "error" ? "err-text" : undefined}>{inf.status}</span>
        {inf.pid != null && <span className="num">pid {inf.pid}</span>}
      </span>
      <Label tip="Micro-VM library (libkrun, QEMU fallback)">Gondolin</Label>
      <span className="num">{versions?.gondolin}</span>
      <Label tip="Simulated bash used by simulated enclosures">just-bash</Label>
      <span className="num">{versions?.justBash}</span>
      <Label tip="Agent loop used by every harness profile">pi-agent-core</Label>
      <span className="num">{versions?.piAgentCore}</span>
      <Label tip="Fixed; each running VM reserves its RAM">VMs at once</Label>
      <span className="num">{info?.maxRunningVms ?? "…"}</span>
    </Section>
  );
}
