// Replies are markdown cut at token boundaries. This reads the whole reply first, so a mark split across tokens still
// pairs, then hands the result back token by token: an index into the result is always the raw token's index, which is
// what click-to-trace needs. A token that was only a mark comes back empty, and keeps its place.

export interface Run {
  text: string;
  bold: boolean;
  italic: boolean;
}

interface Mark {
  at: number;
  len: number;
  open: boolean;
  close: boolean;
}

const BOLD = 1;
const ITALIC = 2;

const RULE = /^[ \t]*([-*_])(?:[ \t]*\1){2,}[ \t\r]*$/;
const HEADING = /^[ \t]*#{1,6}[ \t]+/;
const BULLET = /^[ \t]*[*-][ \t]+/;
const FENCE = /^[ \t]*(?:```|~~~)/;
// Han, Kana and Hangul have no spaces between words, so a letter of theirs beside ** doesn't make it part of a word
const WORD = /(?![\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}])[\p{L}\p{N}]/u;
const SPACE = /\s/;

/** Every `*` run in text[from, to) that could be a mark. Inline code and escapes aren't, and four or more never are. */
function marksIn(text: string, from: number, to: number): Mark[] {
  const out: Mark[] = [];
  for (let i = from; i < to; i++) {
    const c = text[i];
    if (c === "\\") {
      i++;
    } else if (c === "`") {
      const end = text.indexOf("`", i + 1);
      if (end >= 0 && end < to) i = end;
    } else if (c === "*") {
      let len = 1;
      while (text[i + len] === "*") len++;
      if (len <= 3) {
        const before = i > 0 ? text[i - 1] : "";
        const after = i + len < text.length ? text[i + len] : "";
        const open = !WORD.test(before) && !SPACE.test(after); // nothing after: a reply cut off right after the mark
        const close = before !== "" && !SPACE.test(before) && (len > 1 || !WORD.test(after));
        out.push({ at: i, len, open, close });
      }
      i += len - 1;
    }
  }
  return out;
}

/**
 * Pairs the marks of one block and hides those. A mark with no partner stays text, as in 2**3 or *args, except an opening mark
 * in the reply's last block, where a reply cut off mid-bold ends, and a ** that starts a line or list item, which the model never closed.
 */
function pair(text: string, marks: Mark[], hide: Uint8Array, style: Uint8Array, last: boolean) {
  const open: { at: number; len: number }[] = [];
  const hideOf = (at: number, n: number) => hide.fill(1, at, at + n);
  for (const m of marks) {
    let left = m.close ? m.len : 0;
    while (left > 0 && open.length) {
      // the same size if there is one, else (for ***) whatever is open
      let j = open.findLastIndex((o) => o.len === left);
      if (j < 0) j = open.findLastIndex((o) => o.len > left);
      if (j < 0 && left === 3) j = open.length - 1;
      if (j < 0) break;
      open.splice(j + 1);
      const o = open[j];
      const take = Math.min(o.len, left);
      const inner = o.at + o.len;
      const bits = (take >= 2 ? BOLD : 0) | (take % 2 ? ITALIC : 0);
      for (let k = inner; k < m.at; k++) style[k] |= bits;
      hideOf(inner - take, take);
      hideOf(m.at + (m.len - left), take);
      o.len -= take;
      if (!o.len) open.splice(j, 1);
      left -= take;
    }
    if (left === m.len || !m.close) {
      if (m.open) open.push({ at: m.at, len: m.len });
    } else if (left > 0) hideOf(m.at + (m.len - left), left);
  }
  const startsLine = (at: number) => /^\s*(?:[*-]|\d+\.)?\s*$/.test(text.slice(text.lastIndexOf("\n", at - 1) + 1, at));
  for (const o of open) if (last || (o.len >= 2 && startsLine(o.at))) hideOf(o.at, o.len);
}

function scan(text: string) {
  const hide = new Uint8Array(text.length);
  const style = new Uint8Array(text.length);
  const swap = new Map<number, string>();
  let block: Mark[] = [];
  const flush = (last = false) => {
    pair(text, block, hide, style, last);
    block = [];
  };
  let fenced = false;
  let start = 0;
  while (start <= text.length) {
    const nl = text.indexOf("\n", start);
    const end = nl < 0 ? text.length : nl;
    const line = text.slice(start, end);
    const next = end + 1;
    if (FENCE.test(line)) {
      flush();
      fenced = !fenced;
    } else if (fenced) {
      // code: as written
    } else if (!line.trim()) {
      flush();
    } else if (RULE.test(line)) {
      flush();
      // a rule goes, and the blank lines after it, so the text around it keeps one gap
      let stop = Math.min(next, text.length);
      for (;;) {
        const after = text.indexOf("\n", stop);
        if (after < 0 || text.slice(stop, after).trim()) break;
        stop = after + 1;
      }
      hide.fill(1, start, stop);
      start = stop;
      if (stop >= text.length) break;
      continue;
    } else {
      const heading = HEADING.exec(line);
      const bullet = heading ? null : BULLET.exec(line);
      if (heading) {
        flush();
        hide.fill(1, start, start + heading[0].length);
        style.fill(BOLD, start + heading[0].length, end);
        block = marksIn(text, start + heading[0].length, end);
        flush();
      } else if (bullet) {
        flush();
        swap.set(start + bullet[0].search(/[*-]/), "•");
        block = marksIn(text, start + bullet[0].length, end);
      } else block.push(...marksIn(text, start, end));
    }
    start = next;
  }
  flush(true);
  return { hide, style, swap };
}

/** What to show for each piece: no marks, bold and italic runs, a bullet for a list item. One entry per piece, empty if it was only marks. */
export function readable(pieces: string[]): Run[][] {
  const text = pieces.join("");
  const { hide, style, swap } = scan(text);
  let at = 0;
  return pieces.map((piece) => {
    const runs: Run[] = [];
    for (let i = at; i < at + piece.length; i++) {
      if (hide[i]) continue;
      const ch = swap.get(i) ?? text[i];
      const bold = !!(style[i] & BOLD);
      const italic = !!(style[i] & ITALIC);
      const last = runs.at(-1);
      if (last && last.bold === bold && last.italic === italic) last.text += ch;
      else runs.push({ text: ch, bold, italic });
    }
    at += piece.length;
    return runs;
  });
}

/** A reply as plain text, keeping its lines. */
export function plainText(text: string): string {
  return readable([text])[0]
    .map((r) => r.text)
    .join("")
    .trim();
}

/** A reply as one line, for a row or a preview. */
export function plainLine(text: string): string {
  return plainText(text).replace(/\s+/g, " ");
}
