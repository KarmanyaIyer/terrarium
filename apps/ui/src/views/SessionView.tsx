import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ChevronDown, ChevronUp, PanelRight, Square, Trash2 } from "lucide-react";
import type { HarnessProfile, NetworkMode, SessionSummary, UpdateSessionRequest } from "@terrarium/shared";
import { act, openEnv, openView, setPref, useStore } from "../state/store";
import { derive, itemForSelection, type Item } from "../lib/trace";
import { fmtInt, fmtMs, fmtTok, plural } from "../lib/format";
import { ModelPicker } from "../components/ModelPicker";
import { ConfirmButton, Popover, Segmented, Switch, usePop } from "../components/ui";
import { EnvChip, NetIcon } from "../components/Sidebar";
import { Timeline } from "./session/Timeline";
import { CallBlock, RowBlock, ToolBlock, UserBlock } from "./session/Blocks";
import { Composer } from "./session/Composer";
import { Check } from "lucide-react";

export const HARNESS: { id: HarnessProfile; label: string; title: string }[] = [
  { id: "terrarium", label: "terrarium", title: "~125-token prompt; tools bash, read, write, edit" },
  { id: "pi-stock", label: "pi-stock", title: "Pi coding agent 1.4.0 prompt and tools" },
  { id: "chat", label: "chat", title: "No tools, no environment" },
];

function patchSession(id: string, p: UpdateSessionRequest) {
  void act("Update session", (b) => b.updateSession(id, p)).then((s) => {
    if (s) useStore.setState((st) => ({ sessions: { ...st.sessions, [s.id]: s } }));
  });
}

function HarnessPicker({ s }: { s: SessionSummary }) {
  const pop = usePop();
  const running = s.status === "running";
  const cur = HARNESS.find((h) => h.id === s.harness);
  return (
    <>
      <button ref={pop.ref} className="hdr-btn" onClick={pop.toggle} title={`Harness: ${cur?.title ?? s.harness}`}>
        <span className="dim">harness</span> {s.harness}
        <ChevronDown size={12} className="dim" />
      </button>
      <Popover anchor={pop.ref} open={pop.open} onClose={pop.close} width={300}>
        <div className="menu">
          {HARNESS.map((h) => {
            const disabled = running || (h.id !== "chat" && !s.envId);
            return (
              <button
                key={h.id}
                className="menu-item two-line"
                disabled={disabled}
                title={running ? "Stop the run first" : !s.envId && h.id !== "chat" ? "Needs an environment" : undefined}
                onClick={() => {
                  pop.close();
                  if (h.id !== s.harness) patchSession(s.id, { harness: h.id });
                }}
              >
                {h.id === s.harness ? <Check size={12} /> : <span style={{ width: 13 }} />}
                <span>
                  <span className="mono">{h.label}</span>
                  <span className="dim menu-sub">{!running && !s.envId && h.id !== "chat" ? "Needs an environment" : h.title}</span>
                </span>
              </button>
            );
          })}
        </div>
      </Popover>
    </>
  );
}

function Header({ s, stats }: { s: SessionSummary; stats: ReturnType<typeof derive>["totals"] & { ms: number } }) {
  const env = useStore((st) => (s.envId ? st.envs[s.envId] : undefined));
  const models = useStore((st) => st.models);
  const inspectorOpen = useStore((st) => st.inspectorOpen);
  const evalRun = useStore((st) => (s.evalRunId ? st.evalRuns.find((r) => r.id === s.evalRunId) : undefined));
  const model = models.find((m) => m.id === s.modelId);
  const [title, setTitle] = useState(s.title);
  const [editing, setEditing] = useState(false);
  useEffect(() => setTitle(s.title), [s.title]);
  const running = s.status === "running";

  return (
    <div className="session-header">
      <div className="sh-row">
        {editing ? (
          <input
            className="input sh-title-input"
            value={title}
            autoFocus
            onChange={(e) => setTitle(e.target.value)}
            onBlur={() => {
              setEditing(false);
              if (title.trim() && title !== s.title) patchSession(s.id, { title: title.trim() });
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
              if (e.key === "Escape") {
                setTitle(s.title);
                setEditing(false);
              }
            }}
          />
        ) : (
          <h1 className="sh-title truncate" onDoubleClick={() => setEditing(true)} title="Double-click to rename">
            {s.title}
          </h1>
        )}
        {evalRun && (
          <button className="hdr-btn" onClick={() => openView({ kind: "evals", runId: evalRun.id, suiteId: evalRun.suiteId })} title="Open the eval run">
            <span className="dim">eval</span> {evalRun.suiteTitle} <span className="dim mono">{s.evalCaseId}</span>
          </button>
        )}
        {/* whole items wrap onto a hidden second line instead of being cut mid-word */}
        <span className="sh-stats num dim">
          <span>{plural(stats.calls, "call")}</span>
          {s.envId || stats.tools ? <span>{plural(stats.tools, "tool")}</span> : null}
          {stats.errors ? <span className="err-text" title="Tool calls with a non-zero exit or error, plus failed model calls">{stats.errors} failed</span> : null}
          <span title={`Summed over all model calls: ${fmtInt(stats.prompt)} prompt + ${fmtInt(stats.completion)} output tokens`}>
            {fmtTok(stats.prompt)} in, {fmtTok(stats.completion)} out
          </span>
          <span title="Wall time from the first message">{fmtMs(stats.ms)}</span>
        </span>
        <span className="blk-spacer" />
        {running && (
          <button className="btn sm stop" onClick={() => void act("Stop", (b) => b.stopSession(s.id))}>
            <Square /> Stop
          </button>
        )}
        <ConfirmButton
          small
          className="ghost"
          label=""
          icon={<Trash2 />}
          title="Delete session"
          confirmLabel="Delete session"
          disabled={running}
          onConfirm={() => act("Delete session", (b) => b.deleteSession(s.id))}
        />
        <button className={`icon-btn${inspectorOpen ? " on" : ""}`} title="Inspector (⌘I)" onClick={() => setPref("inspectorOpen", !inspectorOpen)}>
          <PanelRight />
        </button>
      </div>
      <div className="sh-row controls">
        {env ? (
          <button className="hdr-btn env" onClick={() => openEnv(env.id, "env")} title={env.facts?.isolation ?? env.name}>
            <span className={`dot ${env.status}`} />
            {env.name}
            <EnvChip type={env.type} />
          </button>
        ) : (
          <span className="hdr-btn static dim" title="Chat-only: no environment, no tools">
            no environment
          </span>
        )}
        <ModelPicker session={s} />
        <HarnessPicker s={s} />
        <Switch
          on={s.thinking}
          label="Thinking"
          disabled={running || model?.thinking === "none"}
          title={model?.thinking === "none" ? `${model.name} has no thinking mode` : "enable_thinking in the chat template; thinking tokens count against the output cap"}
          onChange={(v) => patchSession(s.id, { thinking: v })}
        />
        {env && (
          <div className="hdr-net">
            <NetIcon mode={env.network} />
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
                { value: "registries", label: "Registries", title: "GET/HEAD to PyPI, npm, GitHub downloads, Alpine CDN only" },
                { value: "web", label: "Web", title: "Public HTTP/HTTPS; private, loopback and link-local ranges still denied" },
              ]}
            />
          </div>
        )}
      </div>
    </div>
  );
}

function Transcript({ d, s }: { d: ReturnType<typeof derive>; s: SessionSummary }) {
  const selection = useStore((st) => st.selection);
  const scrollRef = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const [showJump, setShowJump] = useState(false);
  const items = d.items;
  const v = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => (items[i].kind === "tool" ? 120 : items[i].kind === "row" ? 34 : 90),
    overscan: 6,
    getItemKey: (i) => items[i].key,
  });

  // follow the bottom while new content streams in
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && atBottom.current) el.scrollTop = el.scrollHeight;
  });

  // jump to the selected item when it was selected elsewhere (timeline, inspector)
  const selItem = itemForSelection(d, selection);
  const selIndex = selItem ? items.indexOf(selItem) : -1;
  const lastJump = useRef<string | null>(null);
  useEffect(() => {
    const key = selection ? `${selection.kind}:${selection.seq}` : null;
    if (selIndex >= 0 && key !== lastJump.current) {
      lastJump.current = key;
      const el = scrollRef.current;
      const vi = v.getVirtualItems();
      const visible = vi.some((x) => x.index === selIndex && el && x.start >= el.scrollTop && x.end <= el.scrollTop + el.clientHeight);
      if (!visible) {
        atBottom.current = false;
        v.scrollToIndex(selIndex, { align: "center" });
      }
    }
  }, [selIndex, selection, v]);

  const render = (it: Item) => {
    const selected = !!selItem && selItem === it;
    switch (it.kind) {
      case "user":
        return <UserBlock it={it} t0={d.t0} />;
      case "call":
        return <CallBlock it={it} t0={d.t0} selected={selected} />;
      case "tool":
        return <ToolBlock it={it} t0={d.t0} selected={selected} />;
      case "row":
        return <RowBlock it={it} t0={d.t0} session={s} d={d} />;
    }
  };

  return (
    <div
      className="transcript"
      ref={scrollRef}
      onScroll={(e) => {
        const el = e.currentTarget;
        const bottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 40;
        atBottom.current = bottom;
        if (showJump === bottom) setShowJump(!bottom);
      }}
    >
      {items.length === 0 && <div className="empty transcript-empty">No messages yet</div>}
      <div style={{ height: v.getTotalSize(), position: "relative" }}>
        {v.getVirtualItems().map((vi) => (
          <div key={vi.key} data-index={vi.index} ref={v.measureElement} className="tr-row" style={{ transform: `translateY(${vi.start}px)` }}>
            {render(items[vi.index])}
          </div>
        ))}
      </div>
      {showJump && (
        <button
          className="jump-bottom btn sm"
          onClick={() => {
            atBottom.current = true;
            const el = scrollRef.current;
            if (el) el.scrollTop = el.scrollHeight;
            setShowJump(false);
          }}
        >
          <ChevronDown /> Latest
        </button>
      )}
    </div>
  );
}

export function SessionView({ id }: { id: string }) {
  const s = useStore((st) => st.sessions[id]);
  const trace = useStore((st) => st.traces[id]);
  const timelineOpen = useStore((st) => st.timelineOpen);
  const d = useMemo(() => derive(trace), [trace]);
  if (!s) return <div className="empty">Session not found</div>;
  const stats = { ...d.totals, ms: (s.status === "running" ? Date.now() : d.lastTs) - d.t0 };

  return (
    <div className="session">
      <Header s={s} stats={stats} />
      <div className={`tl-wrap${timelineOpen ? "" : " closed"}`}>
        <button className="tl-toggle" onClick={() => setPref("timelineOpen", !timelineOpen)} title={timelineOpen ? "Hide timeline" : "Show timeline"}>
          {timelineOpen ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
          <span>Timeline</span>
        </button>
        {timelineOpen && trace?.loaded && d.items.length > 0 && <Timeline d={d} sessionStatus={s.status} hasEnv={!!s.envId} />}
      </div>
      {!trace?.loaded ? (
        <div className="empty">Loading events…</div>
      ) : trace.error ? (
        <div className="empty err-text">{trace.error}</div>
      ) : (
        <Transcript d={d} s={s} />
      )}
      <Composer session={s} />
    </div>
  );
}
