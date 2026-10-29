// Fake OpenAI-compatible chat completions server for tests. Each request takes the next scripted reply and
// streams it as SSE (or returns JSON when stream is false). Request bodies are recorded verbatim.

import { createServer, type Server } from "node:http";

export type ScriptedReply =
  | { text: string; reasoning?: string; finish?: "stop" | "length" }
  | { toolCall: { name: string; args: Record<string, unknown> }; text?: string }
  | { status: number; error: string };

export interface FakeOpenAI {
  origin: string; // http://127.0.0.1:<port> (what the gateway's upstream wants)
  baseUrl: string; // origin + /v1
  requests: Record<string, any>[];
  close(): Promise<void>;
}

function chunk(model: string, delta: Record<string, unknown>, finish: string | null, usage?: Record<string, unknown>): string {
  return `data: ${JSON.stringify({ id: "chatcmpl-fake", object: "chat.completion.chunk", created: 1, model, choices: [{ index: 0, delta, finish_reason: finish }], ...(usage ? { usage } : {}) })}\n\n`;
}

export async function startFakeOpenAI(script: ScriptedReply[] | ((body: Record<string, any>, n: number) => ScriptedReply), opts: { promptTokens?: (body: Record<string, any>) => number } = {}): Promise<FakeOpenAI> {
  const requests: Record<string, any>[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      requests.push(body);
      const n = requests.length - 1;
      const reply = typeof script === "function" ? script(body, n) : (script[n] ?? { text: "done" });
      if ("status" in reply) {
        res.writeHead(reply.status, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: reply.error } }));
        return;
      }
      const model = String(body.model ?? "fake");
      const promptTokens = opts.promptTokens?.(body) ?? Math.ceil(JSON.stringify(body.messages ?? []).length / 4);
      const text = "text" in reply ? (reply.text ?? "") : "";
      const completionTokens = Math.max(1, Math.ceil((text.length + ("toolCall" in reply ? JSON.stringify(reply.toolCall.args).length : 0)) / 4));
      const usage = {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: promptTokens + completionTokens,
        time_to_first_token: 0.05,
        prompt_tokens_per_second: 1000,
        generation_tokens_per_second: 50,
        total_time: 0.2,
      };
      const finish = "toolCall" in reply ? "tool_calls" : (reply.finish ?? "stop");
      if (body.stream === false) {
        res.writeHead(200, { "Content-Type": "application/json" });
        const message: Record<string, unknown> = { role: "assistant", content: text || null };
        if ("toolCall" in reply) message.tool_calls = [{ id: `call_${n}`, type: "function", function: { name: reply.toolCall.name, arguments: JSON.stringify(reply.toolCall.args) } }];
        res.end(JSON.stringify({ id: "chatcmpl-fake", object: "chat.completion", created: 1, model, choices: [{ index: 0, message, finish_reason: finish }], usage }));
        return;
      }
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
      res.write(": keepalive\n\n");
      res.write(chunk(model, { role: "assistant", content: "" }, null));
      if ("text" in reply && "reasoning" in reply && reply.reasoning) res.write(chunk(model, { reasoning_content: reply.reasoning }, null));
      if (text) for (const part of text.match(/.{1,8}/gs) ?? []) res.write(chunk(model, { content: part }, null));
      if ("toolCall" in reply) {
        const args = JSON.stringify(reply.toolCall.args);
        res.write(chunk(model, { tool_calls: [{ index: 0, id: `call_${n}`, type: "function", function: { name: reply.toolCall.name, arguments: "" } }] }, null));
        res.write(chunk(model, { tool_calls: [{ index: 0, function: { arguments: args } }] }, null));
      }
      res.write(chunk(model, {}, finish));
      res.write(`data: ${JSON.stringify({ id: "chatcmpl-fake", object: "chat.completion.chunk", created: 1, model, choices: [], usage })}\n\n`);
      res.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return {
    origin: `http://127.0.0.1:${port}`,
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests,
    close: () =>
      new Promise((r) => {
        server.close(() => r());
        server.closeAllConnections();
      }),
  };
}
