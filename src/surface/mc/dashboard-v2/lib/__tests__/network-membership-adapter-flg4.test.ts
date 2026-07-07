/**
 * FLG-4 — tests for the roster-state presentation adapters. The acceptance-
 * critical property: `departed` ("left") is VISUALLY SEPARABLE from `revoked`
 * ("kicked") — distinct label, tone, and stable token. Plus the #1600 authorship
 * honesty (verified only shows for a real pass) and the former-member partition.
 */

import { describe, it, expect } from "bun:test";
import {
  admissionStateBadge,
  authorshipBadge,
  sealBadge,
  formatHubAuthorized,
  isFormerMemberState,
  partitionRosterStates,
} from "../network-membership-adapter";
import type { RosterMemberStateDTO } from "../../../api/networks";

describe("admissionStateBadge — departed ≠ revoked (FLG-4 honesty)", () => {
  it("departed reads 'left', revoked reads 'revoked', with different tones + tokens", () => {
    const left = admissionStateBadge("departed");
    const kicked = admissionStateBadge("revoked");
    expect(left.label).toBe("left");
    expect(kicked.label).toBe("revoked");
    expect(left.token).toBe("departed");
    expect(kicked.token).toBe("revoked");
    // Distinct tones — the two states are never rendered identically.
    expect(left.tone).not.toBe(kicked.tone);
  });

  it("covers every state without falling through", () => {
    for (const s of ["admitted", "pending", "departed", "revoked", "rejected", "unknown"] as const) {
      expect(admissionStateBadge(s).label.length).toBeGreaterThan(0);
    }
  });
});

describe("authorshipBadge — #1600 honesty", () => {
  it("verified is 'ok', unverifiable is 'danger', unchecked is 'warn' (never a fabricated pass)", () => {
    expect(authorshipBadge("verified").tone).toBe("ok");
    expect(authorshipBadge("unverifiable").tone).toBe("danger");
    expect(authorshipBadge("unchecked").tone).toBe("warn");
    // unchecked must NOT read as verified.
    expect(authorshipBadge("unchecked").label.toLowerCase()).not.toContain("verified authorship");
    expect(authorshipBadge("unchecked").token).toBe("unchecked");
  });
});

describe("sealBadge + formatHubAuthorized", () => {
  it("sealed vs unsealed carry distinct tokens", () => {
    expect(sealBadge(true).token).toBe("sealed");
    expect(sealBadge(false).token).toBe("unsealed");
  });
  it("hub-authorize surfaces the timestamp verbatim or a pending label", () => {
    expect(formatHubAuthorized("2026-07-08T00:00:00.000Z").authorized).toBe(true);
    expect(formatHubAuthorized("2026-07-08T00:00:00.000Z").label).toContain("2026-07-08T00:00:00.000Z");
    expect(formatHubAuthorized(null).authorized).toBe(false);
    expect(formatHubAuthorized(null).label).toContain("pending");
  });
});

describe("partitionRosterStates", () => {
  const states: RosterMemberStateDTO[] = [
    { principal: "andreas", admission_state: "admitted", sealed: true, hub_authorized_at: null, authorship: "unchecked" },
    { principal: "newcomer", admission_state: "pending", sealed: false, hub_authorized_at: null, authorship: "unchecked" },
    { principal: "leaver", admission_state: "departed", sealed: false, hub_authorized_at: null, authorship: "unchecked" },
    { principal: "kicked", admission_state: "revoked", sealed: false, hub_authorized_at: null, authorship: "unchecked" },
  ];

  it("splits former members (departed/revoked/rejected) from current, keyed by principal", () => {
    const { byPrincipal, former } = partitionRosterStates(states);
    expect([...byPrincipal.keys()].sort()).toEqual(["andreas", "newcomer"]);
    expect(former.map((f) => f.principal).sort()).toEqual(["kicked", "leaver"]);
  });

  it("isFormerMemberState classifies correctly", () => {
    expect(isFormerMemberState("departed")).toBe(true);
    expect(isFormerMemberState("revoked")).toBe(true);
    expect(isFormerMemberState("rejected")).toBe(true);
    expect(isFormerMemberState("admitted")).toBe(false);
    expect(isFormerMemberState("pending")).toBe(false);
  });
});
