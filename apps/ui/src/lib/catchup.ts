import type { NetEntry } from "@terrarium/shared";

/**
 * Whether a live buffer still holds every chunk of its call or tool call once chunk `n` has arrived: only when it got
 * chunk 0 (or saw the call start) and no index was skipped since, whether missed while not subscribed or dropped by
 * the backend for a slow socket. A call opened during prefill gets chunk 0 and is whole. Chunks without an index keep
 * the start-seen rule.
 */
export function afterChunk(prev: { whole?: boolean; next?: number }, n: number | undefined): { whole: boolean; next?: number } {
  if (n === undefined) return { whole: !!prev.whole, next: prev.next };
  const expect = prev.next ?? 0;
  return { whole: n === expect && (expect === 0 || !!prev.whole), next: n + 1 };
}

export const latestAttempt = (e: NetEntry) => e.lastTs ?? e.ts;

/**
 * Rows to show after fetching the newest `limit` net rows (by latest attempt, the backend's order). A row already shown
 * but not in the page stays only when it is newer than the page's oldest row (it arrived during the fetch) or the page
 * holds every row; an older one would sit under a band of rows nobody fetched, a hole under the "latest N" chip. A
 * shown copy with a later attempt than the fetched one wins.
 * `got` answers a request for limit + 1 rows: the extra row only says older rows exist. At the backend's cap (atCap)
 * no extra row can be asked for, so a full page may have left rows out.
 */
export function mergeNetPage(shown: NetEntry[], got: NetEntry[], limit: number, atCap = false): { rows: NetEntry[]; capped: boolean } {
  const capped = got.length > limit || (atCap && got.length >= limit);
  const page = got.slice(0, limit);
  let oldest = Infinity;
  for (const x of page) oldest = Math.min(oldest, latestAttempt(x));
  const fetched = new Map(page.map((x) => [x.id, x]));
  const kept = shown.filter((x) => {
    const f = fetched.get(x.id);
    if (f) {
      if (latestAttempt(x) <= latestAttempt(f)) return false;
      fetched.delete(x.id);
      return true;
    }
    return !capped || latestAttempt(x) > oldest;
  });
  return { rows: [...fetched.values(), ...kept].sort((a, b) => latestAttempt(a) - latestAttempt(b)), capped };
}
