import { useMemo } from "react";
import { ChevronDown, X } from "lucide-react";
import { openEnv, setPref, useStore, type InspectorTab } from "../state/store";
import { derive } from "../lib/trace";
import { Popover, usePop } from "../components/ui";
import { EnvChip, NetIcon } from "../components/Sidebar";
import { FilesTab } from "./FilesTab";
import { RequestTab } from "./RequestTab";
import { NetworkTab } from "./NetworkTab";
import { EnvTab } from "./EnvTab";
import { ShellTab } from "./ShellTab";

const TABS: { id: InspectorTab; label: string; needsEnv: boolean; needsSession: boolean }[] = [
  { id: "files", label: "Files", needsEnv: true, needsSession: false },
  { id: "request", label: "Request", needsEnv: false, needsSession: true },
  { id: "network", label: "Network", needsEnv: true, needsSession: false },
  { id: "env", label: "Environment", needsEnv: true, needsSession: false },
  { id: "shell", label: "Shell", needsEnv: true, needsSession: false },
];

function EnvSwitcher({ envId }: { envId: string | null }) {
  const envs = useStore((s) => s.envs);
  const pop = usePop();
  const env = envId ? envs[envId] : undefined;
  const list = Object.values(envs).filter((e) => !e.ephemeral || e.id === envId);
  return (
    <>
      <button ref={pop.ref} className="insp-env" onClick={pop.toggle} title="Environment shown in the inspector">
        {env ? (
          <>
            <span className={`dot ${env.status}`} />
            <span className="truncate">{env.name}</span>
            <EnvChip type={env.type} />
            <NetIcon mode={env.network} />
          </>
        ) : (
          <span className="dim">No environment</span>
        )}
        <ChevronDown size={12} className="dim" />
      </button>
      <Popover anchor={pop.ref} open={pop.open} onClose={pop.close} width={260}>
        <div className="menu">
          {list.map((e) => (
            <button
              key={e.id}
              className="menu-item"
              onClick={() => {
                pop.close();
                openEnv(e.id, useStore.getState().inspectorTab);
              }}
            >
              <span className={`dot ${e.status}`} />
              <span className="truncate" style={{ flex: 1 }}>
                {e.name}
              </span>
              <span className="dim">{e.type === "vm" ? "VM" : "SIM"}</span>
            </button>
          ))}
        </div>
      </Popover>
    </>
  );
}

export function Inspector() {
  const tab = useStore((s) => s.inspectorTab);
  const width = useStore((s) => s.inspectorWidth);
  const view = useStore((s) => s.view);
  const sessions = useStore((s) => s.sessions);
  const inspectorEnvId = useStore((s) => s.inspectorEnvId);
  const envs = useStore((s) => s.envs);
  const session = view.kind === "session" ? sessions[view.id] : undefined;
  const trace = useStore((s) => (session ? s.traces[session.id] : undefined));
  const d = useMemo(() => derive(trace), [trace]);

  // the inspector follows the open session's env unless another env was picked
  const envId =
    inspectorEnvId && envs[inspectorEnvId]
      ? inspectorEnvId
      : session
        ? session.envId
        : (Object.values(envs).find((e) => !e.ephemeral)?.id ?? null);
  const env = envId ? envs[envId] : undefined;
  const sessionForEnv = session && session.envId === envId ? session : undefined;

  const avail = (t: (typeof TABS)[number]) => (!t.needsEnv || !!env) && (!t.needsSession || !!session);
  const active = TABS.find((t) => t.id === tab && avail(t)) ? tab : (TABS.find(avail)?.id ?? "env");

  return (
    <aside className="inspector" style={{ width }}>
      <div
        className="resize-x left"
        onMouseDown={(ev) => {
          const x0 = ev.clientX;
          const w0 = width;
          const move = (m: MouseEvent) =>
            useStore.setState({ inspectorWidth: Math.max(320, Math.min(window.innerWidth - 560, w0 - (m.clientX - x0))) });
          const up = () => {
            window.removeEventListener("mousemove", move);
            window.removeEventListener("mouseup", up);
            setPref("inspectorWidth", useStore.getState().inspectorWidth);
          };
          window.addEventListener("mousemove", move);
          window.addEventListener("mouseup", up);
        }}
      />
      <div className="insp-head">
        <EnvSwitcher envId={envId} />
        <span className="blk-spacer" />
        <button className="icon-btn sm" title="Close inspector (⌘I)" onClick={() => setPref("inspectorOpen", false)}>
          <X />
        </button>
      </div>
      <div className="insp-tabs" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={active === t.id}
            className={active === t.id ? "on" : ""}
            disabled={!avail(t)}
            title={!avail(t) ? (t.needsSession ? "Open a session" : "No environment") : undefined}
            onClick={() => useStore.setState({ inspectorTab: t.id })}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div className="insp-body">
        {active === "files" && env && <FilesTab env={env} session={sessionForEnv} d={sessionForEnv ? d : undefined} />}
        {active === "request" && session && <RequestTab session={session} d={d} />}
        {active === "network" && env && <NetworkTab env={env} session={sessionForEnv} />}
        {active === "env" && env && <EnvTab env={env} />}
        {active === "shell" && env && <ShellTab env={env} />}
        {active === "env" && !env && <div className="empty">{session ? "This chat has no environment" : "No environments"}</div>}
      </div>
    </aside>
  );
}
