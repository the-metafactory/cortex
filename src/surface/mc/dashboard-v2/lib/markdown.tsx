/**
 * Minimal markdown renderer — text only, no library dependency.
 *
 * Per migration addendum Decision 11, assistant text and principal input
 * render as markdown. We support a tight subset:
 *  - Triple-backtick fenced code blocks (with optional language tag)
 *  - Single-backtick inline code
 *  - Bold (**text**) and italic (*text* or _text_)
 *  - Hyperlinks: <https://…> and bare URLs
 *  - Hard line-breaks preserved
 *
 * Anything more (headings, tables, footnotes) is out of scope. Principals
 * who paste richer content still see plain text — readable, not styled.
 *
 * React's default text-content escaping is the XSS safety guarantee.
 * We never use `dangerouslySetInnerHTML`.
 */

import { Fragment, type ReactNode } from "react";

const URL_RE = /https?:\/\/[^\s<>]+[^\s.,!?:;<>)\]]/g;
const FENCE_RE = /^```([a-z0-9_+-]+)?\s*$/i;

export function renderMarkdown(src: string): ReactNode {
  if (!src) return null;
  const blocks = splitIntoBlocks(src);
  return (
    <>
      {blocks.map((b, i) =>
        b.type === "code" ? (
          <pre key={i} className="md-code-block" data-lang={b.lang ?? ""}>
            <code>{b.text}</code>
          </pre>
        ) : (
          <p key={i} className="md-paragraph">{renderInline(b.text)}</p>
        )
      )}
    </>
  );
}

interface ParagraphBlock { type: "paragraph"; text: string }
interface CodeBlock { type: "code"; text: string; lang?: string }
type Block = ParagraphBlock | CodeBlock;

function splitIntoBlocks(src: string): Block[] {
  const lines = src.split("\n");
  const blocks: Block[] = [];
  let i = 0;
  let para: string[] = [];

  function flushPara() {
    if (para.length === 0) return;
    blocks.push({ type: "paragraph", text: para.join("\n") });
    para = [];
  }

  while (i < lines.length) {
    const line = lines[i]!;
    const fence = line.match(FENCE_RE);
    if (fence) {
      flushPara();
      const lang = fence[1];
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !FENCE_RE.test(lines[i]!)) {
        codeLines.push(lines[i]!);
        i++;
      }
      i++; // skip closing fence (or EOF)
      const block: CodeBlock = { type: "code", text: codeLines.join("\n") };
      if (lang) block.lang = lang;
      blocks.push(block);
      continue;
    }
    para.push(line);
    i++;
  }
  flushPara();
  return blocks;
}

function renderInline(text: string): ReactNode {
  // Sequentially: code spans → bold/italic → URLs.
  // Tokenise into plain-text + special-segment chunks, render each.
  const parts: ReactNode[] = [];
  let buf = "";
  let i = 0;
  let key = 0;
  const flush = () => {
    if (buf.length === 0) return;
    parts.push(<Fragment key={key++}>{renderBoldItalicAndLinks(buf, () => key++)}</Fragment>);
    buf = "";
  };
  while (i < text.length) {
    const ch = text[i];
    if (ch === "`") {
      // inline code — find closing backtick
      const end = text.indexOf("`", i + 1);
      if (end >= 0) {
        flush();
        parts.push(<code key={key++} className="md-inline-code">{text.slice(i + 1, end)}</code>);
        i = end + 1;
        continue;
      }
    }
    buf += ch;
    i++;
  }
  flush();
  return <>{parts}</>;
}

function renderBoldItalicAndLinks(text: string, nextKey: () => number): ReactNode {
  // Auto-link URLs first, then bold/italic on the residue. Order matters
  // to avoid matching `**` inside an `https://…/path/with/**`-improbable
  // edge case.
  const urlMatches: Array<{ start: number; end: number; url: string }> = [];
  URL_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = URL_RE.exec(text)) !== null) {
    urlMatches.push({ start: m.index, end: m.index + m[0].length, url: m[0] });
  }

  if (urlMatches.length === 0) {
    return renderBoldItalic(text, nextKey);
  }

  const parts: ReactNode[] = [];
  let cursor = 0;
  for (const u of urlMatches) {
    if (u.start > cursor) {
      parts.push(<Fragment key={nextKey()}>{renderBoldItalic(text.slice(cursor, u.start), nextKey)}</Fragment>);
    }
    parts.push(
      <a
        key={nextKey()}
        href={u.url}
        target="_blank"
        rel="noopener noreferrer"
        className="md-link"
      >{u.url}</a>
    );
    cursor = u.end;
  }
  if (cursor < text.length) {
    parts.push(<Fragment key={nextKey()}>{renderBoldItalic(text.slice(cursor), nextKey)}</Fragment>);
  }
  return <>{parts}</>;
}

function renderBoldItalic(text: string, nextKey: () => number): ReactNode {
  // Bold (**…**) takes precedence over italic (*…*).
  const parts: ReactNode[] = [];
  let i = 0;
  let buf = "";
  while (i < text.length) {
    if (text.startsWith("**", i)) {
      const end = text.indexOf("**", i + 2);
      if (end > i + 2) {
        if (buf) { parts.push(buf); buf = ""; }
        parts.push(<strong key={nextKey()}>{text.slice(i + 2, end)}</strong>);
        i = end + 2;
        continue;
      }
    }
    if (text[i] === "*" && i + 1 < text.length && text[i + 1] !== "*") {
      const end = text.indexOf("*", i + 1);
      if (end > i + 1) {
        if (buf) { parts.push(buf); buf = ""; }
        parts.push(<em key={nextKey()}>{text.slice(i + 1, end)}</em>);
        i = end + 1;
        continue;
      }
    }
    buf += text[i];
    i++;
  }
  if (buf) parts.push(buf);
  return <>{parts}</>;
}
