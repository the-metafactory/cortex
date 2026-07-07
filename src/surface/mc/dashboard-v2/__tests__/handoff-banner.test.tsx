/**
 * FLG-1 (docs/plan-mc-future-state.md §4.D) — HandoffBanner render tests.
 *
 * The banner is PURE (props only), so it renders under `renderToStaticMarkup`.
 * These assert what the strip actually shows: the 3 legs (seal → hub-authorize →
 * leaf-up) with their owners, whose move is next, why leaf-up is blocked, and —
 * the load-bearing UX honesty — that the "confirm" toggle is offered ONLY when
 * the hub-authorize signal is attestable (undefined), never for a hard hub
 * denial (Sage #1499).
 */

import { describe, it, expect } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { HandoffBanner } from "../components/handoff-banner";
import type { HandoffStatusDTO } from "../hooks/use-handoff";

function dto(partial: Partial<HandoffStatusDTO>): HandoffStatusDTO {
  return {
    network_id: "research",
    member: "andreas",
    legs: [
      { id: "seal", title: "seal", status: "done", owner: "admin", detail: "" },
      { id: "hub-authorize", title: "hub-authorize", status: "done", owner: "hub-owner", detail: "" },
      { id: "leaf-up", title: "leaf-up", status: "done", owner: "member", detail: "" },
    ],
    next_leg: null,
    next_owner: null,
    can_bring_leaf_up: true,
    leaf_up_blocked_reason: null,
    hub_attestable: false,
    attested: false,
    notes: [],
    ...partial,
  };
}

function render(status: HandoffStatusDTO): string {
  return renderToStaticMarkup(
    createElement(HandoffBanner, {
      status,
      confirmed: status.attested,
      onToggleConfirmed: () => {},
    }),
  );
}

describe("HandoffBanner — legs + whose move", () => {
  it("renders all three legs with their ids, statuses and owners", () => {
    const html = render(dto({}));
    expect(html).toContain('data-leg="seal"');
    expect(html).toContain('data-leg="hub-authorize"');
    expect(html).toContain('data-leg="leaf-up"');
    expect(html).toContain('data-owner="admin"');
    expect(html).toContain('data-owner="hub-owner"');
    expect(html).toContain('data-owner="member"');
  });

  it("shows completion when every leg is done", () => {
    const html = render(dto({}));
    expect(html).toContain('data-next-owner="complete"');
    expect(html).toContain("All legs complete");
  });

  it("names the next owner mid-handoff", () => {
    const html = render(
      dto({
        legs: [
          { id: "seal", title: "seal", status: "pending", owner: "admin", detail: "" },
          { id: "hub-authorize", title: "hub-authorize", status: "blocked", owner: "hub-owner", detail: "" },
          { id: "leaf-up", title: "leaf-up", status: "blocked", owner: "member", detail: "" },
        ],
        next_leg: "seal",
        next_owner: "admin",
        can_bring_leaf_up: false,
        leaf_up_blocked_reason: "seal-pending",
      }),
    );
    expect(html).toContain('data-next-owner="admin"');
    expect(html).toContain('data-blocked-reason="seal-pending"');
    expect(html).toContain("Next move");
  });
});

describe("HandoffBanner — attestation toggle (Sage #1499 UX honesty)", () => {
  it("offers the confirm toggle ONLY when the hub leg is attestable (undefined)", () => {
    const html = render(
      dto({
        legs: [
          { id: "seal", title: "seal", status: "done", owner: "admin", detail: "" },
          { id: "hub-authorize", title: "hub-authorize", status: "pending", owner: "hub-owner", detail: "" },
          { id: "leaf-up", title: "leaf-up", status: "blocked", owner: "member", detail: "" },
        ],
        next_leg: "hub-authorize",
        next_owner: "hub-owner",
        can_bring_leaf_up: false,
        leaf_up_blocked_reason: "hub-unverifiable",
        hub_attestable: true,
      }),
    );
    expect(html).toContain('data-testid="handoff-confirm-toggle"');
  });

  it("does NOT offer the toggle for a hard hub denial — shows an honest note instead", () => {
    const html = render(
      dto({
        legs: [
          { id: "seal", title: "seal", status: "done", owner: "admin", detail: "" },
          { id: "hub-authorize", title: "hub-authorize", status: "pending", owner: "hub-owner", detail: "" },
          { id: "leaf-up", title: "leaf-up", status: "blocked", owner: "member", detail: "" },
        ],
        next_leg: "hub-authorize",
        next_owner: "hub-owner",
        can_bring_leaf_up: false,
        leaf_up_blocked_reason: "hub-denied",
        hub_attestable: false,
      }),
    );
    expect(html).not.toContain('data-testid="handoff-confirm-toggle"');
    expect(html).toContain("cannot be confirmed away");
  });
});
