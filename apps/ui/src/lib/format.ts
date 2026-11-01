const KiB = 1024;
const MiB = KiB * 1024;
const GiB = MiB * 1024;

/** Binary units with IEC labels; exact bytes go in tooltips via `exactBytes`. */
export function fmtBytes(n: number | undefined | null, digits?: number): string {
  if (n == null || !Number.isFinite(n)) return "-";
  const a = Math.abs(n);
  if (a >= GiB) return `${(n / GiB).toFixed(digits ?? (a >= 100 * GiB ? 0 : 1))} GiB`;
  if (a >= MiB) return `${(n / MiB).toFixed(digits ?? (a >= 100 * MiB ? 0 : 1))} MiB`;
  if (a >= KiB) return `${(n / KiB).toFixed(digits ?? (a >= 100 * KiB ? 0 : 1))} KiB`;
  return `${n} B`;
}

export function fmtMiB(mib: number | undefined): string {
  if (mib == null) return "-";
  return fmtBytes(mib * MiB);
}

export function exactBytes(n: number | undefined | null): string {
  if (n == null) return "";
  return `${n.toLocaleString("en-US")} bytes`;
}

const nf = new Intl.NumberFormat("en-US");
export function fmtInt(n: number | undefined | null): string {
  if (n == null || !Number.isFinite(n)) return "-";
  return nf.format(Math.round(n));
}

/** Token counts: exact below 10K, compact above (12.4K, 262K). */
export function fmtTok(n: number | undefined | null): string {
  if (n == null || !Number.isFinite(n)) return "-";
  const a = Math.abs(n);
  if (a < 10_000) return nf.format(Math.round(n));
  if (a < 1_000_000) {
    const k = n / 1000;
    return `${k >= 100 ? Math.round(k) : k.toFixed(1).replace(/\.0$/, "")}K`;
  }
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
}

/** Context sizes are powers of two: 16384 -> 16K, 262144 -> 256K. */
export function fmtCtx(n: number | undefined | null): string {
  if (n == null) return "-";
  if (n % 1024 === 0) return `${n / 1024}K`;
  return fmtTok(n);
}

export function fmtMs(ms: number | undefined | null): string {
  if (ms == null || !Number.isFinite(ms)) return "-";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 10_000) return `${(ms / 1000).toFixed(2)} s`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  if (m < 60) return `${m}m ${String(s).padStart(2, "0")}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${String(m % 60).padStart(2, "0")}m`;
}

export function fmtTps(n: number | undefined | null): string {
  if (n == null || !Number.isFinite(n)) return "-";
  return `${n >= 100 ? Math.round(n) : n.toFixed(1)} tok/s`;
}

export function fmtPct(n: number | undefined | null, digits = 0): string {
  if (n == null || !Number.isFinite(n)) return "-";
  return `${n.toFixed(digits)}%`;
}

const dtf = new Intl.DateTimeFormat("en-US", {
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  second: "2-digit",
});
const tf = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", second: "2-digit" });

export function exactTime(ts: number): string {
  const d = new Date(ts);
  return `${dtf.format(d)}.${String(d.getMilliseconds()).padStart(3, "0")}`;
}

export function clockTime(ts: number): string {
  return tf.format(new Date(ts));
}

export function relTime(ts: number, now = Date.now()): string {
  const d = Math.max(0, now - ts);
  if (d < 5_000) return "now";
  if (d < 60_000) return `${Math.floor(d / 1000)}s ago`;
  if (d < 3_600_000) return `${Math.floor(d / 60_000)}m ago`;
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)}h ago`;
  if (d < 7 * 86_400_000) return `${Math.floor(d / 86_400_000)}d ago`;
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" }).format(new Date(ts));
}

/** Offset from session start, e.g. +1:04.2 */
export function offsetTime(ms: number): string {
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  return `${m}:${(s - m * 60).toFixed(1).padStart(4, "0")}`;
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${fmtInt(n)} ${n === 1 ? one : many}`;
}

export function shortId(id: string): string {
  return id.length > 10 ? id.slice(0, 8) : id;
}
