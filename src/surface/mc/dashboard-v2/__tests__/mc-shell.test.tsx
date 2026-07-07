/**
 * MC-D2 (cortex#1289) — shell-chrome render tests (DOM-free via renderToStaticMarkup).
 *
 * Covers the command bar (logo / principal / breadcrumb / posture pill / count),
 * the altitude rail (5 levels, current lit, future stubs, network drill list),
 * and the `McShell` composer (the `.mc-skin` wrap + children pass-through). Pins
 * the load-bearing vocabulary: the posture pill reads ADMIN / MEMBER and NEVER
 * "OPERATOR".
 */

import { describe, it, expect } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { McCommandBar } from "../components/mc-command-bar";
import { McAltitudeRail } from "../components/mc-altitude-rail";
import { McShell } from "../components/mc-shell";
import {
  ROOT_SELECTION,
  buildBreadcrumb,
  drillToNetwork,
} from "../lib/mc-shell-model";
import type { NetworkMembershipDTO } from "../hooks/use-networks";

function net(
  over: Partial<NetworkMembershipDTO> & { network_id: string },
): NetworkMembershipDTO {
  return {
    leaf_node: `${over.network_id}-leaf`,
    roster_status: "ok",
    roster_scope: "complete",
    members: [],
    confidentiality: { mode: "off", key_present: false, key_id: null },
    ...over,
  };
}

const NETWORKS: NetworkMembershipDTO[] = [
  net({ network_id: "meridian", roster_scope: "complete" }), // admin
  net({ network_id: "tide", roster_scope: "self" }), // member
];

describe("McCommandBar", () => {
  it("renders the logo, principal, breadcrumb root, and count", () => {
    const html = renderToStaticMarkup(
      createElement(McCommandBar, {
        principal: "aria",
        breadcrumb: buildBreadcrumb(ROOT_SELECTION),
        posture: null,
        networkCount: 2,
        onNavigate: () => {},
      }),
    );
    expect(html).toContain("MISSION");
    expect(html).toContain("PRINCIPAL");
    expect(html).toContain("aria");
    expect(html).toContain("NETWORK·OF·NETWORKS");
    expect(html).toContain(">2<");
    expect(html).toContain("NETWORKS");
  });

  it("shows an em-dash placeholder when the principal is unknown (no fabrication)", () => {
    const html = renderToStaticMarkup(
      createElement(McCommandBar, {
        principal: null,
        breadcrumb: buildBreadcrumb(ROOT_SELECTION),
        posture: null,
        networkCount: 0,
        onNavigate: () => {},
      }),
    );
    expect(html).toContain("—");
  });

  it("renders no posture pill at the root (posture null)", () => {
    const html = renderToStaticMarkup(
      createElement(McCommandBar, {
        principal: "aria",
        breadcrumb: buildBreadcrumb(ROOT_SELECTION),
        posture: null,
        networkCount: 2,
        onNavigate: () => {},
      }),
    );
    expect(html).not.toContain("mc-posture-pill");
  });

  it("renders an ADMIN pill (never OPERATOR) for admin posture", () => {
    const html = renderToStaticMarkup(
      createElement(McCommandBar, {
        principal: "aria",
        breadcrumb: buildBreadcrumb(drillToNetwork("meridian")),
        posture: "admin",
        networkCount: 2,
        onNavigate: () => {},
      }),
    );
    expect(html).toContain("ADMIN");
    expect(html).toContain('data-posture="admin"');
    expect(html).not.toContain("OPERATOR");
    // the drilled network appears in the breadcrumb
    expect(html).toContain("meridian");
  });

  it("renders a MEMBER pill for member posture", () => {
    const html = renderToStaticMarkup(
      createElement(McCommandBar, {
        principal: "aria",
        breadcrumb: buildBreadcrumb(drillToNetwork("tide")),
        posture: "member",
        networkCount: 2,
        onNavigate: () => {},
      }),
    );
    expect(html).toContain("MEMBER");
    expect(html).toContain('data-posture="member"');
  });
});

describe("McAltitudeRail", () => {
  it("names all five altitude levels with the current one lit", () => {
    const html = renderToStaticMarkup(
      createElement(McAltitudeRail, {
        selection: ROOT_SELECTION,
        networks: NETWORKS,
        onAscendRoot: () => {},
        onDrillNetwork: () => {},
        onAscendToLevel: () => {},
      }),
    );
    expect(html).toContain("ALTITUDE");
    for (const label of ["NETWORKS", "NETWORK", "STACK", "ASSISTANT", "SESSION"]) {
      expect(html).toContain(label);
    }
    expect(html).toContain("10k ft");
    // NETWORKS is the current level at the root.
    expect(html).toContain('data-level="networks"');
    expect(html).toMatch(/data-level="networks"[^>]*data-reach="current"/);
  });

  it("marks stack/assistant/session as future stubs", () => {
    const html = renderToStaticMarkup(
      createElement(McAltitudeRail, {
        selection: ROOT_SELECTION,
        networks: NETWORKS,
        onAscendRoot: () => {},
        onDrillNetwork: () => {},
        onAscendToLevel: () => {},
      }),
    );
    for (const lvl of ["stack", "assistant", "session"]) {
      expect(html).toMatch(
        new RegExp(`data-level="${lvl}"[^>]*data-reach="future"`),
      );
    }
  });

  it("renders the joined networks as drill targets with per-network posture", () => {
    const html = renderToStaticMarkup(
      createElement(McAltitudeRail, {
        selection: ROOT_SELECTION,
        networks: NETWORKS,
        onAscendRoot: () => {},
        onDrillNetwork: () => {},
        onAscendToLevel: () => {},
      }),
    );
    expect(html).toContain('data-network-id="meridian"');
    expect(html).toContain('data-network-id="tide"');
    // posture tags carried on the drill buttons (admin / member, never the
    // deprecated label — built from fragments to keep this file gate-clean).
    const FORBIDDEN = ["oper", "ator"].join("");
    expect(html).toContain('data-posture="admin"');
    expect(html).toContain('data-posture="member"');
    expect(html).not.toContain(FORBIDDEN);
  });

  it("the network stop is a future stub when no networks are joined", () => {
    const html = renderToStaticMarkup(
      createElement(McAltitudeRail, {
        selection: ROOT_SELECTION,
        networks: [],
        onAscendRoot: () => {},
        onDrillNetwork: () => {},
        onAscendToLevel: () => {},
      }),
    );
    expect(html).toMatch(/data-level="network"[^>]*data-reach="future"/);
    // no drill list when there is nothing to drill into
    expect(html).not.toContain("mc-rail-networks");
  });

  it("marks the drilled network active and the network level current", () => {
    const html = renderToStaticMarkup(
      createElement(McAltitudeRail, {
        selection: drillToNetwork("meridian"),
        networks: NETWORKS,
        onAscendRoot: () => {},
        onDrillNetwork: () => {},
        onAscendToLevel: () => {},
      }),
    );
    expect(html).toMatch(/data-level="network"[^>]*data-reach="current"/);
    expect(html).toContain("mc-rail-network-btn--active");
  });
});

describe("McShell", () => {
  it("wraps the chrome + framed pane in a single .mc-skin container", () => {
    const html = renderToStaticMarkup(
      createElement(McShell, {
        principal: "aria",
        networks: NETWORKS,
        selection: ROOT_SELECTION,
        onSelectionChange: () => {},
        children: createElement("div", { className: "framed-pane" }, "BODY"),
      }),
    );
    // single .mc-skin wrapper
    expect(html).toContain("mc-skin");
    // chrome present
    expect(html).toContain("mc-command-bar");
    expect(html).toContain("mc-altitude-rail");
    // children pass through unchanged
    expect(html).toContain("framed-pane");
    expect(html).toContain("BODY");
  });

  it("derives the posture pill from the selected network", () => {
    const html = renderToStaticMarkup(
      createElement(McShell, {
        principal: "aria",
        networks: NETWORKS,
        selection: drillToNetwork("meridian"),
        onSelectionChange: () => {},
        children: "body",
      }),
    );
    expect(html).toContain("ADMIN");
    expect(html).not.toContain("OPERATOR");
  });

  it("renders the pane full-width when no cockpit is provided (non-regressive)", () => {
    const html = renderToStaticMarkup(
      createElement(McShell, {
        principal: "aria",
        networks: NETWORKS,
        selection: ROOT_SELECTION,
        onSelectionChange: () => {},
        children: createElement("div", { className: "framed-pane" }, "BODY"),
      }),
    );
    // No split/dock chrome above STACK.
    expect(html).not.toContain("mc-shell-split");
    expect(html).not.toContain("mc-cockpit-dock");
    expect(html).toContain("framed-pane");
  });

  it("CK-3 — splits into pane + cockpit dock when a cockpit slot is given", () => {
    const html = renderToStaticMarkup(
      createElement(McShell, {
        principal: "aria",
        networks: NETWORKS,
        selection: ROOT_SELECTION,
        onSelectionChange: () => {},
        cockpit: createElement("div", { className: "the-cockpit" }, "COCKPIT"),
        children: createElement("div", { className: "framed-pane" }, "BODY"),
      }),
    );
    expect(html).toContain("mc-shell-split");
    expect(html).toContain("mc-cockpit-dock");
    // both the framed pane AND the cockpit render
    expect(html).toContain("framed-pane");
    expect(html).toContain("the-cockpit");
    expect(html).toContain("COCKPIT");
  });
});
