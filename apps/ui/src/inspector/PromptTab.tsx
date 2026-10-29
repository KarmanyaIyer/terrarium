import { useEffect, useRef, useState } from "react";
import { ChevronRight, Loader2 } from "lucide-react";
import type { SessionPrompt, SessionSummary } from "@terrarium/shared";
import { act, useStore } from "../state/store";
import { HarnessTip, harnessLabel } from "../lib/explain";
import { fmtInt } from "../lib/format";
import { CopyButton, Hint } from "../components/ui";
import { JsonView } from "../components/JsonView";

const SOURCE: Record<SessionPrompt["source"], { label: string; tip: string }> = {
  "built-in": { label: "built-in", tip: "The profile's built-in prompt" },
  profile: { label: "saved default", tip: "Your saved default for this profile (Settings)" },
  session: { label: "this session", tip: "This session's own prompt; other sessions are unaffected" },
};

export function PromptTab({ session }: { session: SessionSummary }) {
  const prompts = useStore((s) => s.settings.prompts);
  const loaded = useStore((s) => s.models.find((m) => m.id === session.modelId)?.loaded ?? false);
  const [p, setP] = useState<SessionPrompt | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [n, setN] = useState(0);

  // The prompt the textarea was last synced to; a refetch (model loaded, settings broadcast) keeps unsaved edits.
  const synced = useRef<{ id: string; text: string } | null>(null);

  useEffect(() => {
    let gone = false;
    void act("System prompt", (b) => b.getSessionPrompt(session.id)).then((r) => {
      if (gone || !r) return;
      const prev = synced.current;
      synced.current = { id: session.id, text: r.text };
      setP(r);
      setText((cur) => (prev?.id === session.id && cur !== prev.text ? cur : r.text));
    });
    return () => {
      gone = true;
    };
  }, [session.id, session.harness, session.customPrompt, session.envId, session.modelId, prompts, loaded, n]);

  if (!p) return <div className="empty">Loading prompt</div>;
  const running = session.status === "running";
  const locked = running || !!session.evalRunId;
  const dirty = text !== p.text;
  const profile = p.envType ? p.harness : "chat";

  const save = async (fn: () => Promise<unknown>, label: string) => {
    setBusy(true);
    await act(label, fn);
    setBusy(false);
    setN((x) => x + 1);
  };
  const forSession = () =>
    save(async () => {
      const b = useStore.getState().backend!;
      const s = await b.updateSession(session.id, { systemPrompt: text === p.defaultText ? null : text });
      useStore.setState((st) => ({ sessions: { ...st.sessions, [s.id]: s } }));
    }, "Save prompt");
  const asDefault = () =>
    save(async () => {
      const b = useStore.getState().backend!;
      await b.updateSettings({ prompts: { [profile]: text } });
      if (session.customPrompt) {
        const s = await b.updateSession(session.id, { systemPrompt: null });
        useStore.setState((st) => ({ sessions: { ...st.sessions, [s.id]: s } }));
      }
    }, "Save default prompt");
  const reset = () =>
    save(async () => {
      const b = useStore.getState().backend!;
      const s = await b.updateSession(session.id, { systemPrompt: null });
      useStore.setState((st) => ({ sessions: { ...st.sessions, [s.id]: s } }));
    }, "Reset prompt");

  return (
    <div className="prompt-tab">
      <div className="pt-head">
        <Hint tip={<HarnessTip id={session.harness} />}>
          <b>{harnessLabel(session.harness)}</b>
        </Hint>
        <Hint tip={SOURCE[p.source].tip}>
          <span className={`chip${p.source === "session" ? " accent" : ""}`}>{SOURCE[p.source].label}</span>
        </Hint>
        <span className="blk-spacer" />
        <Hint
          tip={
            p.tokens.exact
              ? "Counted with the model's tokenizer, chat template included"
              : "About 4 characters per token. Exact counts appear once the model is loaded."
          }
        >
          <span className="num dim">
            {p.tokens.exact ? "" : "≈"}
            {fmtInt(p.tokens.prompt)} prompt
            {p.tools.length ? ` + ${p.tokens.exact ? "" : "≈"}${fmtInt(p.tokens.tools)} tools` : ""} tokens
          </span>
        </Hint>
      </div>

      <div className="pt-section">
        <div className="pt-label">
          <span>System prompt</span>
          <span className="blk-spacer" />
          <CopyButton text={text} />
        </div>
        <textarea
          className="input mono pt-text"
          value={text}
          spellCheck={false}
          readOnly={locked}
          rows={Math.min(24, Math.max(6, text.split("\n").length + 1))}
          onChange={(e) => setText(e.target.value)}
          aria-label="System prompt"
        />
        {!locked && (
          <div className="pt-actions">
            <button className="btn sm primary" disabled={!dirty || busy || !text.trim()} onClick={() => void forSession()}>
              {busy && <Loader2 className="spin" />} Use for this session
            </button>
            <Hint tip={`Every ${harnessLabel(profile)} session without its own prompt sends this, eval runs included.`}>
              <button className="btn sm" disabled={busy || !text.trim() || (!dirty && p.source !== "session")} onClick={() => void asDefault()}>
                Save as profile default
              </button>
            </Hint>
            {dirty && (
              <button className="btn sm ghost" onClick={() => setText(p.text)}>
                Revert
              </button>
            )}
            {!dirty && p.source === "session" && (
              <button className="btn sm ghost" disabled={busy} onClick={() => void reset()}>
                Use profile prompt
              </button>
            )}
          </div>
        )}
        {locked && <div className="dim pt-note">{session.evalRunId ? "Eval sessions keep the prompt they were graded with" : "Stop the run to edit"}</div>}
      </div>

      <div className="pt-section">
        <div className="pt-label">
          <span>Tools</span>
          <span className="dim num">{p.tools.length}</span>
        </div>
        {p.tools.length === 0 && <div className="dim pt-note">None: this profile sends no tool definitions</div>}
        {p.tools.map((t) => (
          <ToolDef key={t.name} name={t.name} description={t.description} parameters={t.parameters} />
        ))}
      </div>
    </div>
  );
}

function ToolDef({ name, description, parameters }: { name: string; description: string; parameters: unknown }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="pt-tool">
      <button className="pt-tool-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        <ChevronRight size={12} className={`tw${open ? " open" : ""}`} />
        <span className={`mono tool-name t-${name}`}>{name}</span>
        <span className="dim truncate">{description}</span>
      </button>
      {open && (
        <div className="pt-tool-body">
          <JsonView value={parameters} open={3} />
        </div>
      )}
    </div>
  );
}
