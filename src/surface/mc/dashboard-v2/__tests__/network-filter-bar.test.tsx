/**
 * G-1114.D.5 — NetworkFilterBar render tests.
 *
 * Pure presentational component (no hooks / no xyflow) → renders under
 * `renderToStaticMarkup` like the other D-phase card inners. Asserts the state
 * toggle reflects the active filter, the capability dropdown lists the options +
 * marks the selection, the Clear affordance shows only when a filter is active,
 * and the spotlight trigger renders.
 */

import { describe, it, expect } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { NetworkFilterBar } from "../components/network-filter-bar";
import type { NetworkFilterBarProps } from "../components/network-filter-bar";
import { DEFAULT_NETWORK_FILTER } from "../lib/network-graph-filter";

function render(over: Partial<NetworkFilterBarProps> = {}): string {
  const props: NetworkFilterBarProps = {
    filter: DEFAULT_NETWORK_FILTER,
    capabilityOptions: ["moderate", "review.code"],
    onStateChange: () => {},
    onCapabilityChange: () => {},
    onScopeChange: () => {},
    onClear: () => {},
    onOpenSpotlight: () => {},
    ...over,
  };
  return renderToStaticMarkup(createElement(NetworkFilterBar, props));
}

describe("NetworkFilterBar — state toggle (G-1114.D.5)", () => {
  it("renders the three state options", () => {
    const html = render();
    expect(html).toContain('data-state-filter="all"');
    expect(html).toContain('data-state-filter="online"');
    expect(html).toContain('data-state-filter="offline"');
  });

  it("marks the active state with aria-pressed", () => {
    const html = render({ filter: { state: "online", capability: null, scope: "include-federated" } });
    // The online button is pressed; all is not.
    expect(html).toContain('aria-pressed="true" data-state-filter="online"');
    expect(html).not.toContain('aria-pressed="true" data-state-filter="all"');
  });

  it("defaults to 'all' pressed", () => {
    const html = render();
    expect(html).toContain('aria-pressed="true" data-state-filter="all"');
  });
});

describe("NetworkFilterBar — capability dropdown (G-1114.D.5)", () => {
  it("renders an 'Any capability' default option plus each capability", () => {
    const html = render();
    expect(html).toContain("Any capability");
    expect(html).toContain("moderate");
    expect(html).toContain("review.code");
  });

  it("marks the selected capability", () => {
    const html = render({ filter: { state: "all", capability: "review.code", scope: "include-federated" } });
    // react-dom serialises a controlled <select value> via the matching option's selected attr.
    expect(html).toContain('value="review.code" selected');
  });
});

describe("NetworkFilterBar — scope toggle (G-1114.E.4)", () => {
  it("renders both scope options", () => {
    const html = render();
    expect(html).toContain('data-scope-filter="include-federated"');
    expect(html).toContain('data-scope-filter="local-only"');
  });

  it("marks 'include-federated' pressed by default", () => {
    const html = render();
    expect(html).toContain(
      'aria-pressed="true" data-scope-filter="include-federated"',
    );
    expect(html).not.toContain(
      'aria-pressed="true" data-scope-filter="local-only"',
    );
  });

  it("marks 'local-only' pressed when scope is local-only", () => {
    const html = render({
      filter: { state: "all", capability: null, scope: "local-only" },
    });
    expect(html).toContain(
      'aria-pressed="true" data-scope-filter="local-only"',
    );
    expect(html).not.toContain(
      'aria-pressed="true" data-scope-filter="include-federated"',
    );
  });

  it("shows Clear when scope narrows to local-only", () => {
    const html = render({
      filter: { state: "all", capability: null, scope: "local-only" },
    });
    expect(html).toContain("network-filter-clear");
  });
});

describe("NetworkFilterBar — clear affordance (G-1114.D.5)", () => {
  it("hides Clear when no filter is active", () => {
    const html = render({ filter: DEFAULT_NETWORK_FILTER });
    expect(html).not.toContain("network-filter-clear");
  });

  it("shows Clear when a state filter is active", () => {
    const html = render({ filter: { state: "online", capability: null, scope: "include-federated" } });
    expect(html).toContain("network-filter-clear");
    expect(html).toContain("Clear filters");
  });

  it("shows Clear when a capability filter is active", () => {
    const html = render({ filter: { state: "all", capability: "moderate", scope: "include-federated" } });
    expect(html).toContain("network-filter-clear");
  });
});

describe("NetworkFilterBar — spotlight trigger (G-1114.D.5)", () => {
  it("renders a Find-agent trigger with the ⌘K hint", () => {
    const html = render();
    expect(html).toContain("network-filter-spotlight");
    expect(html).toContain("Find agent");
    expect(html).toContain("⌘");
    expect(html).toContain("K");
  });
});
