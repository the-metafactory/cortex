/**
 * FS-6 (cortex#1821) — per-peer received-presence ledger tests.
 *
 * The ledger is the honest-absence hinge: `everReceived(peer)` is what splits an
 * admitted-but-absent peer into `absent-offline` (heard, went away) vs
 * `absent-unheard` (never heard — an import/cred gap). These assert the pure
 * state semantics: monotonic count, max-wins `lastAt`, never-heard ⇒ false.
 */

import { describe, expect, test } from "bun:test";
import { FederatedPresenceReceipts } from "../federated-presence-receipts";

describe("FederatedPresenceReceipts", () => {
  test("never-recorded principal ⇒ everReceived false, get undefined", () => {
    const r = new FederatedPresenceReceipts();
    expect(r.everReceived("jc")).toBe(false);
    expect(r.get("jc")).toBeUndefined();
  });

  test("first record ⇒ everReceived true, count 1, lastAt stamped", () => {
    const r = new FederatedPresenceReceipts();
    r.record("jc", 1000);
    expect(r.everReceived("jc")).toBe(true);
    expect(r.get("jc")).toEqual({ count: 1, lastAt: 1000 });
  });

  test("repeated records ⇒ count increments monotonically", () => {
    const r = new FederatedPresenceReceipts();
    r.record("jc", 1000);
    r.record("jc", 2000);
    r.record("jc", 3000);
    expect(r.get("jc")).toEqual({ count: 3, lastAt: 3000 });
  });

  test("out-of-order older observation never rewinds lastAt (max wins)", () => {
    const r = new FederatedPresenceReceipts();
    r.record("jc", 5000);
    r.record("jc", 2000); // older — must not rewind lastAt
    expect(r.get("jc")).toEqual({ count: 2, lastAt: 5000 });
  });

  test("distinct principals are tracked independently", () => {
    const r = new FederatedPresenceReceipts();
    r.record("jc", 1000);
    r.record("zeta", 2000);
    expect(r.everReceived("jc")).toBe(true);
    expect(r.everReceived("zeta")).toBe(true);
    expect(r.everReceived("nyx")).toBe(false);
  });

  test("get / snapshot return copies — mutation can't corrupt internal state", () => {
    const r = new FederatedPresenceReceipts();
    r.record("jc", 1000);
    const copy = r.get("jc")!;
    copy.count = 999;
    expect(r.get("jc")?.count).toBe(1);

    const snap = r.snapshot();
    snap.get("jc")!.count = 42;
    snap.set("ghost", { count: 1, lastAt: 0 });
    expect(r.get("jc")?.count).toBe(1);
    expect(r.everReceived("ghost")).toBe(false);
  });
});
