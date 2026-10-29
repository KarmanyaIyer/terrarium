// Host measurements: system memory from vm_stat/sysctl, per-process RSS/CPU from ps.

import { execFile } from "node:child_process";
import { totalmem } from "node:os";
import { promisify } from "node:util";

const run = promisify(execFile);

export interface SystemMemory {
  totalBytes: number;
  usedBytes: number;
  freeBytes: number; // free + inactive + speculative + purgeable (reclaimable without swapping)
  pressure: "normal" | "warn" | "critical";
}

export function parseVmStat(text: string): { pageSize: number; pages: Record<string, number> } {
  const pageSize = Number(/page size of (\d+) bytes/.exec(text)?.[1] ?? 16384);
  const pages: Record<string, number> = {};
  for (const line of text.split("\n")) {
    const m = /^(.+?):\s+(\d+)\.?$/.exec(line.trim());
    if (m) pages[m[1]] = Number(m[2]);
  }
  return { pageSize, pages };
}

export async function systemMemory(): Promise<SystemMemory> {
  const totalBytes = totalmem();
  const [vm, pressure] = await Promise.all([
    run("/usr/bin/vm_stat", [], { timeout: 2000 }).then((r) => r.stdout).catch(() => ""),
    run("/usr/sbin/sysctl", ["-n", "kern.memorystatus_vm_pressure_level"], { timeout: 2000 }).then((r) => Number(r.stdout.trim())).catch(() => 1),
  ]);
  const { pageSize, pages } = parseVmStat(vm);
  const reclaimable = (pages["Pages free"] ?? 0) + (pages["Pages inactive"] ?? 0) + (pages["Pages speculative"] ?? 0) + (pages["Pages purgeable"] ?? 0);
  const freeBytes = Math.min(totalBytes, reclaimable * pageSize);
  return {
    totalBytes,
    usedBytes: totalBytes - freeBytes,
    freeBytes,
    pressure: pressure >= 4 ? "critical" : pressure >= 2 ? "warn" : "normal",
  };
}

/** RSS (bytes) and CPU% for each pid that is still alive. */
export async function processStats(pids: number[]): Promise<Map<number, { rssBytes: number; cpuPct: number }>> {
  const out = new Map<number, { rssBytes: number; cpuPct: number }>();
  const live = pids.filter((p) => Number.isInteger(p) && p > 0);
  if (!live.length) return out;
  try {
    const { stdout } = await run("/bin/ps", ["-o", "pid=,rss=,%cpu=", "-p", live.join(",")], { timeout: 2000 });
    for (const line of stdout.split("\n")) {
      const [pid, rss, cpu] = line.trim().split(/\s+/).map(Number);
      if (pid) out.set(pid, { rssBytes: rss * 1024, cpuPct: cpu });
    }
  } catch {
    // ps exits 1 when none of the pids exist
  }
  return out;
}
