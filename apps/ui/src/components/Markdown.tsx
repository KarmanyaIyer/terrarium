import { memo, type ReactNode } from "react";
import { Lexer, type Token, type Tokens } from "marked";
import { CodeBlock } from "./CodeView";

// Model text is untrusted: tokens are rendered as React elements only. Raw HTML is shown as text,
// links don't navigate, images are never fetched (a remote image URL could leak data).

function inline(tokens: Token[] | undefined, key: string): ReactNode[] {
  if (!tokens) return [];
  return tokens.map((t, i) => {
    const k = `${key}.${i}`;
    switch (t.type) {
      case "text": {
        const tt = t as Tokens.Text;
        return tt.tokens ? <span key={k}>{inline(tt.tokens, k)}</span> : tt.text;
      }
      case "escape":
        return (t as Tokens.Escape).text;
      case "strong":
        return <strong key={k}>{inline((t as Tokens.Strong).tokens, k)}</strong>;
      case "em":
        return <em key={k}>{inline((t as Tokens.Em).tokens, k)}</em>;
      case "del":
        return <del key={k}>{inline((t as Tokens.Del).tokens, k)}</del>;
      case "codespan":
        return <code key={k}>{(t as Tokens.Codespan).text}</code>;
      case "br":
        return <br key={k} />;
      case "link": {
        const l = t as Tokens.Link;
        return (
          <span key={k} className="md-link" title={l.href}>
            {inline(l.tokens, k)}
          </span>
        );
      }
      case "image": {
        const im = t as Tokens.Image;
        return (
          <span key={k} className="md-image" title={im.href}>
            [image: {im.text || im.href}]
          </span>
        );
      }
      case "html":
        return <span key={k}>{(t as Tokens.HTML).text}</span>;
      default:
        return <span key={k}>{(t as { raw?: string }).raw ?? ""}</span>;
    }
  });
}

function block(tokens: Token[], key: string): ReactNode[] {
  return tokens.map((t, i) => {
    const k = `${key}-${i}`;
    switch (t.type) {
      case "space":
        return null;
      case "paragraph":
        return <p key={k}>{inline((t as Tokens.Paragraph).tokens, k)}</p>;
      case "heading": {
        const h = t as Tokens.Heading;
        const Tag = (`h${Math.min(6, Math.max(3, h.depth + 2))}`) as "h3" | "h4" | "h5" | "h6";
        return <Tag key={k}>{inline(h.tokens, k)}</Tag>;
      }
      case "code": {
        const c = t as Tokens.Code;
        return <CodeBlock key={k} code={c.text} lang={c.lang} />;
      }
      case "blockquote":
        return <blockquote key={k}>{block((t as Tokens.Blockquote).tokens, k)}</blockquote>;
      case "hr":
        return <hr key={k} />;
      case "list": {
        const l = t as Tokens.List;
        const items = l.items.map((it, j) => (
          <li key={`${k}.${j}`}>
            {it.task && <input type="checkbox" checked={!!it.checked} readOnly disabled />}
            {block(it.tokens, `${k}.${j}`)}
          </li>
        ));
        return l.ordered ? (
          <ol key={k} start={typeof l.start === "number" ? l.start : undefined}>
            {items}
          </ol>
        ) : (
          <ul key={k}>{items}</ul>
        );
      }
      case "table": {
        const tb = t as Tokens.Table;
        return (
          <div key={k} className="md-table-wrap">
            <table className="md-table">
              <thead>
                <tr>
                  {tb.header.map((h, j) => (
                    <th key={j} style={{ textAlign: tb.align[j] ?? undefined }}>
                      {inline(h.tokens, `${k}h${j}`)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {tb.rows.map((row, r) => (
                  <tr key={r}>
                    {row.map((cell, j) => (
                      <td key={j} style={{ textAlign: tb.align[j] ?? undefined }}>
                        {inline(cell.tokens, `${k}r${r}c${j}`)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      }
      case "html":
        return (
          <pre key={k} className="md-raw">
            {(t as Tokens.HTML).text}
          </pre>
        );
      case "text": {
        const tt = t as Tokens.Text;
        return <p key={k}>{tt.tokens ? inline(tt.tokens, k) : tt.text}</p>;
      }
      default:
        return (
          <p key={k} className="md-raw">
            {(t as { raw?: string }).raw ?? ""}
          </p>
        );
    }
  });
}

export const Markdown = memo(function Markdown({ text }: { text: string }) {
  let tokens: Token[];
  try {
    tokens = Lexer.lex(text, { gfm: true, breaks: false });
  } catch {
    return <pre className="md-raw">{text}</pre>;
  }
  return <div className="md selectable">{block(tokens, "b")}</div>;
});
