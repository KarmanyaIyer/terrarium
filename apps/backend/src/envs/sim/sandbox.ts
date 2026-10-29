// sandbox-exec profile for just-bash workers: deny all network, deny all file writes, deny reads under the
// home folder except the backend code, the workspace node_modules store and the node install.

import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, sep } from "node:path";
import { BACKEND_DIR, REPO_DIR } from "../../config.ts";

export const SANDBOX_EXEC = "/usr/bin/sandbox-exec";

function q(path: string): string {
  return `"${path.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function ancestors(path: string): string[] {
  const out: string[] = [];
  let p = dirname(path);
  while (p && p !== dirname(p)) {
    out.push(p);
    p = dirname(p);
  }
  return out;
}

export function nodeExecutable(): string {
  return realpathSync(process.execPath);
}

/** Directories the worker may read under $HOME. */
export function readableDirs(): string[] {
  const dirs = [realpathSync(BACKEND_DIR)];
  const nm = join(REPO_DIR, "node_modules");
  if (existsSync(nm)) dirs.push(realpathSync(nm));
  const shared = join(REPO_DIR, "packages", "shared");
  if (existsSync(shared)) dirs.push(realpathSync(shared));
  const nodeBin = nodeExecutable();
  // e.g. ~/.local/share/mise/installs/node/24.18.0/bin/node -> allow the install prefix
  dirs.push(dirname(dirname(nodeBin)));
  return [...new Set(dirs)];
}

export function buildProfile(home = realpathSync(homedir())): string {
  const readable = readableDirs();
  const metadata = new Set<string>();
  for (const d of readable) for (const a of ancestors(d)) metadata.add(a);
  const nodeBin = nodeExecutable();
  const lines = [
    "(version 1)",
    "(allow default)",
    "(deny network*)",
    "(deny file-write*)",
    '(allow file-write-data (literal "/dev/null"))',
    "(deny process-exec*)",
    `(allow process-exec* (literal ${q(nodeBin)}))`,
    `(deny file-read* (subpath ${q(home)}))`,
    ...readable.filter((d) => d === home || d.startsWith(home + sep)).map((d) => `(allow file-read* (subpath ${q(d)}))`),
    // Node resolves real paths: let it stat the parents of allowed dirs (metadata only, no listing or content).
    ...[...metadata].filter((d) => d === home || d.startsWith(home + sep)).map((d) => `(allow file-read-metadata (literal ${q(d)}))`),
  ];
  return lines.join("\n");
}
