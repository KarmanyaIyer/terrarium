// Add and remove models. Hugging Face lookups and downloads run in a separate host process (scripts/hf_model.py
// with the .venv's huggingface_hub) that has network; oMLX itself stays offline (HF_HUB_OFFLINE=1). A download
// lands in data/downloads/<id>/ and moves into models/ when complete, then oMLX re-scans its model dir.

import { type ChildProcess, execFile, spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, renameSync, rmSync, statfsSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ModelCheck, ModelDownload, ModelSuggestion, RemoveModelResult } from "@terrarium/shared";
import { BACKEND_DIR } from "../config.ts";
import type { Hub } from "../hub.ts";
import { HttpError } from "../util/errors.ts";
import { newId } from "../util/ids.ts";
import { logger } from "../util/log.ts";
import type { InferenceService } from "./service.ts";
import { ensureVendoredModels } from "./vendor.ts";
import type { ResourceBudgets } from "../resource-budgets.ts";

const log = logger("downloads");
const REPO_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}\/[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/;
const INSPECT_TIMEOUT_MS = 60_000;
/** Disk left free after a download, so the Mac doesn't run out. */
const DISK_MARGIN = 5e9;

export const SUGGESTIONS: ModelSuggestion[] = [
  {
    repo: "mlx-community/Qwen3.5-4B-MLX-4bit",
    name: "Qwen3.5 4B",
    params: "4B",
    note: "Good first model, runs the Lab's example",
    sizeBytes: 3_061_215_232,
  },
  {
    repo: "LiquidAI/LFM3-1.7B-MLX-8bit",
    name: "LFM3 1.7B",
    params: "1.7B",
    note: "Smaller, and strong with tools",
    detail: "Vendor BFCL v4 71.4 (Qwen3.5 4B: 55.1), IFEval 96.7, GPQA Diamond 63.4 (Qwen3.5 4B: 75.8); 256K context. 8bit: the 4bit build picks a different top token about 1 time in 5",
    sizeBytes: 1_855_280_680,
    released: "2026-10-27",
  },
  { repo: "mlx-community/Qwen3.5-2B-4bit", name: "Qwen3.5 2B", params: "2B", note: "Smallest Qwen3.5", sizeBytes: 1_749_080_357 },
  { repo: "mlx-community/gemma-4-e2b-it-4bit", name: "Gemma 4 E2B", params: "E2B", note: "Gemma 4, on-device size", sizeBytes: 3_583_087_091 },
  { repo: "mlx-community/gemma-4-e4b-it-4bit", name: "Gemma 4 E4B", params: "E4B", note: "Gemma 4, larger", sizeBytes: 5_179_239_942 },
];

export function validRepo(repo: unknown): string {
  const r = typeof repo === "string" ? repo.trim().replace(/^https?:\/\/huggingface\.co\//, "").replace(/\/+$/, "") : "";
  if (!REPO_RE.test(r)) throw new HttpError(400, "repo must be a Hugging Face model id like owner/name");
  return r;
}

/** Free space on the disk a path will live on. models/ doesn't exist until the first download, so walk up to what does. */
export function freeDisk(path: string): number {
  for (let at = path; ; at = dirname(at)) {
    try {
      const st = statfsSync(at);
      return st.bavail * st.bsize;
    } catch {
      if (at === dirname(at)) return 0;
    }
  }
}

function dirBytes(path: string): Promise<number> {
  return new Promise((resolve) =>
    execFile("/usr/bin/du", ["-sk", path], { timeout: 30_000 }, (_e, out) => resolve(Number(/^(\d+)/.exec(String(out ?? ""))?.[1] ?? 0) * 1024)),
  );
}

interface Running {
  download: ModelDownload;
  child: ChildProcess;
  dir: string;
}

export class ModelDownloads {
  private hub: Hub;
  private inference: InferenceService;
  private venvDir: string;
  private modelsDir: string;
  private workDir: string;
  private budgets?: ResourceBudgets;
  private all = new Map<string, ModelDownload>();
  private running = new Map<string, Running>();
  /** Model ids in use by a running session or eval; removal refuses those. */
  inUse: (modelId: string) => string | undefined = () => undefined;

  constructor(opts: { hub: Hub; inference: InferenceService; venvDir: string; modelsDir: string; dataDir: string; budgets?: ResourceBudgets }) {
    this.hub = opts.hub;
    this.inference = opts.inference;
    this.venvDir = opts.venvDir;
    this.modelsDir = opts.modelsDir;
    this.workDir = join(opts.dataDir, "downloads");
    this.budgets = opts.budgets;
    // Leftovers from a download the backend didn't see finish.
    rmSync(this.workDir, { recursive: true, force: true });
  }

  suggestions(): ModelSuggestion[] {
    return SUGGESTIONS;
  }

  list(): ModelDownload[] {
    return [...this.all.values()].sort((a, b) => b.startedAt - a.startedAt);
  }

  private env(): NodeJS.ProcessEnv {
    return { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HOME: process.env.HOME ?? "", TMPDIR: process.env.TMPDIR ?? "/tmp", LANG: "en_US.UTF-8", HF_HUB_DISABLE_TELEMETRY: "1" };
  }

  private helper(args: string[]): ChildProcess {
    return spawn(join(this.venvDir, "bin", "python"), ["-I", join(BACKEND_DIR, "scripts", "hf_model.py"), ...args], { stdio: ["ignore", "pipe", "pipe"], env: this.env() });
  }

  async inspect(repoIn: unknown): Promise<ModelCheck> {
    const repo = validRepo(repoIn);
    if (!existsSync(join(this.venvDir, "bin", "python"))) throw new HttpError(503, `no Python in ${this.venvDir}`);
    ensureVendoredModels(this.venvDir); // the check below looks for mlx_lm/models/<type>.py
    const line = await new Promise<string>((resolve, reject) => {
      const child = this.helper(["inspect", repo]);
      let out = "";
      const timer = setTimeout(() => child.kill("SIGKILL"), INSPECT_TIMEOUT_MS);
      child.stdout!.on("data", (b: Buffer) => (out += b.toString("utf8")));
      child.stderr!.on("data", () => {});
      child.on("error", reject);
      child.on("close", () => {
        clearTimeout(timer);
        resolve(out.trim().split("\n").pop() ?? "");
      });
    });
    let res: any;
    try {
      res = JSON.parse(line);
    } catch {
      throw new HttpError(502, "Hugging Face lookup failed (no answer within 60 s or no network)");
    }
    if (res.error) throw new HttpError(502, res.error);
    const dirName = repo.split("/")[1]!;
    const installed = existsSync(join(this.modelsDir, dirName));
    const free = freeDisk(this.modelsDir);
    const problems: string[] = [...res.problems];
    const reserve = this.budgets?.get().hostFreeDiskReserveBytes ?? DISK_MARGIN;
    if (res.totalBytes + reserve > free) problems.push(`Needs ${(res.totalBytes / 1e9).toFixed(1)} GB plus ${(reserve / 1e9).toFixed(1)} GB reserved; ${(free / 1e9).toFixed(1)} GB free`);
    return {
      repo,
      dirName,
      installed,
      totalBytes: res.totalBytes,
      files: res.files,
      ...(res.modelType ? { modelType: res.modelType } : {}),
      ...(res.loader ? { loader: res.loader } : {}),
      mlx: res.mlx,
      ...(res.quant ? { quant: res.quant } : {}),
      ...(res.contextLength ? { contextLength: res.contextLength } : {}),
      ok: problems.length === 0 && !installed,
      problems,
      freeDiskBytes: free,
      versions: res.versions,
    };
  }

  async start(repoIn: unknown): Promise<ModelDownload> {
    const check = await this.inspect(repoIn);
    if (check.installed) throw new HttpError(409, `models/${check.dirName} already exists`);
    if (!check.ok) throw new HttpError(400, check.problems.join("; "));
    if ([...this.running.values()].some((r) => r.download.repo === check.repo)) throw new HttpError(409, `${check.repo} is already downloading`);
    const id = newId("dl");
    const dir = join(this.workDir, id);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const download: ModelDownload = { id, repo: check.repo, dirName: check.dirName, status: "running", bytesDone: 0, bytesTotal: check.totalBytes, startedAt: Date.now() };
    const child = this.helper(["download", check.repo, dir]);
    const run: Running = { download, child, dir };
    this.all.set(id, download);
    this.running.set(id, run);
    let buf = "";
    let lastError = "";
    let lastPush = 0;
    child.stdout!.on("data", (b: Buffer) => {
      buf += b.toString("utf8");
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        try {
          const msg = JSON.parse(line);
          if (typeof msg.n === "number") download.bytesDone = Math.min(msg.n, download.bytesTotal);
          if (msg.error) lastError = String(msg.error);
        } catch {}
      }
      if (Date.now() - lastPush > 500) {
        lastPush = Date.now();
        const reserve = this.budgets?.get().hostFreeDiskReserveBytes ?? DISK_MARGIN;
        if (freeDisk(this.workDir) < reserve && !lastError) {
          lastError = "Host disk reserve reached. Model download stopped.";
          child.kill("SIGTERM");
        }
        this.push(download);
      }
    });
    child.stderr!.on("data", () => {});
    child.on("close", (code) => void this.finish(run, code === 0 && !lastError ? null : lastError || `download exited with code ${code}`));
    this.push(download);
    log.info(`download ${id} ${check.repo} (${check.totalBytes} bytes)`);
    return download;
  }

  private push(d: ModelDownload): void {
    this.hub.broadcast({ type: "model_download", download: { ...d } });
  }

  private async finish(run: Running, error: string | null): Promise<void> {
    const d = run.download;
    this.running.delete(d.id);
    if (d.status === "canceled") {
      rmSync(run.dir, { recursive: true, force: true });
      return;
    }
    const target = join(this.modelsDir, d.dirName);
    try {
      if (error) throw new Error(error);
      if (existsSync(target)) throw new Error(`models/${d.dirName} appeared during the download`);
      rmSync(join(run.dir, ".cache"), { recursive: true, force: true });
      mkdirSync(this.modelsDir, { recursive: true }); // a fresh install has no models/ yet
      try {
        renameSync(run.dir, target);
      } catch {
        cpSync(run.dir, target, { recursive: true }); // models/ on another volume
      }
      d.status = "done";
      d.bytesDone = d.bytesTotal;
      await this.inference.rescan();
    } catch (err) {
      d.status = "error";
      d.error = err instanceof Error ? err.message : String(err);
      log.warn(`download ${d.id} failed: ${d.error}`);
    }
    rmSync(run.dir, { recursive: true, force: true });
    d.finishedAt = Date.now();
    this.push(d);
  }

  cancel(id: string): ModelDownload {
    const run = this.running.get(id);
    const d = run?.download ?? this.all.get(id);
    if (!d) throw new HttpError(404, `download not found: ${id}`);
    if (!run) return d;
    d.status = "canceled";
    d.finishedAt = Date.now();
    run.child.kill("SIGTERM");
    this.push(d);
    return d;
  }

  cancelAll(): void {
    for (const id of [...this.running.keys()]) this.cancel(id);
  }

  async remove(modelId: string): Promise<RemoveModelResult> {
    if (!this.inference.catalog.ids().includes(modelId)) throw new HttpError(404, `model not found: ${modelId}`);
    const busy = this.inUse(modelId);
    if (busy) throw new HttpError(409, `${modelId} is in use (${busy}); stop it first`);
    const model = await this.inference.model(modelId);
    if (model?.loaded) await this.inference.unload(modelId);
    const dir = join(this.modelsDir, modelId);
    const freedBytes = await dirBytes(dir);
    rmSync(dir, { recursive: true, force: true });
    await this.inference.rescan();
    log.info(`removed model ${modelId} (${freedBytes} bytes)`);
    return { freedBytes };
  }
}
