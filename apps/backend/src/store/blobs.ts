// Content-addressed blob store: data/blobs/<sha256[0:2]>/<sha256>. Writes are atomic (tmp + rename).

import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const SHA_RE = /^[0-9a-f]{64}$/;

export function sha256(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

export class BlobStore {
  readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
    mkdirSync(dir, { recursive: true });
  }

  private pathFor(sha: string): string {
    if (!SHA_RE.test(sha)) throw new Error(`invalid blob id: ${sha.slice(0, 80)}`);
    return join(this.dir, sha.slice(0, 2), sha);
  }

  put(data: string | Uint8Array): string {
    const bytes = typeof data === "string" ? Buffer.from(data, "utf8") : data;
    const sha = sha256(bytes);
    const path = this.pathFor(sha);
    if (!existsSync(path)) {
      mkdirSync(join(this.dir, sha.slice(0, 2)), { recursive: true });
      const tmp = `${path}.${randomBytes(4).toString("hex")}.tmp`;
      writeFileSync(tmp, bytes, { mode: 0o600 });
      renameSync(tmp, path);
    }
    return sha;
  }

  putJson(value: unknown): string {
    return this.put(JSON.stringify(value));
  }

  has(sha: string): boolean {
    return SHA_RE.test(sha) && existsSync(this.pathFor(sha));
  }

  get(sha: string): Buffer | null {
    if (!this.has(sha)) return null;
    return readFileSync(this.pathFor(sha));
  }

  getText(sha: string): string | null {
    const buf = this.get(sha);
    return buf ? buf.toString("utf8") : null;
  }

  getJson<T = unknown>(sha: string): T | null {
    const text = this.getText(sha);
    return text === null ? null : (JSON.parse(text) as T);
  }

  size(sha: string): number | null {
    return this.has(sha) ? statSync(this.pathFor(sha)).size : null;
  }
}
