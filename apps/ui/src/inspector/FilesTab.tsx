import { useEffect, useMemo, useState } from "react";
import { ChevronLeft, ChevronRight, File, Folder, FolderOpen, Link2, RefreshCw } from "lucide-react";
import type { EnvSummary, FileChange, FileContent, FileNode, SessionSummary } from "@terrarium/shared";
import { onEnvFs, select, useStore } from "../state/store";
import type { Derived } from "../lib/trace";
import { shortToolLabel } from "../lib/trace";
import { exactBytes, fmtBytes, fmtInt } from "../lib/format";
import { unifiedDiff } from "../lib/diff";
import { CodeView } from "../components/CodeView";
import { DiffView } from "../components/DiffView";
import { CopyButton, Segmented } from "../components/ui";

type Mode = "file" | "start" | "step";

function countChanges(n: FileNode): number {
  if (n.type !== "dir") return n.change ? 1 : 0;
  return (n.children ?? []).reduce((a, c) => a + countChanges(c), 0);
}

function TreeNode({
  n,
  depth,
  open,
  toggle,
  selected,
  onPick,
  stepPaths,
}: {
  n: FileNode;
  depth: number;
  open: Set<string>;
  toggle: (p: string) => void;
  selected: string | null;
  onPick: (n: FileNode) => void;
  stepPaths: Set<string>;
}) {
  const isDir = n.type === "dir";
  const isOpen = open.has(n.path);
  const changed = isDir ? countChanges(n) : 0;
  return (
    <>
      <div
        className={`tree-row${selected === n.path ? " sel" : ""}${n.heavy ? " heavy" : ""}${n.change === "deleted" ? " gone" : ""}${stepPaths.has(n.path) ? " step" : ""}`}
        style={{ paddingLeft: 6 + depth * 13 }}
        onClick={() => (isDir ? !n.heavy && toggle(n.path) : onPick(n))}
        title={n.heavy ? `${n.path}\nListed, not hashed or diffed (cache/dependency dir)` : `${n.path}${n.size != null ? `\n${exactBytes(n.size)}` : ""}${n.mode != null ? `\nmode ${n.mode.toString(8)}` : ""}${n.sha256 ? `\nsha256 ${n.sha256.slice(0, 16)}…` : ""}`}
      >
        {isDir ? (
          <>
            <ChevronRight size={11} className={`tree-tw${isOpen ? " open" : ""}${n.heavy ? " hidden" : ""}`} />
            {isOpen ? <FolderOpen size={13} className="tree-ic dir" /> : <Folder size={13} className="tree-ic dir" />}
          </>
        ) : (
          <>
            <span className="tree-tw-pad" />
            {n.type === "symlink" ? <Link2 size={13} className="tree-ic" /> : <File size={13} className="tree-ic" />}
          </>
        )}
        <span className="tree-name truncate">{n.name}</span>
        {n.type === "symlink" && n.linkTarget && <span className="dim truncate tree-link">→ {n.linkTarget}</span>}
        {n.heavy && <span className="dim tree-heavy">not hashed</span>}
        {isDir && !isOpen && changed > 0 && <span className="tree-count">{changed}</span>}
        <span className="blk-spacer" />
        {!isDir && n.size != null && <span className="tree-size num">{fmtBytes(n.size)}</span>}
        {n.change && <span className={`fc-badge ${n.change}`}>{n.change === "added" ? "A" : n.change === "deleted" ? "D" : "M"}</span>}
      </div>
      {isDir &&
        isOpen &&
        (n.children ?? []).map((c) => (
          <TreeNode key={c.path} n={c} depth={depth + 1} open={open} toggle={toggle} selected={selected} onPick={onPick} stepPaths={stepPaths} />
        ))}
    </>
  );
}

function collectOpen(n: FileNode, out: Set<string>, depth = 0) {
  if (n.type !== "dir" || n.heavy) return;
  if (depth < 1 || countChanges(n) > 0) out.add(n.path);
  for (const c of n.children ?? []) collectOpen(c, out, depth + 1);
}

function findNode(n: FileNode, path: string): FileNode | undefined {
  if (n.path === path) return n;
  for (const c of n.children ?? []) {
    const f = findNode(c, path);
    if (f) return f;
  }
  return undefined;
}

function StepDiff({ change }: { change: FileChange }) {
  const backend = useStore((s) => s.backend);
  const [text, setText] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    setText(null);
    setErr(null);
    if (!change.diffBlob || !backend) return;
    backend.getBlob(change.diffBlob).then(setText, (e) => setErr(String(e)));
  }, [change.diffBlob, backend]);
  return (
    <div className="step-diff">
      <div className="step-diff-head">
        <span className={`fc-badge ${change.kind}`}>{change.kind === "added" ? "A" : change.kind === "deleted" ? "D" : "M"}</span>
        <span className="mono truncate">{change.path}</span>
        <span className="blk-spacer" />
        <span className="dim num">
          {change.before ? fmtBytes(change.before.size) : "–"} → {change.after ? fmtBytes(change.after.size) : "–"}
        </span>
      </div>
      {change.binary ? (
        <div className="dim pad">Binary file</div>
      ) : change.tooLarge ? (
        <div className="dim pad">Too large to diff</div>
      ) : err ? (
        <div className="err-text pad">{err}</div>
      ) : text == null ? (
        <div className="dim pad">{change.diffBlob ? "Loading" : "No diff stored"}</div>
      ) : (
        <DiffView text={text} />
      )}
    </div>
  );
}

export function FilesTab({ env, session, d }: { env: EnvSummary; session?: SessionSummary; d?: Derived }) {
  const backend = useStore((s) => s.backend);
  const focus = useStore((s) => s.filesFocus);
  const steps = d?.fsSteps ?? [];
  const live = session?.status === "running";
  // step index: -1 = session start, steps.length = latest (live)
  const [stepIdx, setStepIdx] = useState<number>(steps.length);
  const [pinned, setPinned] = useState(false);
  const [tree, setTree] = useState<FileNode | null>(null);
  const [treeErr, setTreeErr] = useState<string | null>(null);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [path, setPath] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>("file");
  const [file, setFile] = useState<FileContent | null>(null);
  const [startFile, setStartFile] = useState<FileContent | null | "none">(null);
  const [fileErr, setFileErr] = useState<string | null>(null);
  const [rev, setRev] = useState(0);

  // follow the newest step unless the user scrubbed back
  useEffect(() => {
    if (!pinned) setStepIdx(steps.length);
  }, [steps.length, pinned]);

  // a tool call selected elsewhere jumps to its step
  useEffect(() => {
    if (!focus?.toolCallId) return;
    const i = steps.findIndex((s) => s.toolCallId === focus.toolCallId);
    if (i >= 0) {
      setStepIdx(i);
      setPinned(true);
      setMode("step");
      const first = steps[i].changes[0];
      if (first) setPath(first.path);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus?.toolCallId, steps.length]);

  useEffect(() => {
    const off = onEnvFs((id) => {
      if (id === env.id) setRev((r) => r + 1);
    });
    return () => {
      off();
    };
  }, [env.id]);

  const atLatest = stepIdx >= steps.length;
  const at = !session ? undefined : atLatest ? undefined : stepIdx < 0 ? 0 : steps[stepIdx].seq;
  const stepNow = stepIdx >= 0 && stepIdx < steps.length ? steps[stepIdx] : atLatest && steps.length ? steps[steps.length - 1] : undefined;
  const stepPaths = useMemo(() => new Set(stepNow && (mode === "step" || !atLatest) ? stepNow.changes.map((c) => c.path) : []), [stepNow, mode, atLatest]);

  useEffect(() => {
    if (!backend) return;
    let alive = true;
    backend.getTree(env.id, { sessionId: session?.id, at }).then(
      (t) => {
        if (!alive) return;
        setTree(t);
        setTreeErr(null);
        setOpen((prev) => {
          if (prev.size) {
            const next = new Set(prev);
            collectOpen(t, next);
            return next;
          }
          const s = new Set<string>();
          collectOpen(t, s);
          return s;
        });
      },
      (e) => alive && setTreeErr(String(e)),
    );
    return () => {
      alive = false;
    };
  }, [backend, env.id, session?.id, at, steps.length, rev, env.status]);

  useEffect(() => {
    if (!backend || !path) return;
    let alive = true;
    setFileErr(null);
    backend.getFile(env.id, path, { sessionId: session?.id, at }).then(
      (f) => alive && setFile(f),
      (e) => {
        if (!alive) return;
        setFile(null);
        setFileErr(String((e as Error).message ?? e));
      },
    );
    if (session) {
      backend.getFile(env.id, path, { sessionId: session.id, at: 0 }).then(
        (f) => alive && setStartFile(f),
        () => alive && setStartFile("none"),
      );
    } else setStartFile(null);
    return () => {
      alive = false;
    };
  }, [backend, env.id, session?.id, path, at, steps.length, rev]);

  const node = tree && path ? findNode(tree, path) : undefined;
  const stepChange = stepNow?.changes.find((c) => c.path === path);
  const startDiff = useMemo(() => {
    if (mode !== "start" || !file) return null;
    const before = startFile && startFile !== "none" ? (startFile.content ?? "") : "";
    return unifiedDiff(before, file?.content ?? "", path ?? "");
  }, [mode, file, startFile, path]);

  const go = (i: number) => {
    const n = Math.max(-1, Math.min(steps.length, i));
    setStepIdx(n);
    setPinned(n < steps.length);
    const st = n >= 0 && n < steps.length ? steps[n] : undefined;
    if (st?.toolCallId && d) {
      const t = d.tools.find((x) => x.toolCallId === st.toolCallId);
      if (t) select({ kind: "tool", toolCallId: t.toolCallId, callId: t.callId, seq: t.seq }, { follow: false });
    }
  };

  const stepLabel =
    stepIdx < 0
      ? "Session start"
      : atLatest
        ? live
          ? "Live"
          : "Latest"
        : `Step ${stepIdx + 1}: ${stepNow ? shortToolLabel(d?.tools.find((t) => t.toolCallId === stepNow.toolCallId)?.name ?? "", d?.tools.find((t) => t.toolCallId === stepNow.toolCallId)?.args) || stepNow.label : ""}`;

  return (
    <div className="files">
      {session && (
        <div className="scrub">
          <button className="icon-btn sm" onClick={() => go(stepIdx - 1)} disabled={stepIdx < 0} title="Previous step">
            <ChevronLeft />
          </button>
          <div className="scrub-track">
            <input
              type="range"
              min={-1}
              max={steps.length}
              step={1}
              value={stepIdx}
              onChange={(e) => go(Number(e.target.value))}
              aria-label="Workspace at step"
            />
            <div className="scrub-ticks">
              {steps.map((s, i) => (
                <span
                  key={s.seq}
                  className={`scrub-tick${i === stepIdx ? " on" : ""}`}
                  style={{ left: `${((i + 1) / (steps.length + 1)) * 100}%` }}
                  title={`${s.label} (${s.changes.length} file${s.changes.length > 1 ? "s" : ""})`}
                />
              ))}
            </div>
          </div>
          <button className="icon-btn sm" onClick={() => go(stepIdx + 1)} disabled={atLatest} title="Next step">
            <ChevronRight />
          </button>
          <span className={`scrub-label truncate${atLatest && live ? " live" : ""}`} title={stepNow?.label}>
            {atLatest && live && <span className="dot live" />}
            {stepLabel}
          </span>
          {!atLatest && (
            <button className="btn sm ghost" onClick={() => go(steps.length)}>
              {live ? "Live" : "Latest"}
            </button>
          )}
        </div>
      )}
      <div className="tree">
        {treeErr ? (
          <div className="empty err-text">{treeErr}</div>
        ) : !tree ? (
          <div className="empty">Loading tree</div>
        ) : !(tree.children ?? []).length ? (
          <div className="empty">/workspace is empty</div>
        ) : (
          <>
            <div className="tree-root mono">
              {tree.path}
              <span className="blk-spacer" />
              <button className="icon-btn sm" title="Refresh" onClick={() => setRev((r) => r + 1)}>
                <RefreshCw />
              </button>
            </div>
            {(tree.children ?? []).map((c) => (
              <TreeNode
                key={c.path}
                n={c}
                depth={0}
                open={open}
                toggle={(p) =>
                  setOpen((o) => {
                    const n = new Set(o);
                    if (n.has(p)) n.delete(p);
                    else n.add(p);
                    return n;
                  })
                }
                selected={path}
                onPick={(n) => {
                  setPath(n.path);
                  if (mode === "step" && !stepNow?.changes.some((c) => c.path === n.path)) setMode(n.change ? "start" : "file");
                }}
                stepPaths={stepPaths}
              />
            ))}
          </>
        )}
      </div>
      <div className="viewer">
        {mode === "step" && stepNow ? (
          <>
            <div className="viewer-head">
              <span className="truncate">
                {stepNow.changes.length} file{stepNow.changes.length > 1 ? "s" : ""} changed by <span className="mono">{stepNow.label.slice(0, 80)}</span>
              </span>
              <span className="blk-spacer" />
              <Segmented<Mode>
                small
                value={mode}
                onChange={setMode}
                options={[
                  { value: "file", label: "File", disabled: !path },
                  { value: "start", label: "vs start", disabled: !path || !session },
                  { value: "step", label: "This step" },
                ]}
              />
            </div>
            <div className="viewer-body">
              {stepNow.changes.map((c) => (
                <StepDiff key={c.path} change={c} />
              ))}
            </div>
          </>
        ) : !path ? (
          <div className="empty">Select a file</div>
        ) : (
          <>
            <div className="viewer-head">
              <span className="mono truncate viewer-path" title={path}>
                {path.replace(/^\/workspace\//, "")}
              </span>
              {file && (
                <span className="dim num" title={exactBytes(file.size)}>
                  {fmtBytes(file.size)}
                  {file.content ? `  ${fmtInt(file.content.split("\n").length - (file.content.endsWith("\n") ? 1 : 0))} lines` : ""}
                </span>
              )}
              <span className="blk-spacer" />
              <Segmented<Mode>
                small
                value={mode}
                onChange={setMode}
                options={[
                  { value: "file", label: "File" },
                  { value: "start", label: "vs start", disabled: !session, title: "Diff against the workspace at session start" },
                  { value: "step", label: "This step", disabled: !stepChange, title: "Diff made by the selected step" },
                ]}
              />
              {file?.content != null && <CopyButton text={file.content} />}
            </div>
            <div className="viewer-body">
              {fileErr ? (
                <div className="empty">{node?.change === "deleted" ? "Deleted at this step" : fileErr}</div>
              ) : !file ? (
                <div className="empty">Loading</div>
              ) : file.binary ? (
                <div className="empty">Binary file, {fmtBytes(file.size)}</div>
              ) : mode === "start" ? (
                startDiff === "" ? (
                  <div className="empty">Unchanged since session start</div>
                ) : startDiff == null ? (
                  <div className="empty">Too large to diff here</div>
                ) : (
                  <DiffView text={startDiff} />
                )
              ) : (
                <>
                  <CodeView code={file.content ?? ""} path={file.path} />
                  {file.truncated && <div className="dim pad">Truncated at {fmtBytes(file.content?.length)}</div>}
                </>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
