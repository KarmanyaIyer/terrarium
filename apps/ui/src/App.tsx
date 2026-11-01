import { runRedo, runUndo } from "./state/undo";
import { lazy, Suspense, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { resolveBackend, saveManualConnection } from "./api/connect";
import { currentSession, dismissToast, act, startBackend, useStore } from "./state/store";
import { TopBar } from "./components/TopBar";
import { Sidebar } from "./components/Sidebar";
import { Palette } from "./components/Palette";
import { SessionView } from "./views/SessionView";
import { HomeView } from "./views/HomeView";
import { Inspector } from "./inspector/Inspector";
import { NewEnvSheet } from "./views/NewEnvSheet";

let booted = false;

const EvalsView = lazy(() => import("./views/EvalsView"));
const ModelsView = lazy(() => import("./views/ModelsView"));
const SettingsView = lazy(() => import("./views/SettingsView"));
const LabView = lazy(() => import("./views/lab/LabView"));

function Toasts() {
  const toasts = useStore((s) => s.toasts);
  if (!toasts.length) return null;
  return createPortal(
    <div className="toasts" role="status">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.tone}`}>
          <span className="selectable">{t.text}</span>
          {t.action && (
            <button
              className="btn sm toast-act"
              onClick={() => {
                t.action!.run();
                dismissToast(t.id);
              }}
            >
              {t.action.label}
            </button>
          )}
          <button className="icon-btn sm" onClick={() => dismissToast(t.id)} aria-label="Dismiss">
            <X />
          </button>
        </div>
      ))}
    </div>,
    document.body,
  );
}

function ConnectScreen({ reason }: { reason: string }) {
  const [url, setUrl] = useState("http://127.0.0.1:");
  const [token, setToken] = useState("");
  return (
    <div className="connect">
      <form
        className="connect-form"
        onSubmit={(e) => {
          e.preventDefault();
          void startBackend(saveManualConnection(url.trim(), token.trim()));
        }}
      >
        <div className="connect-title">Connect to a Terrarium backend</div>
        <div className="dim">{reason}</div>
        <label>
          <span>URL</span>
          <input className="input mono" value={url} onChange={(e) => setUrl(e.target.value)} autoFocus />
        </label>
        <label>
          <span>Token</span>
          <input className="input mono" type="password" value={token} onChange={(e) => setToken(e.target.value)} />
        </label>
        <div className="connect-actions">
          <button className="btn primary" type="submit" disabled={!token || url.length < 12}>
            Connect
          </button>
          <a className="btn ghost" href="?fixtures">
            Open with fixtures
          </a>
        </div>
      </form>
    </div>
  );
}

const NON_TEXT_INPUTS = new Set(["range", "checkbox", "radio", "button", "submit", "reset", "color", "file"]);

/** Whether Cmd+Z here means the field's own text undo. A slider or checkbox has none. */
export function isTextField(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  if (!el?.tagName) return false;
  if (el.isContentEditable || el.tagName === "TEXTAREA") return true;
  return el.tagName === "INPUT" && !NON_TEXT_INPUTS.has((el as HTMLInputElement).type);
}

function useGlobalKeys() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === "k") {
        e.preventDefault();
        useStore.setState((s) => ({ paletteOpen: !s.paletteOpen }));
        return;
      }
      if (mod && e.key.toLowerCase() === "i" && !e.shiftKey) {
        e.preventDefault();
        useStore.setState((s) => ({ inspectorOpen: !s.inspectorOpen }));
        return;
      }
      if (mod && !e.altKey && e.key.toLowerCase() === "z") {
        // a text field's own undo comes first; everything else is the app's
        if (isTextField(e.target)) return;
        e.preventDefault();
        void (e.shiftKey ? runRedo() : runUndo());
        return;
      }
      if (e.key === "Escape" && !e.defaultPrevented) {
        const st = useStore.getState();
        if (st.paletteOpen || st.newEnvOpen) return;
        // Esc in a text field cancels that field; only the composer's Esc stops the run
        const t = e.target as HTMLElement | null;
        const editable = !!t && (t.isContentEditable || t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT");
        if (editable && !t.classList.contains("composer-input")) return;
        const s = currentSession();
        if (s?.status === "running") {
          e.preventDefault();
          void act("Stop", (b) => b.stopSession(s.id));
        }
      }
    };
    window.addEventListener("keydown", onKey);
    // the menu's Undo and Redo in the desktop app, when no text field has the focus (src-tauri/src/main.rs)
    const bridge = window as unknown as { __terrariumUndo?: (redo: boolean) => boolean };
    bridge.__terrariumUndo = (redo) => {
      if (isTextField(document.activeElement)) return false;
      void (redo ? runRedo() : runUndo());
      return true;
    };
    return () => {
      window.removeEventListener("keydown", onKey);
      delete bridge.__terrariumUndo;
    };
  }, []);
}

export function App() {
  const backend = useStore((s) => s.backend);
  const ready = useStore((s) => s.ready);
  const view = useStore((s) => s.view);
  const inspectorOpen = useStore((s) => s.inspectorOpen);
  const sidebarWidth = useStore((s) => s.sidebarWidth);
  // Home shows the inspector only for an environment you picked; sessions always have one
  const homeEnv = useStore((s) => !!s.inspectorEnvId && !!s.envs[s.inspectorEnvId]);
  const showInspector = inspectorOpen && (view.kind === "session" || (view.kind === "home" && homeEnv));
  const [noBackend, setNoBackend] = useState<string | null>(null);
  useGlobalKeys();

  useEffect(() => {
    if (booted) return;
    booted = true;
    void resolveBackend().then((r) => {
      if (r.backend) void startBackend(r.backend);
      else setNoBackend(r.reason);
    });
  }, []);

  if (!backend && noBackend) return <ConnectScreen reason={noBackend} />;
  if (!backend || !ready)
    return (
      <div className="connect">
        <div className="dim">Connecting…</div>
      </div>
    );

  return (
    <div className={`app${showInspector ? "" : " no-inspector"}`} style={{ ["--sidebar-w" as string]: `${sidebarWidth}px` }}>
      <TopBar />
      <div className="body">
        <Sidebar />
        <main className="main">
          {view.kind === "session" && <SessionView key={view.id} id={view.id} />}
          {view.kind === "home" && <HomeView />}
          <Suspense fallback={<div className="empty">Loading…</div>}>
            {view.kind === "evals" && <EvalsView />}
            {view.kind === "models" && <ModelsView />}
            {view.kind === "settings" && <SettingsView />}
            {view.kind === "lab" && <LabView />}
          </Suspense>
        </main>
        {showInspector && <Inspector />}
      </div>
      <Palette />
      <NewEnvSheet />
      <Toasts />
    </div>
  );
}
