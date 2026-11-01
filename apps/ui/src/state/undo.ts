// The app's undo stack: Cmd+Z and Cmd+Shift+Z outside text fields (App.tsx), the Lab's undo buttons, and the Undo button
// on a "Removed L28N1343" toast. Inside a text field Cmd+Z stays the field's own.

import { useSyncExternalStore } from "react";
import { createUndoStack, type UndoEntry } from "../lib/undo";
import { toast, useStore } from "./store";

export const undoStack = createUndoStack();

const failed = (what: string, err: unknown) => {
  const e = err as { message?: string; detail?: string };
  toast(`${what}: ${e.message ?? String(err)}${e.detail ? ` (${e.detail})` : ""}`);
};

/** An Undo button left on a toast would now mean something else. */
const dropUndoToasts = () => useStore.setState((s) => ({ toasts: s.toasts.filter((t) => !t.action) }));

export async function runUndo() {
  try {
    const e = await undoStack.undo();
    dropUndoToasts();
    if (e) toast(`Undid: ${e.label}`, "info");
  } catch (err) {
    failed("Couldn't undo", err);
  }
}

export async function runRedo() {
  try {
    const e = await undoStack.redo();
    dropUndoToasts();
    if (e) toast(`Redid: ${e.label}`, "info");
  } catch (err) {
    failed("Couldn't redo", err);
  }
}

/** Records something that already happened and offers Undo on a toast. */
export function undoable(entry: UndoEntry, opts: { toast?: boolean } = {}) {
  undoStack.push(entry);
  if (opts.toast === false) return;
  toast(entry.label, "info", {
    label: "Undo",
    run: () => {
      if (undoStack.peekUndo()?.label === entry.label) void runUndo();
      else toast("Newer changes are on top: press Cmd+Z to step back to it", "info");
    },
  });
}

/** Re-renders when the stack changes; the labels of what Cmd+Z and Cmd+Shift+Z would do. */
export function useUndoLabels(): { undo?: string; redo?: string } {
  useSyncExternalStore(undoStack.subscribe, undoStack.version);
  return { undo: undoStack.peekUndo()?.label, redo: undoStack.peekRedo()?.label };
}
