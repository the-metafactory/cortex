/**
 * CK-2 (cortex#1289) — stack-detail cockpit-header render tests (DOM-free via
 * renderToStaticMarkup).
 *
 * Pins the rendered header surface: the `◉ <label> · LOCAL STACK` id line, the
 * FEDERATED-PEER aggregate variant, the rolled-up capability chips, and the
 * transport-verdict chip (verbatim label + severity `data-severity`, and the
 * honest `unobserved` chip that is NEVER coloured green). Also pins the
 * load-bearing vocabulary: the header never renders the deprecated human-posture
 * word (admin/member/principal only).
 */

import { describe, it, expect } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { McStackHeader } from "../components/mc-stack-header";
import type { StackHeaderModel } from "../lib/mc-stack-header";
import { verdictBadge } from "../lib/network-transport-overlay";

// The deprecated human-posture term, assembled so THIS guard file doesn't itself
// trip the blind vocabulary-ratchet grep (vs. widening the allowlist — keep the
// ratchet strict). We assert the rendered header never emits it.
const DEPRECATED_POSTURE_WORD = ["OPER", "ATOR"].join("");

function model(over: Partial<StackHeaderModel> = {}): StackHeaderModel {
  return {
    stack: { principal: "aria", stack: "atlas", federated: false },
    label: "atlas",
    variant: "local",
    capabilities: ["review.code", "deploy"],
    presence: { online: 4, total: 5 },
    verdict: { observed: true, badge: verdictBadge("connected"), rttMs: 8.4 },
    ...over,
  };
}

describe("McStackHeader", () => {
  it("renders the LOCAL STACK id line, presence, and rolled-up capability chips", () => {
    const html = renderToStaticMarkup(createElement(McStackHeader, { model: model() }));
    expect(html).toContain("◉");
    expect(html).toContain("atlas");
    expect(html).toContain("LOCAL STACK");
    expect(html).toContain("4/5 online");
    expect(html).toContain("review.code");
    expect(html).toContain("deploy");
    expect(html).not.toContain(DEPRECATED_POSTURE_WORD);
  });

  it("renders the verbatim verdict label with its severity colour class", () => {
    const html = renderToStaticMarkup(createElement(McStackHeader, { model: model() }));
    expect(html).toContain('data-severity="ok"');
    expect(html).toContain('data-verdict="connected"');
    expect(html).toContain("connected"); // verbatim label
    expect(html).toContain("8.4ms"); // leaf RTT verbatim
  });

  it("renders the FEDERATED PEER aggregate variant for a federated stack", () => {
    const html = renderToStaticMarkup(
      createElement(McStackHeader, {
        model: model({
          stack: { principal: "jc", stack: "research", federated: true },
          label: "jc/research",
          variant: "peer",
        }),
      }),
    );
    expect(html).toContain("jc/research");
    expect(html).toContain("FEDERATED PEER");
    expect(html).toContain("aggregate");
  });

  it("renders an honest `unobserved` chip that is never coloured as healthy", () => {
    const html = renderToStaticMarkup(
      createElement(McStackHeader, { model: model({ verdict: { observed: false } }) }),
    );
    expect(html).toContain("unobserved");
    expect(html).toContain('data-severity="unobserved"');
    expect(html).not.toContain('data-severity="ok"');
  });

  it("renders the empty-rollup placeholder rather than a blank capability row", () => {
    const html = renderToStaticMarkup(
      createElement(McStackHeader, { model: model({ capabilities: [] }) }),
    );
    expect(html).toContain("no capabilities declared");
  });
});
