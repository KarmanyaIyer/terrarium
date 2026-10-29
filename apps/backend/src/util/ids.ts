import { randomBytes } from "node:crypto";

/** Sortable id: base36 ms timestamp + 8 random hex chars. */
export function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${randomBytes(4).toString("hex")}`;
}
