// Fake Lab sidecar for tests, speaking lab_serve.py's protocol: prints {"port"} first, gates on the per-launch key,
// reports loading then ready on /health, echoes Lab ops, keeps strain pushes, and serves strains on
// /v1/chat/completions (the reply names the pushes it applied). Exits on stdin EOF like the real one.
// argv: <modelId> [mode]; mode "crash" exits right after startup, "fail" reports a load error.

import { createServer } from "node:http";

const [modelId = "fake", mode = ""] = process.argv.slice(2);
const key = process.env.TERRARIUM_LAB_KEY ?? "";
const started = Date.now();
type Push = { kind?: string; name?: string; strength?: number; layer: number; neuron: number; mode: string; value: number };
const strains = new Map<string, Push[]>();
const settings = new Map<string, unknown>();
let busy: string | null = null;
const LAYERS = 4;
const N = 16;

function recipe(pushes: Push[]): string {
  return pushes.map((p) => (p.kind === "vector" ? `[${p.name} L${p.layer} x${p.strength}]` : `L${p.layer}N${p.neuron}${p.mode === "clamp" ? "=" : p.value < 0 ? "-" : "+"}${Math.abs(p.value)}`)).join(" ");
}

const server = createServer((req, res) => {
  const send = (status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  if (req.headers.authorization !== `Bearer ${key}` || !key) return send(401, { error: "missing or invalid key" });
  const chunks: Buffer[] = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", async () => {
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
    const path = req.url ?? "";
    const loading = Date.now() - started < 300;
    if (req.method === "GET" && path === "/health") {
      if (mode === "fail" && !loading) return send(200, { status: "error", stage: "loading weights", progress: 0, busy: null, activeBytes: 0, peakBytes: 0, detail: "fake load failure" });
      if (loading) return send(200, { status: "loading", stage: "calibrating", progress: 0.5, busy: null, activeBytes: 0, peakBytes: 0 });
      const facts = { modelId, arch: "qwen3_5", layers: LAYERS, neuronsPerLayer: Array(LAYERS).fill(N), totalNeurons: LAYERS * N, dModel: 8, activation: "swiglu", quant: "4bit", residNorm: [1, 2, 3, 4], calibrationTokens: 10, residentBytes: 1000, loadMs: 5 };
      return send(200, { status: "ready", stage: "ready", progress: 1, busy, activeBytes: 1000, peakBytes: 2000, facts, strains: [...strains.keys()] });
    }
    if (loading) return send(409, { error: "model is loading (calibrating)" });
    if (req.method === "PUT" && path.startsWith("/strains/")) {
      const pushes = body.pushes as Push[];
      if (pushes.some((p) => p.layer >= LAYERS)) return send(400, { error: `layer must be 0 to ${LAYERS - 1}` });
      strains.set(decodeURIComponent(path.slice("/strains/".length)), pushes);
      settings.set(decodeURIComponent(path.slice("/strains/".length)), body.settings);
      return send(200, { ok: true });
    }
    if (req.method === "DELETE" && path.startsWith("/strains/")) {
      strains.delete(decodeURIComponent(path.slice("/strains/".length)));
      return send(200, { ok: true });
    }
    if (req.method !== "POST") return send(404, { error: "not found" });
    if (path === "/v1/tokenize") return send(200, { count: 7, tokens: [], max_model_len: 32768 });
    if (path === "/tokens") return send(200, { tokens: (body.texts as string[]).map((t) => [{ id: 1, text: t }]) });
    if (path === "/cancel") return send(200, { ok: true, busy });
    if (path === "/v1/chat/completions") {
      const id = String(body.model ?? "").replace(/^strain:/, "");
      const pushes = strains.get(id);
      if (!pushes) return send(400, { error: { message: `unknown model ${body.model}` } });
      const last = JSON.stringify(body.messages?.at(-1) ?? "");
      busy = "session";
      if (last.includes("slow")) await new Promise((r) => setTimeout(r, 800));
      busy = null;
      const system = (body.messages as { role: string }[]).some((m) => m.role === "system");
      const text = last.includes("settings") ? JSON.stringify({ settings: settings.get(id), system, thinking: body.chat_template_kwargs?.enable_thinking, temperature: body.temperature, top_p: body.top_p }) : `steered by ${recipe(pushes)}`;
      const usage = { prompt_tokens: 7, completion_tokens: 4, total_tokens: 11 };
      if (!body.stream) return send(200, { id: "x", object: "chat.completion", model: body.model, choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }], usage });
      res.writeHead(200, { "content-type": "text/event-stream" });
      const chunk = (delta: unknown, finish: string | null, extra = {}) => `data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", model: body.model, choices: [{ index: 0, delta, finish_reason: finish }], ...extra })}\n\n`;
      res.write(chunk({ role: "assistant", content: "" }, null));
      res.write(chunk({ content: text }, null));
      res.write(chunk({}, "stop"));
      res.write(`data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", model: body.model, choices: [], usage })}\n\n`);
      res.end("data: [DONE]\n\n");
      return;
    }
    const op = path.slice(1);
    if (!["probe", "find", "neuron", "generate", "sweep", "attribute", "examples", "explore"].includes(op)) return send(404, { error: "not found" });
    if (body.fail) return send(400, { error: "give at least 2 concept texts and 2 control texts" });
    busy = op;
    if (body.slow) await new Promise((r) => setTimeout(r, 400));
    busy = null;
    send(200, { op, body });
  });
});

server.listen(0, "127.0.0.1", () => {
  const port = (server.address() as { port: number }).port;
  process.stdout.write(`${JSON.stringify({ port })}\n`);
  if (mode === "crash") {
    process.stderr.write("fake lab crashed: out of memory\n");
    setTimeout(() => process.exit(3), 50);
  }
});

process.stdin.on("end", () => process.exit(0));
process.stdin.resume();
