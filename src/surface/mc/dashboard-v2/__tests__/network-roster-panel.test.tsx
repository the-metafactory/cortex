/**
 * MC-A3 (cortex#1277) — NetworkRosterPanel render tests, focused on the
 * per-network confidentiality posture chip (ADR-0019/0018).
 *
 * The panel is pure (no hooks / no xyflow), so it renders under
 * `renderToStaticMarkup`. These assert the read-only HONESTY of the chip: a
 * sealed network reads "encrypted", a configured-but-keyless network reads
 * "no key" (degraded, never "encrypted"), and a cleartext network reads
 * "cleartext".
 */

import { describe, it, expect } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { NetworkRosterPanel } from "../components/network-roster-panel";
import type { NetworkMembershipDTO } from "../hooks/use-networks";
import type { NetworkConfidentialityDTO } from "../../api/networks";

function net(
  id: string,
  confidentiality: NetworkConfidentialityDTO,
): NetworkMembershipDTO {
  return {
    network_id: id,
    leaf_node: `${id}-leaf`,
    roster_status: "ok",
    roster_scope: "complete",
    confidentiality,
    members: [
      { principal: "andreas", verdict: "admitted-present", present_stacks: ["main"], accepts: "self" },
    ],
  };
}

function render(networks: NetworkMembershipDTO[]): string {
  return renderToStaticMarkup(
    createElement(NetworkRosterPanel, { networks, localPrincipal: "andreas" }),
  );
}

describe("NetworkRosterPanel — confidentiality chip", () => {
  it("renders nothing when no networks are joined", () => {
    expect(render([])).toBe("");
  });

  it("badges a sealed (enabled + key) network as encrypted", () => {
    const html = render([
      net("research", { mode: "enabled", key_present: true, key_id: "research/k1" }),
    ]);
    expect(html).toContain('data-posture="encrypted"');
    expect(html).toContain("encrypted");
  });

  it("badges a required + key network as encrypted (required)", () => {
    const html = render([
      net("research", { mode: "required", key_present: true, key_id: "research/k1" }),
    ]);
    expect(html).toContain('data-posture="encrypted-required"');
    expect(html).toContain("required");
  });

  it("HONESTY: configured enabled but NO key renders degraded, never 'encrypted'", () => {
    const html = render([
      net("research", { mode: "enabled", key_present: false, key_id: null }),
    ]);
    expect(html).toContain('data-posture="degraded"');
    expect(html).toContain("no key");
    // The chip label must not claim encryption for a keyless network.
    expect(html).toContain("encryption: no key");
  });

  it("badges a cleartext (off) network as cleartext", () => {
    const html = render([
      net("research", { mode: "off", key_present: false, key_id: null }),
    ]);
    expect(html).toContain('data-posture="cleartext"');
    expect(html).toContain("cleartext");
  });
});

describe("NetworkRosterPanel — per-principal acceptance chip (MC-A2)", () => {
  const CLEARTEXT: NetworkConfidentialityDTO = {
    mode: "off",
    key_present: false,
    key_id: null,
  };

  function netWithMembers(members: NetworkMembershipDTO["members"]): NetworkMembershipDTO {
    return {
      network_id: "research",
      leaf_node: "research-leaf",
      roster_status: "ok",
      roster_scope: "complete",
      confidentiality: CLEARTEXT,
      members,
    };
  }

  it("renders the acceptance chip for peers (accepted vs not-accepted)", () => {
    const html = render([
      netWithMembers([
        { principal: "andreas", verdict: "admitted-present", present_stacks: ["main"], accepts: "self" },
        { principal: "jc", verdict: "admitted-present", present_stacks: ["research"], accepts: "accepted-network" },
        { principal: "mallory", verdict: "absent-offline", present_stacks: [], accepts: "not-accepted" },
      ]),
    ]);
    expect(html).toContain('data-acceptance="accepted-network"');
    expect(html).toContain('data-acceptance="not-accepted"');
    expect(html).toContain("not accepted");
  });

  it("does NOT render an acceptance chip for the serving principal (self is marked '(you)')", () => {
    const html = render([
      netWithMembers([
        { principal: "andreas", verdict: "admitted-present", present_stacks: ["main"], accepts: "self" },
      ]),
    ]);
    expect(html).toContain("(you)");
    expect(html).not.toContain('data-acceptance="self"');
  });
});
