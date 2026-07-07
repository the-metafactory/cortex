/**
 * CK-4b (cortex#1295) — cross-stack WORKING aggregate render tests (DOM-free via
 * renderToStaticMarkup). Pins: tiles keyed on schema origin, session-tree child
 * (sub-agent) counts, honest queued/provider-retry copy (NO "awaiting hands" —
 * D-9), and the metadata-only boundary (no drill affordance, ADR-0005).
 */

import { describe, it, expect } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { WorkingAggregate } from "../components/working-aggregate";
import type { WorkingStackAggregate } from "../hooks/use-working-aggregation";

function agg(over: Partial<WorkingStackAggregate> = {}): WorkingStackAggregate {
  return {
    originStackId: null,
    activeSessionCount: 1,
    subAgentCount: 0,
    providerRetry: null,
    ...over,
  };
}

function render(aggregates: WorkingStackAggregate[], loaded = true, error: string | null = null): string {
  return renderToStaticMarkup(
    createElement(WorkingAggregate, { aggregates, loaded, error })
  );
}

describe("WorkingAggregate — cross-stack metadata tiles", () => {
  it("renders one tile per origin, labelled by schema origin (local + cross-stack)", () => {
    const html = render([
      agg({ originStackId: null, activeSessionCount: 2 }),
      agg({ originStackId: "andreas/work", activeSessionCount: 3 }),
      agg({ originStackId: "jc/home", activeSessionCount: 1 }),
    ]);
    expect(html).toContain('data-origin="local"');
    expect(html).toContain('data-origin="andreas/work"');
    expect(html).toContain('data-origin="jc/home"');
    // three distinct tiles.
    expect((html.match(/working-aggregate-tile/g) ?? []).length).toBe(3);
  });

  it("tags the own/local origin distinctly from a cross-stack (peer/sibling) origin", () => {
    const html = render([
      agg({ originStackId: null }),
      agg({ originStackId: "jc/home" }),
    ]);
    expect(html).toContain('data-origin-kind="local"');
    expect(html).toContain('data-origin-kind="cross-stack"');
    expect(html).toContain("this stack");
  });

  it("renders session-tree child (sub-agent) counts as accessible text", () => {
    const html = render([agg({ activeSessionCount: 4, subAgentCount: 2 })]);
    expect(html).toContain("4 working");
    expect(html).toContain("2 sub-agents");
  });

  it("renders singular sub-agent + honest zero", () => {
    expect(render([agg({ subAgentCount: 1 })])).toContain("1 sub-agent");
    expect(render([agg({ subAgentCount: 0 })])).toContain("no sub-agents");
  });

  it("renders the honest queued/provider-retry chip — NEVER 'awaiting hands' (D-9)", () => {
    const html = render([
      agg({ activeSessionCount: 0, providerRetry: { state: "not_now", retryAfterMs: 4000 } }),
    ]);
    expect(html).toContain("queued");
    expect(html).toContain("retry in 4s");
    // The deferred SPX-3 capacity copy must not appear pre-release.
    expect(html).not.toContain("awaiting hands");
    expect(html).not.toContain("hands");
  });

  it("omits the queued chip entirely when there is no pending back-pressure", () => {
    const html = render([agg({ providerRetry: null })]);
    expect(html).not.toContain("working-aggregate-queued");
    expect(html).not.toContain("queued");
  });

  it("is METADATA-ONLY: no drill affordance (no button / onClick target)", () => {
    const html = render([
      agg({ originStackId: "jc/home", activeSessionCount: 5, subAgentCount: 1 }),
    ]);
    // A federated peer tile must never expose an interactive drill control.
    expect(html).not.toContain("<button");
    expect(html).not.toContain('role="button"');
  });

  it("shows an honest empty state when loaded with no rollups", () => {
    expect(render([])).toContain("No stacks working right now.");
  });

  it("shows a loading state pre-boot", () => {
    expect(render([], false, null)).toContain("Loading…");
  });

  it("surfaces a boot error", () => {
    const html = render([], true, "HTTP 500");
    expect(html).toContain("HTTP 500");
  });
});
