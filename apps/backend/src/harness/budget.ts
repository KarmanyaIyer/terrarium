// Token accounting. Server usage (prompt_tokens) is ground truth; between calls we estimate with pi-ai's
// heuristic scaled by the ratio observed on the last call for this session.

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import { estimateMessageTokens } from "@earendil-works/pi-ai/utils/estimate";

export function rawEstimate(messages: AgentMessage[]): number {
  const llm = messages.filter((m) => m.role === "system" || m.role === "user" || m.role === "assistant" || m.role === "toolResult") as Message[];
  // Pure per-message heuristic (system messages include declared tools). Not estimateContextTokens: that anchors
  // on the last assistant usage, which is stale after compaction and would be double-scaled by the calibrator.
  let total = 0;
  for (const m of llm) total += estimateMessageTokens(m);
  return total;
}

export class TokenCalibrator {
  private ratio = 1;

  /** Record server truth for a request whose messages estimated to `estimated` tokens. */
  observe(estimated: number, serverPromptTokens: number): void {
    if (estimated > 50 && serverPromptTokens > 0) {
      const r = serverPromptTokens / estimated;
      if (r > 0.3 && r < 4) this.ratio = r;
    }
  }

  estimate(messages: AgentMessage[]): number {
    return Math.ceil(rawEstimate(messages) * this.ratio);
  }

  get factor(): number {
    return this.ratio;
  }
}

/**
 * Output budget for one call: the session's max output, but never more than what is left in the window after
 * the prompt (minus a small margin). This replaces pi-ai's fixed 4,096-token safety clamp.
 */
export function callBudget(window: number, promptTokens: number, sessionMaxOutput: number, margin = 64): number {
  return Math.max(1, Math.min(sessionMaxOutput, window - promptTokens - margin));
}
