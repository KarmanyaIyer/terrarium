// What a new toast does to the ones on screen: one of a kind at a time, so restoring ten results doesn't stack ten lines.

export interface ToastShape {
  id: number;
  text: string;
  kind: string;
}

/** What a toast replaces. An offer to undo is about the newest change, "Undid: x" about the newest step back; anything else only repeats itself. */
export function toastKind(text: string, hasAction: boolean): string {
  if (hasAction) return "offer";
  if (/^(Undid|Redid): /.test(text)) return "stepped";
  return `text:${text}`;
}

export function addToast<T extends ToastShape>(list: T[], t: T, max = 4): T[] {
  return [...list.filter((x) => x.kind !== t.kind), t].slice(-max);
}
