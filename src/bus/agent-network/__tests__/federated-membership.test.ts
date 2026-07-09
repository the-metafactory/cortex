/**
 * FS-1 (cortex#1825, design §3 D-1) — federated-membership oracle tests.
 *
 * Coverage axes:
 *   1. Authoritative read ⇒ `isAdmittedMember` true for ADMITTED principals,
 *      false for everyone else (pending / absent / local).
 *   2. Self-scope (non-authoritative) read ⇒ NEVER establishes peer membership
 *      (a self read does not enumerate peers) — last-good is preserved.
 *   3. Failed / degraded read ⇒ last-good preserved (never wipe on an outage).
 *   4. `not_configured` provider ⇒ empty snapshot (honest degradation).
 *   5. Multi-network union.
 *   6. Lifecycle — start/stop with an injected scheduler; stop is idempotent.
 */

import { describe, expect, test } from "bun:test";
import { createFederatedMembershipOracle } from "../federated-membership";
import type {
  AdmissionRowsProvider,
  AdmissionRowsResult,
  AdmissionRow,
} from "../admission-read";

/** Build a provider that returns a scripted result per network id. */
function providerFor(
  script: Record<string, AdmissionRowsResult>,
  fallback: AdmissionRowsResult = {
    ok: false,
    reason: "not_configured",
    detail: "no script",
  },
): AdmissionRowsProvider {
  return {
    readAdmissionRows: (networkId: string): Promise<AdmissionRowsResult> =>
      Promise.resolve(script[networkId] ?? fallback),
  };
}

/** A mutable provider whose result can be swapped between refreshes. */
function mutableProvider(initial: AdmissionRowsResult): {
  provider: AdmissionRowsProvider;
  set: (r: AdmissionRowsResult) => void;
} {
  let current = initial;
  return {
    provider: {
      readAdmissionRows: (): Promise<AdmissionRowsResult> =>
        Promise.resolve(current),
    },
    set: (r: AdmissionRowsResult) => {
      current = r;
    },
  };
}

function row(
  principal_id: string,
  network_id: string,
  status: AdmissionRow["status"],
): AdmissionRow {
  return { principal_id, network_id, status };
}

function completeRows(rows: AdmissionRow[]): AdmissionRowsResult {
  return { ok: true, rows, scope: "complete" };
}

describe("FS-1 federated-membership oracle", () => {
  test("authoritative read ⇒ ADMITTED principals are members; others are not", async () => {
    const provider = providerFor({
      metafactory: completeRows([
        row("jc", "metafactory", "ADMITTED"),
        row("mia", "metafactory", "PENDING"),
        row("evil", "other-net", "ADMITTED"), // wrong network — filtered out
      ]),
    });
    const oracle = createFederatedMembershipOracle({
      networkIds: ["metafactory"],
      provider,
      runOnStart: false,
    });
    await oracle.refresh();
    expect(oracle.isAdmittedMember("jc")).toBe(true); // ADMITTED
    expect(oracle.isAdmittedMember("mia")).toBe(false); // PENDING is not a member
    expect(oracle.isAdmittedMember("evil")).toBe(false); // wrong network
    expect(oracle.isAdmittedMember("nobody")).toBe(false);
  });

  test("self-scope (non-authoritative) read NEVER establishes membership + preserves last-good", async () => {
    const m = mutableProvider(
      completeRows([row("jc", "metafactory", "ADMITTED")]),
    );
    const oracle = createFederatedMembershipOracle({
      networkIds: ["metafactory"],
      provider: m.provider,
      runOnStart: false,
    });
    await oracle.refresh();
    expect(oracle.isAdmittedMember("jc")).toBe(true);

    // Now the registry only answers a SELF-scope read (scope: "self") — it does
    // not enumerate peers. The oracle must NOT collapse membership to "just me";
    // it keeps the last authoritative snapshot.
    m.set({ ok: true, rows: [row("andreas", "metafactory", "ADMITTED")], scope: "self" });
    await oracle.refresh();
    expect(oracle.isAdmittedMember("jc")).toBe(true); // last-good preserved
    expect(oracle.isAdmittedMember("andreas")).toBe(false); // self read ignored
  });

  test("degraded read (unreachable) preserves last-good — never wipes membership", async () => {
    const m = mutableProvider(
      completeRows([row("jc", "metafactory", "ADMITTED")]),
    );
    const oracle = createFederatedMembershipOracle({
      networkIds: ["metafactory"],
      provider: m.provider,
      runOnStart: false,
    });
    await oracle.refresh();
    expect(oracle.isAdmittedMember("jc")).toBe(true);

    m.set({ ok: false, reason: "unreachable", detail: "registry down" });
    await oracle.refresh();
    expect(oracle.isAdmittedMember("jc")).toBe(true); // still a member (last-good)
  });

  test("not_configured provider ⇒ empty snapshot (no membership-fold)", async () => {
    const oracle = createFederatedMembershipOracle({
      networkIds: ["metafactory"],
      provider: providerFor({}),
      runOnStart: false,
    });
    await oracle.refresh();
    expect(oracle.isAdmittedMember("jc")).toBe(false);
  });

  test("union across multiple networks", async () => {
    const oracle = createFederatedMembershipOracle({
      networkIds: ["net-a", "net-b"],
      provider: providerFor({
        "net-a": completeRows([row("jc", "net-a", "ADMITTED")]),
        "net-b": completeRows([row("mia", "net-b", "ADMITTED")]),
      }),
      runOnStart: false,
    });
    await oracle.refresh();
    expect(oracle.isAdmittedMember("jc")).toBe(true);
    expect(oracle.isAdmittedMember("mia")).toBe(true);
  });

  test("no networks ⇒ inert; start()/stop() are no-ops and never throw", async () => {
    const oracle = createFederatedMembershipOracle({
      networkIds: [],
      provider: providerFor({}),
    });
    oracle.start();
    expect(oracle.isAdmittedMember("jc")).toBe(false);
    await oracle.stop();
    await oracle.stop(); // idempotent
  });

  test("start() runs an initial refresh and schedules the poller (injected clock)", async () => {
    const scheduled: { fn: () => void; ms: number }[] = [];
    const oracle = createFederatedMembershipOracle({
      networkIds: ["metafactory"],
      provider: providerFor({
        metafactory: completeRows([row("jc", "metafactory", "ADMITTED")]),
      }),
      schedule: (fn, ms) => {
        scheduled.push({ fn, ms });
        return () => undefined;
      },
    });
    oracle.start();
    await oracle.settle();
    expect(scheduled.length).toBe(1); // interval armed
    expect(oracle.isAdmittedMember("jc")).toBe(true); // runOnStart refreshed
    await oracle.stop();
  });
});
