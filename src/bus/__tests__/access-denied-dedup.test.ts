/**
 * cortex#1213 — `AccessDeniedDeduper` unit tests.
 *
 * The deduper is the defence-in-depth backstop that keeps a genuinely-repeated
 * denial AUDITED (security preserved) but never FLOODING the bus. Clock is
 * injected so the window behaviour is deterministic.
 */

import { describe, expect, test } from "bun:test";
import {
  AccessDeniedDeduper,
  type DenialIdentity,
} from "../access-denied-dedup";

const ID: DenialIdentity = {
  capability: "federated.subject_dispatch",
  subject: "federated.andreas.meta-factory.agent.heartbeat",
  reason: "peer_not_in_accept_list",
  source: "andreas",
};

describe("AccessDeniedDeduper", () => {
  test("first occurrence emits + firstSeen", () => {
    const d = new AccessDeniedDeduper({ now: () => 0 });
    const decision = d.decide(ID);
    expect(decision.emit).toBe(true);
    expect(decision.firstSeen).toBe(true);
    expect(decision.suppressed).toBe(0);
  });

  test("identical denial inside the window is SUPPRESSED (counted, not emitted)", () => {
    let clock = 0;
    const d = new AccessDeniedDeduper({ now: () => clock, windowMs: 60_000 });
    expect(d.decide(ID).emit).toBe(true); // first

    clock = 30_000; // still inside the 60s window
    const second = d.decide(ID);
    expect(second.emit).toBe(false);
    expect(second.firstSeen).toBe(false);
    expect(second.suppressed).toBe(1);

    clock = 31_000;
    const third = d.decide(ID);
    expect(third.emit).toBe(false);
    expect(third.suppressed).toBe(2);
  });

  test("first occurrence AFTER the window emits a ROLLUP carrying the suppressed count", () => {
    let clock = 0;
    const d = new AccessDeniedDeduper({ now: () => clock, windowMs: 1_000 });
    expect(d.decide(ID).emit).toBe(true); // first emit at t=0

    clock = 500; // inside window — suppressed
    expect(d.decide(ID).emit).toBe(false);
    clock = 900; // inside window — suppressed
    expect(d.decide(ID).emit).toBe(false);

    clock = 1_000; // window elapsed → rollup emit
    const rollup = d.decide(ID);
    expect(rollup.emit).toBe(true);
    expect(rollup.firstSeen).toBe(false);
    expect(rollup.suppressed).toBe(2); // the two suppressed since the last emit

    clock = 1_100; // counter reset after the rollup
    const afterRollup = d.decide(ID);
    expect(afterRollup.emit).toBe(false);
    expect(afterRollup.suppressed).toBe(1);
  });

  test("distinct tuples are tracked independently", () => {
    const d = new AccessDeniedDeduper({ now: () => 0 });
    expect(d.decide(ID).emit).toBe(true);
    // Same except reason — a DIFFERENT denial, emits on its own first occurrence.
    expect(d.decide({ ...ID, reason: "max_hop_exceeded" }).emit).toBe(true);
    // Same except source.
    expect(d.decide({ ...ID, source: "joel" }).emit).toBe(true);
    // The original tuple is still suppressed.
    expect(d.decide(ID).emit).toBe(false);
  });

  test("stale entries are pruned under the soft cap (no unbounded growth)", () => {
    let clock = 0;
    const d = new AccessDeniedDeduper({
      now: () => clock,
      windowMs: 100,
      maxEntries: 2,
    });
    d.decide({ ...ID, subject: "a" });
    d.decide({ ...ID, subject: "b" });
    clock = 1_000; // both windows elapsed
    // Inserting a 3rd at-cap triggers a prune of the two stale entries, then
    // re-inserting one of them is a fresh firstSeen (it was evicted).
    d.decide({ ...ID, subject: "c" });
    const reinserted = d.decide({ ...ID, subject: "a" });
    expect(reinserted.firstSeen).toBe(true);
  });
});
