import { useEffect, useState } from "react";
import { Box, Download, Loader2, X } from "lucide-react";
import type { ModelDownload, ModelSuggestion } from "@terrarium/shared";
import { act, useStore } from "../state/store";
import { fmtBytes } from "../lib/format";
import { buildVmImage } from "../lib/actions";

let cache: ModelSuggestion[] | null = null;

export function useSuggestions(): ModelSuggestion[] {
  const [list, setList] = useState(cache ?? []);
  useEffect(() => {
    if (cache) return;
    void act("Load suggestions", (b) => b.modelSuggestions()).then((s) => {
      if (s) {
        cache = s;
        setList(s);
      }
    });
  }, []);
  return list;
}

/** Download a repo: the backend checks it first, a few seconds. */
export function useDownload(repo: string | undefined) {
  const [starting, setStarting] = useState(false);
  const running = useStore((s) => Object.values(s.downloads).find((d) => d.repo === repo && d.status === "running"));
  const start = async () => {
    if (!repo) return;
    setStarting(true);
    await act("Start download", (b) => b.startDownload(repo));
    setStarting(false);
  };
  return { starting, running, start };
}

const EXAMPLE_REPO = "mlx-community/Qwen3.5-4B-MLX-4bit";

/** The Lab's example runs on one model; without it, this instead of a dead button. */
export function GetExampleModel({ small }: { small?: boolean }) {
  const suggestion = useSuggestions().find((s) => s.repo === EXAMPLE_REPO);
  const { starting, running, start } = useDownload(EXAMPLE_REPO);
  const pct = running?.bytesTotal ? Math.round((running.bytesDone / running.bytesTotal) * 100) : 0;
  if (running) return <span className="dim num">Downloading Qwen3.5 4B, {pct}%</span>;
  return (
    <button className={`btn${small ? " sm" : ""}`} disabled={starting} title="The example runs on Qwen3.5 4B" onClick={() => void start()}>
      {starting ? <Loader2 className="spin" /> : <Download />} Get Qwen3.5 4B{suggestion?.sizeBytes ? `, ${fmtBytes(suggestion.sizeBytes)}` : ""}
    </button>
  );
}

export function DownloadRow({ d, onDismiss }: { d: ModelDownload; onDismiss: () => void }) {
  const pct = d.bytesTotal ? Math.min(100, (d.bytesDone / d.bytesTotal) * 100) : 0;
  return (
    <div className={`dl-row ${d.status}`}>
      <span className="strong truncate">{d.repo}</span>
      <div className="dl-bar">
        <span style={{ width: `${pct}%` }} />
      </div>
      <span className="num dim">
        {fmtBytes(d.bytesDone)} / {fmtBytes(d.bytesTotal)}
      </span>
      {d.status === "running" ? (
        <button className="btn sm ghost" onClick={() => void act("Cancel download", (b) => b.cancelDownload(d.id))}>
          <X /> Cancel
        </button>
      ) : (
        <span className="dl-end">
          <span className={d.status === "error" ? "err-text truncate" : "dim"} title={d.error}>
            {d.status === "error" ? d.error : d.status}
          </span>
          <button className="icon-btn" aria-label="Dismiss" title="Dismiss" onClick={onDismiss}>
            <X />
          </button>
        </span>
      )}
    </div>
  );
}

function SuggestionRow({ s, primary }: { s: ModelSuggestion; primary: boolean }) {
  const { starting, running, start } = useDownload(s.repo);
  const pct = running?.bytesTotal ? Math.min(100, (running.bytesDone / running.bytesTotal) * 100) : 0;
  return (
    <div className="sugg">
      <span className="sugg-main">
        <span className="strong">{s.name}</span>
        <span className="dim truncate" title={s.note}>
          {s.note}
        </span>
      </span>
      {running ? (
        <>
          <span className="dl-bar sugg-bar">
            <span style={{ width: `${pct}%` }} />
          </span>
          <span className="num dim sugg-size">{fmtBytes(running.bytesDone)}</span>
          <button className="btn sm ghost" onClick={() => void act("Cancel download", (b) => b.cancelDownload(running.id))}>
            <X /> Cancel
          </button>
        </>
      ) : (
        <>
          <span className="num dim sugg-size">{s.sizeBytes ? fmtBytes(s.sizeBytes) : ""}</span>
          <button className={`btn sm${primary ? " primary" : ""}`} disabled={starting} onClick={() => void start()}>
            {starting ? <Loader2 className="spin" /> : <Download />} {starting ? "Checking" : "Download"}
          </button>
        </>
      )}
    </div>
  );
}

/** The way out of having no models: one click on a known-good download. */
export function ModelSuggestions({ limit, onOther }: { limit?: number; onOther?: () => void }) {
  const all = useSuggestions();
  const models = useStore((s) => s.models);
  const downloads = useStore((s) => s.downloads);
  const [dismissed, setDismissed] = useState<Set<string>>(() => new Set());
  const failed = Object.values(downloads).filter((d) => d.status === "error" && !dismissed.has(d.id));
  const list = all.filter((s) => !models.some((m) => m.id === s.repo.split("/").pop())).slice(0, limit);
  return (
    <div className="suggs">
      {list.map((s, i) => (
        <SuggestionRow key={s.repo} s={s} primary={i === 0} />
      ))}
      {!all.length && <Loader2 size={13} className="spin dim" />}
      {failed.map((d) => (
        <DownloadRow key={d.id} d={d} onDismiss={() => setDismissed((x) => new Set(x).add(d.id))} />
      ))}
      {onOther && (
        <button className="cell-link sugg-other" onClick={onOther}>
          Use another model from Hugging Face
        </button>
      )}
    </div>
  );
}

/** A fresh data dir has no guest image; the build is one script and about a minute. */
export function VmSetupNote() {
  const setup = useStore((s) => s.vmSetup);
  const building = useStore((s) => s.vmBuilding);
  if (setup.ok) return null;
  const missingImage = /guest image/.test(setup.detail ?? "");
  return (
    <div className="vm-note">
      <Box size={13} className="dim" />
      <span>{building ? "Building the Linux VM image, about a minute." : missingImage ? "Linux VMs need a one-time image build, about a minute." : setup.detail}</span>
      <span className="blk-spacer" />
      <button className="btn sm" disabled={building != null} onClick={() => void buildVmImage()}>
        {building != null && <Loader2 className="spin" />} Build VM image
      </button>
    </div>
  );
}
