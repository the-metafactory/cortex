/**
 * MC-B1/B2 (cortex#1278/#1279) — the Pier queue (pending admission requests +
 * Tier-2 grant/reject) was RELOCATED out of the Network topology view into the
 * Governance tab's "Admissions" subsection. These tests lock that placement:
 *
 *   - the admin queue renders under an "Admissions" heading when the principal
 *     admins a network with pending requests;
 *   - the whole Admissions subsection self-effaces (no heading, no panel) when
 *     the principal admins no networks — the SAME admin-posture gate PierQueue
 *     itself uses, so the Governance tab is byte-identical for a pure member;
 *   - it self-effaces when `networks` is omitted (the scoped cockpit mount).
 *
 * The verdict/denial audit surface is covered elsewhere; here we render with an
 * empty governance snapshot and assert only the relocated admissions affordance.
 */

import { describe, it, expect } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { GovernanceView } from "../components/governance-view";
import type { GovernanceState } from "../hooks/use-governance";
import type { NetworkMembershipDTO, MembershipMemberDTO } from "../hooks/use-networks";

/** An empty, loaded governance snapshot — no verdicts, no denials. */
const EMPTY_STATE: GovernanceState = { data: null, loaded: true, error: null };

function member(
  over: Partial<MembershipMemberDTO> & { principal: string },
): MembershipMemberDTO {
  return { verdict: "pending", present_stacks: [], accepts: "not-accepted", ...over };
}

function net(over: Partial<NetworkMembershipDTO> & { network_id: string }): NetworkMembershipDTO {
  return {
    leaf_node: `${over.network_id}-leaf`,
    roster_status: "ok",
    roster_scope: "complete",
    members: [],
    confidentiality: { mode: "off", key_present: false, key_id: null },
    ...over,
  };
}

function render(networks?: readonly NetworkMembershipDTO[]): string {
  return renderToStaticMarkup(
    createElement(GovernanceView, { state: EMPTY_STATE, networks }),
  );
}

describe("GovernanceView — Admissions subsection (relocated Pier queue)", () => {
  it("renders the Admissions heading + Pier queue for an admin network with pending", () => {
    const html = render([
      net({
        network_id: "alpha",
        members: [member({ principal: "jc", verdict: "pending" })],
      }),
    ]);
    expect(html).toContain("governance-admissions");
    expect(html).toContain(">Admissions<");
    // the relocated queue itself
    expect(html).toContain("Pier queue");
    expect(html).toContain("jc");
  });

  it("self-effaces (no Admissions heading, no queue) when the principal admins no networks", () => {
    const html = render([net({ network_id: "beta", roster_scope: "self" })]);
    expect(html).not.toContain("governance-admissions");
    expect(html).not.toContain(">Admissions<");
    expect(html).not.toContain("Pier queue");
  });

  it("self-effaces when networks is omitted (the scoped cockpit mount)", () => {
    const html = render();
    expect(html).not.toContain("governance-admissions");
    expect(html).not.toContain("Pier queue");
  });
});
