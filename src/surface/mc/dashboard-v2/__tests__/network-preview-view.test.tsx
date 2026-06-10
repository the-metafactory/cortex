/**
 * G-1114.A — render test for the Network (preview) stub tab.
 *
 * Walks the rendered React tree (no DOM harness — same approach as
 * markdown.test.tsx) to assert the placeholder renders, names the preview
 * status, and lists the four `agent`-domain presence actions. NO data wiring is
 * exercised because there is none (inert grounding slice).
 */

import { describe, it, expect } from "bun:test";
import { createElement, isValidElement, type ReactNode } from "react";
import { NetworkPreviewView } from "../components/network-preview-view";

interface El {
  type: unknown;
  props: { className?: string; children?: ReactNode; "aria-label"?: string };
}

function isEl(node: unknown): node is El {
  return isValidElement(node);
}

function collectText(node: ReactNode): string {
  let out = "";
  function walk(n: ReactNode): void {
    if (n == null || typeof n === "boolean") return;
    if (typeof n === "string" || typeof n === "number") {
      out += String(n);
      return;
    }
    if (Array.isArray(n)) {
      for (const c of n) walk(c);
      return;
    }
    if (isEl(n)) walk(n.props.children);
  }
  walk(node);
  return out;
}

describe("NetworkPreviewView (G-1114.A stub)", () => {
  const tree = createElement(NetworkPreviewView);
  // NetworkPreviewView is a plain function component; invoke it to get its tree.
  const rendered = NetworkPreviewView();

  it("renders a section element", () => {
    expect(isValidElement(tree)).toBe(true);
    expect(isEl(rendered) && rendered.type).toBe("section");
  });

  it("labels itself a preview", () => {
    const text = collectText(rendered);
    expect(text).toContain("Network (preview)");
    expect(text).toContain("G-1114.B");
  });

  it("lists the four agent-domain presence actions", () => {
    const text = collectText(rendered);
    expect(text).toContain("agent.online");
    expect(text).toContain("agent.heartbeat");
    expect(text).toContain("agent.offline");
    expect(text).toContain("agent.capabilities-changed");
  });

  it("distinguishes presence from the dispatch-scoped heartbeat", () => {
    const text = collectText(rendered);
    expect(text).toContain("system.agent.heartbeat");
    expect(text.toLowerCase()).toContain("session interior");
  });
});
