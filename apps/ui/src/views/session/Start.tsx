import { useEffect, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import type { SessionSummary } from "@terrarium/shared";
import { loadHarness, openEnv, useStore } from "../../state/store";
import { harnessLabel } from "../../lib/explain";
import { starters } from "../../lib/starters";
import { modelName } from "../../components/ModelPicker";
import { EnvChip } from "../../components/Sidebar";

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
          role={model?.strain ? `Lab strain: ${model.strain.recipe}` : env ? "Writes every reply and tool call" : "Writes every reply"}
          // the picker lives in the header; open it there so there is one model menu
          onClick={() => document.querySelector<HTMLButtonElement>(".sh-row.controls .hdr-btn.model")?.click()}
        />
        <ChevronRight size={14} className="ss-arrow" aria-hidden />
        <Part
          label="Prompt"
          value={harnessLabel(s.harness)}
          role={tools.length ? `With tools: ${tools.join(", ")}` : s.harness === "chat" ? "Replies only" : "No tools"}
          onClick={() => useStore.setState({ inspectorTab: "prompt", inspectorOpen: true })}
        />
        <ChevronRight size={14} className="ss-arrow" aria-hidden />
        {env ? (
          <Part
            label="Enclosure"
            value={
              <>
                {env.name} <EnvChip type={env.type} />
              </>
            }
            role={`Runs the tool calls; ${net}`}
            onClick={() => openEnv(env.id, "env")}
          />
        ) : (
          <Part label="Enclosure" value="None" role="Chat: the model can't run anything" />
        )}
      </div>
      {model?.strain && <p className="dim">A steered model can start repeating itself after several turns. A new chat resets it.</p>}
      <div className="ss-try">
        <div className="ss-try-head dim">Try</div>
        {starters(env, s.harness === "chat", !!model?.strain).map((t) => (
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
