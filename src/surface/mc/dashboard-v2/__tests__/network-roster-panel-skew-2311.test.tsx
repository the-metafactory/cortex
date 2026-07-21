/**
 * cortex#2311 — NetworkRosterPanel version-skew defense.
 *
 * The dashboard bundle is built at install time and can drift from the serving
 * daemon across wire renames (e.g. FS-6's `admitted-absent` →
 * `absent-offline`/`absent-unheard`, cortex#1821). Pre-#2311 the badge adapters
 * were compile-time-total switches with NO runtime fallback: an out-of-union
 * verdict/acceptance/status returned `undefined` and the panel threw on
 * `.tone` inside `networks.map → members.map`, blanking the whole Network view.
 *
 * These tests feed the panel deliberately skewed payloads (cast past the
 * compile-time types, exactly as JSON off the wire arrives) and assert it
 * renders an honest fallback — never a throw, and one bad entry never blanks
 * the panel.
 */

import { describe, it, expect } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { NetworkRosterPanel } from "../components/network-roster-panel";
import type { NetworkMembershipDTO } from "../hooks/use-networks";
import {
  acceptanceBadge,
  rosterStatusBadge,
  summarizeMembership,
  verdictBadge,
} from "../lib/network-membership-adapter";
import type {
  MembershipVerdict,
  PeerAcceptance,
  RosterStatus,
} from "../../api/networks";

/** Build a DTO from a RAW (possibly skewed) object — the wire's eye view. */
function wire(raw: unknown): NetworkMembershipDTO {
  return raw as NetworkMembershipDTO;
}

function render(networks: NetworkMembershipDTO[]): string {
  return renderToStaticMarkup(
    createElement(NetworkRosterPanel, { networks, localPrincipal: "andreas" }),
  );
}

const BASE = {
  network_id: "research",
  leaf_node: "research-leaf",
  roster_status: "ok",
  roster_scope: "complete",
  confidentiality: { mode: "off", key_present: false, key_id: null },
} as const;

describe("NetworkRosterPanel — version-skew defense (cortex#2311)", () => {
  it("legacy pre-FS-6 'admitted-absent' verdict renders an honest absent badge, no throw", () => {
    const html = render([
      wire({
        ...BASE,
        members: [
          { principal: "jc", verdict: "admitted-absent", present_stacks: [], accepts: "not-accepted" },
        ],
      }),
    ]);
    expect(html).toContain("jc");
    expect(html).toContain(">absent<");
    expect(html).toContain("tone-warn");
  });

  it("an unrecognized verdict renders the unknown fallback badge, no throw", () => {
    const html = render([
      wire({
        ...BASE,
        members: [
          { principal: "jc", verdict: "some-future-verdict", present_stacks: [], accepts: "not-accepted" },
        ],
      }),
    ]);
    expect(html).toContain("verdict unknown");
    expect(html).toContain("tone-warn");
    // Honesty: never claim presence for an unknown verdict.
    expect(html).not.toContain(">present<");
  });

  it("an unrecognized acceptance renders the unknown fallback chip, no throw", () => {
    const html = render([
      wire({
        ...BASE,
        members: [
          { principal: "jc", verdict: "admitted-present", present_stacks: ["hub"], accepts: "accepted-did" },
        ],
      }),
    ]);
    expect(html).toContain('data-acceptance="unknown"');
    expect(html).toContain("acceptance unknown");
  });

  it("an unrecognized roster_status renders the unknown status chip, no throw", () => {
    const html = render([
      wire({ ...BASE, roster_status: "forbidden", members: [] }),
    ]);
    expect(html).toContain("roster: unknown");
  });

  it("a missing members array renders the empty-roster state, no throw", () => {
    const html = render([wire({ ...BASE, members: undefined })]);
    expect(html).toContain("No admitted members resolved.");
  });

  it("a missing confidentiality posture renders 'unknown' (never assumed encrypted), no throw", () => {
    const html = render([
      wire({
        ...BASE,
        confidentiality: undefined,
        members: [
          { principal: "andreas", verdict: "admitted-present", present_stacks: ["main"], accepts: "self" },
        ],
      }),
    ]);
    expect(html).toContain('data-posture="unknown"');
    expect(html).not.toContain('data-posture="encrypted"');
  });

  it("one bad entry does not blank the panel — good rows still render", () => {
    const html = render([
      wire({
        ...BASE,
        members: [
          null, // holey/corrupt entry
          { verdict: "admitted-present" }, // no principal, no present_stacks, no accepts
          { principal: "jc", verdict: "bogus", present_stacks: [], accepts: "bogus" },
          { principal: "andreas", verdict: "admitted-present", present_stacks: ["main"], accepts: "self" },
        ],
        roster_states: [null, { principal: "jc", admission_state: "SOME_NEW_STATE", sealed: false, hub_authorized_at: null, authorship: "unchecked" }],
      }),
    ]);
    // The healthy row survives its corrupt siblings.
    expect(html).toContain("andreas");
    expect(html).toContain("(you)");
    // The partially-shaped rows render with fallbacks instead of throwing.
    expect(html).toContain("(unknown principal)");
    expect(html).toContain("verdict unknown");
  });
});

describe("network-membership-adapter — runtime totality (cortex#2311)", () => {
  it("verdictBadge never returns undefined for out-of-union values", () => {
    for (const v of ["admitted-absent", "whatever", "", undefined, null]) {
      const badge = verdictBadge(v as unknown as MembershipVerdict);
      expect(badge).toBeDefined();
      expect(typeof badge.tone).toBe("string");
    }
  });

  it("acceptanceBadge never returns undefined for out-of-union values", () => {
    for (const a of ["accepted-did", "", undefined, null]) {
      const badge = acceptanceBadge(a as unknown as PeerAcceptance);
      expect(badge).toBeDefined();
      expect(badge.token).toBe("unknown");
    }
  });

  it("rosterStatusBadge never returns undefined for out-of-union values", () => {
    for (const s of ["forbidden", "", undefined, null]) {
      const badge = rosterStatusBadge(s as unknown as RosterStatus, null);
      expect(badge).toBeDefined();
      expect(badge.tone).toBe("warn");
    }
  });

  it("summarizeMembership tolerates a missing/holey members array", () => {
    expect(
      summarizeMembership({ members: undefined as unknown as NetworkMembershipDTO["members"] }),
    ).toEqual({ present: 0, absent: 0, unadmitted: 0, pending: 0, total: 0 });
    const s = summarizeMembership({
      members: [
        null,
        { principal: "jc", verdict: "bogus", present_stacks: [], accepts: "self" },
        { principal: "andreas", verdict: "admitted-present", present_stacks: ["main"], accepts: "self" },
      ] as unknown as NetworkMembershipDTO["members"],
    });
    // Unknown verdicts stay uncounted in the coarse header tallies but are in total.
    expect(s.total).toBe(3);
    expect(s.present).toBe(1);
  });
});
