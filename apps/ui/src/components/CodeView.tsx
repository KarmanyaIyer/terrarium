import { memo, useEffect, useState, type ReactNode } from "react";
import type { HLJSApi } from "highlight.js";
import { CopyButton } from "./ui";

// highlight.js core + a handful of grammars, loaded on first use. Its HTML output is converted
// to React nodes by a tiny tokenizer (only <span class> + entities), so nothing goes through innerHTML.

let hljsPromise: Promise<HLJSApi> | null = null;

function loadHljs(): Promise<HLJSApi> {
  hljsPromise ??= (async () => {
    const [core, py, js, ts, json, bash, yaml, ini, md, xml, css, c, diff, sql, rust, go] = await Promise.all([
      import("highlight.js/lib/core"),
      import("highlight.js/lib/languages/python"),
      import("highlight.js/lib/languages/javascript"),
      import("highlight.js/lib/languages/typescript"),
      import("highlight.js/lib/languages/json"),
      import("highlight.js/lib/languages/bash"),
      import("highlight.js/lib/languages/yaml"),
      import("highlight.js/lib/languages/ini"),
      import("highlight.js/lib/languages/markdown"),
      import("highlight.js/lib/languages/xml"),
      import("highlight.js/lib/languages/css"),
      import("highlight.js/lib/languages/c"),
      import("highlight.js/lib/languages/diff"),
      import("highlight.js/lib/languages/sql"),
      import("highlight.js/lib/languages/rust"),
      import("highlight.js/lib/languages/go"),
    ]);
    const h = core.default;
    const reg: [string, { default: Parameters<HLJSApi["registerLanguage"]>[1] }][] = [
      ["python", py], ["javascript", js], ["typescript", ts], ["json", json], ["bash", bash], ["yaml", yaml],
      ["ini", ini], ["markdown", md], ["xml", xml], ["css", css], ["c", c], ["diff", diff], ["sql", sql],
      ["rust", rust], ["go", go],
    ];
    for (const [name, mod] of reg) h.registerLanguage(name, mod.default);
    h.registerAliases(["py"], { languageName: "python" });
    h.registerAliases(["js", "mjs", "cjs", "jsx"], { languageName: "javascript" });
    h.registerAliases(["ts", "tsx", "mts"], { languageName: "typescript" });
    h.registerAliases(["sh", "shell", "zsh", "console"], { languageName: "bash" });
    h.registerAliases(["yml"], { languageName: "yaml" });
    h.registerAliases(["toml", "cfg", "conf"], { languageName: "ini" });
    h.registerAliases(["md"], { languageName: "markdown" });
    h.registerAliases(["html", "svg"], { languageName: "xml" });
    h.registerAliases(["h", "cpp", "cc"], { languageName: "c" });
    h.registerAliases(["patch"], { languageName: "diff" });
    h.registerAliases(["rs"], { languageName: "rust" });
    return h;
  })();
  return hljsPromise;
}

export function langForPath(path: string): string | undefined {
  const name = path.split("/").pop() ?? "";
  if (/^(Makefile|Dockerfile)$/.test(name)) return undefined;
  const ext = name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";
  const map: Record<string, string> = {
    py: "python", js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "javascript", ts: "typescript",
    tsx: "typescript", json: "json", sh: "bash", bash: "bash", yml: "yaml", yaml: "yaml", toml: "ini", ini: "ini",
    cfg: "ini", md: "markdown", html: "xml", xml: "xml", svg: "xml", css: "css", c: "c", h: "c", diff: "diff",
    patch: "diff", sql: "sql", rs: "rust", go: "go",
  };
  return map[ext];
}

const ENT: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#x27;": "'", "&#39;": "'" };
const decode = (s: string) => s.replace(/&(?:amp|lt|gt|quot|#x27|#39);/g, (m) => ENT[m] ?? m);

/** Splits hljs output into per-line React nodes, carrying open spans across newlines. */
function toLines(html: string): ReactNode[][] {
  const lines: ReactNode[][] = [[]];
  const stack: string[] = [];
  const re = /<span class="([^"]+)">|<\/span>|([^<]+)/g;
  let m: RegExpExecArray | null;
  let k = 0;
  while ((m = re.exec(html))) {
    if (m[1] != null) stack.push(m[1]);
    else if (m[0] === "</span>") stack.pop();
    else if (m[2] != null) {
      const parts = decode(m[2]).split("\n");
      parts.forEach((p, i) => {
        if (i > 0) lines.push([]);
        if (!p) return;
        const cls = stack.join(" ");
        lines[lines.length - 1].push(
          cls ? (
            <span key={k++} className={cls}>
              {p}
            </span>
          ) : (
            p
          ),
        );
      });
    }
  }
  return lines;
}

function useHighlighted(code: string, lang: string | undefined): ReactNode[][] | null {
  const [lines, setLines] = useState<ReactNode[][] | null>(null);
  useEffect(() => {
    let alive = true;
    setLines(null);
    if (!lang || code.length > 400_000) return;
    void loadHljs().then((h) => {
      if (!alive || !h.getLanguage(lang)) return;
      try {
        setLines(toLines(h.highlight(code, { language: lang, ignoreIllegals: true }).value));
      } catch {
        /* plain text fallback */
      }
    });
    return () => {
      alive = false;
    };
  }, [code, lang]);
  return lines;
}

/** Fenced code inside markdown. */
export const CodeBlock = memo(function CodeBlock({ code, lang }: { code: string; lang?: string }) {
  const l = lang?.split(/\s/)[0]?.toLowerCase();
  const lines = useHighlighted(code, l);
  return (
    <div className="codeblock">
      <div className="codeblock-head">
        <span className="dim">{l || "text"}</span>
        <CopyButton text={code} />
      </div>
      <pre className="selectable hljs">
        {lines ? lines.map((ln, i) => <div key={i}>{ln.length ? ln : "​"}</div>) : code}
      </pre>
    </div>
  );
});

/** File viewer with line numbers. */
export const CodeView = memo(function CodeView({ code, path, highlightLines }: { code: string; path: string; highlightLines?: Set<number> }) {
  const lang = langForPath(path);
  const hl = useHighlighted(code, lang);
  const raw = code.replace(/\n$/, "").split("\n");
  const lines = hl ?? raw.map((l) => [l] as ReactNode[]);
  const w = String(raw.length).length;
  return (
    <div className="codeview hljs selectable" style={{ ["--gutter" as string]: `${w + 2}ch` }}>
      {lines.map((ln, i) => (
        <div key={i} className={`cv-line${highlightLines?.has(i + 1) ? " hl" : ""}`}>
          <span className="cv-no">{i + 1}</span>
          <span className="cv-text">{ln.length ? ln : "​"}</span>
        </div>
      ))}
    </div>
  );
});
