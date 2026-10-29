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
