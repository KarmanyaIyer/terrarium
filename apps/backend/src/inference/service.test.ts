// Model list broadcasts: oMLX loads on first request and evicts on its own, so the status poll must notice.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { WsMessage } from "@terrarium/shared";
import { Hub } from "../hub.ts";
import { Store } from "../store/db.ts";
import type { OmlxStatus } from "./omlx.ts";
import { InferenceService } from "./service.ts";

const dir = mkdtempSync(join(tmpdir(), "terrarium-inference-"));
after(() => rmSync(dir, { recursive: true, force: true }));

test("a change in the loaded set seen by the status poll broadcasts the model list", async () => {
  const store = new Store(join(dir, "t.db"), join(dir, "blobs"));
  const hub = new Hub();
  const svc = new InferenceService({ store, hub, modelsDir: join(dir, "models"), venvDir: join(dir, "venv"), omlxDataDir: join(dir, "omlx") });
  let status: OmlxStatus = { models: [{ id: "m1", loaded: false }] } as unknown as OmlxStatus;
  svc.omlx.isReady = () => true;
  svc.omlx.status = async () => status;
  const sent: WsMessage[] = [];
  hub.listen((m) => sent.push(m));
  const models = () => sent.filter((m) => m.type === "models").length;
  const poll = async () => {
    (svc as unknown as { statusCache: null }).statusCache = null;
    await svc.loadedModels();
    await new Promise((r) => setTimeout(r, 10));
  };

  await poll();
  assert.equal(models(), 0, "nothing loaded and nothing changed");
  status = { models: [{ id: "m1", loaded: true, actual_size: 123 }] } as unknown as OmlxStatus;
  await poll();
  assert.equal(models(), 1, "auto-load on first request");
  await poll();
  assert.equal(models(), 1, "no repeat while unchanged");
  status = { models: [{ id: "m1", loaded: false }] } as unknown as OmlxStatus;
  await poll();
  assert.equal(models(), 2, "eviction");
  store.close();
});

// rescan(): oMLX's reload unloads every loaded model, so it waits until none is loaded (or a new model must load).
function rescanService() {
  const svc = new InferenceService({ store: new Store(join(dir, "r.db"), join(dir, "blobs")), hub: new Hub(), modelsDir: join(dir, "models"), venvDir: join(dir, "venv"), omlxDataDir: join(dir, "omlx") });
  const st = { known: ["a"], loaded: ["a"], reloads: 0 };
  Object.assign(svc.omlx, {
    isReady: () => true,
    ensureStarted: async () => {},
    status: async () => ({ models: st.known.map((id) => ({ id, loaded: st.loaded.includes(id) })) }),
    unload: async (id: string) => void (st.loaded = st.loaded.filter((x) => x !== id)),
    applySettings: async () => {},
    request: async (_m: string, path: string) => {
      if (path !== "/admin/api/reload") return;
      st.reloads++;
      st.loaded = [];
      st.known = ["a", "new"];
    },
  });
  Object.assign(svc, { model: async (id: string) => ({ id, defaultContext: 4096, defaultMaxOutput: 1024, sampling: {}, family: "x" }) });
  return { svc, st };
}

test("rescan waits while a model is loaded and runs once none is", async () => {
  const { svc, st } = rescanService();
  await svc.rescan();
  assert.equal(st.reloads, 0);
  await svc.ensureModel("a", 4096);
  assert.equal(st.reloads, 0, "a known model loads without a re-scan");
  await svc.unload("a");
  assert.equal(st.reloads, 1);
  await svc.unload("a");
  assert.equal(st.reloads, 1, "nothing pending");
});

test("rescan runs before loading a model oMLX doesn't know yet", async () => {
  const { svc, st } = rescanService();
  await svc.rescan();
  await svc.ensureModel("new", 4096);
  assert.equal(st.reloads, 1);
});

test("rescan runs right away when nothing is loaded", async () => {
  const { svc, st } = rescanService();
  st.loaded = [];
  await svc.rescan();
  assert.equal(st.reloads, 1);
});
