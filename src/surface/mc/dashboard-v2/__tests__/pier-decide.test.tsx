/**
 * MC-B2 (cortex#1279) — static render tests for PierDecideForm (no DOM harness;
 * the interactive behaviour is covered by pier-decide-lib.test.ts). Asserts: no
 * action surface without an admin network; both action buttons render disabled
 * initially (typed-confirm not yet satisfied); a single admin network renders as
 * a label and multiple as a select.
 */

import { describe, it, expect } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { PierDecideForm } from "../components/pier-decide";

function render(adminNetworks: readonly string[]): string {
  return renderToStaticMarkup(createElement(PierDecideForm, { adminNetworks }));
}

describe("PierDecideForm", () => {
  it("renders nothing when the principal admins no networks", () => {
    expect(render([])).toBe("");
  });

  it("renders Grant + Reject, both disabled before a request id is entered", () => {
    const html = render(["alpha"]);
    expect(html).toContain("Grant");
    expect(html).toContain("Reject");
    // Initial state: no request id, no confirm → both actions disabled.
    const disabledButtons = html.match(/<button[^>]*disabled/g) ?? [];
    expect(disabledButtons.length).toBe(2);
  });

  it("renders a single admin network as a static label (no select)", () => {
    const html = render(["alpha"]);
    expect(html).toContain("alpha");
    expect(html).not.toContain("<select");
  });

  it("renders multiple admin networks as a select with an option each", () => {
    const html = render(["alpha", "beta"]);
    expect(html).toContain("<select");
    expect(html).toContain("alpha");
    expect(html).toContain("beta");
  });

  it("mentions the list-pending source so the principal knows where to get the id", () => {
    const html = render(["alpha"]);
    expect(html).toContain("--list-pending");
  });
});
