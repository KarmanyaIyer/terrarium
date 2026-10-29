// oMLX process manager + admin client. oMLX runs on 127.0.0.1 with a random API key known only to the backend,
// through scripts/omlx_serve.py, which allowlists the routes below and blocks the rest (MCP, web, benchmarks).

import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import type { InferenceState } from "@terrarium/shared";
import { BACKEND_DIR, VERSIONS } from "../config.ts";
import { errorMessage } from "../util/errors.ts";
import { logger } from "../util/log.ts";

const log = logger("omlx");

export interface OmlxModelStatus {
  id: string;
  loaded: boolean;
  is_loading: boolean;
  estimated_size?: number;
  actual_size?: number | null;
  model_context_length?: number;
  max_context_window?: number | null;
  max_tokens?: number | null;
  thinking_default?: boolean;
  model_type?: string;
  config_model_type?: string;
}

export interface OmlxStatus {
  final_ceiling?: number;
  current_model_memory?: number;
  loaded_count?: number;
  models: OmlxModelStatus[];
}

export interface OmlxModelSettings {
  model_type_override?: "llm" | "vlm";
  max_context_window?: number;
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  top_k?: number;
  presence_penalty?: number;
}

export interface OmlxOptions {
  venvDir: string;
  modelsDir: string;
  dataDir: string; // data/omlx
  budgetBytes: () => number;
  onState: (state: InferenceState) => void;
}

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as { port: number }).port;
      srv.close(() => resolve(port));
    });
  });
}

export class OmlxManager {
  private opts: OmlxOptions;
  private child: ChildProcess | null = null;
  private port = 0;
  private apiKey = "";
  private starting: Promise<void> | null = null;
  private tail: string[] = [];
  state: InferenceState = { status: "stopped", version: VERSIONS.omlx };

  constructor(opts: OmlxOptions) {
    this.opts = opts;
  }

  get baseUrl(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  get key(): string {
    return this.apiKey;
  }

  get pid(): number | undefined {
    return this.child?.pid;
  }

  isReady(): boolean {
    return this.state.status === "ready";
  }

  private setState(patch: Partial<InferenceState>): void {
    this.state = { ...this.state, ...patch, version: VERSIONS.omlx, pid: this.child?.pid };
    this.opts.onState(this.state);
  }

  installed(): boolean {
    return existsSync(join(this.opts.venvDir, "bin", "python")) && existsSync(join(this.opts.venvDir, "bin", "omlx"));
  }

  /** Starts oMLX if needed and resolves when /health answers. Concurrent callers share one start. */
  ensureStarted(): Promise<void> {
    if (this.state.status === "ready") return Promise.resolve();
    if (!this.starting) {
      this.starting = this.start().finally(() => {
        this.starting = null;
      });
    }
    return this.starting;
  }

  private async start(): Promise<void> {
    if (!this.installed()) {
      this.setState({ status: "error", detail: `oMLX not installed in ${this.opts.venvDir} (see apps/backend/README.md)` });
      throw new Error(this.state.detail);
    }
    this.port = await freePort();
    this.apiKey = randomBytes(24).toString("hex");
    const budgetGb = Math.max(4, Math.round((this.opts.budgetBytes() / 1e9) * 10) / 10);
    mkdirSync(join(this.opts.dataDir, "cache"), { recursive: true });
    const args = [
      "-I",
      join(BACKEND_DIR, "scripts", "omlx_serve.py"),
      "--model-dir", this.opts.modelsDir,
      "--host", "127.0.0.1",
      "--port", String(this.port),
      "--api-key", this.apiKey,
      "--base-path", this.opts.dataDir,
      "--no-hf-cache",
      "--memory-guard-gb", String(budgetGb),
      "--sse-keepalive-mode", "comment",
      "--paged-ssd-cache-dir", join(this.opts.dataDir, "cache"),
      "--paged-ssd-cache-max-size", "4GB",
    ];
    this.setState({ status: "starting", detail: undefined, memoryCeilingBytes: budgetGb * 1e9 });
    const logFile = createWriteStream(join(this.opts.dataDir, "server.log"), { flags: "a" });
    const child = spawn(join(this.opts.venvDir, "bin", "python"), args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HOME: process.env.HOME ?? "", TMPDIR: process.env.TMPDIR ?? "/tmp", LANG: "en_US.UTF-8", OMLX_HEADLESS: "1", HF_HUB_OFFLINE: "1", HF_HUB_DISABLE_TELEMETRY: "1" },
    });
    this.child = child;
    const onData = (buf: Buffer) => {
      logFile.write(buf);
      for (const line of buf.toString("utf8").split("\n")) {
        if (!line.trim()) continue;
        this.tail.push(line.slice(0, 500));
        if (this.tail.length > 40) this.tail.shift();
      }
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.on("exit", (code, signal) => {
      logFile.end();
      if (this.child !== child) return;
      this.child = null;
      const expected = this.state.status === "stopping";
      log[expected ? "info" : "warn"](`oMLX exited code=${code} signal=${signal}`);
      this.setState(expected ? { status: "stopped", detail: undefined, rssBytes: undefined } : { status: "error", detail: `oMLX exited (code ${code ?? signal}): ${this.tail.slice(-3).join(" | ")}` });
    });
    const deadline = Date.now() + 180_000;
    while (Date.now() < deadline) {
      if (this.child !== child) throw new Error(this.state.detail || "oMLX exited during startup");
      try {
        const res = await fetch(`${this.baseUrl}/health`, { signal: AbortSignal.timeout(1000) });
        if (res.ok) {
          log.info(`oMLX ready on port ${this.port} (pid ${child.pid})`);
          this.setState({ status: "ready", detail: undefined });
          return;
        }
      } catch {
        // not listening yet
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    await this.stop();
    this.setState({ status: "error", detail: "oMLX did not become healthy within 180 s" });
    throw new Error(this.state.detail);
  }

  async stop(): Promise<void> {
    const child = this.child;
    if (!child) {
      if (this.state.status !== "stopped") this.setState({ status: "stopped", detail: undefined });
      return;
    }
    this.setState({ status: "stopping" });
    const exited = new Promise<void>((r) => child.once("exit", () => r()));
    child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
    await exited;
    clearTimeout(timer);
  }

  async request<T = unknown>(method: string, path: string, body?: unknown, timeoutMs = 30_000): Promise<T> {
    if (!this.isReady()) throw new Error("inference server is not running");
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: { authorization: `Bearer ${this.apiKey}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    if (!res.ok) {
      let detail = text.slice(0, 500);
      try {
        detail = JSON.parse(text).detail ?? detail;
      } catch {}
      throw new Error(`oMLX ${method} ${path} -> ${res.status}: ${typeof detail === "string" ? detail : JSON.stringify(detail)}`);
    }
    return (text ? JSON.parse(text) : {}) as T;
  }

  status(): Promise<OmlxStatus> {
    return this.request<OmlxStatus>("GET", "/v1/models/status", undefined, 5000);
  }

  async load(modelId: string): Promise<void> {
    await this.request("POST", `/v1/models/${encodeURIComponent(modelId)}/load`, undefined, 600_000);
  }

  async unload(modelId: string): Promise<void> {
    try {
      await this.request("POST", `/v1/models/${encodeURIComponent(modelId)}/unload`, undefined, 60_000);
    } catch (err) {
      if (!/not loaded/i.test(errorMessage(err))) throw err;
    }
  }

  applySettings(modelId: string, settings: OmlxModelSettings): Promise<unknown> {
    return this.request("PUT", `/admin/api/models/${encodeURIComponent(modelId)}/settings`, settings, 10_000);
  }
}
