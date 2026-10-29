// What the remedy buttons under a cut-off reply or a refused message set. Pure, so apps/ui/test can check that a remedy
// changes what actually limited the reply and that a suggested window is one the backend's compaction can use.

/** Compaction keeps this many tokens free beyond the output cap: its limit is window - cap - this (backend compaction.ts). */
export const COMPACTION_MARGIN = 256;
/** The backend caps a session's output at window - this (sessions.ts sizing). */
const PROMPT_FLOOR = 1024;

export interface Settings {
  contextWindow: number;
  maxOutputTokens: number;
}

export interface CutoffRemedy {
  /** Raise the output cap within this window. */
  cap?: number;
  /** A bigger window, with the output cap to go with it. */
  window?: Settings;
}

/**
 * For a reply cut off at `budget` tokens (the call's max_tokens) with output cap `cap` in `window`: raise what limited
 * it. The window, when the prompt filled it (the cap stays). The cap, when it set the limit: doubled, at most half the
 * window so the prompt keeps the rest. A cap already at half the window can only grow with the window: the next
 * window, with the cap doubled (at most half of that window).
 */
export function cutoffRemedy(o: { window: number; budget: number; cap: number; session: Settings; nativeContext?: number; choices: number[] }): CutoffRemedy {
  const byWindow = o.budget < o.cap;
  const nextCap = Math.min(o.cap * 2, Math.floor(o.window / 2));
  const canCap = !byWindow && nextCap > o.cap && nextCap > o.session.maxOutputTokens;
  const out: CutoffRemedy = canCap ? { cap: nextCap } : {};
  const next = o.choices.find((c) => c > o.window && (o.nativeContext == null || c <= o.nativeContext));
  if ((byWindow || !canCap) && next != null && o.session.contextWindow <= o.window) {
    const cap = byWindow ? o.session.maxOutputTokens : Math.max(o.session.maxOutputTokens, Math.min(o.cap * 2, Math.floor(next / 2)));
    out.window = { contextWindow: next, maxOutputTokens: Math.min(cap, next - PROMPT_FLOOR) };
  }
  return out;
}

export interface OverflowRemedy {
  /** Settings to apply before retrying (absent: the session's settings already fit). */
  raise?: Settings;
  retry: boolean;
}

/**
 * For a message refused as over the window (a `promptTokens`-token prompt after compaction): Retry when the session's
 * settings now let compaction keep it (window - cap - margin >= prompt); otherwise the smallest window that does with
 * the session's cap, then Retry. Nothing when no window up to the model's native context does.
 */
export function overflowRemedy(o: { promptTokens: number; suggestedWindow?: number; session: Settings; nativeContext?: number; choices: number[] }): OverflowRemedy {
  const fits = (s: Settings) => s.contextWindow - s.maxOutputTokens - COMPACTION_MARGIN >= o.promptTokens;
  if (fits(o.session)) return { retry: true };
  const cap = o.session.maxOutputTokens;
  const windows = [...new Set([...o.choices, ...(o.suggestedWindow ? [o.suggestedWindow] : [])])].sort((a, b) => a - b);
  const w = windows.find((c) => c > o.session.contextWindow && (o.nativeContext == null || c <= o.nativeContext) && cap <= c - PROMPT_FLOOR && fits({ contextWindow: c, maxOutputTokens: cap }));
  return w ? { raise: { contextWindow: w, maxOutputTokens: cap }, retry: true } : { retry: false };
}
