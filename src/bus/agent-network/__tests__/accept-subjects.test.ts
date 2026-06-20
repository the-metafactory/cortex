/**
 * P2 (cortex#1087) — deriveAcceptSubjects unit tests.
 *
 * Tests the PURE roster → accept_subjects derivation in isolation against a
 * roster-peer fixture (no registry, no runtime; the dual-grammar is string
 * assembly). Covers:
 *
 *   1. dual-grammar — own subtree (dispatch, RECEIVER-addressed) ∪ one subtree
 *      per peer (presence, SOURCE-addressed). The exact OQ2 union.
 *   2. empty-roster — 0 peers ⇒ OWN-only, preserving the pre-P2 behaviour
 *      exactly (#762 guard is the CALLER's; the function never returns []).
 *   3. ordering + de-dupe — own first, peers in roster order, duplicate / self
 *      subtrees collapsed.
 *   4. the gate actually admits the derived patterns (subjectMatches round-trip)
 *      — proves the derivation produces patterns the gate will honour, the
 *      property gate-level admission depends on.
 *
 * Design: docs/design-roster-driven-federation-wiring.md §7 P2 + §8 OQ2.
 * Umbrella: cortex#1084.
 */

import { describe, expect, test } from "bun:test";

import { deriveAcceptSubjects } from "../accept-subjects";
import type { RosterPeer } from "../roster-read";
import { subjectMatches } from "../../surface-router";

// =============================================================================
// Fixtures
// =============================================================================

const SELF = { principal: "andreas", stack: "meta-factory" } as const;

/** A roster peer in the P1 projection shape. Only the wire view is read here. */
function peer(principal: string, stack: string): RosterPeer {
  return {
    principal,
    stack,
    principal_id: principal,
    stack_id: `${principal}/${stack}`,
  };
}

const OWN_SUBTREE = "federated.andreas.meta-factory.>";

// =============================================================================
// dual-grammar union (the OQ2 fix)
// =============================================================================

describe("deriveAcceptSubjects — dual-grammar union", () => {
  test("own subtree ∪ one subtree per peer (the OQ2 union)", () => {
    const subjects = deriveAcceptSubjects(SELF, [peer("jc", "default")]);
    expect(subjects).toEqual([
      OWN_SUBTREE, // dispatch addressed TO me (RECEIVER-addressed)
      "federated.jc.default.agent.>", // presence sourced FROM jc (SOURCE-addressed, presence-only)
    ]);
  });

  test("multiple peers → own + each peer subtree, in roster order", () => {
    const subjects = deriveAcceptSubjects(SELF, [
      peer("jc", "sage-host"),
      peer("dana", "default"),
    ]);
    expect(subjects).toEqual([
      OWN_SUBTREE,
      "federated.jc.sage-host.agent.>",
      "federated.dana.default.agent.>",
    ]);
  });

  test("a peer with a non-default stack slug uses that slug, not 'default'", () => {
    const subjects = deriveAcceptSubjects(SELF, [peer("jc", "research")]);
    expect(subjects).toContain("federated.jc.research.agent.>");
  });
});

// =============================================================================
// empty roster — OWN-only, pre-P2 behaviour preserved
// =============================================================================

describe("deriveAcceptSubjects — empty roster (#762-adjacent)", () => {
  test("0 peers → OWN-only accept-list (exactly the pre-P2 behaviour)", () => {
    expect(deriveAcceptSubjects(SELF, [])).toEqual([OWN_SUBTREE]);
  });

  test("never returns [] for a valid self — own subtree is always present", () => {
    const subjects = deriveAcceptSubjects(SELF, []);
    expect(subjects.length).toBeGreaterThan(0);
    expect(subjects[0]).toBe(OWN_SUBTREE);
  });
});

// =============================================================================
// ordering + de-dupe
// =============================================================================

describe("deriveAcceptSubjects — ordering + de-dupe", () => {
  test("own subtree comes first", () => {
    const subjects = deriveAcceptSubjects(SELF, [peer("jc", "default")]);
    expect(subjects[0]).toBe(OWN_SUBTREE);
  });

  test("a peer whose subtree equals the self subtree is collapsed (no dup own row)", () => {
    // Defensive: P1 excludes the local principal, but if a self-shaped peer
    // slips through, the own row must not appear twice.
    const subjects = deriveAcceptSubjects(SELF, [
      peer("andreas", "meta-factory"),
    ]);
    expect(subjects).toEqual([OWN_SUBTREE]);
  });

  test("two roster entries with the same principal/stack contribute the pattern once", () => {
    const subjects = deriveAcceptSubjects(SELF, [
      peer("jc", "default"),
      peer("jc", "default"),
    ]);
    expect(subjects).toEqual([OWN_SUBTREE, "federated.jc.default.agent.>"]);
  });

  test("same principal, different stacks → two distinct subtrees", () => {
    const subjects = deriveAcceptSubjects(SELF, [
      peer("jc", "default"),
      peer("jc", "sage-host"),
    ]);
    expect(subjects).toEqual([
      OWN_SUBTREE,
      "federated.jc.default.agent.>",
      "federated.jc.sage-host.agent.>",
    ]);
  });

  test("does not mutate the input peers array", () => {
    const peers = [peer("jc", "default")];
    const before = JSON.stringify(peers);
    deriveAcceptSubjects(SELF, peers);
    expect(JSON.stringify(peers)).toBe(before);
  });
});

// =============================================================================
// the derived patterns are honoured by the gate's matcher (round-trip)
// =============================================================================

describe("deriveAcceptSubjects — derived patterns match real wire subjects", () => {
  const subjects = deriveAcceptSubjects(SELF, [peer("jc", "default")]);

  test("own subtree matches an inbound DISPATCH subject addressed to me", () => {
    const hit = subjects.some((p) =>
      subjectMatches(p, "federated.andreas.meta-factory.tasks.code-review.ts"),
    );
    expect(hit).toBe(true);
  });

  test("peer subtree matches an inbound PRESENCE subject sourced from the peer", () => {
    // This is the subject the OWN-only accept-list rejected pre-P2.
    const hit = subjects.some((p) =>
      subjectMatches(p, "federated.jc.default.agent.online"),
    );
    expect(hit).toBe(true);
  });

  test("a NON-peer's presence subject still matches NOTHING (no over-admission)", () => {
    const hit = subjects.some((p) =>
      subjectMatches(p, "federated.stranger.default.agent.online"),
    );
    expect(hit).toBe(false);
  });

  test("least-privilege — a PEER's NON-presence subject (dispatch destined for the peer) is NOT admitted", () => {
    // The peer accept-list is presence-only (`…agent.>`), so traffic on the
    // peer's subtree that is NOT presence — e.g. dispatch addressed TO the peer
    // (receiver-addressed, the peer's business, not mine) — must NOT match. This
    // is the design §6 invariant: the auto-wiring widens PRESENCE acceptance only.
    const dispatchToPeer = subjects.some((p) =>
      subjectMatches(p, "federated.jc.default.tasks.code-review.ts"),
    );
    expect(dispatchToPeer).toBe(false);
    const dispatchLifecycleToPeer = subjects.some((p) =>
      subjectMatches(p, "federated.jc.default.dispatch.task.started"),
    );
    expect(dispatchLifecycleToPeer).toBe(false);
    // And the own subtree (`.>`) must NOT accidentally cover the peer's subjects.
    expect(subjectMatches(OWN_SUBTREE, "federated.jc.default.agent.online")).toBe(false);
  });
});
