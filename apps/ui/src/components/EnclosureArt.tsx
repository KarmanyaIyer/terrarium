import type { EnvType, NetworkMode } from "@terrarium/shared";

/** One leaf from (x, y), pointing left (-1) or right (1). */
const leaf = (x: number, y: number, dir: number, len: number) =>
  `M${x} ${y}c${dir * len * 0.3} ${-len * 0.55} ${dir * len * 0.85} ${-len * 0.6} ${dir * len} ${-len * 0.15}c${-dir * len * 0.2} ${len * 0.42} ${-dir * len * 0.7} ${len * 0.5} ${-dir * len} ${len * 0.15}z`;

/** Stem height and paired leaves per stem. The plant is the session count: bare soil, sprout, seedling, plant, overgrown. */
function plant(n: number): { x: number; h: number; pairs: number }[] {
  if (n <= 0) return [];
  if (n < 3) return [{ x: 28, h: 8, pairs: 1 }];
  if (n < 8) return [{ x: 28, h: 15, pairs: 2 }];
  if (n < 20)
    return [
      { x: 28, h: 22, pairs: 3 },
      { x: 19, h: 8, pairs: 1 },
    ];
  return [
    { x: 28, h: 28, pairs: 4 },
    { x: 18, h: 16, pairs: 2 },
    { x: 38, h: 11, pairs: 1 },
  ];
}

/**
 * An enclosure as a glass case. Every part is data: the lid is the network policy (shut, vented, lifted), a dashed pane is
 * a simulated shell and a solid one a real VM, the plant grows with the sessions run in it.
 */
export function EnclosureArt({
  network,
  type,
  sessions = 0,
  live,
  failed,
  flip,
  size = 56,
}: {
  network: NetworkMode;
  type: EnvType;
  sessions?: number;
  live?: boolean;
  failed?: boolean;
  flip?: boolean;
  size?: number;
}) {
  return (
    <svg className={`ea${live ? " live" : ""}${failed ? " failed" : ""}`} viewBox="0 0 56 66" width={size} height={(size * 66) / 56} aria-hidden>
      <rect className="ea-glass" x="7" y="12" width="42" height="49" rx="3" strokeDasharray={type === "sim" ? "3 2.2" : undefined} />
      <path className="ea-soil" d="M8.5 52c6-2.2 11-2.2 19.5 0s13 2 19.5-.4V57a2.5 2.5 0 0 1-2.5 2.5H11A2.5 2.5 0 0 1 8.5 57z" />
      <g transform={flip ? "translate(56 0) scale(-1 1)" : undefined}>
        {plant(sessions).map((s) => (
          <g key={s.x}>
            <path className="ea-stem" d={`M${s.x} 52V${52 - s.h}`} />
            {Array.from({ length: s.pairs }, (_, i) => {
              const y = 52 - s.h + (i * s.h) / s.pairs + 1.5;
              const len = 4 + (i * 2.4) / Math.max(1, s.pairs - 1);
              return <path key={i} className="ea-leaf" d={leaf(s.x, y, 1, len) + leaf(s.x, y, -1, len)} />;
            })}
          </g>
        ))}
      </g>
      <path className="ea-streak" d="M13 18v22" />
      {network === "off" && <rect className="ea-lid" x="4.5" y="7.5" width="47" height="4.5" rx="1.4" />}
      {network === "registries" && (
        <>
          <path className="ea-vent" d="M12 7v5M28 7v5M44 7v5" />
          <rect className="ea-lid" x="4.5" y="3.5" width="47" height="4.5" rx="1.4" />
        </>
      )}
      {network === "web" && <rect className="ea-lid" x="4.5" y="7.5" width="47" height="4.5" rx="1.4" transform="rotate(-15 7 12)" />}
    </svg>
  );
}
