import { memo, useMemo } from "react";
import { parseUnified } from "../lib/diff";

export const DiffView = memo(function DiffView({ text, compact }: { text: string; compact?: boolean }) {
  const d = useMemo(() => parseUnified(text), [text]);
  if (!d.hunks.length) return <div className="diff-empty dim">No textual change</div>;
  return (
    <div className={`diff selectable${compact ? " compact" : ""}`}>
      {d.hunks.map((h, i) => (
        <div key={i} className="diff-hunk">
          <div className="diff-hh">{h.header}</div>
          {h.lines.map((l, j) => (
            <div key={j} className={`diff-l ${l.kind}`}>
              <span className="diff-no">{l.oldNo ?? ""}</span>
              <span className="diff-no">{l.newNo ?? ""}</span>
              <span className="diff-sign">{l.kind === "add" ? "+" : l.kind === "del" ? "−" : " "}</span>
              <span className="diff-text">{l.text || "​"}</span>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
});

export function diffStats(text: string) {
  const d = parseUnified(text);
  return { added: d.added, removed: d.removed };
}
