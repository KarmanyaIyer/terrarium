import { memo, useState } from "react";
import { ChevronRight } from "lucide-react";
import { CopyButton } from "./ui";

function StringVal({ s }: { s: string }) {
  const [open, setOpen] = useState(false);
  const lines = s.split("\n").length;
  const long = s.length > 280 || lines > 4;
  const shown = long && !open ? (s.split("\n").slice(0, 3).join("\n").slice(0, 260) + "…") : s;
  return (
    <span className="jv-str">
      "{shown}"
      {long && (
        <button className="jv-more" onClick={() => setOpen(!open)}>
          {open ? "less" : `${s.length.toLocaleString("en-US")} chars`}
        </button>
      )}
    </span>
  );
}

function Leaf({ v }: { v: unknown }) {
  if (v === null) return <span className="jv-null">null</span>;
  if (typeof v === "string") return <StringVal s={v} />;
  if (typeof v === "number") return <span className="jv-num">{String(v)}</span>;
  if (typeof v === "boolean") return <span className="jv-bool">{String(v)}</span>;
  return <span className="jv-null">{String(v)}</span>;
}

const Node = memo(function Node({ k, v, depth, open: open0, last }: { k?: string; v: unknown; depth: number; open: number; last: boolean }) {
  const isObj = v !== null && typeof v === "object";
  const [open, setOpen] = useState(depth < open0);
  const key = k != null ? (
    <>
      <span className="jv-key">{/^\d+$/.test(k) ? k : `"${k}"`}</span>
      <span className="jv-punct">: </span>
    </>
  ) : null;
  if (!isObj)
    return (
      <div className="jv-row" style={{ paddingLeft: depth * 14 + 14 }}>
        {key}
        <Leaf v={v} />
        {!last && <span className="jv-punct">,</span>}
      </div>
    );
  const arr = Array.isArray(v);
  const entries = arr ? (v as unknown[]).map((x, i) => [String(i), x] as const) : Object.entries(v as Record<string, unknown>);
  const [o, c] = arr ? ["[", "]"] : ["{", "}"];
  return (
    <>
      <div className="jv-row jv-branch" style={{ paddingLeft: depth * 14 }} onClick={() => setOpen(!open)}>
        <ChevronRight className={`jv-tw${open ? " open" : ""}`} />
        {key}
        <span className="jv-punct">{o}</span>
        {!open && (
          <>
            <span className="jv-summary">{arr ? `${entries.length} items` : `${entries.length} keys`}</span>
            <span className="jv-punct">
              {c}
              {!last && ","}
            </span>
          </>
        )}
        <span className="jv-actions" onClick={(e) => e.stopPropagation()}>
          <CopyButton text={() => JSON.stringify(v, null, 2)} />
        </span>
      </div>
      {open &&
        entries.map(([ck, cv], i) => <Node key={ck} k={arr ? undefined : ck} v={cv} depth={depth + 1} open={open0} last={i === entries.length - 1} />)}
      {open && (
        <div className="jv-row" style={{ paddingLeft: depth * 14 + 14 }}>
          <span className="jv-punct">
            {c}
            {!last && ","}
          </span>
        </div>
      )}
    </>
  );
});

export function JsonView({ value, open = 2 }: { value: unknown; open?: number }) {
  return (
    <div className="jv selectable">
      <Node v={value} depth={0} open={open} last />
    </div>
  );
}
