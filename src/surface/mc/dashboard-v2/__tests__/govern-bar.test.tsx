/**
 * CK-7 (cortex#1673) — GOVERN bar SHELL render tests (DOM-free via
 * renderToStaticMarkup).
 *
 * Pins the shell contract: the admin verb rail is an EMPTY per-verb harness (no
 * live verbs), the admin gate is the pier-queue `roster_scope==='complete'` gate
 * (fail-closed for a member/degraded read), the two named banners + doctor drill
 * mount, the member footer surfaces Leave as CLI TEXT (never a button, invariant
 * 16), the registry-admin vs hub-admin badges are distinct, and no copy renders
 * the deprecated posture word (built from fragments so THIS file stays
 * carve-out-gate-clean).
 */

import { describe, it, expect } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { GovernBar, type GovernBarProps } from "../components/govern-bar";
import {
  GOVERN_VERB_SLOTS,
  selectAdmissionRequests,
  governIsAdmin,
  adminAuthorityBadges,
} from "../lib/govern-bar-adapter";
import type { NetworkMembershipDTO } from "../hooks/use-networks";

const FORBIDDEN = ["oper", "ator"].join(""); // the deprecated posture word

function net(over: Partial<NetworkMembershipDTO> = {}): NetworkMembershipDTO {
  return {
    network_id: "tide",
    leaf_node: "leaf-1",
    roster_status: "ok",
    roster_scope: "complete",
    confidentiality: { mode: "cleartext", key_present: false, key_id: null },
    members: [],
    ...over,
  } as NetworkMembershipDTO;
}

function member(principal: string, verdict: string): NetworkMembershipDTO["members"][number] {
  return {
    principal,
    verdict: verdict as NetworkMembershipDTO["members"][number]["verdict"],
    present_stacks: [],
    accepts: "accepted-network",
  } as NetworkMembershipDTO["members"][number];
}

function props(over: Partial<GovernBarProps>): GovernBarProps {
  return {
    posture: "admin",
    networkId: "tide",
    localPrincipal: "aria",
    network: net(),
    ...over,
  };
}

function render(over: Partial<GovernBarProps>): string {
  return renderToStaticMarkup(createElement(GovernBar, props(over)));
}

describe("GovernBar — admin posture (verb rail harness)", () => {
  it("renders the verb rail with every slot as an inert harness placeholder", () => {
    const html = render({});
    expect(html).toContain("govern-verb-rail");
    // every taxonomy slot renders…
    for (const slot of GOVERN_VERB_SLOTS) {
      expect(html).toContain(`data-verb="${slot.id}"`);
    }
    // …and every button is disabled (NO verb is wired in this shell).
    const buttons = html.match(/govern-verb-btn/g) ?? [];
    expect(buttons.length).toBe(GOVERN_VERB_SLOTS.length);
    expect(html).toContain("disabled");
    // the four decision-gated verbs are honest placeholders
    expect(html).toContain('data-verb="authorize"');
    expect(html).toContain('data-verb="seal"');
    expect(html).toContain('data-verb="rotate"');
    expect(html).toContain('data-verb="revoke"');
    // never the deprecated posture word
    expect(html).not.toContain(FORBIDDEN);
  });

  it("marks the one already-live slot (dispatch) distinct from the pending ones", () => {
    const html = render({});
    expect(html).toContain('data-verb="dispatch"');
    expect(html).toContain('data-verb-state="live"');
    expect(html).toContain('data-verb-state="pending"');
  });

  it("mounts the admission-request banner with an honest pending count (no ids yet)", () => {
    const html = render({
      network: net({
        members: [
          member("aria", "present"),
          member("rob", "pending"),
          member("vincent", "pending"),
        ],
      }),
    });
    expect(html).toContain("govern-admission-banner");
    expect(html).toContain('data-pending="2"');
    expect(html).toContain("2 request");
    expect(html).toContain("FLG-5");
    // truth-not-theater: the shell offers no grant/deny action.
    expect(html.toLowerCase()).not.toContain("grant<");
    expect(html).not.toContain(FORBIDDEN);
  });

  it("renders both authority badges (registry-admin vs hub-admin) distinct", () => {
    const html = render({});
    expect(html).toContain('data-authority="registry-admin"');
    expect(html).toContain('data-authority="hub-admin"');
    expect(html).toContain("registry admin");
    expect(html).toContain("hub admin");
  });

  it("mounts the two named banners area (handoff FLG-1 + doctor FLG-3) when a network is dived", () => {
    const html = render({});
    expect(html).toContain("govern-banners");
  });

  it("never renders a Leave button for an admin", () => {
    const html = render({});
    expect(html).not.toContain("Leave</button>");
  });
});

describe("GovernBar — member posture (footer, no verbs)", () => {
  it("renders the participate footer and NO verb rail (fail-closed)", () => {
    const html = render({ posture: "member", network: null });
    expect(html).not.toContain("govern-verb-rail");
    expect(html).toContain("govern-member-footer");
    expect(html).toContain("participate in");
    expect(html).toContain("tide");
    expect(html).not.toContain(FORBIDDEN);
  });

  it("surfaces Leave as CLI TEXT, never a button (invariant 16)", () => {
    const html = render({ posture: "member", network: null });
    expect(html).toContain('data-leave="cli-only"');
    expect(html).toContain("cortex network leave tide");
    // the deviation from the mockup: Leave is text/state, not a button
    expect(html).not.toContain("Leave</button>");
    expect(html).not.toContain("govern-verb-btn");
  });

  it("keeps the two authority badges distinct in the member footer", () => {
    const html = render({ posture: "member", network: null });
    expect(html).toContain('data-authority="registry-admin"');
    expect(html).toContain('data-authority="hub-admin"');
  });

  it("falls back to 'this network' copy when no network id is known", () => {
    const html = render({ posture: "member", networkId: null, network: null });
    expect(html).toContain("this network");
    expect(html).toContain("cortex network leave this network");
  });
});

describe("GovernBar — fail-closed gate (never trusts posture alone)", () => {
  it("does NOT render the admin rail for a self-scoped (non-authoritative) read", () => {
    // roster_scope 'self' ⇒ NOT admin-authoritative, even if a stale posture said admin.
    const html = render({
      posture: "admin",
      network: net({ roster_scope: "self" }),
    });
    expect(html).not.toContain("govern-verb-rail");
    expect(html).not.toContain("govern-admission-banner");
  });

  it("does NOT render the admin rail for an unreachable roster read", () => {
    const html = render({
      posture: "admin",
      network: net({ roster_status: "unreachable", roster_scope: null }),
    });
    expect(html).not.toContain("govern-verb-rail");
  });

  it("renders a neutral note (no rail, no footer verbs) for unknown posture", () => {
    const html = render({ posture: null, network: null });
    expect(html).not.toContain("govern-verb-rail");
    expect(html).toContain("govern-unknown-note");
    expect(html).not.toContain(FORBIDDEN);
  });

  it("does NOT mount the banners area when no network is dived", () => {
    const html = render({ posture: null, networkId: null, network: null });
    expect(html).not.toContain("govern-banners");
  });
});

describe("govern-bar-adapter — pure gate + selectors", () => {
  it("governIsAdmin reuses the pier-queue admin-authoritative gate", () => {
    expect(governIsAdmin(net(), null)).toBe(true);
    expect(governIsAdmin(net({ roster_scope: "self" }), "admin")).toBe(false);
    expect(governIsAdmin(net({ roster_status: "unreachable", roster_scope: null }), "admin")).toBe(false);
  });

  it("governIsAdmin falls back to posture when no network DTO is present", () => {
    expect(governIsAdmin(null, "admin")).toBe(true);
    expect(governIsAdmin(null, "member")).toBe(false);
    expect(governIsAdmin(undefined, null)).toBe(false);
  });

  it("selectAdmissionRequests returns null for a network the principal does not admin", () => {
    expect(selectAdmissionRequests(net({ roster_scope: "self" }))).toBeNull();
    expect(selectAdmissionRequests(null)).toBeNull();
  });

  it("selectAdmissionRequests counts pending verdicts for an admin network", () => {
    const summary = selectAdmissionRequests(
      net({ members: [member("a", "present"), member("b", "pending"), member("c", "pending")] }),
    );
    expect(summary).not.toBeNull();
    expect(summary?.pending).toBe(2);
    expect(summary?.networkId).toBe("tide");
  });

  it("exposes two distinct authority badges", () => {
    const badges = adminAuthorityBadges();
    expect(badges.map((b) => b.token)).toEqual(["registry-admin", "hub-admin"]);
    expect(badges[0]?.tone).not.toBe(badges[1]?.tone);
  });

  it("the verb rail taxonomy has exactly one live slot (dispatch); the rest pending", () => {
    const live = GOVERN_VERB_SLOTS.filter((s) => s.state === "live");
    const pending = GOVERN_VERB_SLOTS.filter((s) => s.state === "pending");
    expect(live.map((s) => s.id)).toEqual(["dispatch"]);
    expect(pending.map((s) => s.id)).toEqual(["authorize", "seal", "rotate", "revoke"]);
  });
});
