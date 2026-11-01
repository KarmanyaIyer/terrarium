import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Boxes, FlaskConical, MessageSquare, Microscope, Plus, Server, Settings, TerminalSquare } from "lucide-react";
import { openEnv, openSession, openView, useStore } from "../state/store";
import { newSession } from "../lib/actions";
import { relTime } from "../lib/format";
import { TerrariumMark } from "./Mark";

interface Item {
  id: string;
  label: string;
  hint?: string;
  icon: ReactNode;
  group: string;
  run: () => void;
}

function score(q: string, text: string): number {
  if (!q) return 1;
  const t = text.toLowerCase();
  const i = t.indexOf(q);
  if (i >= 0) return 100 - i;
  let ti = 0;
  let s = 0;
  for (const ch of q) {
    const j = t.indexOf(ch, ti);
    if (j < 0) return 0;
    s += j === ti ? 3 : 1;
    ti = j + 1;
  }
  return s;
}

export function Palette() {
  const open = useStore((s) => s.paletteOpen);
  const envs = useStore((s) => s.envs);
  const sessions = useStore((s) => s.sessions);
  const [q, setQ] = useState("");
  const [idx, setIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setQ("");
      setIdx(0);
      window.setTimeout(() => inputRef.current?.focus(), 10);
    }
  }, [open]);

  const items = useMemo<Item[]>(() => {
    const out: Item[] = [];
    const sess = Object.values(sessions)
      .filter((s) => !s.evalRunId)
      .sort((a, b) => b.updatedAt - a.updatedAt);
    for (const s of sess)
      out.push({
        id: `s:${s.id}`,
        label: s.title,
        hint: `${s.envId ? (envs[s.envId]?.name ?? "env") : "chat"} · ${s.status === "running" ? "running" : relTime(s.updatedAt)}`,
        icon: s.envId ? <TerminalSquare size={13} /> : <MessageSquare size={13} />,
        group: "Sessions",
        run: () => openSession(s.id),
      });
    for (const e of Object.values(envs).filter((x) => !x.ephemeral))
      out.push({
        id: `e:${e.id}`,
        label: e.name,
        hint: `${e.type === "vm" ? "VM" : "SIM"} · ${e.status} · network ${e.network}`,
        icon: <Server size={13} />,
        group: "Enclosures",
        run: () => openEnv(e.id),
      });
    out.push(
      { id: "v:home", label: "Home", icon: <TerrariumMark size={13} />, group: "Go to", run: () => openView({ kind: "home" }) },
      { id: "v:evals", label: "Evals", icon: <FlaskConical size={13} />, group: "Go to", run: () => openView({ kind: "evals" }) },
      { id: "v:lab", label: "Lab", icon: <Microscope size={13} />, group: "Go to", run: () => openView({ kind: "lab" }) },
      { id: "v:models", label: "Models", icon: <Boxes size={13} />, group: "Go to", run: () => openView({ kind: "models" }) },
      { id: "v:settings", label: "Settings", icon: <Settings size={13} />, group: "Go to", run: () => openView({ kind: "settings" }) },
      { id: "a:newenv", label: "New enclosure", icon: <Plus size={13} />, group: "Actions", run: () => useStore.setState({ newEnvOpen: true }) },
      { id: "a:newchat", label: "New chat", icon: <Plus size={13} />, group: "Actions", run: () => void newSession(null) },
    );
    return out;
  }, [sessions, envs]);

  const filtered = useMemo(() => {
    const ql = q.trim().toLowerCase();
    const hits = items
      .map((it) => ({ it, s: score(ql, `${it.label} ${it.hint ?? ""}`) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => (ql ? b.s - a.s : 0));
    // keep each group together (ordered by its best hit) so a group header appears once
    const order = new Map<string, number>();
    hits.forEach((x, i) => {
      if (!order.has(x.it.group)) order.set(x.it.group, i);
    });
    return hits
      .map((x, i) => ({ ...x, i }))
      .sort((a, b) => order.get(a.it.group)! - order.get(b.it.group)! || a.i - b.i)
      .map((x) => x.it);
  }, [items, q]);
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    listRef.current?.querySelector(".menu-item.active")?.scrollIntoView({ block: "nearest" });
  }, [idx, filtered]);

  if (!open) return null;
  const close = () => useStore.setState({ paletteOpen: false });
  const run = (it: Item | undefined) => {
    if (!it) return;
    close();
    it.run();
  };

  let lastGroup = "";
  return createPortal(
    <div className="overlay" onMouseDown={close}>
      <div className="palette" onMouseDown={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          className="palette-input"
          placeholder="Jump to a session, enclosure or view"
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setIdx(0);
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setIdx((i) => Math.min(filtered.length - 1, i + 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setIdx((i) => Math.max(0, i - 1));
            } else if (e.key === "Enter") {
              e.preventDefault();
              run(filtered[idx]);
            } else if (e.key === "Escape") {
              e.preventDefault();
              close();
            }
          }}
        />
        <div className="palette-list" ref={listRef} role="listbox">
          {filtered.length === 0 && <div className="empty">No match</div>}
          {filtered.map((it, i) => {
            const head = it.group !== lastGroup ? it.group : null;
            lastGroup = it.group;
            return (
              <div key={it.id}>
                {head && <div className="menu-label">{head}</div>}
                <button
                  className={`menu-item${i === idx ? " active" : ""}`}
                  role="option"
                  aria-selected={i === idx}
                  tabIndex={-1}
                  onMouseMove={() => i !== idx && setIdx(i)}
                  onClick={() => run(it)}
                >
                  {it.icon}
                  <span className="truncate">{it.label}</span>
                  {it.hint && <span className="dim palette-hint truncate">{it.hint}</span>}
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </div>,
    document.body,
  );
}
