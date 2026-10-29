import type { Backend } from "./backend";
import { HttpBackend } from "./http";

export type Resolved = { backend: Backend } | { backend: null; reason: string };

const STORE_KEY = "terrarium.conn";

export function wantsFixtures(): boolean {
  const q = new URLSearchParams(location.search);
  return q.has("fixtures") || import.meta.env.VITE_FIXTURES === "1";
}

function inTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/** Fixtures > Tauri `backend_info` > location hash > VITE_BACKEND_* env > last manual entry. */
export async function resolveBackend(): Promise<Resolved> {
  if (wantsFixtures()) {
    const { FixtureBackend } = await import("../fixtures/backend");
    const speed = Number(new URLSearchParams(location.search).get("speed") ?? "1") || 1;
    return { backend: new FixtureBackend({ speed }) };
  }

  if (inTauri()) {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const info = await invoke<{ url: string; token: string }>("backend_info");
      return { backend: new HttpBackend(info.url, info.token) };
    } catch (err) {
      return { backend: null, reason: `backend_info failed: ${String(err)}` };
    }
  }

  const hash = new URLSearchParams(location.hash.replace(/^#/, ""));
  const hUrl = hash.get("url");
  const hToken = hash.get("token");
  if (hUrl && hToken) {
    sessionStorage.setItem(STORE_KEY, JSON.stringify({ url: hUrl, token: hToken }));
    history.replaceState(null, "", location.pathname + location.search);
    return { backend: new HttpBackend(hUrl, hToken) };
  }

  const envUrl = import.meta.env.VITE_BACKEND_URL as string | undefined;
  const envToken = import.meta.env.VITE_BACKEND_TOKEN as string | undefined;
  if (envUrl && envToken) return { backend: new HttpBackend(envUrl, envToken) };

  const saved = sessionStorage.getItem(STORE_KEY);
  if (saved) {
    try {
      const { url, token } = JSON.parse(saved) as { url: string; token: string };
      if (url && token) return { backend: new HttpBackend(url, token) };
    } catch {
      sessionStorage.removeItem(STORE_KEY);
    }
  }
  return { backend: null, reason: "No backend URL" };
}

/** Forget a hash or manually entered connection and leave fixture mode; the next load resolves again. */
export function forgetConnection() {
  sessionStorage.removeItem(STORE_KEY);
  location.href = location.pathname;
}

export function saveManualConnection(url: string, token: string): Backend {
  sessionStorage.setItem(STORE_KEY, JSON.stringify({ url, token }));
  return new HttpBackend(url, token);
}
