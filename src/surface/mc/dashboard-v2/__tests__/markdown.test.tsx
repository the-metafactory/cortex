/**
 * lib/markdown unit tests — minimal renderer.
 *
 * The renderer returns React nodes; we walk the resulting tree for the
 * structural assertions instead of dragging in a JSX-rendering test
 * harness. Children are inspected via the React-internals `props` shape
 * which is stable across React 18/19.
 */

import { describe, it, expect } from "bun:test";
import { isValidElement, type ReactNode } from "react";
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
    if (Array.isArray(n)) { for (const c of n) walk(c); return; }
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
});
