import { createElement, Fragment, type ReactNode } from "react";

const URL_RE = /https?:\/\/[^\s<>]+[^\s.,!?:;<>)\]]/g;
const FENCE_RE = /^```([a-z0-9_+-]+)?\s*$/i;

export function renderMarkdown(src: string): ReactNode {
  if (!src) return null;
  return <>{splitIntoBlocks(src).map(renderBlock)}</>;
}

type HeadingTag = "h1" | "h2" | "h3" | "h4" | "h5" | "h6";
type Block =
  | { type: "paragraph"; text: string }
  | { type: "code"; text: string; lang?: string }
  | { type: "heading"; text: string; tag: HeadingTag }
  | { type: "list"; items: string[]; start: number | null }
  | { type: "quote"; text: string }
  | { type: "table"; header: string[]; align: CellAlign[]; rows: string[][] };

type CellAlign = "left" | "center" | "right" | undefined;

const HEADING_TAGS: HeadingTag[] = ["h1", "h2", "h3", "h4", "h5", "h6"];
const HEADING_RE = /^(#{1,6})[ \t]+(.*)$/;
const LIST_RE = /^\s*(?:([-+*])|(\d+)[.)])\s+(.+)$/;
const QUOTE_RE = /^\s*>\s?(.*)$/;
const WORD_RE = /[\p{L}\p{N}_]/u;
const TABLE_DELIMITER_CELL_RE = /^:?-+:?$/;

function splitTableRow(line: string): string[] {
  let row = line.trim();
  if (row.startsWith("|")) row = row.slice(1);
  if (row.endsWith("|") && !row.endsWith("\\|")) row = row.slice(0, -1);
  const cells: string[] = [];
  let cell = "";
  for (let i = 0; i < row.length; i++) {
    const ch = row[i];
    if (ch === "\\" && row[i + 1] === "|") { cell += "|"; i++; continue; }
    if (ch === "|") { cells.push(cell.trim()); cell = ""; continue; }
    cell += ch ?? "";
  }
  cells.push(cell.trim());
  return cells;
}

function tableAlignment(line: string): CellAlign[] | null {
  if (!line.includes("-") || !line.includes("|")) return null;
  const cells = splitTableRow(line);
  if (!cells.every((c) => TABLE_DELIMITER_CELL_RE.test(c))) return null;
  return cells.map((c) => {
    const left = c.startsWith(":");
    const right = c.endsWith(":");
    if (left && right) return "center";
    if (right) return "right";
    return left ? "left" : undefined;
  });
}

function isTableRow(line: string): boolean {
  return line.includes("|") && line.trim() !== "";
}

function continuesTable(line: string): boolean {
  return line.trim() !== "" && ![FENCE_RE, HEADING_RE, QUOTE_RE, LIST_RE].some((re) => re.test(line));
}

function cellStyle(align: CellAlign): { textAlign: CellAlign } | undefined {
  return align ? { textAlign: align } : undefined;
}

function fitRow(cells: string[], width: number): string[] {
  return Array.from({ length: width }, (_, i) => cells[i] ?? "");
}

function headingText(raw: string): string {
  const text = raw.trim();
  let end = text.length;
  while (end > 0 && text[end - 1] === "#") end--;
  if (end === 0) return "";
  return text[end - 1] === " " || text[end - 1] === "\t" ? text.slice(0, end).trimEnd() : text;
}

function renderBlock(block: Block, key: number): ReactNode {
  switch (block.type) {
    case "paragraph": return <p key={key} className="md-paragraph">{renderInline(block.text)}</p>;
    case "code": return <pre key={key} className="md-code-block" data-lang={block.lang ?? ""}><code>{block.text}</code></pre>;
    case "heading": return createElement(block.tag, { key }, renderInline(block.text));
    case "list": {
      const items = block.items.map((text, i) => <li key={i}>{renderInline(text)}</li>);
      return block.start === null ? <ul key={key}>{items}</ul> : <ol key={key} start={block.start}>{items}</ol>;
    }
    case "quote": return <blockquote key={key}><p className="md-paragraph">{renderInline(block.text)}</p></blockquote>;
    case "table": return (
      <div key={key} className="md-table-wrap">
        <table className="md-table">
          <thead><tr>{block.header.map((cell, i) => <th key={i} style={cellStyle(block.align[i])}>{renderInline(cell)}</th>)}</tr></thead>
          {block.rows.length > 0 && <tbody>{block.rows.map((row, r) => <tr key={r}>{row.map((cell, i) => <td key={i} style={cellStyle(block.align[i])}>{renderInline(cell)}</td>)}</tr>)}</tbody>}
        </table>
      </div>
    );
    default: {
      const exhaustive: never = block;
      return exhaustive;
    }
  }
}

function splitIntoBlocks(src: string): Block[] {
  const lines = src.split("\n");
  const blocks: Block[] = [];
  let i = 0;
  let para: string[] = [];
  const flush = (): void => {
    if (para.length) blocks.push({ type: "paragraph", text: para.join("\n") });
    para = [];
  };
  while (i < lines.length) {
    const line = lines[i] ?? "";
    const fence = FENCE_RE.exec(line);
    const heading = HEADING_RE.exec(line);
    const list = LIST_RE.exec(line);
    const quote = QUOTE_RE.exec(line);
    const align = isTableRow(line) ? tableAlignment(lines[i + 1] ?? "") : null;
    const header = align ? splitTableRow(line) : [];
    if (align && header.length === align.length) {
      flush();
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && continuesTable(lines[i] ?? "")) rows.push(fitRow(splitTableRow(lines[i++] ?? ""), header.length));
      blocks.push({ type: "table", header, align, rows });
    } else if (fence) {
      flush();
      const code: string[] = [];
      i++;
      while (i < lines.length && !FENCE_RE.test(lines[i] ?? "")) code.push(lines[i++] ?? "");
      i++;
      blocks.push({ type: "code", text: code.join("\n"), ...(fence[1] ? { lang: fence[1] } : {}) });
    } else if (heading) {
      flush();
      blocks.push({ type: "heading", text: headingText(heading[2] ?? ""), tag: HEADING_TAGS[(heading[1]?.length ?? 1) - 1] ?? "h6" });
      i++;
    } else if (list) {
      flush();
      const ordered = list[2] !== undefined;
      const items: string[] = [];
      let item: RegExpExecArray | null = list;
      while (item && (item[2] !== undefined) === ordered) {
        items.push(item[3] ?? "");
        item = LIST_RE.exec(lines[++i] ?? "");
      }
      const first = Number(list[2]);
      const start = Number.isSafeInteger(first) ? first : 1;
      blocks.push({ type: "list", items, start: ordered ? start : null });
    } else if (quote) {
      flush();
      const quoted: string[] = [];
      let part: RegExpExecArray | null = quote;
      while (part) {
        quoted.push(part[1] ?? "");
        part = QUOTE_RE.exec(lines[++i] ?? "");
      }
      blocks.push({ type: "quote", text: quoted.join("\n") });
    } else {
      if (line.trim()) para.push(line);
      else flush();
      i++;
    }
  }
  flush();
  return blocks;
}

function renderInline(text: string): ReactNode {
  const parts: ReactNode[] = [];
  let buf = "";
  let i = 0;
  let key = 0;
  const flush = () => {
    if (buf.length === 0) return;
    parts.push(<Fragment key={key++}>{renderLabelledLinks(buf, () => key++)}</Fragment>);
    buf = "";
  };
  while (i < text.length) {
    const ch = text[i];
    if (ch === "`") {
      const end = text.indexOf("`", i + 1);
      if (end >= 0) {
        flush();
        parts.push(<code key={key++} className="md-inline-code">{text.slice(i + 1, end)}</code>);
        i = end + 1;
        continue;
      }
    }
    buf += ch ?? "";
    i++;
  }
  flush();
  return <>{parts}</>;
}

const LABELLED_LINK_RE = /\[([^[\]\n]+)\]\(((?:[^()\s]|\([^()\s]*\))+)\)/g;

function safeHref(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" || url.protocol === "mailto:" ? url.href : null;
  } catch {
    return null;
  }
}

function renderLabelledLinks(text: string, nextKey: () => number): ReactNode {
  const parts: ReactNode[] = [];
  let cursor = 0;
  LABELLED_LINK_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = LABELLED_LINK_RE.exec(text)) !== null) {
    parts.push(<Fragment key={nextKey()}>{renderBoldItalicAndLinks(text.slice(cursor, match.index), nextKey)}</Fragment>);
    const label = match[1] ?? "";
    const href = safeHref(match[2] ?? "");
    parts.push(href ? <a key={nextKey()} href={href} target="_blank" rel="noopener noreferrer" className="md-link">{renderBoldItalic(label, nextKey)}</a> : <Fragment key={nextKey()}>{label}</Fragment>);
    cursor = match.index + match[0].length;
  }
  parts.push(<Fragment key={nextKey()}>{renderBoldItalicAndLinks(text.slice(cursor), nextKey)}</Fragment>);
  return <>{parts}</>;
}

function renderBoldItalicAndLinks(text: string, nextKey: () => number): ReactNode {
  const urlMatches: { start: number; end: number; url: string }[] = [];
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
    const marker = text[i];
    const opening = marker === "*" || (marker === "_" && !WORD_RE.test(text[i - 1] ?? ""));
    if (opening && i + 1 < text.length && text[i + 1] !== marker) {
      let end = text.indexOf(marker, i + 1);
      while (marker === "_" && end >= 0 && WORD_RE.test(text[end + 1] ?? "")) end = text.indexOf(marker, end + 1);
      if (end > i + 1) {
        if (buf) { parts.push(buf); buf = ""; }
        parts.push(<em key={nextKey()}>{text.slice(i + 1, end)}</em>);
        i = end + 1;
        continue;
      }
    }
    buf += text[i] ?? "";
    i++;
  }
  if (buf) parts.push(buf);
  return <>{parts}</>;
}
