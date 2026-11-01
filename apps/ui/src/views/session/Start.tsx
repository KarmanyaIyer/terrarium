import { useEffect, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import type { EnvSummary, SessionSummary } from "@terrarium/shared";
import { loadHarness, openEnv, useStore } from "../../state/store";
import { harnessLabel } from "../../lib/explain";
import { modelName } from "../../components/ModelPicker";
import { EnvChip } from "../../components/Sidebar";

/** Starter tasks per place the session runs: each shows something different on record (files, commands, the network log). */
function starters(env: EnvSummary | undefined, s: SessionSummary, strain: boolean): string[] {
  if (strain) return ["Who are you?", "Describe your home in three sentences.", "What should I have for dinner tonight?"];
  if (!env || s.harness === "chat")
    return [
      "A bat and a ball cost $1.10 in total. The bat costs $1.00 more than the ball. How much does the ball cost?",
      "Explain the difference between a process and a thread in three sentences.",
      "Write a haiku about a terrarium.",
    ];
  const net =
    env.network === "off"
      ? "Fetch https://example.com with curl and tell me what happened."
      : env.type === "vm"
        ? "Install the requests package with pip, then print its version."
        : "Fetch https://example.com with curl and show the page title.";
  if (env.type === "vm")
    return [
      "Write a Python script that prints the first 20 prime numbers, save it as primes.py and run it.",
      "Show the kernel version, the CPU count and the free memory of this machine.",
      net,
      "Try to read a file from the Mac outside this environment and tell me what happened.",
    ];
  return [
    "Create three files a.txt, b.txt and c.txt with one line each, then show them with cat.",
    "Make a CSV of five fruits and their prices, then print the most expensive one with awk.",
    net,
    "Try to read a file from the Mac outside this environment and tell me what happened.",
  ];
}

function Part({ label, value, role, onClick }: { label: string; value: ReactNode; role: ReactNode; onClick?: () => void }) {
  const body = (
    <>
      <span className="ss-part-label">{label}</span>
      <span className="ss-part-value">{value}</span>
      <span className="ss-part-role dim">{role}</span>
    </>
  );
  return onClick ? (
    <button className="ss-part click" onClick={onClick}>
      {body}
    </button>
  ) : (
    <div className="ss-part">{body}</div>
  );
}

/** An empty session: how its parts fit together, and tasks to try. */
export function SessionStart({ s }: { s: SessionSummary }) {
  const env = useStore((st) => (s.envId ? st.envs[s.envId] : undefined));
  const models = useStore((st) => st.models);
  const info = useStore((st) => st.harness?.find((h) => h.id === s.harness));
  const loaded = useStore((st) => st.harness != null);
  useEffect(() => {
    if (!loaded) void loadHarness();
  }, [loaded]);
  const model = models.find((m) => m.id === s.modelId);
  const tools = info?.tools.map((t) => t.name) ?? [];
  const net = env ? (env.network === "off" ? "network off" : env.network === "registries" ? "package registries only" : "public web") : "";

  return (
    <div className="ss-start">
      <div className="ss-chain">
        <Part
          label="Model"
          value={modelName(models, s.modelId)}
          role={model?.strain ? `Lab strain: ${model.strain.recipe}` : "Writes every reply and tool call"}
        />
        <ChevronRight size={14} className="ss-arrow" aria-hidden />
        <Part
          label="Harness"
          value={harnessLabel(s.harness)}
          role={tools.length ? `Prompt and tools: ${tools.join(", ")}` : "Prompt only, no tools"}
          onClick={() => useStore.setState({ inspectorTab: "prompt", inspectorOpen: true })}
        />
        <ChevronRight size={14} className="ss-arrow" aria-hidden />
        {env ? (
          <Part
            label="Environment"
            value={
              <>
                {env.name} <EnvChip type={env.type} />
              </>
            }
            role={`Runs the tool calls; ${net}`}
            onClick={() => openEnv(env.id, "env")}
          />
        ) : (
          <Part label="Environment" value="None" role="Chat: the model can't run anything" />
        )}
      </div>
      <div className="ss-try">
        <div className="ss-try-head dim">Try</div>
        {starters(env, s, !!model?.strain).map((t) => (
          <button
            key={t}
            className="ss-task"
            onClick={() => useStore.setState((st) => ({ composerFill: { sessionId: s.id, text: t, n: (st.composerFill?.n ?? 0) + 1 } }))}
          >
            {t}
          </button>
        ))}
      </div>
    </div>
  );
}
