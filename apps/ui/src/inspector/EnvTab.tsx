import { patchEnv } from "../state/appUndo";
import { useEffect, useMemo, useState } from "react";
import { Camera, GitFork, Play, RotateCcw, Square, Trash2 } from "lucide-react";
import type { EnvSummary, NetworkMode, Snapshot } from "@terrarium/shared";
import { act, openEnv, useStore } from "../state/store";
import { exactBytes, fmtBytes, fmtMiB, fmtPct } from "../lib/format";
import { ConfirmButton, Hint, Popover, Segmented, Time, usePop } from "../components/ui";
import { ENV_TYPE_TIP, EnvCompare, FIELD_TIP, NET_ALWAYS, NET_TIP } from "../lib/explain";
import { Sparkline } from "../components/Sparkline";
import { EnvChip, NetIcon } from "../components/Sidebar";
import { busyReason, evalOwner } from "../lib/envuse";

function putEnv(e: EnvSummary | undefined) {
  if (e) useStore.setState((st) => ({ envs: { ...st.envs, [e.id]: e } }));
}

function SnapshotButton({ env, inUse, onDone }: { env: EnvSummary; inUse?: string; onDone: () => void }) {
  const pop = usePop();
  const [label, setLabel] = useState("");
  return (
    <>
      <button ref={pop.ref} className="btn sm" onClick={pop.toggle} disabled={!!inUse || (env.status !== "running" && env.status !== "stopped")} title={inUse && `Busy: ${inUse}`}>
        <Camera /> Snapshot
      </button>
      <Popover anchor={pop.ref} open={pop.open} onClose={pop.close} width={260}>
        <form
          className="pop-pad pop-form"
          onSubmit={(e) => {
            e.preventDefault();
            pop.close();
            void act("Snapshot", (b) => b.snapshotEnv(env.id, { label: label.trim() || undefined })).then(onDone);
            setLabel("");
          }}
        >
          <input className="input" autoFocus placeholder="Label" value={label} onChange={(e) => setLabel(e.target.value)} />
          <button className="btn primary sm" type="submit">
            Take snapshot
          </button>
        </form>
      </Popover>
    </>
  );
}

export function EnvTab({ env }: { env: EnvSummary }) {
  const samples = useStore((s) => s.samples);
  const envs = useStore((s) => s.envs);
  const [snaps, setSnaps] = useState<Snapshot[] | null>(null);
  const [rev, setRev] = useState(0);
  const [name, setName] = useState(env.name);
  const [editing, setEditing] = useState(false);
  const f = env.facts;
  const busy = env.status === "starting" || env.status === "stopping" || env.status === "busy";
  // A session run, shell command or eval case: the backend refuses to take the env down under it.
  const inUse = busyReason(env);
  const inUseTitle = inUse && `Busy: ${inUse}`;
  const evalUse = evalOwner(env);

  useEffect(() => setName(env.name), [env.name]);
  useEffect(() => {
    let alive = true;
    void act("Snapshots", (b) => b.listSnapshots(env.id)).then((s) => alive && setSnaps(s ?? []));
    return () => {
      alive = false;
    };
  }, [env.id, rev, env.status]);

  const series = useMemo(() => {
    const rss: { t: number; v: number }[] = [];
    const cpu: { t: number; v: number }[] = [];
    for (const s of samples) {
      const e = s.envs.find((x) => x.envId === env.id);
      if (!e) continue;
      rss.push({ t: s.ts, v: e.rssBytes });
      cpu.push({ t: s.ts, v: e.cpuPct });
    }
    return { rss, cpu };
  }, [samples, env.id]);

  const parent = env.parentEnvId ? envs[env.parentEnvId] : undefined;
  const memMax = env.vm ? env.vm.memoryMiB * 1024 * 1024 : undefined;

  return (
    <div className="envtab">
      <div className="env-title">
        <span className={`dot ${env.status}`} />
        {editing ? (
          <input
            className="input"
            value={name}
            autoFocus
            onChange={(e) => setName(e.target.value)}
            onBlur={() => {
              setEditing(false);
              if (name.trim() && name !== env.name) void patchEnv(env, { name: name.trim() }, "Rename");
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
              if (e.key === "Escape") {
                setName(env.name);
                setEditing(false);
              }
            }}
          />
        ) : (
          <h2 onDoubleClick={() => setEditing(true)} title="Double-click to rename">
            {env.name}
          </h2>
        )}
        <EnvChip type={env.type} />
        <span className="dim">{env.status}</span>
        {env.statusDetail && <span className="dim truncate">{env.statusDetail}</span>}
      </div>

      <div className="env-actions">
        {env.released ? null : env.status === "stopped" || env.status === "error" ? (
          <button className="btn sm" disabled={busy} onClick={() => void act("Start", (b) => b.startEnv(env.id)).then(putEnv)}>
            <Play /> Start
          </button>
        ) : (
          <button className="btn sm" disabled={busy || !!inUse} title={inUseTitle} onClick={() => void act("Stop", (b) => b.stopEnv(env.id)).then(putEnv)}>
            <Square /> Stop
          </button>
        )}
        {/* a released eval fork has no storage left to start, snapshot, fork or reset */}
        {!env.released && (
          <>
            <SnapshotButton env={env} inUse={inUse} onDone={() => setRev((r) => r + 1)} />
            <button className="btn sm" disabled={busy || !!inUse} title={inUseTitle} onClick={() => void act("Fork", (b) => b.forkEnv(env.id, {})).then((e) => e && openEnv(e.id))}>
              <GitFork /> Fork
            </button>
            <ConfirmButton
              small
              label="Reset"
              icon={<RotateCcw />}
              confirmLabel={env.baseSnapshotId ? "Reset to base snapshot" : "Reset to clean image"}
              disabled={busy || !!inUse}
              title={inUseTitle ?? "Discard all changes in this environment"}
              onConfirm={() => act("Reset", (b) => b.resetEnv(env.id, {})).then(putEnv)}
            />
          </>
        )}
        <ConfirmButton
          small
          className="danger"
          label="Delete"
          icon={<Trash2 />}
          confirmLabel={`Delete ${env.name}`}
          disabled={!!inUse}
          title={inUseTitle}
          onConfirm={() => act("Delete", (b) => b.deleteEnv(env.id))}
        />
      </div>
      {inUse && (
        <div className="env-busy" title={inUseTitle}>
          <span className="dot busy" />
          <span className="truncate">{inUse}</span>
        </div>
      )}

      <div className="env-net">
        <NetIcon mode={env.network} size={13} />
        <Hint tip={NET_ALWAYS}>
          <span className="dim">Network</span>
        </Hint>
        {env.released || evalUse ? (
          <>
            <span>{env.network}</span>
            {evalUse && (
              <span className="chip" title={`Read-only while ${evalUse.reason}`}>
                read-only: eval running
              </span>
            )}
          </>
        ) : (
          <Segmented<NetworkMode>
            small
            value={env.network}
            onChange={(v) => void patchEnv(env, { network: v }, "Network mode")}
            options={[
              { value: "off", label: "Off", tip: NET_TIP.off },
              { value: "registries", label: "Registries", tip: NET_TIP.registries },
              { value: "web", label: "Web", tip: NET_TIP.web },
            ]}
          />
        )}
      </div>

      <section className="env-sec">
        <h3>Facts</h3>
        {!f ? (
          <div className="dim">{env.status === "starting" ? "Gathering from the environment" : "Not gathered"}</div>
        ) : (
          <dl className="kv facts">
            <dt>
              <Hint tip={ENV_TYPE_TIP[env.type]}>Isolation</Hint>
            </dt>
            <dd>{f.isolation}</dd>
            {f.os && (
              <>
                <dt>OS</dt>
                <dd>{f.os}</dd>
              </>
            )}
            {f.kernel && (
              <>
                <dt>Kernel</dt>
                <dd className="mono">{f.kernel}</dd>
              </>
            )}
            {f.arch && (
              <>
                <dt>Arch</dt>
                <dd className="mono">{f.arch}</dd>
              </>
            )}
            {f.cpus != null && (
              <>
                <dt>CPUs</dt>
                <dd className="num">{f.cpus} vCPU</dd>
              </>
            )}
            {f.memoryMiB != null && (
              <>
                <dt>Memory</dt>
                <dd className="num">{fmtMiB(f.memoryMiB)}</dd>
              </>
            )}
            {f.diskMiB != null && (
              <>
                <dt>Disk</dt>
                <dd className="num">
                  {f.diskUsedMiB != null ? `${fmtMiB(f.diskUsedMiB)} used of ` : ""}
                  {fmtMiB(f.diskMiB)}
                  {f.diskUsedMiB != null && (
                    <span className="disk-bar">
                      <span style={{ width: `${(f.diskUsedMiB / f.diskMiB) * 100}%` }} />
                    </span>
                  )}
                </dd>
              </>
            )}
            <dt>Runs as</dt>
            <dd className="mono">{f.user}</dd>
            <dt>Workdir</dt>
            <dd className="mono">{f.workdir}</dd>
            <dt>Mac folders</dt>
            <dd>{f.hostFoldersMounted ? <span className="err-text">mounted</span> : "none mounted"}</dd>
            <dt>Exchange dirs</dt>
            <dd>
              {f.mounts.length
                ? f.mounts.map((m) => (
                    <span key={m.path} className="mono fact-chip" title={`${m.kind}, ${m.access === "ro" ? "read-only" : "read-write"} for the agent`}>
                      {m.path} {m.access}
                    </span>
                  ))
                : "none"}
            </dd>
            {f.image && (
              <>
                <dt>Image</dt>
                <dd>
                  <span className="mono">{f.image.name}</span>
                  {f.image.bytes != null && <span className="dim num"> {fmtBytes(f.image.bytes)}</span>}
                  {f.image.digest && (
                    <div className="mono dim fact-digest" title={f.image.digest}>
                      {f.image.digest.slice(0, 19)}…
                    </div>
                  )}
                </dd>
              </>
            )}
            {f.runtimes && (
              <>
                <dt>Runtimes</dt>
                <dd>
                  <Hint tip={FIELD_TIP.python}>Python (WASM) {f.runtimes.python ? "on" : "off"}</Hint>,{" "}
                  <Hint tip={FIELD_TIP.javascript}>JavaScript {f.runtimes.javascript ? "on" : "off"}</Hint>
                </dd>
              </>
            )}
            {f.tools && f.tools.length > 0 && (
              <>
                <dt>Tools</dt>
                <dd className="fact-tools">
                  {f.tools.map((t) => (
                    <span key={t} className="mono fact-chip">
                      {t}
                    </span>
                  ))}
                </dd>
              </>
            )}
            {f.simCommands && (
              <>
                <dt>Commands</dt>
                <dd>
                  <details className="fact-cmds">
                    <summary>{f.simCommands.length} simulated commands</summary>
                    <div className="mono dim">{f.simCommands.join(" ")}</div>
                  </details>
                </dd>
              </>
            )}
            {env.vm && (
              <>
                <dt>
                  <Hint tip={FIELD_TIP.backend}>VM backend</Hint>
                </dt>
                <dd className="mono">{env.vm.backend}</dd>
              </>
            )}
            {env.sim && (
              <>
                <dt>
                  <Hint tip={FIELD_TIP.fsLimit}>FS limit</Hint>
                </dt>
                <dd className="num">{fmtBytes(env.sim.maxTotalBytes)}</dd>
              </>
            )}
            {env.diskBytes != null && (
              <>
                <dt>On Mac disk</dt>
                <dd className="num" title={exactBytes(env.diskBytes)}>
                  {fmtBytes(env.diskBytes)}
                </dd>
              </>
            )}
            {parent && (
              <>
                <dt>Forked from</dt>
                <dd>
                  <button className="cell-link" onClick={() => openEnv(parent.id)}>
                    {parent.name}
                  </button>
                  {env.baseSnapshotId && <span className="dim mono"> {env.baseSnapshotId}</span>}
                </dd>
              </>
            )}
            <dt>Gathered</dt>
            <dd>
              <Time ts={f.gatheredAt} />
            </dd>
          </dl>
        )}
      </section>

      <details className="env-sec env-compare-sec">
        <summary>
          <h3>VM vs simulated</h3>
        </summary>
        <EnvCompare highlight={env.type} />
      </details>

      <section className="env-sec">
        <h3>Resources</h3>
        {env.status !== "running" && env.status !== "busy" ? (
          <div className="dim">Not running</div>
        ) : (
          <div className="sparks">
            <div className="spark-box">
              <div className="spark-label">
                Memory (RSS){memMax ? <span className="dim num"> of {fmtBytes(memMax)}</span> : null}
              </div>
              <Sparkline points={series.rss} format={(v) => fmtBytes(v)} max={memMax} label="RSS" color="var(--c-vm)" />
            </div>
            <div className="spark-box">
              <div className="spark-label" title="100% = one full core">
                CPU{f?.cpus ? <span className="dim num"> of {f.cpus * 100}%</span> : null}
              </div>
              <Sparkline points={series.cpu} format={(v) => fmtPct(v)} max={(f?.cpus ?? 1) * 100} label="CPU" color="var(--c-model)" />
            </div>
          </div>
        )}
      </section>

      <section className="env-sec">
        <h3>
          Snapshots <span className="dim num">{snaps?.length ?? ""}</span>
        </h3>
        {snaps == null ? (
          <div className="dim">Loading</div>
        ) : snaps.length === 0 ? (
          <div className="dim">No snapshots</div>
        ) : (
          <div className="snaps">
            {snaps
              .slice()
              .reverse()
              .map((s) => (
                <div key={s.id} className="snap-row">
                  <div className="snap-main">
                    <div className="truncate">{s.label}</div>
                    <div className="dim snap-meta num">
                      <span className={`chip ${s.kind === "factory" ? "" : s.kind === "auto" ? "accent" : ""}`}>{s.kind}</span> {fmtBytes(s.bytes)} <Time ts={s.createdAt} />
                    </div>
                  </div>
                  <div className="snap-actions" hidden={env.released}>
                    <ConfirmButton
                      small
                      className="ghost"
                      label="Restore"
                      confirmLabel="Restore, discarding changes"
                      disabled={busy || !!inUse}
                      title={inUseTitle}
                      onConfirm={() => act("Restore", (b) => b.resetEnv(env.id, { snapshotId: s.id })).then(putEnv)}
                    />
                    <button className="btn sm ghost" onClick={() => void act("Fork", (b) => b.forkEnv(env.id, { snapshotId: s.id })).then((e) => e && openEnv(e.id))}>
                      Fork
                    </button>
                  </div>
                </div>
              ))}
          </div>
        )}
      </section>
    </div>
  );
}
