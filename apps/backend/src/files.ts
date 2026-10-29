// File tree and file content for the UI: live from the env, or at a past event seq of a session (time travel)
// from the stored manifests and content-addressed blobs.

import { posix } from "node:path";
import type { FileContent, FileNode } from "@terrarium/shared";
import type { EnvManager } from "./envs/manager.ts";
import { manifestTree } from "./envs/manifest-diff.ts";
import type { EnvRuntime, Manifest } from "./envs/types.ts";
import { isBinary, MAX_CAPTURE_BYTES } from "./harness/observer.ts";
import type { Store } from "./store/db.ts";
import { HttpError } from "./util/errors.ts";

export interface AtOpts {
  at?: number;
  sessionId?: string;
}

export function cleanEnvPath(p: unknown): string {
  if (typeof p !== "string" || !p || p.includes("\0")) throw new HttpError(400, "path is required");
  const abs = posix.normalize(p.startsWith("/") ? p : `/workspace/${p}`);
  return abs.length > 1 ? abs.replace(/\/$/, "") : abs;
}

export class FileViews {
  private store: Store;
  private envs: EnvManager;

  constructor(opts: { store: Store; envs: EnvManager }) {
    this.store = opts.store;
    this.envs = opts.envs;
  }

  private manifestBlob(blob: string | undefined): Manifest | null {
    return blob ? this.store.blobs.getJson<Manifest>(blob) : null;
  }

  private baseline(envId: string, sessionId: string | undefined): Manifest | null {
    if (!sessionId) return null;
    const r = this.store.get<{ blob: string }>("SELECT blob FROM manifests WHERE session_id = ? AND env_id = ? ORDER BY seq ASC LIMIT 1", sessionId, envId);
    return this.manifestBlob(r?.blob);
  }

  private at(envId: string, sessionId: string, seq: number): Manifest | null {
    const r =
      this.store.get<{ blob: string }>("SELECT blob FROM manifests WHERE session_id = ? AND env_id = ? AND seq <= ? ORDER BY seq DESC LIMIT 1", sessionId, envId, seq) ??
      this.store.get<{ blob: string }>("SELECT blob FROM manifests WHERE session_id = ? AND env_id = ? ORDER BY seq ASC LIMIT 1", sessionId, envId);
    return this.manifestBlob(r?.blob);
  }

  private latestStored(envId: string): Manifest | null {
    const r = this.store.get<{ blob: string }>("SELECT blob FROM manifests WHERE env_id = ? ORDER BY created_at DESC, seq DESC LIMIT 1", envId);
    return this.manifestBlob(r?.blob);
  }

  /** Running runtime; simulated envs are cheap, so they start on demand for viewing. VMs never do. */
  private async liveRuntime(envId: string): Promise<EnvRuntime | null> {
    const env = this.envs.get(envId);
    let rt = await this.envs.inspect(envId);
    if (!rt && env.type === "sim" && env.status !== "error") {
      try {
        await this.envs.start(envId);
        rt = await this.envs.inspect(envId);
      } catch {
        rt = null; // released eval env or broken storage: fall back to stored manifests
      }
    }
    return rt;
  }

  async tree(envId: string, opts: AtOpts): Promise<FileNode> {
    this.envs.get(envId);
    if (opts.sessionId && opts.at !== undefined) {
      const m = this.at(envId, opts.sessionId, opts.at);
      if (m) return manifestTree(m, this.baseline(envId, opts.sessionId));
    }
    const baseline = this.baseline(envId, opts.sessionId);
    const rt = await this.liveRuntime(envId);
    if (rt) {
      const cached = this.envs.cachedManifest(envId);
      const m = await rt.manifest("/workspace", cached ? { previous: cached.manifest } : undefined);
      return manifestTree(m, baseline);
    }
    const stored = this.latestStored(envId);
    if (stored) return manifestTree(stored, baseline);
    return { path: "/workspace", name: "workspace", type: "dir", children: [] };
  }

  private fromBlob(path: string, sha: string | undefined, size: number, at?: number): FileContent {
    const data = sha ? this.store.blobs.get(sha) : null;
    if (!data) return { path, ...(at !== undefined ? { at } : {}), binary: false, size, ...(sha ? { sha256: sha } : {}), truncated: true };
    const binary = isBinary(data);
    return { path, ...(at !== undefined ? { at } : {}), ...(binary ? {} : { content: data.toString("utf8") }), binary, size, sha256: sha, truncated: false };
  }

  async file(envId: string, rawPath: unknown, opts: AtOpts): Promise<FileContent> {
    this.envs.get(envId);
    const path = cleanEnvPath(rawPath);
    if (opts.sessionId && opts.at !== undefined) {
      const m = this.at(envId, opts.sessionId, opts.at);
      if (m) {
        const e = m.entries.find((x) => x.path === path);
        if (!e) throw new HttpError(404, `${path} did not exist at seq ${opts.at}`);
        if (e.type !== "file") throw new HttpError(400, `${path} is a ${e.type}`);
        return this.fromBlob(path, e.sha256, e.size, opts.at);
      }
    }
    const rt = await this.liveRuntime(envId);
    if (rt) {
      let r;
      try {
        r = await rt.readFile(path, { maxBytes: MAX_CAPTURE_BYTES, as: "root" });
      } catch (err) {
        throw new HttpError(404, `${path}: ${(err as Error).message}`);
      }
      const data = Buffer.from(r.data);
      const binary = isBinary(r.truncated ? data.subarray(0, 8192) : data);
      return { path, ...(binary ? {} : { content: data.toString("utf8") }), binary, size: r.size, truncated: r.truncated };
    }
    const stored = this.latestStored(envId);
    const e = stored?.entries.find((x) => x.path === path);
    if (!e) throw new HttpError(404, `${path}: environment is stopped and no stored copy exists`);
    if (e.type !== "file") throw new HttpError(400, `${path} is a ${e.type}`);
    return this.fromBlob(path, e.sha256, e.size);
  }
}
