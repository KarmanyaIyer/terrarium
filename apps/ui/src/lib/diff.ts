export interface DiffLine {
  kind: "ctx" | "add" | "del" | "meta";
  text: string;
  oldNo?: number;
  newNo?: number;
}

export interface DiffHunk {
  header: string;
  lines: DiffLine[];
}

export interface ParsedDiff {
  oldPath?: string;
  newPath?: string;
  hunks: DiffHunk[];
  added: number;
  removed: number;
}

/** Parses unified diff text (one or more files concatenated is treated as one stream of hunks). */
export function parseUnified(text: string): ParsedDiff {
  const out: ParsedDiff = { hunks: [], added: 0, removed: 0 };
  let hunk: DiffHunk | null = null;
  let o = 0;
  let n = 0;
  for (const raw of text.split("\n")) {
    if (raw.startsWith("--- ")) {
      out.oldPath ??= raw.slice(4).replace(/^a\//, "").split("\t")[0];
      hunk = null;
      continue;
    }
    if (raw.startsWith("+++ ")) {
      out.newPath ??= raw.slice(4).replace(/^b\//, "").split("\t")[0];
      continue;
    }
    const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(raw);
    if (m) {
      o = Number(m[1]);
      n = Number(m[2]);
      hunk = { header: raw, lines: [] };
      out.hunks.push(hunk);
      continue;
    }
    if (!hunk) continue;
    if (raw.startsWith("+")) {
      hunk.lines.push({ kind: "add", text: raw.slice(1), newNo: n++ });
      out.added++;
    } else if (raw.startsWith("-")) {
      hunk.lines.push({ kind: "del", text: raw.slice(1), oldNo: o++ });
      out.removed++;
    } else if (raw.startsWith("\\")) {
      hunk.lines.push({ kind: "meta", text: raw });
    } else if (raw.length || hunk.lines.length) {
      hunk.lines.push({ kind: "ctx", text: raw.slice(1), oldNo: o++, newNo: n++ });
    }
  }
  // trailing empty context line from a final newline
  for (const h of out.hunks) {
    const last = h.lines[h.lines.length - 1];
    if (last && last.kind === "ctx" && last.text === "" && last.oldNo === undefined) h.lines.pop();
  }
  return out;
}

type Op = { k: "=" | "+" | "-"; a: number; b: number };

/** Line diff via LCS; fine for workspace-sized files. Returns null when too large to diff in the UI. */
export function unifiedDiff(oldText: string, newText: string, path: string, context = 3): string | null {
  const a = oldText === "" ? [] : oldText.replace(/\n$/, "").split("\n");
  const b = newText === "" ? [] : newText.replace(/\n$/, "").split("\n");
  if (a.length * b.length > 4_000_000) return null;

  // trim common prefix/suffix to keep the table small
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const A = a.slice(pre, a.length - suf);
  const B = b.slice(pre, b.length - suf);
  const n = A.length;
  const m = B.length;
  const dp: Uint32Array[] = [];
  for (let i = 0; i <= n; i++) dp.push(new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--) dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);

  const ops: Op[] = [];
  for (let i = 0; i < pre; i++) ops.push({ k: "=", a: i, b: i });
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && A[i] === B[j]) {
      ops.push({ k: "=", a: pre + i++, b: pre + j++ });
    } else if (j < m && (i >= n || dp[i][j + 1] >= dp[i + 1][j])) {
      ops.push({ k: "+", a: pre + i, b: pre + j++ });
    } else {
      ops.push({ k: "-", a: pre + i++, b: pre + j });
    }
  }
  for (let s = 0; s < suf; s++) ops.push({ k: "=", a: a.length - suf + s, b: b.length - suf + s });

  if (!ops.some((x) => x.k !== "=")) return "";

  const lines: string[] = [`--- a${path}`, `+++ b${path}`];
  let idx = 0;
  while (idx < ops.length) {
    while (idx < ops.length && ops[idx].k === "=") idx++;
    if (idx >= ops.length) break;
    const start = Math.max(0, idx - context);
    let end = idx;
    let lastChange = idx;
    while (end < ops.length) {
      if (ops[end].k !== "=") lastChange = end;
      else if (end - lastChange > context * 2) break;
      end++;
    }
    end = Math.min(ops.length, lastChange + context + 1);
    const slice = ops.slice(start, end);
    const aStart = slice.find((x) => x.k !== "+")?.a ?? slice[0].a;
    const bStart = slice.find((x) => x.k !== "-")?.b ?? slice[0].b;
    const aLen = slice.filter((x) => x.k !== "+").length;
    const bLen = slice.filter((x) => x.k !== "-").length;
    lines.push(`@@ -${aLen ? aStart + 1 : aStart},${aLen} +${bLen ? bStart + 1 : bStart},${bLen} @@`);
    for (const op of slice) {
      if (op.k === "=") lines.push(` ${a[op.a]}`);
      else if (op.k === "-") lines.push(`-${a[op.a]}`);
      else lines.push(`+${b[op.b]}`);
    }
    idx = end;
  }
  return lines.join("\n") + "\n";
}
