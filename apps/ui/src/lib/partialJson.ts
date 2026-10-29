/**
 * Reads the top-level fields of a JSON object that is still streaming in, e.g.
 * `{"path":"/workspace/a.py","content":"import os\n` -> path (done), content (open).
 * String values are unescaped so they read as text. Returns null when the text is not an object.
 */
export interface PartialField {
  key: string;
  value: string;
  string: boolean;
  done: boolean;
}

const ESC: Record<string, string> = { n: "\n", t: "\t", r: "\r", b: "\b", f: "\f", '"': '"', "\\": "\\", "/": "/" };

function readString(s: string, i: number): { text: string; end: number; done: boolean } {
  let out = "";
  while (i < s.length) {
    const ch = s[i];
    if (ch === '"') return { text: out, end: i + 1, done: true };
    if (ch === "\\") {
      const n = s[i + 1];
      if (n == null) break;
      if (n === "u") {
        const hex = s.slice(i + 2, i + 6);
        if (hex.length < 4) break;
        out += String.fromCharCode(parseInt(hex, 16));
        i += 6;
        continue;
      }
      out += ESC[n] ?? n;
      i += 2;
      continue;
    }
    out += ch;
    i++;
  }
  return { text: out, end: s.length, done: false };
}

export function partialFields(raw: string): PartialField[] | null {
  const s = raw.trimStart();
  if (!s.startsWith("{")) return null;
  const fields: PartialField[] = [];
  let i = 1;
  const ws = () => {
    while (i < s.length && /[\s,]/.test(s[i])) i++;
  };
  while (i < s.length) {
    ws();
    if (s[i] === "}") break;
    if (s[i] !== '"') return fields.length ? fields : null;
    const k = readString(s, i + 1);
    if (!k.done) break;
    i = k.end;
    while (i < s.length && /\s/.test(s[i])) i++;
    if (s[i] !== ":") break;
    i++;
    while (i < s.length && /\s/.test(s[i])) i++;
    if (i >= s.length) {
      fields.push({ key: k.text, value: "", string: false, done: false });
      break;
    }
    if (s[i] === '"') {
      const v = readString(s, i + 1);
      fields.push({ key: k.text, value: v.text, string: true, done: v.done });
      i = v.end;
      if (!v.done) break;
    } else {
      // number, bool, null, array or object: raw text up to the next top-level comma
      let depth = 0;
      let j = i;
      let inStr = false;
      for (; j < s.length; j++) {
        const c = s[j];
        if (inStr) {
          if (c === "\\") j++;
          else if (c === '"') inStr = false;
        } else if (c === '"') inStr = true;
        else if (c === "{" || c === "[") depth++;
        else if (c === "}" || c === "]") {
          if (depth === 0) break;
          depth--;
        } else if (c === "," && depth === 0) break;
      }
      fields.push({ key: k.text, value: s.slice(i, j).trim(), string: false, done: j < s.length });
      i = j;
    }
  }
  return fields;
}
