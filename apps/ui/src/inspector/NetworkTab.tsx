import { useEffect, useMemo, useRef, useState } from "react";
import type { EnvSummary, NetworkMode, SessionSummary } from "@terrarium/shared";
import { act, loadNet, select, useStore } from "../state/store";
import { clockTime, exactTime, fmtBytes } from "../lib/format";
import { Segmented } from "../components/ui";
import { NetIcon } from "../components/Sidebar";

export function NetworkTab({ env, session }: { env: EnvSummary; session?: SessionSummary }) {
  const entries = useStore((s) => s.net[env.id]);
  const selection = useStore((s) => s.selection);
  const traceEvents = useStore((s) => (session ? s.traces[session.id]?.events : undefined));
  const [decision, setDecision] = useState<"all" | "allow" | "deny">("all");
  const [scope, setScope] = useState<"session" | "env">(session ? "session" : "env");
  const [q, setQ] = useState("");
  const selRef = useRef<HTMLTableRowElement>(null);

  useEffect(() => {
    void loadNet(env.id);
  }, [env.id]);
  useEffect(() => {
    if (!session) setScope("env");
  }, [session]);

  const selId = selection?.kind === "net" ? selection.entryId : null;
  const rows = useMemo(() => {
    const ql = q.trim().toLowerCase();
    return (entries ?? [])
      .filter((e) => decision === "all" || e.decision === decision)
      .filter((e) => scope === "env" || !session || e.sessionId === session.id)
      .filter((e) => !ql || `${e.method} ${e.url} ${e.reason} ${e.ip ?? ""}`.toLowerCase().includes(ql))
      .slice()
      .reverse();
  }, [entries, decision, scope, session, q]);

  useEffect(() => {
    selRef.current?.scrollIntoView({ block: "nearest" });
  }, [selId]);

  const all = entries ?? [];
  const denied = all.filter((e) => e.decision === "deny").length;

  return (
    <div className="nettab">
      <div className="net-mode">
        <NetIcon mode={env.network} size={13} />
        <span className="dim">Mode</span>
        <Segmented<NetworkMode>
          small
          value={env.network}
          ariaLabel="Network mode"
          onChange={(v) =>
            void act("Network mode", (b) => b.updateEnv(env.id, { network: v })).then((e) => {
              if (e) useStore.setState((st) => ({ envs: { ...st.envs, [e.id]: e } }));
            })
          }
          options={[
            { value: "off", label: "Off", title: "Every connection denied" },
            { value: "registries", label: "Registries", title: "GET/HEAD to PyPI, npm, GitHub downloads, Alpine CDN" },
            { value: "web", label: "Web", title: "Public HTTP/HTTPS; private, loopback, link-local ranges still denied" },
          ]}
        />
        <span className="blk-spacer" />
        <span className="dim num">
          {all.length} logged, <span className={denied ? "err-text" : undefined}>{denied} denied</span>
        </span>
      </div>
      <div className="net-filters">
        <Segmented
          small
          value={decision}
          onChange={setDecision}
          options={[
            { value: "all", label: "All" },
            { value: "allow", label: "Allowed" },
            { value: "deny", label: "Denied" },
          ]}
        />
        {session && (
          <Segmented
            small
            value={scope}
            onChange={setScope}
            options={[
              { value: "session", label: "This session" },
              { value: "env", label: "Whole env" },
            ]}
          />
        )}
        <input className="input net-q" placeholder="Filter URL, reason" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <div className="net-table-wrap">
        {entries == null ? (
          <div className="empty">Loading</div>
        ) : rows.length === 0 ? (
          <div className="empty">{all.length ? "No entries match" : "No network attempts"}</div>
        ) : (
          <table className="table net-table">
            <thead>
              <tr>
                <th>Time</th>
                <th>Request</th>
                <th>Decision</th>
                <th className="r">Status</th>
                <th className="r">In</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((e) => {
                const sel = e.id === selId;
                return (
                  <tr
                    key={e.id}
                    ref={sel ? selRef : undefined}
                    className={`click${sel ? " sel" : ""}`}
                    onClick={() => {
                      const ev = traceEvents?.find((x) => x.type === "net" && x.entry.id === e.id);
                      select({ kind: "net", entryId: e.id, seq: ev?.seq ?? 0 }, { follow: false });
                    }}
                  >
                    <td className="num dim nowrap" title={exactTime(e.ts)}>
                      {clockTime(e.ts)}
                    </td>
                    <td className="net-url">
                      {/* the selected row shows the whole request instead of a cut-off line */}
                      <div className={`mono${sel ? " net-full" : " truncate"}`} title={sel ? undefined : e.url}>
                        <span className="dim">{e.method}</span> {sel ? e.url : e.host}
                        {!sel && <span className="dim">{e.url.replace(/^https?:\/\/[^/]+/, "")}</span>}
                      </div>
                      <div className={`dim net-reason${sel ? "" : " truncate"}`} title={sel ? undefined : e.reason}>
                        {e.reason}
                        {e.ip ? ` · ${e.ip}` : ""}
                        {sel && e.bytesOut != null ? ` · ${fmtBytes(e.bytesOut)} out` : ""}
                      </div>
                    </td>
                    <td>
                      <span className={`chip ${e.decision === "deny" ? "err" : "ok"}`}>{e.decision === "deny" ? "denied" : "allowed"}</span>
                    </td>
                    <td className="r num">{e.status ?? "–"}</td>
                    <td className="r num dim">{e.bytesIn != null ? fmtBytes(e.bytesIn) : "–"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
