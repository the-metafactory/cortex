import { describe, it, expect } from "bun:test";
import { isValidElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DrillRowList, type LogRow } from "../components/drill-log";
import { renderMarkdown } from "../lib/markdown";

interface Element {
  type: unknown;
  props: { className?: string; children?: ReactNode; href?: string };
}

function isEl(node: unknown): node is Element {
  return isValidElement(node);
}

function flatten(node: ReactNode): Element[] {
  const out: Element[] = [];
  function walk(n: ReactNode): void {
    if (Array.isArray(n)) { n.forEach(walk); return; }
    if (isEl(n)) {
      out.push(n);
      walk(n.props.children);
    }
  }
  walk(node);
  return out;
}

describe("lib/markdown", () => {
  it("returns null on empty input", () => {
    expect(renderMarkdown("")).toBeNull();
  });

  it("wraps plain text in a single .md-paragraph", () => {
    const tree = renderMarkdown("hello world");
    const els = flatten(tree);
    const para = els.find((e) => e.props.className === "md-paragraph");
    expect(para).toBeDefined();
  });

  it("emits a fenced code block with .md-code-block", () => {
    const tree = renderMarkdown("```\nconst x = 1;\n```");
    const els = flatten(tree);
    const code = els.find((e) => e.props.className === "md-code-block");
    expect(code).toBeDefined();
  });

  it("emits inline code with .md-inline-code", () => {
    const tree = renderMarkdown("the `foo` thing");
    const els = flatten(tree);
    const inline = els.find((e) => e.props.className === "md-inline-code");
    expect(inline).toBeDefined();
  });

  it("auto-links bare URLs as <a className='md-link'>", () => {
    const tree = renderMarkdown("see https://example.com/path now");
    const els = flatten(tree);
    const link = els.find((e) => e.props.className === "md-link");
    expect(link).toBeDefined();
    expect(link?.props.href).toBe("https://example.com/path");
  });

  it("renders **bold** as <strong> and *italic* as <em>", () => {
    const tree = renderMarkdown("**big** and *small*");
    const els = flatten(tree);
    const strong = els.find((e) => e.type === "strong");
    const em = els.find((e) => e.type === "em");
    expect(strong).toBeDefined();
    expect(em).toBeDefined();
  });

  it("preserves a leading code fence with no closing fence (treats EOF as close)", () => {
    const tree = renderMarkdown("```\nunterminated");
    const els = flatten(tree);
    const code = els.find((e) => e.props.className === "md-code-block");
    expect(code).toBeDefined();
  });

  it.each(["javascript:alert", "JaVaScRiPt:alert", "java\u0000script:alert", "java&#x73;cript:alert", "javascript%3Aalert", "data:text/html,attack", "vbscript:attack", "file:///tmp/probe", "//example.com"])("does not link the untrusted destination %s", destination => {
    const html = renderToStaticMarkup(<>{renderMarkdown(`[Unsafe](${destination})`)}</>);
    expect(html).not.toContain("<a ");
  });

  it("keeps structured Markdown valid in both existing drill-log callers", () => {
    const common = { ts: "2026-01-01T10:00:00Z", color: "none", weight: "primary", text: "## Heading\n\n- A task" } as const;
    const rows: LogRow[] = [{ ...common, id: "a", kind: "assistant.text" }, { ...common, id: "b", kind: "principal.input" }];
    const html = renderToStaticMarkup(<DrillRowList rows={rows} loaded hasMore={false} error={null} isInitiallyEmpty={false} />);
    expect(html.split('<div class="text"><h2>Heading</h2><ul><li>A task</li></ul></div>')).toHaveLength(3);
    expect(html).not.toContain("<p><h2>");
    expect(html).not.toContain("<p><ul>");
  });

  it("preserves snake_case and path underscores while rendering delimited emphasis", () => {
    const html = renderToStaticMarkup(<>{renderMarkdown("foo_bar_baz session_schema and user_id with (_quiet_) words")}</>);
    expect(html).toContain("foo_bar_baz session_schema and user_id");
    expect(html).toContain("(<em>quiet</em>)");
  });

  it("preserves balanced parentheses in a labelled link destination", () => {
    const html = renderToStaticMarkup(<>{renderMarkdown("[A guide](https://example.com/guide_(paper))")}</>);
    expect(html).toContain('href="https://example.com/guide_(paper)"');
    expect(html).toContain('class="md-link">A guide</a></p>');
  });

  it("renders a GFM pipe table with header, alignment and inline markdown in cells", () => {
    const md = "Results:\n\n| Name | Count |\n|:-----|------:|\n| **a** | `1` |\n| b \\| c | 2 |\n\nAfter.";
    const html = renderToStaticMarkup(<>{renderMarkdown(md)}</>);
    expect(html).toContain('<p class="md-paragraph">Results:</p><div class="md-table-wrap"><table class="md-table"><thead><tr><th style="text-align:left">Name</th><th style="text-align:right">Count</th></tr></thead>');
    expect(html).toContain('<tr><td style="text-align:left"><strong>a</strong></td><td style="text-align:right"><code class="md-inline-code">1</code></td></tr>');
    expect(html).toContain('<td style="text-align:left">b | c</td>');
    expect(html).toContain('</table></div><p class="md-paragraph">After.</p>');
  });

  it("pads short rows and drops extra cells", () => {
    const html = renderToStaticMarkup(<>{renderMarkdown("a | b\n--|--\n1\n`x\\|y` | 2 | 3")}</>);
    expect(html).toContain("<tbody><tr><td>1</td><td></td></tr><tr><td><code class=\"md-inline-code\">x|y</code></td><td>2</td></tr></tbody>");
  });

  it("splits an unclosed backtick cell on the next pipe and needs a pipe in the delimiter row", () => {
    expect(renderToStaticMarkup(<>{renderMarkdown("a | b\n--|--\n`x | y")}</>)).toContain("<td>`x</td><td>y</td>");
    expect(renderToStaticMarkup(<>{renderMarkdown("| a |\n---")}</>)).not.toContain("<table");
  });

  it("ends a table at the next block", () => {
    const html = renderToStaticMarkup(<>{renderMarkdown("a | b\n--|--\n1 | 2\n## Next")}</>);
    expect(html).toContain("</table></div><h2>Next</h2>");
  });

  it("leaves a pipe line without a delimiter row as a paragraph", () => {
    const html = renderToStaticMarkup(<>{renderMarkdown("a | b\nc | d")}</>);
    expect(html).not.toContain("<table");
    expect(html).toContain('<p class="md-paragraph">a | b\nc | d</p>');
  });
});
