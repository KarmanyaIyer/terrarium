// sandbox-exec profile for just-bash workers. Everything is denied by default; the worker may exec only the
// node binary, read the backend code, the workspace node_modules store, the node install and the system
// libraries node loads, write only /dev/null, and signal or inspect only itself. No network, no Mach or XPC
// services, no other processes, no IOKit, no files under $HOME beyond the code it runs.

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

/** What node itself reads at startup: the dyld shared cache, system libraries and a few device files. */
const SYSTEM_READS = [
  "(literal \"/\")", // the worker's cwd; node opens it at startup (lists top-level names only)
  "(subpath \"/usr/lib\")",
  "(subpath \"/usr/share/icu\")",
  "(subpath \"/System/Library\")",
  "(subpath \"/System/Volumes/Preboot/Cryptexes\")",
  "(subpath \"/System/Cryptexes\")",
  "(subpath \"/private/var/db/timezone\")",
  "(literal \"/private/etc/localtime\")",
  "(literal \"/dev/null\")",
  "(literal \"/dev/random\")",
  "(literal \"/dev/urandom\")",
];

export function buildProfile(home = realpathSync(homedir())): string {
  void home; // reads are allowed by subpath, so nothing under $HOME is readable unless listed
  const readable = readableDirs();
  const metadata = new Set<string>(["/", "/private", "/private/etc", "/private/var", "/etc", "/var", "/tmp", "/usr", "/System", "/System/Volumes", "/System/Volumes/Preboot"]);
  for (const d of readable) for (const a of ancestors(d)) metadata.add(a);
  const nodeBin = nodeExecutable();
  const lines = [
    "(version 1)",
    "(deny default)",
    `(allow process-exec (literal ${q(nodeBin)}))`,
    "(allow process-info* (target self))",
    "(allow signal (target self))",
    "(allow sysctl-read)",
    `(allow file-read* ${SYSTEM_READS.join(" ")})`,
    ...readable.map((d) => `(allow file-read* (subpath ${q(d)}))`),
    // Node resolves real paths: let it stat the parents of allowed dirs (metadata only, no listing or content).
    ...[...metadata].sort().map((d) => `(allow file-read-metadata (literal ${q(d)}))`),
    '(allow file-write-data (literal "/dev/null"))',
    '(allow file-ioctl (literal "/dev/null"))',
  ];
  return lines.join("\n");
}
