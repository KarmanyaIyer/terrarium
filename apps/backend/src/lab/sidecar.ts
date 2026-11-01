// One Lab sidecar process: scripts/lab_serve.py with one model loaded and neuron hooks on every layer. Like oMLX it
// listens on 127.0.0.1 behind a random per-launch key, and reads EOF on a stdin pipe we never write to, so it exits
// when the backend dies however it dies. One process per specimen: unloading the model is stopping the process.

import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createWriteStream, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { LabModelFacts } from "@terrarium/shared";
import { Agent, fetch as undiciFetch } from "undici";
import { BACKEND_DIR } from "../config.ts";
import { logger } from "../util/log.ts";

const log = logger("lab");

/** Lab ops send nothing until they finish: no header or body timeouts (Node's fetch cuts off at 5 min); request()'s own timeout applies. */
const agent = new Agent({ headersTimeout: 0, bodyTimeout: 0 });

/** The process prints its port before loading the model; this long without it means it hung starting Python. */
const STARTUP_TIMEOUT_MS = 180_000;

export interface LabHealth {
  status: "loading" | "ready" | "error";
  stage: string;
  progress: number;
  busy: string | null;
  activeBytes: number;
  peakBytes: number;
  detail?: string;
  facts?: Omit<LabModelFacts, "name">;
  strains?: string[];
}

export interface SidecarOptions {
  modelId: string;
  venvDir: string;
  modelsDir: string;
  dataDir: string; // data/lab: calibration cache and sidecar.log
  /** Tests: run this instead of the venv's python with lab_serve.py (same protocol). */
  command?: { cmd: string; args: string[] };
}

/** Error from the sidecar with its HTTP status (400: a request the Lab can't serve, 409: not ready). */
export class SidecarError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export class LabSidecar {
  readonly modelId: string;
  private opts: SidecarOptions;
  private child: ChildProcess | null = null;
  private port = 0;
  private apiKey = randomBytes(24).toString("hex");
  private tail: string[] = [];
  private stopping = false;
  /** Called once when the process exits; detail is undefined when it was stopped on purpose. */
  onExit: (detail: string | undefined) => void = () => {};

  constructor(opts: SidecarOptions) {
    this.opts = opts;
    this.modelId = opts.modelId;
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

  get running(): boolean {
    return this.child !== null;
  }

  /** Last lines the process printed, for error messages. */
  lastLines(n = 3): string {
    return this.tail.slice(-n).join(" | ");
  }

  /** Spawns the process and resolves with its port once it prints it. Loading the model continues in the background. */
  spawn(): Promise<void> {
    const dataDir = this.opts.dataDir;
    mkdirSync(join(dataDir, "cache"), { recursive: true, mode: 0o700 });
    const cmd = this.opts.command ?? {
      cmd: join(this.opts.venvDir, "bin", "python"),
      args: ["-I", join(BACKEND_DIR, "scripts", "lab_serve.py"), "--model-dir", join(this.opts.modelsDir, this.modelId), "--cache-dir", join(dataDir, "cache"), "--port", "0"],
    };
    const logFile = createWriteStream(join(dataDir, "sidecar.log"), { flags: "a" });
    logFile.write(`\n--- ${new Date().toISOString()} ${this.modelId}\n`);
    const child = spawn(cmd.cmd, cmd.args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HOME: process.env.HOME ?? "", TMPDIR: process.env.TMPDIR ?? "/tmp", LANG: "en_US.UTF-8", HF_HUB_OFFLINE: "1", HF_HUB_DISABLE_TELEMETRY: "1", TERRARIUM_PARENT_STDIN: "1", TERRARIUM_LAB_KEY: this.apiKey },
    });
    child.stdin?.on("error", () => {}); // EPIPE once it is gone; nothing is ever written
    this.child = child;
    return new Promise((resolve, reject) => {
      let pending = "";
      let gotPort = false;
      let exited = false;
      const keep = (line: string) => {
        if (!line.trim()) return;
        this.tail.push(line.slice(0, 500));
        if (this.tail.length > 40) this.tail.shift();
      };
      const startup = setTimeout(() => {
        keep(`no port after ${STARTUP_TIMEOUT_MS / 1000} s`);
        child.kill("SIGKILL");
      }, STARTUP_TIMEOUT_MS);
      const finish = (detail: string | undefined) => {
        if (exited) return;
        exited = true;
        clearTimeout(startup);
        logFile.end();
        if (this.child === child) this.child = null;
        if (!gotPort) reject(new Error(detail ?? "Lab process stopped during startup"));
        this.onExit(detail);
      };
      child.stdout?.on("data", (buf: Buffer) => {
        logFile.write(buf);
        pending += buf.toString("utf8");
        let nl: number;
        while ((nl = pending.indexOf("\n")) >= 0) {
          const line = pending.slice(0, nl);
          pending = pending.slice(nl + 1);
          if (!gotPort) {
            try {
              const port = (JSON.parse(line) as { port?: unknown }).port;
              if (typeof port === "number" && port > 0) {
                gotPort = true;
                clearTimeout(startup);
                this.port = port;
                log.info(`Lab sidecar for ${this.modelId} on port ${port} (pid ${child.pid})`);
                resolve();
                continue;
              }
            } catch {}
          }
          keep(line);
        }
      });
      child.stderr?.on("data", (buf: Buffer) => {
        logFile.write(buf);
        for (const line of buf.toString("utf8").split("\n")) keep(line);
      });
      child.on("error", (err) => {
        keep(`spawn failed: ${err.message}`);
        // a failed spawn (python missing) emits error and close, never exit
        if (child.pid === undefined) {
          log.warn(`Lab sidecar failed to start: ${err.message}`);
          finish(`Could not start the Lab's Python (${cmd.cmd}): ${err.message}. Set up the repo's .venv first.`);
        }
      });
      child.on("exit", (code, signal) => {
        const expected = this.stopping;
        log[expected ? "info" : "warn"](`Lab sidecar exited code=${code} signal=${signal}`);
        finish(expected ? undefined : `Lab process exited (${code ?? signal}): ${this.lastLines() || "no output"}`);
      });
    });
  }

  async health(timeoutMs = 2000): Promise<LabHealth> {
    return this.request<LabHealth>("GET", "/health", undefined, timeoutMs);
  }

  async request<T>(method: string, path: string, body?: unknown, timeoutMs = 600_000, signal?: AbortSignal): Promise<T> {
    if (!this.child || !this.port) throw new SidecarError(409, "the Lab is not running");
    const timeout = AbortSignal.timeout(timeoutMs);
    let res: Awaited<ReturnType<typeof undiciFetch>>;
    try {
      res = await undiciFetch(`${this.baseUrl}${path}`, {
        method,
        headers: { authorization: `Bearer ${this.apiKey}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
        dispatcher: agent,
      });
    } catch (err) {
      if (timeout.aborted) throw new SidecarError(504, `the Lab did not answer within ${Math.round(timeoutMs / 1000)} s`);
      throw new SidecarError(502, `the Lab is unreachable: ${err instanceof Error ? err.message : String(err)}`);
    }
    const text = await res.text();
    let json: any = undefined;
    try {
      json = text ? JSON.parse(text) : {};
    } catch {}
    if (!res.ok) {
      const msg = typeof json?.error === "string" ? json.error : (json?.error?.message ?? text.slice(0, 500));
      throw new SidecarError(res.status, msg || `Lab returned ${res.status}`);
    }
    if (json === undefined) throw new SidecarError(502, "invalid JSON from the Lab");
    return json as T;
  }

  async stop(): Promise<void> {
    const child = this.child;
    if (!child) return;
    this.stopping = true;
    const exited = new Promise<void>((r) => child.once("exit", () => r()));
    child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 5_000);
    await exited;
    clearTimeout(timer);
  }
}
