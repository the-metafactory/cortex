/**
 * FLG-4 — NetworkRosterPanel render tests for the roster-state row (seal /
 * hub-authorize / authorship) and the FORMER-members group. The panel is pure,
 * so it renders under `renderToStaticMarkup`.
 *
 * Acceptance-critical assertions:
 *   - a member's seal + hub-authorize timestamp + #1600 authorship render on the row;
 *   - DEPARTED ('left') is visually SEPARABLE from REVOKED ('kicked') — distinct
 *     `data-admission-state` tokens + labels in a dedicated former-members group;
 *   - depart/leave/retire appear as STATE ONLY — the former group carries no
 *     button affordance (retire is root-seed-signed; leave/depart are CLI-side).
 */

import { describe, it, expect } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { NetworkRosterPanel } from "../components/network-roster-panel";
import type { NetworkMembershipDTO } from "../hooks/use-networks";
import type { NetworkConfidentialityDTO, RosterMemberStateDTO } from "../../api/networks";

const CLEARTEXT: NetworkConfidentialityDTO = { mode: "off", key_present: false, key_id: null };

function net(states: RosterMemberStateDTO[]): NetworkMembershipDTO {
  return {
    network_id: "metafactory",
    leaf_node: "metafactory-leaf",
    roster_status: "ok",
    roster_scope: "complete",
    confidentiality: CLEARTEXT,
    members: [
      { principal: "andreas", verdict: "admitted-present", present_stacks: ["main"], accepts: "self" },
      { principal: "jc", verdict: "absent-offline", present_stacks: [], accepts: "accepted-network" },
    ],
    roster_states: states,
  };
}

function render(dto: NetworkMembershipDTO): string {
  return renderToStaticMarkup(
    createElement(NetworkRosterPanel, { networks: [dto], localPrincipal: "andreas" }),
  );
}

const STATES: RosterMemberStateDTO[] = [
  { principal: "andreas", admission_state: "admitted", sealed: true, hub_authorized_at: "2026-07-08T00:00:00.000Z", authorship: "verified" },
  { principal: "jc", admission_state: "admitted", sealed: false, hub_authorized_at: null, authorship: "unchecked" },
  { principal: "leaver", admission_state: "departed", sealed: false, hub_authorized_at: null, authorship: "unchecked" },
  { principal: "kicked", admission_state: "revoked", sealed: false, hub_authorized_at: null, authorship: "unchecked" },
];

describe("NetworkRosterPanel — FLG-4 roster states", () => {
  it("renders seal, hub-authorize timestamp, and #1600 authorship on the member row", () => {
    const html = render(net(STATES));
    expect(html).toContain('data-seal="sealed"');
    expect(html).toContain("2026-07-08T00:00:00.000Z");
    expect(html).toContain('data-hub-authorized="true"');
    expect(html).toContain('data-authorship="verified"');
  });

  it("renders unsealed / hub-authorize-pending / authorship-unchecked honestly for a member without progress", () => {
    const html = render(net(STATES));
    expect(html).toContain('data-seal="unsealed"');
    expect(html).toContain('data-hub-authorized="false"');
    expect(html).toContain('data-authorship="unchecked"');
    // Honesty: unchecked authorship must not be dressed up as verified.
    expect(html).not.toContain('data-authorship="verified"><');
  });

  it("keeps DEPARTED ('left') visually separable from REVOKED ('kicked')", () => {
    const html = render(net(STATES));
    expect(html).toContain('data-admission-state="departed"');
    expect(html).toContain('data-admission-state="revoked"');
    expect(html).toContain(">left<");
    expect(html).toContain(">revoked<");
    // Distinct CSS tones (warn for departed, danger for revoked).
    expect(html).toContain("network-roster-badge tone-warn");
    expect(html).toContain("network-roster-badge tone-danger");
  });

  it("surfaces former members as STATE ONLY — no button/verb affordance", () => {
    const html = render(net(STATES));
    expect(html).toContain("network-roster-former");
    expect(html).toContain("Former members");
    expect(html.toLowerCase()).toContain("cli-side by design");
    // No interactive control is rendered WITHIN the former-members group (the
    // panel elsewhere has the FLG-3 doctor button — that's a different feature).
    const formerStart = html.indexOf('class="network-roster-former"');
    expect(formerStart).toBeGreaterThan(-1);
    const formerRegion = html.slice(formerStart);
    expect(formerRegion).not.toContain("<button");
    expect(formerRegion).not.toContain("<input");
  });

  it("renders no state badges when the read carries no roster_states (honest absence)", () => {
    const html = render(net([]));
    expect(html).not.toContain("data-seal=");
    expect(html).not.toContain("data-authorship=");
    expect(html).not.toContain("network-roster-former");
  });
});
