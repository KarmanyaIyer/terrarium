// One press of Cmd+Z can reach the app twice in the packaged window: WebKit sends the page a keydown, and the Edit menu's
// accelerator fires too. Whichever comes first runs; the same action from the other source right after is the same press.
// Holding the keys repeats from one source, so that still steps.

export type EditAction = "undo" | "redo";
export type EditSource = "key" | "menu";

const SAME_PRESS_MS = 150;

export function createEditGate(now: () => number = Date.now): (action: EditAction, source: EditSource) => boolean {
  let last: { action: EditAction; source: EditSource; at: number } | null = null;
  return (action, source) => {
    const t = now();
    if (last && last.action === action && last.source !== source && t - last.at < SAME_PRESS_MS) return false;
    last = { action, source, at: t };
    return true;
  };
}
