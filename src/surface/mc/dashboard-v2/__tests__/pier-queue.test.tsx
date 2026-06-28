/**
 * MC-B1 (cortex#1278) — PierQueue render tests (DOM-free via renderToStaticMarkup).
 *
 * Asserts the ADMIN-posture rendering + the load-bearing trust boundary:
 *   - renders the pending requests for networks you ADMIN (complete roster);
 *   - renders NOTHING when you admin no networks (a pure member / non-federated
 *     stack is byte-identical — no admin queue applies);
 *   - renders a reassuring empty-inbox state when you admin networks but the
 *     queue is clear;
 *   - NEVER renders a pending principal sourced from a self-scoped / degraded
 *     network read (the trust boundary, asserted through the DOM).
 */

import { describe, it, expect } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { PierQueue } from "../components/pier-queue";
import type { NetworkMembershipDTO, MembershipMemberDTO } from "../hooks/use-networks";

function member(
  over: Partial<MembershipMemberDTO> & { principal: string },
): MembershipMemberDTO {
  return { verdict: "pending", present_stacks: [], ...over };
}

function net(over: Partial<NetworkMembershipDTO> & { network_id: string }): NetworkMembershipDTO {
  return {
    leaf_node: `${over.network_id}-leaf`,
    roster_status: "ok",
    roster_scope: "complete",
    members: [],
    ...over,
  };
}

function render(networks: readonly NetworkMembershipDTO[]): string {
  return renderToStaticMarkup(createElement(PierQueue, { networks }));
}

describe("PierQueue", () => {
  it("renders nothing when the principal admins no networks", () => {
    // pure member of one network, not federated to anything it admins
    const html = render([net({ network_id: "beta", roster_scope: "self" })]);
    expect(html).toBe("");
  });

  it("renders nothing for no networks at all", () => {
    expect(render([])).toBe("");
  });

  it("renders pending requesters for an admin network", () => {
    const html = render([
      net({
        network_id: "alpha",
        members: [
          member({ principal: "andreas", verdict: "admitted-present", present_stacks: ["research"] }),
          member({ principal: "jc", verdict: "pending" }),
        ],
      }),
    ]);
    expect(html).toContain("Pier queue");
    expect(html).toContain("alpha");
    expect(html).toContain("jc");
    // an admitted member is NOT a pending request
    expect(html).not.toContain("andreas");
  });

  it("renders a clear-inbox state when admin networks have no pending", () => {
    const html = render([
      net({ network_id: "alpha", members: [member({ principal: "andreas", verdict: "admitted-present" })] }),
    ]);
    expect(html).toContain("Pier queue");
    expect(html.toLowerCase()).toContain("no pending");
  });

  it("TRUST BOUNDARY: a pending principal on a self-scoped network never reaches the DOM", () => {
    const html = render([
      net({
        network_id: "beta",
        roster_status: "ok",
        roster_scope: "self",
        members: [member({ principal: "intruder", verdict: "pending" })],
      }),
    ]);
    // you admin nothing → no panel at all, and certainly no "intruder"
    expect(html).toBe("");
    expect(html).not.toContain("intruder");
  });

  it("TRUST BOUNDARY: with a mix, only admin-network pending shows; self-network pending is suppressed", () => {
    const html = render([
      net({ network_id: "admin1", roster_scope: "complete", members: [member({ principal: "wanted", verdict: "pending" })] }),
      net({ network_id: "member1", roster_status: "ok", roster_scope: "self", members: [member({ principal: "selfonly-principal", verdict: "pending" })] }),
    ]);
    expect(html).toContain("wanted");
    expect(html).not.toContain("selfonly-principal");
  });
});
