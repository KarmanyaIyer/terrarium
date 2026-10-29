// When the model's tokenizer fails (review 4, #8 and #9): the run counts with estimates that err high, says so in the
// trace, and holds them to the session window like exact counts, so no request asks for more than the window; the
// tokenizer is asked once per run, not on every count; and Stop cancels a count that hangs.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { ModelInfo, TraceEvent } from "@terrarium/shared";
import { EnvManager } from "../envs/manager.ts";
import { Hub } from "../hub.ts";
import { Gateway } from "../inference/gateway.ts";
import type { InferenceService } from "../inference/service.ts";
import { TokenCounter } from "../inference/tokens.ts";
import { Store } from "../store/db.ts";
import { startFakeOpenAI, type FakeOpenAI, type ScriptedReply } from "../test-support/fake-openai.ts";
import { conservativeTokens } from "./budget.ts";
import { SessionManager } from "./sessions.ts";

const MODEL: ModelInfo = {
  id: "fake-model",
  name: "Fake",
  family: "qwen3.5",
  params: "4B",
  quant: "4bit",
  diskBytes: 1,
  nativeContext: 32768,
  toolFormat: "qwen3_coder XML",
  thinking: "none",
  kvBytesPerToken: 1,
  fixedBytes: 1,
  weightsBytes: 1,
  loaded: false,
  defaultContext: 8192,
  defaultMaxOutput: 2048,
  sampling: { temperature: 0.7, topP: 0.8 },
};

/** Like Qwen's tokenizer: every digit is a token; other text about 4 characters per token; plus the template. */
function qwenish(body: Record<string, any>): number {
  const text = JSON.stringify(body.messages ?? []) + JSON.stringify(body.tools ?? []);
  const digits = (text.match(/\d/g) ?? []).length;
  return digits + Math.ceil((text.length - digits) / 4) + 8;
}

/** A tokenizer endpoint that fails: 404 (an oMLX without /v1/tokenize), 500, or never answers. */
let tokMode: "404" | "500" | "hang" = "404";
let tokRequests = 0;
const hanging: ServerResponse[] = [];
let tokServer: Server;
let tokOrigin = "";

let dir: string;
let store: Store;
let hub: Hub;
let fake: FakeOpenAI;
let gateway: Gateway;
let sessions: SessionManager;
let reply: (body: Record<string, any>, n: number) => ScriptedReply = () => ({ text: "ok" });
const inference = { model: async (id: string) => (id === MODEL.id ? MODEL : null), ensureModel: async () => {} } as unknown as InferenceService;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "terrarium-est-"));
  store = new Store(join(dir, "db.sqlite"), join(dir, "blobs"));
  hub = new Hub();
  tokServer = createServer((req: IncomingMessage, res: ServerResponse) => {
    req.resume();
    req.on("end", () => {
      tokRequests++;
      if (tokMode === "hang") {
        hanging.push(res);
        return;
      }
      res.writeHead(Number(tokMode), { "Content-Type": "application/json" });
      res.end(JSON.stringify({ detail: tokMode === "404" ? "Not Found" : "boom" }));
    });
  });
  await new Promise<void>((r) => tokServer.listen(0, "127.0.0.1", r));
  const a = tokServer.address();
  tokOrigin = `http://127.0.0.1:${typeof a === "object" && a ? a.port : 0}`;
  fake = await startFakeOpenAI((body, n) => reply(body, n), { promptTokens: qwenish });
  gateway = new Gateway(store, { baseUrl: () => fake.origin, apiKey: () => "k", ensureReady: async () => {} });
  await gateway.listen();
  const envs = new EnvManager({ store, hub, dataDir: dir, drivers: { sim: null, vm: null } });
  const tokens = new TokenCounter({ baseUrl: () => tokOrigin, apiKey: () => "k", ensureReady: async () => {} });
  sessions = new SessionManager({ store, hub, envs, inference, gateway, tokens });
});

after(async () => {
  for (const r of hanging) r.destroy();
  await sessions.stopAll();
  await gateway.close();
  await fake.close();
  tokServer.closeAllConnections();
  await new Promise<void>((r) => tokServer.close(() => r()));
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

const of = <T extends TraceEvent["type"]>(sessionId: string, type: T) => store.events(sessionId).filter((e) => e.type === type) as Extract<TraceEvent, { type: T }>[];
const digits = (n: number) => Array.from({ length: n }, (_, i) => String((i * 7) % 10)).join("");

test("conservativeTokens counts digits one each, where chars/3.5 counted 6,000 of them as ~1,700", () => {
  assert.ok(conservativeTokens(digits(6000)) >= 6000);
  assert.ok(conservativeTokens("Ünïcödé 漢字 😀") >= 3 + 2 + 2);
});

test("tokenizer 404: a 6,000-digit message is refused as over the 4,096 window, with a visible warning that counts are estimates", async () => {
  tokMode = "404";
  const s = await sessions.create({ envId: null, modelId: MODEL.id, harness: "chat", contextWindow: 4096 });
  const sent = fake.requests.length;
  const asked = tokRequests;
  const out = await sessions.run(s.id, digits(6000));
  assert.equal(out.reason, "error");
  assert.equal(fake.requests.length, sent, "no completion request reached the server");
  assert.equal(tokRequests - asked, 1, "the tokenizer was asked once, then the run used estimates");
  const warn = of(s.id, "warning").filter((w) => w.code === "token_estimate");
  assert.equal(warn.length, 1);
  assert.match(warn[0].message, /^Token counts are estimates for the rest of this run: the model's tokenizer failed \(tokenizer returned 404/);
  const err = of(s.id, "error")[0];
  assert.equal(err.code, "context_overflow");
  assert.equal(err.data!.counted, "estimate");
  assert.ok((err.data!.promptTokens as number) >= 6000, `estimated ${err.data!.promptTokens}`);
  assert.match(err.message, /^Request not sent: the prompt is about [\d,]+ tokens after compaction, over the 4,096-token context window\.$/);
});

test("tokenizer 500: a digit-heavy message that fits is sent with prompt + max_tokens inside the window by the server's own count", async () => {
  tokMode = "500";
  const s = await sessions.create({ envId: null, modelId: MODEL.id, harness: "chat", contextWindow: 4096 });
  const sent = fake.requests.length;
  reply = () => ({ text: "The digits repeat with period 10." });
  const out = await sessions.run(s.id, `What repeats here? ${digits(3000)}`);
  assert.equal(out.reason, "done", out.error);
  const req = fake.requests[sent];
  assert.ok(req, "the request was sent");
  assert.ok(qwenish(req) + req.max_tokens <= 4096, `server prompt ${qwenish(req)} + max_tokens ${req.max_tokens} within 4,096`);
  const st = of(s.id, "model_call_start")[0];
  assert.equal(st.promptCount, "estimate");
  assert.ok(st.promptTokensEst >= qwenish(req), `estimate ${st.promptTokensEst} >= server ${qwenish(req)}`);
  assert.equal(of(s.id, "warning").filter((w) => w.code === "token_estimate").length, 1);

  // The next run builds on the server's count of the first request: the shared prefix isn't estimated again.
  const sent2 = fake.requests.length;
  const out2 = await sessions.run(s.id, "And the period?");
  assert.equal(out2.reason, "done", out2.error);
  const st2 = of(s.id, "model_call_start")[1];
  const req2 = fake.requests[sent2];
  assert.ok(st2.promptTokensEst >= qwenish(req2), `estimate ${st2.promptTokensEst} >= server ${qwenish(req2)}`);
  assert.ok(st2.promptTokensEst - qwenish(req2) < st.promptTokensEst - qwenish(req), "the second estimate is closer: only the new turns are estimated");
});

test("Stop cancels a tokenizer count that never answers", async () => {
  tokMode = "hang";
  const s = await sessions.create({ envId: null, modelId: MODEL.id, harness: "chat", contextWindow: 4096 });
  const asked = tokRequests;
  const run = sessions.run(s.id, "hello");
  for (let i = 0; i < 100 && tokRequests === asked; i++) await new Promise((r) => setTimeout(r, 10));
  assert.ok(tokRequests > asked, "a count is in flight");
  const t0 = Date.now();
  await sessions.stop(s.id);
  const out = await Promise.race([run, new Promise<null>((r) => setTimeout(() => r(null), 5000))]);
  assert.ok(out, "the run ended within 5 s of Stop");
  assert.equal(out.reason, "stopped");
  assert.ok(Date.now() - t0 < 3000, `stopped after ${Date.now() - t0} ms`);
  assert.equal(of(s.id, "model_call_start").length, 0);
});
