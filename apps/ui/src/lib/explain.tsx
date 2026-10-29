// Hover-card copy for terms and controls: harness profiles, env types, network modes, env fields. Facts come from
// the backend (harness/profiles.ts, policy/index.ts, envs/sim, envs/vm, guest/README.md); keep them in sync.

import { useEffect, type ReactNode } from "react";
import { Box, Terminal } from "lucide-react";
import { Hint } from "../components/ui";
import type { EnvType, HarnessProfile, NetworkMode } from "@terrarium/shared";
import { loadHarness, useStore } from "../state/store";
import { fmtInt } from "./format";

export const HARNESS: { id: HarnessProfile; label: string; short: string; when: string }[] = [
  {
    id: "terrarium",
    label: "Terrarium: minimal prompt",
    short: "Short prompt, 4 simple tools",
    when: "Default for small models: the short prompt leaves room for context, and the tools take flat arguments.",
  },
  {
    id: "pi-stock",
    label: "Pi: stock prompt",
    short: "Pi 1.4.0's prompt and tools",
    when: "Comparison: the prompt and tool shapes the Pi coding agent ships (edit takes a list of edits).",
  },
  {
    id: "chat",
    label: "Chat: no tools",
    short: "No tools, no environment",
    when: "Plain questions and answers. The model can't run or read anything.",
  },
];

export const harnessLabel = (id: HarnessProfile) => HARNESS.find((h) => h.id === id)?.label ?? id;

/** Hover card for a harness profile: what it sends the model, measured from the backend's definitions. */
export function HarnessTip({ id }: { id: HarnessProfile }) {
  const info = useStore((s) => s.harness?.find((h) => h.id === id));
  const loaded = useStore((s) => s.harness != null);
  useEffect(() => {
    if (!loaded) void loadHarness();
  }, [loaded]);
  const h = HARNESS.find((x) => x.id === id)!;
  return (
    <>
      <span className="hint-title">
        {h.label} <span className="mono hint-k">{id}</span>
      </span>
      <div className="hint-line">{h.when}</div>
      <div className="hint-rows">
        <span>Prompt</span>
        <span>
          {info ? `≈${fmtInt(info.tokensEst.prompt)} tokens` : "…"}
          {info?.custom ? ", your saved default" : ""}
          {id === "terrarium" ? ", plus a note in simulated envs" : ""}
        </span>
        <span>Tools</span>
        <span className="mono">{info ? (info.tools.length ? info.tools.map((t) => t.name).join(", ") : "none") : "…"}</span>
        {info && info.tools.length > 0 && (
          <>
            <span>Tool specs</span>
            <span>≈{fmtInt(info.tokensEst.tools)} tokens, plus the chat template's tool instructions (exact count in the Prompt tab)</span>
          </>
        )}
      </div>
      <div className="hint-line hint-k" style={{ marginTop: 6 }}>
        Harness = agent loop + system prompt + tool definitions. The loop is the same for every profile. The environment
        decides where tool calls run.
      </div>
    </>
  );
}

// ---------- environments ----------

export const ENV_ROWS: { label: string; vm: ReactNode; sim: ReactNode }[] = [
  { label: "What it is", vm: "Linux micro-VM, Alpine 3.23", sim: "Bash interpreter written in TypeScript (just-bash)" },
  { label: "Runs", vm: "Real programs: python3 3.12 + pip, node 24 + npm, gcc, git", sim: "~85 built-in commands; Python 3.13 and JS run as WebAssembly / QuickJS" },
  { label: "Installs", vm: "pip and npm (network on)", sim: "None: no package manager, no compiler" },
  { label: "Boundary", vm: "Hardware virtualization (Apple Hypervisor); own kernel", sim: "Software: interpreter in a node process under macOS sandbox-exec" },
  { label: "Files", vm: "VM disk; snapshots copy it", sim: "In memory, saved to data/envs" },
  { label: "Cost", vm: "Its RAM (1 GiB default) while running; boots in 1 to 2 s", sim: "~50 to 90 MiB, starts instantly" },
  { label: "Limit", vm: "2 running at once", sim: "None" },
];

const ENV_HEAD: Record<EnvType, { title: string; icon: ReactNode }> = {
  vm: { title: "Linux VM", icon: <Box size={14} /> },
  sim: { title: "Simulated shell", icon: <Terminal size={14} /> },
};

/** VM vs simulated, side by side. With onPick the column heads are the type picker. */
export function EnvCompare({ highlight, onPick }: { highlight?: EnvType; onPick?: (t: EnvType) => void }) {
  const cls = (t: EnvType) => (highlight === t ? "on" : undefined);
  return (
    <table className={`env-compare${onPick ? " pick" : ""}`} role={onPick ? "radiogroup" : undefined} aria-label={onPick ? "Environment type" : undefined}>
      <thead>
        <tr>
          <th />
          {(["vm", "sim"] as const).map((t) => (
            <th key={t} className={cls(t)}>
              {onPick ? (
                <Hint tip={ENV_TYPE_TIP[t]}>
                  <button type="button" role="radio" aria-checked={highlight === t} className="ec-pick" onClick={() => onPick(t)}>
                    <span className={`ec-radio${highlight === t ? " on" : ""}`} />
                    {ENV_HEAD[t].icon}
                    <b>{ENV_HEAD[t].title}</b>
                  </button>
                </Hint>
              ) : (
                <Hint tip={ENV_TYPE_TIP[t]}>
                  <span className="ec-pick static">
                    {ENV_HEAD[t].icon}
                    <b>{ENV_HEAD[t].title}</b>
                  </span>
                </Hint>
              )}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {ENV_ROWS.map((r) => (
          <tr key={r.label}>
            <th>{r.label}</th>
            <td className={cls("vm")} onClick={onPick ? () => onPick("vm") : undefined}>
              {r.vm}
            </td>
            <td className={cls("sim")} onClick={onPick ? () => onPick("sim") : undefined}>
              {r.sim}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export const ENV_TYPE_TIP: Record<EnvType, ReactNode> = {
  vm: (
    <>
      <span className="hint-title">Linux VM</span>
      <div className="hint-line">Use for real code: installs, compilers, test suites, anything that must behave like Linux.</div>
      <div className="hint-line">
        Safest place to run untrusted native code: a hardware-virtualized guest with no Mac folders mounted; the agent runs as an
        unprivileged user (uid 1000) and can't regain root.
      </div>
    </>
  ),
  sim: (
    <>
      <span className="hint-title">Simulated shell</span>
      <div className="hint-line">Use for file and text tasks, quick tries and evals that don't need installs. Many can run at once.</div>
      <div className="hint-line">
        Nothing native runs, so there is less to attack, but the boundary is software: an interpreter bug would land in a node
        process that sandbox-exec still keeps off the network and your files.
      </div>
    </>
  ),
};

export const NET_TIP: Record<NetworkMode, ReactNode> = {
  off: (
    <>
      <span className="hint-title">Network off</span>
      <div className="hint-line">Every connection is denied and logged. Default; keep it for anything that doesn't need downloads.</div>
    </>
  ),
  registries: (
    <>
      <span className="hint-title">Package registries</span>
      <div className="hint-line">
        GET and HEAD (and git fetch) to PyPI, npm, GitHub downloads and the Alpine CDN, ports 80/443. Nothing can be posted out.
      </div>
      <div className="hint-line">Turn on for pip/npm installs or cloning. The model can download and run any package from those hosts inside the env.</div>
    </>
  ),
  web: (
    <>
      <span className="hint-title">Public web</span>
      <div className="hint-line">Any public HTTP/HTTPS, any method.</div>
      <div className="hint-line">
        <b>Risk:</b> a misbehaving or prompt-injected model can send workspace contents to any server, or download and run
        anything. Turn on only for tasks that need the web, with nothing private in the workspace.
      </div>
    </>
  ),
};

export const NET_ALWAYS = "In every mode: the Mac, LAN, loopback, link-local, private ranges and cloud metadata addresses are blocked, and every attempt is logged. VMs only get HTTP/HTTPS (other TCP and UDP are dropped).";

export const FIELD_TIP: Record<string, ReactNode> = {
  start: (
    <>
      <span className="hint-title">Start from</span>
      <div className="hint-line">Clean: the base image. Fork: a copy of another env's current disk (not while it's busy). Snapshot: a copy of a saved snapshot.</div>
    </>
  ),
  cpus: (
    <>
      <span className="hint-title">CPUs</span>
      <div className="hint-line">Virtual CPUs the VM gets. 2 is enough for most tasks; more helps builds and test suites.</div>
    </>
  ),
  memory: (
    <>
      <span className="hint-title">Memory</span>
      <div className="hint-line">Guest RAM, taken from the Mac while the VM runs, alongside the model's memory. Raise for pip installs of big packages or builds.</div>
    </>
  ),
  disk: (
    <>
      <span className="hint-title">Disk</span>
      <div className="hint-line">Size of the VM's root disk, where /workspace and installed packages live. It only uses Mac disk space as it fills.</div>
    </>
  ),
  backend: (
    <>
      <span className="hint-title">Hypervisor backend</span>
      <div className="hint-line">krun (libkrun on Apple Hypervisor.framework) boots in 1 to 2 s. QEMU is the fallback if krun fails; slower boot.</div>
    </>
  ),
  python: (
    <>
      <span className="hint-title">Python (WASM)</span>
      <div className="hint-line">Adds python3: CPython 3.13 compiled to WebAssembly. Standard library only: no pip, no native extensions.</div>
      <div className="hint-line">Leave on for data tasks and the shell-data evals. Turn off to keep the env to plain shell commands.</div>
    </>
  ),
  javascript: (
    <>
      <span className="hint-title">JavaScript</span>
      <div className="hint-line">Adds js-exec and node, both QuickJS rather than Node.js: no npm, no native modules.</div>
      <div className="hint-line">Off by default; turn on when a task needs a JS one-liner.</div>
    </>
  ),
  fsLimit: (
    <>
      <span className="hint-title">Filesystem limit</span>
      <div className="hint-line">Total bytes the in-memory filesystem may hold; writes past it fail. Larger limits use more of the Mac's RAM as files grow.</div>
    </>
  ),
};
