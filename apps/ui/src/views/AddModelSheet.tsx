import { useEffect, useState } from "react";
import { Check, Loader2, X } from "lucide-react";
import type { ModelCheck, ModelSuggestion } from "@terrarium/shared";
import { act, useStore } from "../state/store";
import { exactBytes, fmtBytes, fmtCtx } from "../lib/format";

/** Paste a Hugging Face repo id (or pick a suggestion), check it, then download into models/. */
export function AddModelSheet({ onClose }: { onClose: () => void }) {
  const models = useStore((s) => s.models);
  const downloads = useStore((s) => s.downloads);
  const [suggestions, setSuggestions] = useState<ModelSuggestion[]>([]);
  const [repo, setRepo] = useState("");
  const [check, setCheck] = useState<ModelCheck | null>(null);
  const [checking, setChecking] = useState(false);
  const [starting, setStarting] = useState(false);

  useEffect(() => {
    void act("Load suggestions", (b) => b.modelSuggestions()).then((s) => s && setSuggestions(s));
  }, []);

  const installed = (r: string) => models.some((m) => m.id === r.split("/").pop());
  const downloading = (r: string) => Object.values(downloads).some((d) => d.repo === r && d.status === "running");

  const inspect = async (r: string) => {
    const id = r.trim();
    if (!id) return;
    setRepo(id);
    setCheck(null);
    setChecking(true);
    const c = await act("Check model", (b) => b.inspectModel(id));
    setChecking(false);
    if (c) setCheck(c);
  };

  const start = async () => {
    if (!check) return;
    setStarting(true);
    const d = await act("Start download", (b) => b.startDownload(check.repo));
    setStarting(false);
    if (d) onClose();
  };

  const busy = check ? downloading(check.repo) : false;

  return (
    <div
      className="overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          onClose();
        }
      }}
    >
      <form
        className="sheet add-model"
        role="dialog"
        aria-label="Add model"
        onSubmit={(e) => {
          e.preventDefault();
          void inspect(repo);
        }}
      >
        <div className="sheet-head">
          <h2>Add model</h2>
          <span className="blk-spacer" />
          <button type="button" className="icon-btn" title="Close (Esc)" onClick={onClose}>
            <X size={14} />
          </button>
        </div>

        <div className="sheet-body">
          <div className="am-input">
            <input
              className="input mono"
              autoFocus
              placeholder="owner/name or huggingface.co URL (MLX builds only)"
              value={repo}
              spellCheck={false}
              onChange={(e) => {
                setRepo(e.target.value);
                setCheck(null);
              }}
            />
            <button type="submit" className="btn" disabled={!repo.trim() || checking}>
              {checking && <Loader2 className="spin" />} Check
            </button>
          </div>

          {check ? (
            <CheckResult c={check} />
          ) : (
            <div className="am-sugg">
              <h3>Suggestions</h3>
              {suggestions.map((s) => {
                const have = installed(s.repo);
                return (
                  <button type="button" key={s.repo} className="am-sugg-row" title={`${s.repo}${s.detail ? `\n${s.detail}` : ""}`} onClick={() => void inspect(s.repo)}>
                    <span className="strong">{s.name}</span>
                    <span className="dim2 truncate">{s.note}</span>
                    <span className="num">{s.sizeBytes ? fmtBytes(s.sizeBytes) : ""}</span>
                    {have ? <span className="dim2">installed</span> : <span className="am-sugg-go">Check</span>}
                  </button>
                );
              })}
              {!suggestions.length && <span>Loading</span>}
            </div>
          )}
        </div>

        <div className="sheet-foot">
          {check && (
            <button type="button" className="btn ghost" onClick={() => setCheck(null)}>
              Back to suggestions
            </button>
          )}
          <span className="blk-spacer" />
          <button type="button" className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn primary"
            disabled={!check?.ok || check.installed || busy || starting}
            onClick={() => void start()}
            title={check && !check.ok ? "Fix the problems above first" : undefined}
          >
            {starting && <Loader2 className="spin" />} Download{check?.ok ? ` ${fmtBytes(check.totalBytes)}` : ""}
          </button>
        </div>
      </form>
    </div>
  );
}

function CheckResult({ c }: { c: ModelCheck }) {
  return (
    <div className="am-check">
      <div className="am-check-head">
        <span className="strong mono">{c.repo}</span>
        {c.ok ? (
          <span className="ok-text am-verdict">
            <Check size={12} /> Can load
          </span>
        ) : (
          <span className="err-text am-verdict">Can't load</span>
        )}
        {c.installed && <span className="dim2">Already installed</span>}
      </div>
      <dl className="am-facts">
        <dt>Download</dt>
        <dd className="num" title={exactBytes(c.totalBytes)}>
          {fmtBytes(c.totalBytes)}, {c.files} files
        </dd>
        <dt>Lands in</dt>
        <dd className="mono">models/{c.dirName}</dd>
        <dt>Architecture</dt>
        <dd className="mono">{c.modelType ?? "unknown"}</dd>
        <dt>Loader</dt>
        <dd>
          {c.loader ?? "none"}{" "}
          (mlx-lm {c.versions.mlxLm}
          {c.versions.mlxVlm ? `, mlx-vlm ${c.versions.mlxVlm}` : ""})
        </dd>
        {c.quant && (
          <>
            <dt>Quant</dt>
            <dd>{c.quant}</dd>
          </>
        )}
        {c.contextLength ? (
          <>
            <dt>Max context</dt>
            <dd className="num">{fmtCtx(c.contextLength)}</dd>
          </>
        ) : null}
        <dt>Free disk</dt>
        <dd className="num">{fmtBytes(c.freeDiskBytes)}</dd>
      </dl>
      {c.problems.length > 0 && (
        <ul className="am-problems">
          {c.problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
