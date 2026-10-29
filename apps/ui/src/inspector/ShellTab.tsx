import { useEffect, useRef, useState } from "react";
import { CornerDownLeft, Loader2 } from "lucide-react";
import type { EnvSummary, ExecResult } from "@terrarium/shared";
import { act } from "../state/store";
import { clockTime, exactTime, fmtMs } from "../lib/format";
import { ansiSpans } from "../components/Ansi";
import { Expander, Segmented } from "../components/ui";

interface Entry {
  id: number;
  ts: number;
  command: string;
  as: "agent" | "root";
  result?: ExecResult;
  error?: string;
}

// kept per env for the app's lifetime
const history = new Map<string, Entry[]>();
let nextId = 1;

export function ShellTab({ env }: { env: EnvSummary }) {
  const [entries, setEntries] = useState<Entry[]>(() => history.get(env.id) ?? []);
  const [cmd, setCmd] = useState("");
  const [as, setAs] = useState<"agent" | "root">("agent");
  const [recall, setRecall] = useState(-1);
  const endRef = useRef<HTMLDivElement>(null);
  const isVm = env.type === "vm";
  const up = env.status === "running" || env.status === "busy";

  useEffect(() => {
    setEntries(history.get(env.id) ?? []);
  }, [env.id]);
  useEffect(() => {
    history.set(env.id, entries);
    endRef.current?.scrollIntoView({ block: "end" });
  }, [entries, env.id]);

  const run = async () => {
    const c = cmd.trim();
    if (!c) return;
    const e: Entry = { id: nextId++, ts: Date.now(), command: c, as: isVm ? as : "agent" };
    setEntries((x) => [...x, e]);
    setCmd("");
    setRecall(-1);
    const r = await act("Shell", (b) => b.exec(env.id, { command: c, as: e.as, timeoutMs: 60_000 }));
    setEntries((x) => x.map((y) => (y.id === e.id ? { ...y, result: r, error: r ? undefined : "failed" } : y)));
  };

  const cmds = entries.map((e) => e.command);

  return (
    <div className="shelltab">
      <div className="shell-log selectable">
        {entries.length === 0 && <div className="empty">{up ? "Run a command in this environment" : `Environment is ${env.status}`}</div>}
        {entries.map((e) => (
          <div key={e.id} className="shell-entry">
            <div className="shell-cmd">
              <span className="tag-you" title="Run by you; never shown to the model">
                you
              </span>
              {isVm && <span className="dim mono">{e.as}</span>}
              <span className="mono shell-prompt">{e.as === "root" ? "#" : "$"}</span>
              <span className="mono shell-text">{e.command}</span>
              <span className="blk-spacer" />
              {e.result ? (
                <>
                  <span className={`chip ${e.result.exitCode ? "err" : ""}`}>exit {e.result.exitCode}</span>
                  <span className="dim num">{fmtMs(e.result.durationMs)}</span>
                </>
              ) : e.error ? (
                <span className="chip err">{e.error}</span>
              ) : (
                <Loader2 size={12} className="spin dim" />
              )}
              <span className="dim num" title={exactTime(e.ts)}>
                {clockTime(e.ts)}
              </span>
            </div>
            {e.result && (e.result.stdout || e.result.stderr) && (
              <Expander lines={(e.result.stdout + e.result.stderr).split("\n").length} limit={20}>
                {() => (
                  <pre className="well out">
                    {e.result!.stdout && <span>{ansiSpans(e.result!.stdout)}</span>}
                    {e.result!.stderr && <span className="stderr">{ansiSpans(e.result!.stderr, "e")}</span>}
                  </pre>
                )}
              </Expander>
            )}
          </div>
        ))}
        <div ref={endRef} />
      </div>
      <form
        className="shell-input"
        onSubmit={(ev) => {
          ev.preventDefault();
          void run();
        }}
      >
        {isVm ? (
          <Segmented
            small
            value={as}
            onChange={setAs}
            options={[
              { value: "agent", label: "agent", title: "uid 1000, same as the model" },
              { value: "root", label: "root" },
            ]}
          />
        ) : (
          <span className="dim shell-sim" title="just-bash: simulated commands, in-memory filesystem">
            just-bash
          </span>
        )}
        <span className="mono dim">{as === "root" && isVm ? "#" : "$"}</span>
        <input
          className="input mono shell-field"
          value={cmd}
          disabled={!up}
          placeholder={up ? "ls -la /workspace" : `Start ${env.name} to run commands`}
          onChange={(e) => setCmd(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "ArrowUp" && cmds.length) {
              e.preventDefault();
              const i = recall < 0 ? cmds.length - 1 : Math.max(0, recall - 1);
              setRecall(i);
              setCmd(cmds[i]);
            } else if (e.key === "ArrowDown" && recall >= 0) {
              e.preventDefault();
              const i = recall + 1;
              if (i >= cmds.length) {
                setRecall(-1);
                setCmd("");
              } else {
                setRecall(i);
                setCmd(cmds[i]);
              }
            }
          }}
        />
        <button className="btn sm" type="submit" disabled={!up || !cmd.trim()}>
          <CornerDownLeft /> Run
        </button>
      </form>
    </div>
  );
}
