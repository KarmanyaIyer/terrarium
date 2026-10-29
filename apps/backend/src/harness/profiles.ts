// What each harness profile sends the model: system prompt (built-in, a saved profile default, or a session's
// override) and tool definitions. sessions.ts builds runs from this; GET /api/harness and the session prompt
// view show the same values.

import type { AppSettings, EnvType, HarnessInfo, HarnessProfile, SessionPrompt, ToolDefinition } from "@terrarium/shared";
import { CHAT_PROMPT, PI_STOCK_PROMPT, SIM_NOTE, TERRARIUM_PROMPT } from "./prompts.ts";
import { type ToolHost, piStockTools, terrariumTools } from "./tools.ts";

export const BUILT_IN: Record<HarnessProfile, string> = {
  terrarium: TERRARIUM_PROMPT,
  "pi-stock": PI_STOCK_PROMPT,
  chat: CHAT_PROMPT,
};

/** Tool definitions as the request carries them (tools[].function). Building them never touches the host. */
export function toolDefinitions(harness: HarnessProfile, hasEnv = true): ToolDefinition[] {
  if (harness === "chat" || !hasEnv) return [];
  const stub = {} as ToolHost;
  const tools = harness === "pi-stock" ? piStockTools(stub) : terrariumTools(stub);
  // JSON round trip drops TypeBox's symbol keys, as the request serializer does.
  return tools.map((t) => ({ name: t.name, description: t.description, parameters: JSON.parse(JSON.stringify(t.parameters)) }));
}

/** The profile's prompt for an env type: saved default or built-in, plus the sim note for the terrarium profile. */
export function profilePrompt(harness: HarnessProfile, envType: EnvType | null, prompts: AppSettings["prompts"]): string {
  if (harness === "chat" || !envType) return prompts.chat ?? CHAT_PROMPT;
  const base = prompts[harness] ?? BUILT_IN[harness];
  return harness === "terrarium" && envType === "sim" ? base + SIM_NOTE : base;
}

/** The prompt a session's next run sends. `override`: the session's own prompt, sent verbatim. */
export function sessionPrompt(
  harness: HarnessProfile,
  envType: EnvType | null,
  override: string | null,
  prompts: AppSettings["prompts"],
): Pick<SessionPrompt, "text" | "source" | "defaultText"> {
  const defaultText = profilePrompt(harness, envType, prompts);
  const profile: HarnessProfile = harness === "chat" || !envType ? "chat" : harness;
  if (override != null) return { text: override, source: "session", defaultText };
  return { text: defaultText, source: prompts[profile] != null ? "profile" : "built-in", defaultText };
}

/** A saved profile default never carries the sim note: it is appended per env. */
export function stripSimNote(harness: HarnessProfile, text: string): string {
  return harness === "terrarium" && text.endsWith(SIM_NOTE) ? text.slice(0, -SIM_NOTE.length) : text;
}

/** Display estimate, about 4 characters per token for English and JSON. Budgets use budget.ts's counts, which err high. */
export function roughTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Tool declarations as JSON, for estimates (the chat template adds some wrapping the estimate doesn't see). */
export function toolsJson(tools: ToolDefinition[]): string {
  return JSON.stringify(tools.map((t) => ({ type: "function", function: t })));
}

export function harnessInfo(prompts: AppSettings["prompts"]): HarnessInfo[] {
  return (["terrarium", "pi-stock", "chat"] as const).map((id) => {
    const tools = toolDefinitions(id);
    const prompt = prompts[id] ?? BUILT_IN[id];
    return {
      id,
      prompt,
      builtIn: BUILT_IN[id],
      ...(id === "terrarium" ? { simNote: SIM_NOTE } : {}),
      custom: prompts[id] != null,
      tools,
      tokensEst: { prompt: roughTokens(prompt), tools: tools.length ? roughTokens(toolsJson(tools)) : 0 },
    };
  });
}
