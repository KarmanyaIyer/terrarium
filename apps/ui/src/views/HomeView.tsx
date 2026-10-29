import { useMemo } from "react";
import { Plus } from "lucide-react";
import { openEnv, openSession, useStore } from "../state/store";
import { newSession } from "../lib/actions";
import { fmtCtx, fmtInt } from "../lib/format";
import { Time } from "../components/ui";
import { EnvChip, NetIcon } from "../components/Sidebar";
import { modelName } from "../components/ModelPicker";

export function HomeView() {
  const sessions = useStore((s) => s.sessions);
  const envs = useStore((s) => s.envs);
  const models = useStore((s) => s.models);
  const list = useMemo(
    () =>
      Object.values(sessions)
        .filter((s) => !s.evalRunId)
        .sort((a, b) => b.updatedAt - a.updatedAt),
    [sessions],
  );
  const envList = Object.values(envs).filter((e) => !e.ephemeral);

  if (!list.length && !envList.length)
    return (
      <div className="empty fill">
        No environments or chats yet
        <div className="row-gap">
          <button className="btn primary" onClick={() => useStore.setState({ newEnvOpen: true })}>
            <Plus /> New environment
          </button>
          <button className="btn" onClick={() => void newSession(null)}>
            <Plus /> New chat
          </button>
        </div>
      </div>
    );

  return (
    <div className="home">
      <div className="view-head">
        <h1>Sessions</h1>
        <span className="blk-spacer" />
        <button className="btn" onClick={() => void newSession(null)}>
          <Plus /> New chat
        </button>
        <button className="btn primary" onClick={() => useStore.setState({ newEnvOpen: true })}>
          <Plus /> New environment
        </button>
      </div>
      <div className="table-wrap">
        <table className="table">
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
                <tr key={s.id} onClick={() => openSession(s.id)} className="click">
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
                  <td>{modelName(models, s.modelId)}</td>
                  <td className="mono dim">{s.harness}</td>
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
      </div>
    </div>
  );
}
