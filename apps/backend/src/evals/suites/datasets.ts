// Dataset download + cache. Files come from pinned revisions (evals/datasets.json) and are
// checked against sha256 before anything is written. Cache: data/datasets/<id>/, with a
// manifest.json written last (its presence means the cache is complete).

import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface DatasetFile {
  name: string;
  url: string;
  sha256: string;
  bytes: number;
  extract?: string; // tar archives: keep only regular files under this prefix
}

export interface DatasetMeta {
  id: string;
  title: string;
  description: string;
  dataset: string;
  url: string;
  license: string;
  revision: string;
  envType: "none" | "vm";
  total: number;
  defaultSampleSize: number;
  subjects?: string[];
  files: DatasetFile[];
}

interface Manifest {
  revision: string;
  sources: Record<string, string>; // source file name -> sha256 it was verified against
  files: Record<string, string>; // cached file name -> sha256
}

const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

export async function readDatasetMetas(evalsDir: string): Promise<DatasetMeta[]> {
  const raw = JSON.parse(await readFile(join(evalsDir, "datasets.json"), "utf8")) as { datasets: DatasetMeta[] };
  return raw.datasets;
}

// Cached files if present and intact, else null.
export async function readCachedDataset(meta: DatasetMeta, dataDir: string): Promise<Map<string, Buffer> | null> {
  const dir = join(dataDir, meta.id);
  let manifest: Manifest;
  try {
    manifest = JSON.parse(await readFile(join(dir, "manifest.json"), "utf8")) as Manifest;
  } catch {
    return null;
  }
  if (manifest.revision !== meta.revision) return null;
  if (meta.files.some((f) => manifest.sources[f.name] !== f.sha256)) return null;
  const out = new Map<string, Buffer>();
  for (const [name, hash] of Object.entries(manifest.files)) {
    let buf: Buffer;
    try {
      buf = await readFile(join(dir, name));
    } catch {
      return null;
    }
    if (sha256(buf) !== hash) return null;
    out.set(name, buf);
  }
  return out;
}

const inflight = new Map<string, Promise<Map<string, Buffer>>>();

export function ensureDataset(meta: DatasetMeta, dataDir: string, fetchImpl: typeof fetch = fetch): Promise<Map<string, Buffer>> {
  const key = join(dataDir, meta.id);
  let p = inflight.get(key);
  if (!p) {
    p = (async () => (await readCachedDataset(meta, dataDir)) ?? (await downloadDataset(meta, dataDir, fetchImpl)))();
    inflight.set(key, p);
    p.finally(() => inflight.delete(key)).catch(() => {});
  }
  return p;
}

async function downloadDataset(meta: DatasetMeta, dataDir: string, fetchImpl: typeof fetch): Promise<Map<string, Buffer>> {
  const files = new Map<string, Buffer>();
  for (const f of meta.files) {
    const res = await fetchImpl(f.url, { redirect: "follow", signal: AbortSignal.timeout(15 * 60_000) });
    if (!res.ok || !res.body) throw new Error(`${meta.id}: download failed (${res.status}) ${f.url}`);
    const hash = createHash("sha256");
    const tar = f.extract !== undefined ? new TarExtractor(f.extract) : null;
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      const b = Buffer.from(chunk);
      hash.update(b);
      bytes += b.length;
      if (tar) tar.push(b);
      else chunks.push(b);
    }
    const digest = hash.digest("hex");
    if (digest !== f.sha256 || bytes !== f.bytes) {
      throw new Error(`${meta.id}: ${f.name} sha256/size mismatch (got ${digest}, ${bytes} bytes)`);
    }
    if (tar) for (const [name, buf] of tar.finish()) files.set(name, buf);
    else files.set(f.name, Buffer.concat(chunks));
  }
  const dir = join(dataDir, meta.id);
  await mkdir(dir, { recursive: true });
  const manifest: Manifest = { revision: meta.revision, sources: {}, files: {} };
  for (const f of meta.files) manifest.sources[f.name] = f.sha256;
  for (const [name, buf] of files) {
    await writeFile(join(dir, `${name}.tmp`), buf);
    await rename(join(dir, `${name}.tmp`), join(dir, name));
    manifest.files[name] = sha256(buf);
  }
  await writeFile(join(dir, "manifest.json.tmp"), JSON.stringify(manifest, null, 2));
  await rename(join(dir, "manifest.json.tmp"), join(dir, "manifest.json"));
  return files;
}

// Streaming reader for ustar/GNU tar. Keeps regular files under `prefix` (flattened to their
// path below the prefix); everything else is skipped without buffering.
export class TarExtractor {
  private prefix: string;
  private pending: Buffer[] = [];
  private pendingLen = 0;
  private state: "header" | "body" | "pad" | "end" = "header";
  private remaining = 0;
  private padding = 0;
  private current: { name: string; type: string; keep: Buffer[] | null } | null = null;
  private longName: string | null = null;
  private out = new Map<string, Buffer>();

  constructor(prefix: string) {
    this.prefix = prefix;
  }

  push(chunk: Buffer): void {
    this.pending.push(chunk);
    this.pendingLen += chunk.length;
    this.drain();
  }

  finish(): Map<string, Buffer> {
    if (this.state === "body" || (this.state === "pad" && this.padding > 0)) throw new Error("tar: truncated archive");
    return this.out;
  }

  private take(n: number, collect: Buffer[] | null): number {
    let got = 0;
    while (got < n && this.pending.length) {
      const head = this.pending[0];
      const k = Math.min(n - got, head.length);
      if (collect) collect.push(head.subarray(0, k));
      if (k === head.length) this.pending.shift();
      else this.pending[0] = head.subarray(k);
      got += k;
    }
    this.pendingLen -= got;
    return got;
  }

  private drain(): void {
    for (;;) {
      if (this.state === "end") {
        this.take(this.pendingLen, null);
        return;
      }
      if (this.state === "header") {
        if (this.pendingLen < 512) return;
        const parts: Buffer[] = [];
        this.take(512, parts);
        const h = Buffer.concat(parts);
        if (h.every((b) => b === 0)) {
          this.state = "end";
          continue;
        }
        const str = (s: number, e: number) => {
          const raw = h.subarray(s, e);
          const nul = raw.indexOf(0);
          return raw.subarray(0, nul < 0 ? raw.length : nul).toString("utf8");
        };
        const size = parseInt(str(124, 136).trim() || "0", 8);
        const type = str(156, 157) || "0";
        const ustarPrefix = h.subarray(257, 262).toString() === "ustar" ? str(345, 500) : "";
        let name = ustarPrefix ? `${ustarPrefix}/${str(0, 100)}` : str(0, 100);
        if (this.longName !== null && type !== "L" && type !== "x") {
          name = this.longName;
          this.longName = null;
        }
        const meta = type === "L" || type === "x";
        const wanted = (type === "0" || type === "7") && name.startsWith(this.prefix) && name.length > this.prefix.length;
        this.current = { name, type, keep: wanted || meta ? [] : null };
        this.remaining = size;
        this.padding = (512 - (size % 512)) % 512;
        this.state = "body";
        continue;
      }
      if (this.state === "body") {
        const got = this.take(Math.min(this.remaining, this.pendingLen), this.current?.keep ?? null);
        this.remaining -= got;
        if (this.remaining > 0) return;
        const cur = this.current!;
        if (cur.keep) {
          const data = Buffer.concat(cur.keep);
          if (cur.type === "L") this.longName = data.toString("utf8").replace(/\0+$/, "");
          else if (cur.type === "x") {
            const m = /\d+ path=([^\n]*)\n/.exec(data.toString("utf8"));
            if (m) this.longName = m[1];
          } else this.out.set(cur.name.slice(this.prefix.length), data);
        }
        this.current = null;
        this.state = "pad";
        continue;
      }
      if (this.state === "pad") {
        this.padding -= this.take(Math.min(this.padding, this.pendingLen), null);
        if (this.padding > 0) return;
        this.state = "header";
      }
    }
  }
}

// RFC 4180 CSV: quoted fields, "" escapes, commas and newlines inside quotes, LF or CRLF.
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}
