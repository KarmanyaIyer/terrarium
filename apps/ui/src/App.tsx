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

function Toasts() {
  const toasts = useStore((s) => s.toasts);
  if (!toasts.length) return null;
  return createPortal(
    <div className="toasts" role="status">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.tone}`}>
          <span className="selectable">{t.text}</span>
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
      if (e.key === "Escape" && !e.defaultPrevented) {
        const st = useStore.getState();
        if (st.paletteOpen || st.newEnvOpen) return;
        const s = currentSession();
        if (s?.status === "running") {
          e.preventDefault();
          void act("Stop", (b) => b.stopSession(s.id));
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}

export function App() {
  const backend = useStore((s) => s.backend);
  const ready = useStore((s) => s.ready);
  const view = useStore((s) => s.view);
  const inspectorOpen = useStore((s) => s.inspectorOpen);
  const sidebarWidth = useStore((s) => s.sidebarWidth);
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
    <div className={`app${inspectorOpen ? "" : " no-inspector"}`} style={{ ["--sidebar-w" as string]: `${sidebarWidth}px` }}>
      <TopBar />
      <div className="body">
        <Sidebar />
        <main className="main">
          {view.kind === "session" && <SessionView key={view.id} id={view.id} />}
          {view.kind === "home" && <HomeView />}
          <Suspense fallback={<div className="empty">Loading…</div>}>
            {view.kind === "evals" && <EvalsView />}
            {view.kind === "models" && <ModelsView />}
          </Suspense>
        </main>
        {inspectorOpen && view.kind !== "models" && <Inspector />}
      </div>
      <Palette />
      <NewEnvSheet />
      <Toasts />
    </div>
  );
}
