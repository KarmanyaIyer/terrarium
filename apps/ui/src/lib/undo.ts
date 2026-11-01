// The undo stack, with no UI or store in it: entries say how to go back and forth, and edits of one thing a moment apart
// (a slider drag, typing) become one entry. state/undo.ts holds the app's instance.

export interface UndoEntry {
  label: string; // "Removed L28N1343"
  undo: () => void | Promise<unknown>;
  redo: () => void | Promise<unknown>;
  /** Pushes with the same key within coalesceMs merge: the first undo, the last redo. */
  key?: string;
  /** What the entry belongs to, for dropping it when that goes away (the Lab's model changes). */
  scope?: string;
}

export interface UndoStack {
  push(e: UndoEntry): void;
  undo(): Promise<UndoEntry | null>;
  redo(): Promise<UndoEntry | null>;
  peekUndo(): UndoEntry | null;
  peekRedo(): UndoEntry | null;
  /** True while an entry is being applied: changes it causes aren't new edits. */
  applying(): boolean;
  drop(scope: string): void;
  clear(): void;
  subscribe(fn: () => void): () => void;
  /** Bumps on every change, for useSyncExternalStore. */
  version(): number;
}

export function createUndoStack(opts: { limit?: number; coalesceMs?: number; now?: () => number } = {}): UndoStack {
  const limit = opts.limit ?? 200;
  const coalesceMs = opts.coalesceMs ?? 800;
  const now = opts.now ?? Date.now;
  let done: UndoEntry[] = [];
  let undone: UndoEntry[] = [];
  let lastAt = 0;
  let busy = false;
  let ver = 0;
  const subs = new Set<() => void>();
  const changed = () => {
    ver++;
    for (const f of subs) f();
  };
  // an entry that can't be applied is off both stacks; the caller says why
  const apply = async (from: () => UndoEntry[], to: () => UndoEntry[], run: (e: UndoEntry) => void | Promise<unknown>): Promise<UndoEntry | null> => {
    if (busy) return null;
    const e = from().pop();
    if (!e) return null;
    busy = true;
    try {
      await run(e);
      to().push(e);
      return e;
    } finally {
      busy = false;
      lastAt = 0; // a new edit after this starts its own entry
      changed();
    }
  };
  return {
    push(e) {
      if (busy) return;
      const t = now();
      const last = done[done.length - 1];
      if (e.key && last?.key === e.key && t - lastAt <= coalesceMs) done[done.length - 1] = { ...last, redo: e.redo, label: e.label };
      else done.push(e);
      if (done.length > limit) done = done.slice(-limit);
      undone = [];
      lastAt = t;
      changed();
    },
    undo: () =>
      apply(
        () => done,
        () => undone,
        (e) => e.undo(),
      ),
    redo: () =>
      apply(
        () => undone,
        () => done,
        (e) => e.redo(),
      ),
    peekUndo: () => done[done.length - 1] ?? null,
    peekRedo: () => undone[undone.length - 1] ?? null,
    applying: () => busy,
    drop(scope) {
      done = done.filter((e) => e.scope !== scope);
      undone = undone.filter((e) => e.scope !== scope);
      changed();
    },
    clear() {
      done = [];
      undone = [];
      changed();
    },
    subscribe(fn) {
      subs.add(fn);
      return () => {
        subs.delete(fn);
      };
    },
    version: () => ver,
  };
}

/** The keys that differ, with their values on each side; null when none do. */
export function diffKeys<T extends object>(prev: T, next: T, keys: readonly (keyof T)[]): { before: Partial<T>; after: Partial<T>; keys: (keyof T)[] } | null {
  const changed = keys.filter((k) => prev[k] !== next[k]);
  if (!changed.length) return null;
  const before: Partial<T> = {};
  const after: Partial<T> = {};
  for (const k of changed) {
    before[k] = prev[k];
    after[k] = next[k];
  }
  return { before, after, keys: changed };
}
