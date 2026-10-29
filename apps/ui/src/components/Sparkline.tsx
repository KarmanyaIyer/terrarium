import { useState } from "react";
import { ChartTip, type TipState } from "./ui";

/** Single-series sparkline with a crosshair readout; series named by the caller's label. */
export function Sparkline({
  points,
  format,
  height = 34,
  color = "var(--c-model)",
  max: maxIn,
  label,
}: {
  points: { t: number; v: number }[];
  format: (v: number) => string;
  height?: number;
  color?: string;
  max?: number;
  label: string;
}) {
  const [tip, setTip] = useState<TipState | null>(null);
  const [hover, setHover] = useState<number | null>(null);
  const w = 260;
  if (points.length < 2) return <div className="spark-empty dim">Collecting samples</div>;
  const max = Math.max(maxIn ?? 0, ...points.map((p) => p.v)) || 1;
  const t0 = points[0].t;
  const t1 = points[points.length - 1].t;
  const x = (t: number) => ((t - t0) / Math.max(1, t1 - t0)) * w;
  const y = (v: number) => height - 2 - (v / max) * (height - 6);
  const d = points.map((p, i) => `${i ? "L" : "M"}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join("");
  const area = `${d}L${w},${height}L0,${height}Z`;
  const last = points[points.length - 1];
  const hp = hover != null ? points[hover] : null;
  return (
    <div className="spark">
      <svg
        viewBox={`0 0 ${w} ${height}`}
        preserveAspectRatio="none"
        width="100%"
        height={height}
        onMouseMove={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          const tx = t0 + ((e.clientX - r.left) / r.width) * (t1 - t0);
          let bi = 0;
          for (let i = 0; i < points.length; i++) if (Math.abs(points[i].t - tx) < Math.abs(points[bi].t - tx)) bi = i;
          setHover(bi);
          const p = points[bi];
          setTip({
            x: e.clientX,
            y: e.clientY,
            content: (
              <>
                <div className="tip-row">
                  <span>{label}</span>
                  <span>{format(p.v)}</span>
                </div>
                <div className="tip-row">
                  <span>At</span>
                  <span>{Math.round((t1 - p.t) / 1000)} s ago</span>
                </div>
              </>
            ),
          });
        }}
        onMouseLeave={() => {
          setHover(null);
          setTip(null);
        }}
      >
        <path d={area} fill={color} opacity={0.1} />
        <path d={d} fill="none" stroke={color} strokeWidth={1.5} vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
        {hp && <line x1={x(hp.t)} x2={x(hp.t)} y1={0} y2={height} stroke="var(--fg-3)" strokeWidth={1} vectorEffect="non-scaling-stroke" />}
      </svg>
      <div className="spark-val num">{format(last.v)}</div>
      <ChartTip tip={tip} />
    </div>
  );
}
