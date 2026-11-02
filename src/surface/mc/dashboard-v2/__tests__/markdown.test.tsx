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
});
