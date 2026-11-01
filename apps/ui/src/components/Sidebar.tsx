import { deleteSession } from "../state/appUndo";
import { useMemo } from "react";
import { Boxes, ChevronRight, FlaskConical, Globe, Microscope, Package, Plus, Square, SquareCheck, Trash2, WifiOff, Settings as SettingsIcon } from "lucide-react";
import type { EnvSummary, NetworkMode, SessionSummary } from "@terrarium/shared";
import { openEnv, openSession, openView, setPref, useStore } from "../state/store";
import { useLab } from "../state/lab";
import { ConfirmButton, Time } from "./ui";
import { newSession } from "../lib/actions";
import { TerrariumMark } from "./Mark";

export function NetIcon({ mode, size = 12 }: { mode: NetworkMode; size?: number }) {
  const title =
    mode === "off"
      ? "Network off: every connection is denied"
      : mode === "registries"
        ? "Network: package registries only (GET/HEAD to PyPI, npm, GitHub downloads, Alpine)"
        : "Network: public web (private and loopback ranges still denied)";
  const I = mode === "off" ? WifiOff : mode === "registries" ? Package : Globe;
  return (
    <span className={`net-icon ${mode}`} title={title} aria-label={title}>
      <I size={size} />
    </span>
  );
}

export function EnvChip({ type }: { type: EnvSummary["type"] }) {
  return (
    <span className={`chip ${type}`} title={type === "vm" ? "Linux micro-VM" : "Simulated shell (not a real OS)"}>
      {type === "vm" ? "VM" : "SIM"}
    </span>
  );
}

function SessionRow({ s, active }: { s: SessionSummary; active: boolean }) {
  return (
    <div
      className={`sb-session${active ? " active" : ""}`}
      onClick={() => openSession(s.id)}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) {
          e.preventDefault();
          openSession(s.id);
        }
      }}
    >
      <span className={`dot ${s.status === "running" ? "live" : s.status === "error" ? "error" : "idle"}`} />
      <span className="truncate sb-title">{s.title}</span>
      {s.status === "running" ? <span className="sb-time live-text">running</span> : <Time ts={s.updatedAt} className="sb-time" />}
      <span className="sb-hover" onClick={(e) => e.stopPropagation()}>
        <ConfirmButton
          small
          className="ghost icon-only"
          label=""
          icon={<Trash2 />}
          title="Delete session"
          confirmLabel="Delete"
          onConfirm={() => deleteSession(s)}
        />
      </span>
    </div>
  );
}

export function Sidebar() {
  const envs = useStore((s) => s.envs);
  const sessions = useStore((s) => s.sessions);
  const view = useStore((s) => s.view);
  const expanded = useStore((s) => s.expandedEnvs);
  const inspectorEnvId = useStore((s) => s.inspectorEnvId);
  const showEphemeral = useStore((s) => s.showEphemeral);
  const allModels = useStore((s) => s.models);
  const models = useMemo(() => allModels.filter((m) => !m.strain), [allModels]);
  const specimen = useLab((s) => (s.lab?.status === "ready" ? s.lab.model?.name : undefined));
  const evalRuns = useStore((s) => s.evalRuns);
  const width = useStore((s) => s.sidebarWidth);

  const envList = useMemo(
    () => Object.values(envs).filter((e) => showEphemeral || !e.ephemeral).sort((a, b) => a.createdAt - b.createdAt),
    [envs, showEphemeral],
  );
  const byEnv = useMemo(() => {
    const m: Record<string, SessionSummary[]> = {};
    for (const s of Object.values(sessions)) {
      if (s.evalRunId && !showEphemeral) continue;
      const k = s.envId ?? "";
      (m[k] ??= []).push(s);
    }
    for (const k of Object.keys(m)) m[k].sort((a, b) => b.updatedAt - a.updatedAt);
    return m;
  }, [sessions, showEphemeral]);
  const ephemeralCount = Object.values(envs).filter((e) => e.ephemeral).length;
  const activeId = view.kind === "session" ? view.id : null;
  const loaded = models.filter((m) => m.loaded).length;
  const runningEvals = evalRuns.filter((r) => r.status === "running").length;
  const runningSessions = Object.values(sessions).filter((s) => s.status === "running" && !s.evalRunId).length;
  const chats = byEnv[""] ?? [];

  return (
    <nav className="sidebar" style={{ width }}>
      <div className="sb-areas">
        <button className={`sb-nav${view.kind === "home" ? " active" : ""}`} onClick={() => openView({ kind: "home" })}>
          <TerrariumMark size={13} />
          <span>Home</span>
          {runningSessions > 0 && (
            <span className="sb-badge live" title="Sessions running now">
              <span className="dot live" />
              {runningSessions}
            </span>
          )}
        </button>
        <button className={`sb-nav${view.kind === "evals" ? " active" : ""}`} onClick={() => openView({ kind: "evals" })}>
          <FlaskConical size={13} />
          <span>Evals</span>
          {runningEvals > 0 && (
            <span className="sb-badge live" title="Eval runs in progress">
              <span className="dot live" />
              {runningEvals}
            </span>
          )}
        </button>
        <button className={`sb-nav${view.kind === "lab" ? " active" : ""}`} onClick={() => openView({ kind: "lab" })}>
          <Microscope size={13} />
          <span>Lab</span>
          {specimen && (
            <span className="sb-badge" title={`On the bench: ${specimen}`}>
              <span className="dot ready" />
            </span>
          )}
        </button>
        <button className={`sb-nav${view.kind === "models" ? " active" : ""}`} onClick={() => openView({ kind: "models" })}>
          <Boxes size={13} />
          <span>Models</span>
          <span className="sb-badge num" title="Models loaded in oMLX">
            {loaded}/{models.length}
          </span>
        </button>
      </div>
      <div className="sb-scroll">
        <div className="sb-head">
          <span>Environments</span>
          <button className="icon-btn sm" title="New environment" onClick={() => useStore.setState({ newEnvOpen: true })}>
            <Plus />
          </button>
        </div>
        {envList.length === 0 && (
          <button className="sb-new" onClick={() => useStore.setState({ newEnvOpen: true })}>
            <Plus size={11} /> New environment
          </button>
        )}
        {envList.map((e) => {
          const open = !!expanded[e.id];
          const list = byEnv[e.id] ?? [];
          const running = list.some((s) => s.status === "running");
          return (
            <div key={e.id} className="sb-env-group">
              {/* the row opens the env in the inspector (and expands it); only the chevron collapses */}
              <div
                className={`sb-env${inspectorEnvId === e.id ? " inspecting" : ""}`}
                onClick={() => openEnv(e.id)}
                onKeyDown={(ev) => {
                  if (ev.target !== ev.currentTarget) return;
                  if (ev.key === "Enter" || ev.key === " ") {
                    ev.preventDefault();
                    openEnv(e.id);
                  } else if (ev.key === "ArrowLeft" || ev.key === "ArrowRight") {
                    ev.preventDefault();
                    useStore.setState({ expandedEnvs: { ...expanded, [e.id]: ev.key === "ArrowRight" } });
                  }
                }}
                role="button"
                tabIndex={0}
                aria-expanded={open}
                title={e.statusDetail ?? `${e.name}: ${e.status}`}
              >
                {/* mouse target only; the row handles Left/Right for keyboard users */}
                <span
                  className="sb-tw-btn"
                  aria-hidden
                  title={open ? "Collapse" : "Expand"}
                  onClick={(ev) => {
                    ev.stopPropagation();
                    useStore.setState({ expandedEnvs: { ...expanded, [e.id]: !open } });
                  }}
                >
                  <ChevronRight className={`sb-tw${open ? " open" : ""}`} size={12} />
                </span>
                <span className={`dot ${e.status}`} />
                <span className="truncate sb-title">{e.name}</span>
                {running && <span className="dot live" title="A session is running" />}
                <EnvChip type={e.type} />
                <NetIcon mode={e.network} />
              </div>
              {open && (
                <div className="sb-sessions">
                  {list.map((s) => (
                    <SessionRow key={s.id} s={s} active={s.id === activeId} />
                  ))}
                  <button className="sb-new" onClick={() => void newSession(e.id)}>
                    <Plus size={11} /> New session
                  </button>
                </div>
              )}
            </div>
          );
        })}

        <div className="sb-head">
          <span>Chats</span>
          <button className="icon-btn sm" title="New chat (no environment)" onClick={() => void newSession(null)}>
            <Plus />
          </button>
        </div>
        {chats.length === 0 && (
          <button className="sb-new" onClick={() => void newSession(null)}>
            <Plus size={11} /> New chat
          </button>
        )}
        <div className="sb-sessions flat">
          {chats.map((s) => (
            <SessionRow key={s.id} s={s} active={s.id === activeId} />
          ))}
        </div>
      </div>

      <div className="sb-foot">
        <button className={`sb-nav${view.kind === "settings" ? " active" : ""}`} onClick={() => openView({ kind: "settings" })}>
          <SettingsIcon size={13} />
          <span>Settings</span>
        </button>
        {ephemeralCount > 0 && (
          <button
            className={`sb-nav small${showEphemeral ? " checked" : ""}`}
            role="checkbox"
            aria-checked={showEphemeral}
            onClick={() => useStore.setState({ showEphemeral: !showEphemeral })}
            title="Disposable envs and sessions, one per eval cell"
          >
            {showEphemeral ? <SquareCheck size={12} /> : <Square size={12} />}
            <span>Show eval forks</span>
            <span className="sb-badge num">{ephemeralCount}</span>
          </button>
        )}
      </div>
      <div
        className="resize-x right"
        onMouseDown={(ev) => {
          const x0 = ev.clientX;
          const w0 = width;
          const move = (m: MouseEvent) => useStore.setState({ sidebarWidth: Math.max(180, Math.min(380, w0 + m.clientX - x0)) });
          const up = () => {
            window.removeEventListener("mousemove", move);
            window.removeEventListener("mouseup", up);
            setPref("sidebarWidth", useStore.getState().sidebarWidth);
          };
          window.addEventListener("mousemove", move);
          window.addEventListener("mouseup", up);
        }}
      />
    </nav>
  );
}
