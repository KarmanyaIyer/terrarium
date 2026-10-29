import { memo, type CSSProperties, type ReactNode } from "react";

const NAMES = ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white"];

interface Style {
  fg?: string;
  bg?: string;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
}

function xterm256(n: number): string {
  if (n < 8) return `var(--ansi-${NAMES[n]})`;
  if (n < 16) return `var(--ansi-${NAMES[n - 8]})`;
  if (n < 232) {
    const i = n - 16;
    const c = (v: number) => (v === 0 ? 0 : 55 + v * 40);
    return `rgb(${c(Math.floor(i / 36))},${c(Math.floor(i / 6) % 6)},${c(i % 6)})`;
  }
  const g = 8 + (n - 232) * 10;
  return `rgb(${g},${g},${g})`;
}

function apply(st: Style, codes: number[]): Style {
  const s = { ...st };
  for (let i = 0; i < codes.length; i++) {
    const c = codes[i];
    if (c === 0) {
      for (const k of Object.keys(s)) delete s[k as keyof Style];
    } else if (c === 1) s.bold = true;
    else if (c === 2) s.dim = true;
    else if (c === 3) s.italic = true;
    else if (c === 4) s.underline = true;
    else if (c === 22) s.bold = s.dim = false;
    else if (c === 23) s.italic = false;
    else if (c === 24) s.underline = false;
    else if (c >= 30 && c <= 37) s.fg = `var(--ansi-${NAMES[c - 30]})`;
    else if (c >= 90 && c <= 97) s.fg = `var(--ansi-${NAMES[c - 90]})`;
    else if (c === 39) s.fg = undefined;
    else if (c >= 40 && c <= 47) s.bg = `color-mix(in srgb, var(--ansi-${NAMES[c - 40]}) 22%, transparent)`;
    else if (c === 49) s.bg = undefined;
    else if ((c === 38 || c === 48) && codes[i + 1] === 5) {
      const col = xterm256(codes[i + 2] ?? 0);
      if (c === 38) s.fg = col;
      else s.bg = `color-mix(in srgb, ${col} 25%, transparent)`;
      i += 2;
    } else if ((c === 38 || c === 48) && codes[i + 1] === 2) {
      const col = `rgb(${codes[i + 2] ?? 0},${codes[i + 3] ?? 0},${codes[i + 4] ?? 0})`;
      if (c === 38) s.fg = col;
      else s.bg = `color-mix(in srgb, ${col} 25%, transparent)`;
      i += 4;
    }
  }
  return s;
}

/** Applies carriage returns the way a terminal would (last write wins on a line). */
function collapseCR(text: string): string {
  if (!text.includes("\r")) return text;
  return text
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((l) => {
      const i = l.lastIndexOf("\r");
      return i >= 0 ? l.slice(i + 1) : l;
    })
    .join("\n");
}

// eslint-disable-next-line no-control-regex
const SEQ = /\x1b\[([0-9;?]*)([A-Za-z])|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][A-Za-z0-9]|\x1b[=>]/g;

export function stripAnsi(text: string): string {
  return collapseCR(text).replace(SEQ, "");
}

export function ansiSpans(text: string, keyPrefix = ""): ReactNode[] {
  const t = collapseCR(text);
  const out: ReactNode[] = [];
  let st: Style = {};
  let last = 0;
  let k = 0;
  const push = (s: string) => {
    if (!s) return;
    if (!st.fg && !st.bg && !st.bold && !st.dim && !st.italic && !st.underline) {
      out.push(s);
      return;
    }
    const css: CSSProperties = {
      color: st.fg,
      background: st.bg,
      fontWeight: st.bold ? 650 : undefined,
      opacity: st.dim ? 0.65 : undefined,
      fontStyle: st.italic ? "italic" : undefined,
      textDecoration: st.underline ? "underline" : undefined,
    };
    out.push(
      <span key={`${keyPrefix}${k++}`} style={css}>
        {s}
      </span>,
    );
  };
  SEQ.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = SEQ.exec(t))) {
    push(t.slice(last, m.index));
    last = m.index + m[0].length;
    if (m[2] === "m") {
      const codes = (m[1] || "0").split(";").map((x) => Number(x) || 0);
      st = apply(st, codes);
    }
  }
  push(t.slice(last));
  return out;
}

export const Ansi = memo(function Ansi({ text }: { text: string }) {
  return <>{ansiSpans(text)}</>;
});
