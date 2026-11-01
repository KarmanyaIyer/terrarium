import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Box, Loader2, Terminal, X } from "lucide-react";
import type { CreateEnvRequest, EnvFacts, EnvSummary, EnvType, NetworkMode, Snapshot } from "@terrarium/shared";
import { act, openEnv, useStore } from "../state/store";
import { fmtBytes, relTime } from "../lib/format";
import { Hint, Kbd, Segmented, Switch } from "../components/ui";
import { NetIcon } from "../components/Sidebar";
import { EnvCompare, FIELD_TIP, NET_ALWAYS, NET_TIP } from "../lib/explain";
import { busyReason } from "../lib/envuse";
import { newSession, nextEnvName } from "../lib/actions";
import { VmSetupNote } from "./ModelSuggestions";

const MiB = 1024 * 1024;
type Source = "clean" | "fork" | "snapshot";

const NET_OPTS: { value: NetworkMode; label: string; tip: ReactNode }[] = [
  { value: "off", label: "Off", tip: NET_TIP.off },
  { value: "registries", label: "Registries", tip: NET_TIP.registries },
  { value: "web", label: "Web", tip: NET_TIP.web },
];

/** Rough RSS of a sim env (node child process + in-memory FS); VMs reserve their configured RAM. */
const SIM_RSS = 90 * MiB;

const sizeLabel = (mib: number) => (mib >= 1024 ? `${mib / 1024} GiB` : `${mib} MiB`);

const nextName = nextEnvName;

export function NewEnvSheet() {
  const open = useStore((s) => s.newEnvOpen);
  if (!open) return null;
  return <Sheet onClose={() => useStore.setState({ newEnvOpen: false, newEnvPreset: null })} />;
}

function Sheet({ onClose }: { onClose: () => void }) {
  const envMap = useStore((s) => s.envs);
  const backend = useStore((s) => s.backend);
  const samples = useStore((s) => s.samples);
  const budget = useStore((s) => s.budget);
  const defaults = useStore((s) => s.settings.newEnv);
  const preset = useStore((s) => s.newEnvPreset);
  const envs = useMemo(() => Object.values(envMap).filter((e) => !e.ephemeral), [envMap]);

  const [type, setType] = useState<EnvType>(preset?.type ?? defaults.type);
  const [name, setName] = useState(() => nextName(envs, preset?.type ?? defaults.type));
  const [nameTouched, setNameTouched] = useState(false);
  const [source, setSource] = useState<Source>("clean");
  const [srcEnv, setSrcEnv] = useState<string>("");
  const [snaps, setSnaps] = useState<Snapshot[] | null>(null);
  const [snapId, setSnapId] = useState<string>("");
  const [network, setNetwork] = useState<NetworkMode>(defaults.network);
  const [cpus, setCpus] = useState(2);
  const [memMiB, setMemMiB] = useState(1024);
  const [diskMiB, setDiskMiB] = useState(4096);
  const [vmBackend, setVmBackend] = useState<"krun" | "qemu">("krun");
  const [python, setPython] = useState(true);
  const [js, setJs] = useState(false);
  const [simMax, setSimMax] = useState(64 * MiB);
  const [busy, setBusy] = useState(false);
  const vmOk = useStore((s) => s.vmSetup.ok);
  const nameRef = useRef<HTMLInputElement>(null);

  const sameType = envs.filter((e) => e.type === type);
  const src = srcEnv ? envMap[srcEnv] : undefined;

  useEffect(() => {
    if (!nameTouched) setName(nextName(envs, type));
    setSrcEnv((cur) => (cur && envMap[cur]?.type === type ? cur : (sameType[0]?.id ?? "")));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [type]);

  useEffect(() => {
    if (source !== "snapshot" || !srcEnv || !backend) return;
    let gone = false;
    setSnaps(null);
    backend
      .listSnapshots(srcEnv)
      .then((s) => {
        if (gone) return;
        setSnaps(s);
        setSnapId(s[s.length - 1]?.id ?? "");
      })
      .catch(() => !gone && setSnaps([]));
    return () => {
      gone = true;
    };
  }, [source, srcEnv, backend]);

  // a fork inherits the source's resources
  useEffect(() => {
    if (source === "clean" || !src) return;
    if (src.vm) {
      setCpus(src.vm.cpus);
      setMemMiB(src.vm.memoryMiB);
      setDiskMiB(src.vm.diskMiB);
      setVmBackend(src.vm.backend);
    }
    if (src.sim) {
      setPython(src.sim.python);
      setJs(src.sim.javascript);
      setSimMax(src.sim.maxTotalBytes);
    }
    setNetwork(src.network);
  }, [source, src]);

  useEffect(() => nameRef.current?.select(), []);

  const needsSrc = source !== "clean";
  // A fork snapshots the source's live disk, which the backend refuses while something uses it.
  const srcBusy = source === "fork" && src ? busyReason(src) : undefined;
  const valid = name.trim().length > 0 && (!needsSrc || !!srcEnv) && (source !== "snapshot" || !!snapId) && !srcBusy;

  const create = async () => {
    if (!valid || busy) return;
    const req: CreateEnvRequest = {
      name: name.trim(),
      type,
      network,
      from: source === "fork" ? { envId: srcEnv } : source === "snapshot" ? { snapshotId: snapId } : undefined,
      vm: type === "vm" ? { cpus, memoryMiB: memMiB, diskMiB, backend: vmBackend } : undefined,
      sim: type === "sim" ? { python, javascript: js, maxTotalBytes: simMax } : undefined,
    };
    setBusy(true);
    const env = await act("Create enclosure", (b) => b.createEnv(req));
    setBusy(false);
    if (!env) return;
    useStore.setState((s) => ({ envs: { ...s.envs, [env.id]: env }, newEnvOpen: false, newEnvPreset: null }));
    openEnv(env.id);
    // the next step is always a session in it
    void newSession(env.id, preset?.modelId);
  };

  // facts preview: gathered from the source env, or from an existing env built on the same base
  const factsFrom = needsSrc ? src : sameType.find((e) => e.facts);
  const facts = factsFrom?.facts;

  const sample = samples[samples.length - 1];
  const free = sample?.system.freeBytes;
  const total = sample?.system.totalBytes ?? budget.totalBytes;
  const adds = type === "vm" ? memMiB * MiB : SIM_RSS;

  return (
    <div
      className="overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          onClose();
        } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          void create();
        }
      }}
    >
      <form
        className="sheet"
        role="dialog"
        aria-label="New enclosure"
        onSubmit={(e) => {
          e.preventDefault();
          void create();
        }}
      >
        <div className="sheet-head">
          <h2>New enclosure</h2>
          <span className="blk-spacer" />
          <button type="button" className="icon-btn" title="Close (Esc)" onClick={onClose}>
            <X size={14} />
          </button>
        </div>

        <div className="sheet-body">
          <div className="env-cards" role="radiogroup" aria-label="Enclosure type">
            {(["sim", "vm"] as const).map((t) => (
              <button type="button" key={t} role="radio" aria-checked={type === t} className={`env-card${type === t ? " on" : ""}`} onClick={() => setType(t)}>
                <b>
                  {t === "vm" ? <Box size={14} /> : <Terminal size={14} />} {t === "vm" ? "Linux VM" : "Simulated shell"}
                </b>
                <span className="dim">{t === "vm" ? "Real Linux: installs, compilers, tests." : "Instant and light: files and common commands."}</span>
              </button>
            ))}
          </div>
          <details className="env-compare-more">
            <summary>Compare in detail</summary>
            <EnvCompare highlight={type} />
          </details>

          <div className="form-grid">
            <label htmlFor="ne-name">Name</label>
            <input
              id="ne-name"
              ref={nameRef}
              className="input"
              value={name}
              spellCheck={false}
              onChange={(e) => {
                setName(e.target.value);
                setNameTouched(true);
              }}
            />

            <Hint tip={FIELD_TIP.start}>
              <span>Start from</span>
            </Hint>
            <div className="form-stack">
              <Segmented<Source>
                value={source}
                onChange={setSource}
                ariaLabel="Start from"
                options={[
                  { value: "clean", label: "Clean", title: "Fresh base image" },
                  { value: "fork", label: "Fork", title: "Copy of another enclosure's current disk", disabled: !sameType.length },
                  { value: "snapshot", label: "Snapshot", title: "Copy of a saved snapshot", disabled: !sameType.length },
                ]}
              />
              {needsSrc && (
                <div className="form-row">
                  <select className="input" value={srcEnv} onChange={(e) => setSrcEnv(e.target.value)} aria-label="Source enclosure">
                    {sameType.map((e) => (
                      <option key={e.id} value={e.id}>
                        {e.name}
                      </option>
                    ))}
                  </select>
                  {srcBusy && (
                    <span className="dim truncate" title={`Busy: ${srcBusy}`}>
                      busy: {srcBusy}
                    </span>
                  )}
                  {source === "snapshot" &&
                    (snaps == null ? (
                      <Loader2 size={13} className="spin dim" />
                    ) : snaps.length ? (
                      <select className="input" value={snapId} onChange={(e) => setSnapId(e.target.value)} aria-label="Snapshot">
                        {snaps.map((s) => (
                          <option key={s.id} value={s.id}>
                            {s.label} ({s.kind}, {relTime(s.createdAt)})
                          </option>
                        ))}
                      </select>
                    ) : (
                      <span className="dim">No snapshots</span>
                    ))}
                </div>
              )}
            </div>

            <Hint tip={NET_ALWAYS}>
              <span>Network</span>
            </Hint>
            <div className="form-row">
              <Segmented<NetworkMode> value={network} onChange={setNetwork} ariaLabel="Network mode" options={NET_OPTS} />
              <NetIcon mode={network} size={13} />
            </div>

            {type === "vm" ? (
              <>
                <Hint tip={FIELD_TIP.cpus}>
                  <span>CPUs</span>
                </Hint>
                <Segmented
                  value={String(cpus)}
                  onChange={(v) => setCpus(Number(v))}
                  ariaLabel="CPUs"
                  options={[1, 2, 4, 6].map((n) => ({ value: String(n), label: String(n) }))}
                />
                <Hint tip={FIELD_TIP.memory}>
                  <span>Memory</span>
                </Hint>
                <Segmented
                  value={String(memMiB)}
                  onChange={(v) => setMemMiB(Number(v))}
                  ariaLabel="Memory"
                  options={[512, 1024, 2048, 4096].map((n) => ({ value: String(n), label: sizeLabel(n) }))}
                />
                <Hint tip={FIELD_TIP.disk}>
                  <span>Disk</span>
                </Hint>
                <Segmented
                  value={String(diskMiB)}
                  onChange={(v) => setDiskMiB(Number(v))}
                  ariaLabel="Disk"
                  options={[2048, 4096, 8192, 16384].map((n) => ({ value: String(n), label: sizeLabel(n) }))}
                />
                <Hint tip={FIELD_TIP.backend}>
                  <span>Backend</span>
                </Hint>
                <Segmented
                  value={vmBackend}
                  onChange={setVmBackend}
                  ariaLabel="VM backend"
                  options={[
                    { value: "krun", label: "krun" },
                    { value: "qemu", label: "QEMU" },
                  ]}
                />
              </>
            ) : (
              <>
                <span>Runtimes</span>
                <div className="form-row">
                  <Switch on={python} onChange={setPython} label="Python (WASM)" tip={FIELD_TIP.python} />
                  <Switch on={js} onChange={setJs} label="JavaScript" tip={FIELD_TIP.javascript} />
                </div>
                <Hint tip={FIELD_TIP.fsLimit}>
                  <span>FS limit</span>
                </Hint>
                <Segmented
                  value={String(simMax)}
                  onChange={(v) => setSimMax(Number(v))}
                  ariaLabel="Filesystem limit"
                  options={[16, 64, 256].map((n) => ({ value: String(n * MiB), label: sizeLabel(n) }))}
                />
              </>
            )}

            <span title="Memory this enclosure takes from the Mac while it runs">On this Mac</span>
            <MemImpact adds={adds} free={free} total={total} vm={type === "vm"} />
          </div>

          {facts && <FactsPreview facts={facts} from={factsFrom!} inherited={needsSrc} />}
        </div>

        <div className="sheet-foot">
          <span className="blk-spacer" />
          <button type="button" className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          {type === "vm" && <VmSetupNote />}
          <button type="submit" className="btn primary" disabled={!valid || busy || (type === "vm" && !vmOk)}>
            {busy && <Loader2 className="spin" />} Create enclosure <Kbd k="⌘↵" />
          </button>
        </div>
      </form>
    </div>
  );
}

function MemImpact({ adds, free, total, vm }: { adds: number; free?: number; total: number; vm: boolean }) {
  const used = free != null ? total - free : undefined;
  const over = free != null && adds > free;
  if (!total || used == null)
    return (
      <span className="num">
        {vm ? "" : "~"}
        {fmtBytes(adds)} while running
      </span>
    );
  const pct = (n: number) => `${Math.min(100, (n / total) * 100)}%`;
  return (
    <div className="mem-impact">
      <div className="mem-impact-bar" title={`In use ${fmtBytes(used)}, this env ${fmtBytes(adds)}, free ${fmtBytes(free)}`}>
        <span className="mi-used" style={{ width: pct(used) }} />
        <span className={`mi-add${vm ? " vm" : " sim"}${over ? " over" : ""}`} style={{ width: pct(adds) }} />
      </div>
      <span className="num">
        {vm ? "" : "~"}
        {fmtBytes(adds)} while running
      </span>
      <span className={`num ${over ? "err-text" : "dim"}`}>{over ? `only ${fmtBytes(free)} free` : `${fmtBytes(free)} free now`}</span>
    </div>
  );
}

function FactsPreview({ facts, from, inherited }: { facts: EnvFacts; from: EnvSummary; inherited: boolean }) {
  return (
    <div className="facts-preview">
      <div className="facts-preview-head dim">{inherited ? `Copied from ${from.name}` : `Base image, as gathered in ${from.name}`}</div>
      <dl className="kv facts">
        <dt>Isolation</dt>
        <dd>{facts.isolation}</dd>
        {facts.os && (
          <>
            <dt>OS</dt>
            <dd>
              {facts.os}
              {facts.kernel ? <span className="dim"> kernel {facts.kernel}</span> : null}
            </dd>
          </>
        )}
        <dt>Runs as</dt>
        <dd className="mono">{facts.user}</dd>
        <dt>Workdir</dt>
        <dd className="mono">{facts.workdir}</dd>
        <dt>Mac folders</dt>
        <dd>none mounted</dd>
        {facts.tools?.length ? (
          <>
            <dt>Tools</dt>
            <dd>
              {facts.tools.map((t) => (
                <span key={t} className="fact-chip mono">
                  {t}
                </span>
              ))}
            </dd>
          </>
        ) : null}
        {facts.simCommands?.length ? (
          <>
            <dt>Commands</dt>
            <dd className="num">{facts.simCommands.length}</dd>
          </>
        ) : null}
      </dl>
    </div>
  );
}
