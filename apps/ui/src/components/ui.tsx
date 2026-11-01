import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { Check, CircleHelp, Copy } from "lucide-react";
import { exactTime, relTime } from "../lib/format";

// ---------- popover ----------

export function Popover(props: {
  anchor: RefObject<HTMLElement | null>;
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  align?: "start" | "end";
  width?: number;
  className?: string;
  side?: "below" | "above";
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number; maxH: number } | null>(null);

  useLayoutEffect(() => {
    if (!props.open || !props.anchor.current) return;
    const place = () => {
      const r = props.anchor.current!.getBoundingClientRect();
      const w = props.width ?? ref.current?.offsetWidth ?? 220;
      let left = props.align === "end" ? r.right - w : r.left;
      left = Math.max(8, Math.min(left, window.innerWidth - w - 8));
      const roomBelow = window.innerHeight - r.bottom - 15;
      const roomAbove = r.top - 12;
      // near the bottom of a short window a popover opens upward instead of squeezing into what's left
      const wanted = ref.current?.scrollHeight ?? 0;
      const above = props.side === "above" || (props.side !== "below" && roomBelow < Math.min(wanted, 240) && roomAbove > roomBelow) || (props.side === "below" && roomBelow < 160 && roomAbove > roomBelow);
      if (above) {
        setPos({ left, top: -1, maxH: roomAbove });
        const h = Math.min(ref.current?.scrollHeight ?? 0, roomAbove, 560);
        setPos({ left, top: Math.max(8, r.top - 6 - h), maxH: roomAbove });
      } else {
        const top = r.bottom + 5;
        setPos({ left, top, maxH: window.innerHeight - top - 10 });
      }
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [props.open, props.anchor, props.align, props.width, props.side]);

  useEffect(() => {
    if (!props.open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (ref.current?.contains(t) || props.anchor.current?.contains(t)) return;
      props.onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        props.onClose();
      }
    };
    document.addEventListener("mousedown", onDown, true);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDown, true);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [props.open, props.onClose, props.anchor]);

  if (!props.open) return null;
  return createPortal(
    <div
      ref={ref}
      className={`popover ${props.className ?? ""}`}
      style={{
        left: pos?.left ?? -9999,
        top: pos?.top ?? -9999,
        width: props.width,
        maxHeight: pos ? Math.min(560, pos.maxH) : undefined,
      }}
    >
      {props.children}
    </div>,
    document.body,
  );
}

export function usePop() {
  const ref = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  return { ref, open, setOpen, toggle: () => setOpen((o) => !o), close: () => setOpen(false) };
}

// ---------- dialog ----------

/** A form over the app: fits any window, the body scrolls, the actions stay in view. Esc or the backdrop closes it. */
export function Dialog(props: { title: ReactNode; onClose: () => void; children: ReactNode; foot: ReactNode; width?: number; onSubmit?: () => void }) {
  const prior = useRef<HTMLElement | null>(null);
  useEffect(() => {
    prior.current = document.activeElement as HTMLElement | null;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        e.preventDefault();
        props.onClose();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      prior.current?.focus?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return createPortal(
    <div
      className="dialog-back"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) props.onClose();
      }}
    >
      <form
        className="sheet dialog"
        role="dialog"
        aria-modal="true"
        style={props.width ? { width: `min(${props.width}px, 94vw)` } : undefined}
        onSubmit={(e) => {
          e.preventDefault();
          props.onSubmit?.();
        }}
      >
        <div className="sheet-head">
          <h2>{props.title}</h2>
        </div>
        <div className="sheet-body">{props.children}</div>
        <div className="sheet-foot">{props.foot}</div>
      </form>
    </div>,
    document.body,
  );
}

// ---------- inline confirm ----------

/** Destructive action: first click arms it inline; second click on the red button runs it. */
export function ConfirmButton(props: {
  label: ReactNode;
  confirmLabel: string;
  onConfirm: () => void | Promise<unknown>;
  icon?: ReactNode;
  className?: string;
  disabled?: boolean;
  title?: string;
  small?: boolean;
}) {
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!armed) return;
    const off = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setArmed(false);
    };
    const t = window.setTimeout(() => setArmed(false), 6000);
    document.addEventListener("mousedown", off);
    return () => {
      document.removeEventListener("mousedown", off);
      window.clearTimeout(t);
    };
  }, [armed]);
  const sm = props.small ? " sm" : "";
  if (!armed)
    return (
      <button
        type="button"
        className={`btn${sm} ${props.className ?? ""}`}
        disabled={props.disabled || busy}
        title={props.title}
        onClick={() => setArmed(true)}
      >
        {props.icon}
        {props.label}
      </button>
    );
  return (
    <span
      ref={ref}
      className="confirm-inline"
      onKeyDown={(e) => {
        if (e.key !== "Escape") return;
        e.preventDefault();
        setArmed(false);
      }}
    >
      <button
        type="button"
        className={`btn${sm} danger solid`}
        autoFocus
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          try {
            await props.onConfirm();
          } finally {
            setBusy(false);
            setArmed(false);
          }
        }}
      >
        {props.confirmLabel}
      </button>
      <button type="button" className={`btn${sm} ghost`} onClick={() => setArmed(false)}>
        Cancel
      </button>
    </span>
  );
}

// ---------- time ----------

let tickers = new Set<() => void>();
window.setInterval(() => tickers.forEach((f) => f()), 5000);

export function useNow(interval: "5s" | "frame" = "5s"): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (interval === "frame") {
      let raf = 0;
      let last = 0;
      const loop = (t: number) => {
        if (t - last > 100) {
          last = t;
          setNow(Date.now());
        }
        raf = requestAnimationFrame(loop);
      };
      raf = requestAnimationFrame(loop);
      return () => cancelAnimationFrame(raf);
    }
    const f = () => setNow(Date.now());
    tickers.add(f);
    return () => {
      tickers.delete(f);
    };
  }, [interval]);
  return now;
}

export function Time({ ts, className }: { ts: number; className?: string }) {
  const now = useNow();
  return (
    <time className={`num ${className ?? ""}`} dateTime={new Date(ts).toISOString()} title={exactTime(ts)}>
      {relTime(ts, now)}
    </time>
  );
}

// ---------- copy ----------

export function CopyButton({ text, label, className }: { text: string | (() => string); label?: string; className?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className={label ? `btn sm ghost ${className ?? ""}` : `icon-btn sm ${className ?? ""}`}
      title={done ? "Copied" : "Copy"}
      onClick={(e) => {
        e.stopPropagation();
        void navigator.clipboard.writeText(typeof text === "function" ? text() : text).then(() => {
          setDone(true);
          window.setTimeout(() => setDone(false), 1200);
        });
      }}
    >
      {done ? <Check /> : <Copy />}
      {label}
    </button>
  );
}

// ---------- segmented / switch ----------

export function Segmented<T extends string | number>(props: {
  value: T;
  options: { value: T; label: ReactNode; title?: string; disabled?: boolean; tip?: ReactNode }[];
  onChange: (v: T) => void;
  small?: boolean;
  disabled?: boolean;
  ariaLabel?: string;
}) {
  return (
    <div className={`seg${props.small ? " sm" : ""}`} role="radiogroup" aria-label={props.ariaLabel}>
      {props.options.map((o) => {
        const b = (
          <button
            type="button"
            key={o.value}
            role="radio"
            aria-checked={o.value === props.value}
            className={o.value === props.value ? "on" : ""}
            title={o.tip ? undefined : o.title}
            disabled={props.disabled || o.disabled}
            onClick={() => o.value !== props.value && props.onChange(o.value)}
          >
            {o.label}
          </button>
        );
        return o.tip ? (
          <Hint key={o.value} tip={o.tip} className="seg-hint">
            {b}
          </Hint>
        ) : (
          b
        );
      })}
    </div>
  );
}

export function Switch(props: { on: boolean; onChange: (v: boolean) => void; label: ReactNode; disabled?: boolean; title?: string; tip?: ReactNode }) {
  if (props.tip) {
    const { tip, title: _t, ...rest } = props;
    return (
      <Hint tip={tip}>
        <Switch {...rest} />
      </Hint>
    );
  }
  return (
    <button
      type="button"
      className={`switch${props.on ? " on" : ""}`}
      role="switch"
      aria-checked={props.on}
      disabled={props.disabled}
      title={props.title}
      onClick={() => props.onChange(!props.on)}
    >
      <span className="track" />
      {props.label}
    </button>
  );
}

// ---------- chart tooltip ----------

export interface TipState {
  x: number;
  y: number;
  content: ReactNode;
}

export function ChartTip({ tip }: { tip: TipState | null }) {
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 200, h: 80 });
  useLayoutEffect(() => {
    if (ref.current) setSize({ w: ref.current.offsetWidth, h: ref.current.offsetHeight });
  }, [tip?.content]);
  if (!tip) return null;
  let left = tip.x + 12;
  let top = tip.y + 14;
  if (left + size.w > window.innerWidth - 8) left = tip.x - size.w - 12;
  if (top + size.h > window.innerHeight - 8) top = tip.y - size.h - 10;
  return createPortal(
    <div ref={ref} className="chart-tip" style={{ left, top }}>
      {tip.content}
    </div>,
    document.body,
  );
}

// ---------- expander for long verbatim text ----------

export function Expander({
  lines,
  limit = 14,
  children,
  label = "lines",
}: {
  lines: number;
  limit?: number;
  children: (collapsed: boolean) => ReactNode;
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  const long = lines > limit;
  const collapsed = long && !open;
  return (
    <div className={`expander${collapsed ? " collapsed" : ""}`} style={collapsed ? { maxHeight: `${limit * 1.5 + 0.6}em` } : undefined}>
      {children(collapsed)}
      {long && (
        <button type="button" className="expander-btn" onClick={() => setOpen(!open)}>
          {open ? "Collapse" : `Show all ${lines.toLocaleString("en-US")} ${label}`}
        </button>
      )}
    </div>
  );
}

export function Kbd({ k }: { k: string }) {
  return <kbd>{k}</kbd>;
}

// ---------- hint (hover card) ----------

/**
 * Hover card for a term or a control: what it is, when to use it. Shows after a short hover or on keyboard focus.
 * Without children it renders a small help icon as the anchor.
 */
export function Hint({ tip, children, width = 300, className, label }: { tip: ReactNode; children?: ReactNode; width?: number; className?: string; label?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const timer = useRef(0);
  const show = () => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => ref.current && setRect(ref.current.getBoundingClientRect()), 220);
  };
  const hide = () => {
    window.clearTimeout(timer.current);
    setRect(null);
  };
  useEffect(() => () => window.clearTimeout(timer.current), []);
  return (
    <span ref={ref} className={`hint-anchor ${className ?? ""}`} onMouseEnter={show} onMouseLeave={hide} onFocus={show} onBlur={hide}>
      {children ?? (
        <span className="hint-icon" tabIndex={0} role="img" aria-label={label ?? "More information"}>
          <CircleHelp size={12} />
        </span>
      )}
      {rect && <HintCard rect={rect} width={width}>{tip}</HintCard>}
    </span>
  );
}

function HintCard({ rect, width, children }: { rect: DOMRect; width: number; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [h, setH] = useState(0);
  useLayoutEffect(() => setH(ref.current?.offsetHeight ?? 0), [children]);
  const w = Math.min(width, window.innerWidth - 16);
  const left = Math.max(8, Math.min(rect.left, window.innerWidth - w - 8));
  const below = rect.bottom + 6 + h < window.innerHeight - 8;
  const top = below ? rect.bottom + 6 : Math.max(8, rect.top - 6 - h);
  return createPortal(
    <div ref={ref} className="hint-card" role="tooltip" style={{ left, top, width: w, visibility: h ? "visible" : "hidden" }}>
      {children}
    </div>,
    document.body,
  );
}
