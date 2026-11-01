import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ChevronDown, ChevronRight, ChevronUp, PanelRight, Square, Trash2 } from "lucide-react";
import type { EnvSummary, NetworkMode, SessionSummary, UpdateSessionRequest } from "@terrarium/shared";
import { act, openEnv, openView, setPref, useStore } from "../state/store";
import { derive, itemForSelection, type Item } from "../lib/trace";
import { fmtInt, fmtMs, fmtTok, plural } from "../lib/format";
import { ModelPicker } from "../components/ModelPicker";
import { ConfirmButton, Hint, Popover, Switch, usePop } from "../components/ui";
import { HARNESS, HarnessTip, NET_TIP, harnessName } from "../lib/explain";
import { EnvChip, NetIcon } from "../components/Sidebar";
import { evalOwner } from "../lib/envuse";
import { Timeline } from "./session/Timeline";
import { CallBlock, RowBlock, ToolBlock, UserBlock } from "./session/Blocks";
import { Composer } from "./session/Composer";
import { SessionStart } from "./session/Start";
import { Check } from "lucide-react";

function patchSession(id: string, p: UpdateSessionRequest) {
  void act("Update session", (b) => b.updateSession(id, p)).then((s) => {
    if (s) useStore.setState((st) => ({ sessions: { ...st.sessions, [s.id]: s } }));
  });
}

function HarnessPicker({ s }: { s: SessionSummary }) {
  const pop = usePop();
  const running = s.status === "running";
  const label = (
    <>
      <span className="dim">harness</span> {harnessName(s.harness)}
      {s.customPrompt && <span className="chip accent" title="This session sends its own system prompt">custom prompt</span>}
    </>
  );
  if (s.evalRunId)
    return (
      <Hint tip={<HarnessTip id={s.harness} />}>
        <span className="hdr-btn static">{label}</span>
      </Hint>
    );
  return (
    <>
      <Hint tip={pop.open ? null : <HarnessTip id={s.harness} />}>
        <button ref={pop.ref} className="hdr-btn" onClick={pop.toggle}>
          {label}
          <ChevronDown size={12} className="dim" />
        </button>
      </Hint>
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
                  <span>{h.label}</span>
                  <span className="dim menu-sub">{!running && !s.envId && h.id !== "chat" ? "Needs an environment" : h.short}</span>
                </span>
              </button>
            );
          })}
          <div className="menu-sep" />
          <button
            className="menu-item"
            onClick={() => {
              pop.close();
              useStore.setState({ inspectorTab: "prompt", inspectorOpen: true });
            }}
          >
            <span style={{ width: 13 }} />
            System prompt and tools
          </button>
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
        {/* whole items wrap onto a hidden second line instead of being cut mid-word; nothing to count before the first call */}
        {stats.calls > 0 && <span className="sh-stats num dim">
          <span>{plural(stats.calls, "turn")}</span>
          {s.envId || stats.tools ? <span>{plural(stats.tools, "tool call")}</span> : null}
          {stats.errors ? <span className="err-text" title="Tool calls with a non-zero exit or error, plus failed model calls">{stats.errors} failed</span> : null}
          <span title={`Summed over all model calls: ${fmtInt(stats.prompt)} prompt + ${fmtInt(stats.completion)} output tokens`}>
            {fmtTok(stats.prompt)} in, {fmtTok(stats.completion)} out
          </span>
          <span title="Wall time from the first message">{fmtMs(stats.ms)}</span>
        </span>}
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
      {/* the setup in the order a turn flows: the model writes, the harness turns tool calls into commands, the env runs them */}
      <div className="sh-row controls">
        <span className="sh-part">
          <ModelPicker session={s} />
          {s.evalRunId ? (
            <span className="hdr-btn static">
              <span className="dim">thinking</span> {s.thinking ? "on" : "off"}
            </span>
          ) : (
            <Switch
              on={s.thinking}
              label="Thinking"
              disabled={running || model?.thinking === "none"}
              title={model?.thinking === "none" ? `${model.name} has no thinking mode` : "enable_thinking in the chat template; thinking tokens count against the output cap"}
              onChange={(v) => patchSession(s.id, { thinking: v })}
            />
          )}
        </span>
        <span className="sh-part">
          <ChevronRight size={12} className="sh-sep" aria-hidden />
          <HarnessPicker s={s} />
        </span>
        <span className="sh-part">
          <ChevronRight size={12} className="sh-sep" aria-hidden />
        {env ? (
          <Hint tip={<EnvTip env={env} />} width={320} className="sh-env-hint">
            <button className="hdr-btn env" onClick={() => openEnv(env.id, "env")}>
              <span className="dim">env</span>
              <span className={`dot ${env.status}`} />
              <span className="truncate">{env.name}</span>
              <EnvChip type={env.type} />
            </button>
          </Hint>
        ) : (
          <span className="hdr-btn static dim" title="Chat-only: no environment, no tools">
            no environment
          </span>
        )}
        {env && (s.evalRunId || evalOwner(env)) && (
          <span className="hdr-btn static" title={!s.evalRunId && evalOwner(env) ? `Read-only while ${evalOwner(env)!.reason}` : undefined}>
            <NetIcon mode={env.network} />
            <span className="dim">network</span> {env.network}
          </span>
        )}
        {env && !s.evalRunId && !evalOwner(env) && <NetPicker env={env} />}
        </span>
      </div>
    </div>
  );
}

const NET_CHOICES: { value: NetworkMode; label: string; sub: string }[] = [
  { value: "off", label: "Off", sub: "Every connection is denied" },
  { value: "registries", label: "Registries", sub: "Downloads from PyPI, npm, GitHub and Alpine" },
  { value: "web", label: "Web", sub: "Any public site; the Mac and LAN stay blocked" },
];

/** The env's network mode as a menu: a three-way switch is too wide for the setup row. */
function NetPicker({ env }: { env: EnvSummary }) {
  const pop = usePop();
  const cur = NET_CHOICES.find((c) => c.value === env.network)!;
  return (
    <>
      <Hint tip={pop.open ? null : NET_TIP[env.network]} width={320} className="sh-net-hint">
        <button ref={pop.ref} className="hdr-btn" aria-label="Network mode" onClick={pop.toggle}>
          <NetIcon mode={env.network} />
          <span className="dim">network</span> {cur.label}
          <ChevronDown size={12} className="dim" />
        </button>
      </Hint>
      <Popover anchor={pop.ref} open={pop.open} onClose={pop.close} width={300}>
        <div className="menu">
          {NET_CHOICES.map((c) => (
            <button
              key={c.value}
              className="menu-item two-line"
              onClick={() => {
                pop.close();
                if (c.value !== env.network)
                  void act("Network mode", (b) => b.updateEnv(env.id, { network: c.value })).then((e) => {
                    if (e) useStore.setState((st) => ({ envs: { ...st.envs, [e.id]: e } }));
                  });
              }}
            >
              {c.value === env.network ? <Check size={12} /> : <span style={{ width: 13 }} />}
              <span>
                <span>{c.label}</span>
                <span className="dim menu-sub">{c.sub}</span>
              </span>
            </button>
          ))}
        </div>
      </Popover>
    </>
  );
}

/** Hover card for the session's environment: what it is and what its tool calls can reach. */
function EnvTip({ env }: { env: EnvSummary }) {
  return (
    <>
      <span className="hint-title">
        {env.name} <span className="hint-k">{env.type === "vm" ? "Linux VM" : "Simulated shell"}</span>
      </span>
      <div className="hint-line">{env.facts?.isolation ?? (env.type === "vm" ? "Linux micro-VM" : "Simulated shell, not a real OS")}</div>
      <div className="hint-line hint-k" style={{ marginTop: 6 }}>
        Environment = where the agent's tool calls run, with its own files and network policy. Click to inspect it.
      </div>
    </>
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
      {items.length === 0 && (s.evalRunId ? <div className="empty transcript-empty">No messages yet</div> : <SessionStart s={s} />)}
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
  if (!s)
    return (
      <div className="empty fill">
        This session no longer exists.
        <button className="btn" onClick={() => openView({ kind: "home" })}>
          Go to Home
        </button>
      </div>
    );
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
