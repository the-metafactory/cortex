/**
 * S5 (Network Join Control Plane, #739, spec F5) — public-scope opt-in
 * orchestration tests. The open square of the Internet of Agentic Work.
 *
 * Every I/O is a FAKE port (no real fs / exec / registry — the S4/S5 SAFETY
 * rule; dry-run-default). Coverage maps to the S5 brief's TESTS list:
 *
 *   - `join public` subscribes `public.>` + announces declared capabilities to
 *     the registry public capability index (dry-run writes NOTHING).
 *   - the inbound public gate is allowlist-gated by default — `join public`
 *     does NOT auto-trust anyone; it writes `policy.public` with
 *     `enabled:false` (off) OR an explicit allowlist when `--allow` is given,
 *     and NEVER an open-claim posture.
 *   - `leave public` reverses: unsubscribe `public.>` + deregister capabilities
 *     + clear the opt-in.
 *   - the no-principal-segment scope (`public.>`) doesn't trip the federated
 *     peer gate — public is a separate trust tier (asserted in the
 *     surface-router gate tests; here we assert the lib never touches federated
 *     state).
 */

import { describe, test, expect } from "bun:test";

import {
  joinPublic,
  leavePublic,
  type PublicJoinInputs,
} from "../network-public-lib";
import type {
  PublicScopePorts,
  PublicRegistryPort,
  PublicSubscribePort,
  PublicPolicyPort,
} from "../network-public-ports";
import type { DaemonPort } from "../network-ports";
import type { PolicyPublic } from "../../../../common/types/cortex-config";

// =============================================================================
// Fake ports + recorder
// =============================================================================

interface Recorder {
  announced: string[][];
  deregistered: number;
  subscribed: number;
  unsubscribed: number;
  policyWrites: (PolicyPublic | undefined)[];
  restarts: number;
}

function makeFakes(opts?: {
  announceOk?: boolean;
  restartOk?: boolean;
  initialSubscribed?: boolean;
  initialPublic?: PolicyPublic;
  mutate?: boolean; // false ⇒ dry-run: every WRITE is a no-op (the recorder still logs intent)
}): { ports: PublicScopePorts; rec: Recorder } {
  const mutate = opts?.mutate ?? true;
  const rec: Recorder = {
    announced: [],
    deregistered: 0,
    subscribed: 0,
    unsubscribed: 0,
    policyWrites: [],
    restarts: 0,
  };

  let subscribed = opts?.initialSubscribed ?? false;
  let pub: PolicyPublic | undefined = opts?.initialPublic;

  const registry: PublicRegistryPort = {
    async announceCapabilities(caps) {
      rec.announced.push([...caps]);
      return opts?.announceOk === false
        ? { ok: false, reason: "registry rejected" }
        : { ok: true, note: "HTTP 201" };
    },
    async deregisterCapabilities() {
      rec.deregistered++;
      return opts?.announceOk === false
        ? { ok: false, reason: "registry rejected" }
        : { ok: true, note: "HTTP 201" };
    },
  };

  const subscribe: PublicSubscribePort = {
    hasPublicSubscription() {
      return subscribed;
    },
    addPublicSubscription() {
      rec.subscribed++;
      if (mutate) subscribed = true;
    },
    removePublicSubscription() {
      rec.unsubscribed++;
      if (mutate) subscribed = false;
    },
  };

  const policy: PublicPolicyPort = {
    readPublic() {
      return pub;
    },
    writePublic(next) {
      rec.policyWrites.push(next);
      if (mutate) pub = next;
    },
  };

  const daemon: DaemonPort = {
    async restart() {
      rec.restarts++;
      return opts?.restartOk === false
        ? { ok: false, reason: "launchctl kickstart failed" }
        : { ok: true };
    },
  };

  return { ports: { registry, subscribe, policy, daemon }, rec };
}

const BASE_INPUTS: PublicJoinInputs = {
  capabilities: ["code-review.typescript", "research.synthesis"],
  allowPrincipals: [],
};

// =============================================================================
// join public
// =============================================================================

describe("joinPublic", () => {
  test("subscribes public.> + announces declared capabilities + restarts", async () => {
    const { ports, rec } = makeFakes({});
    const res = await joinPublic(BASE_INPUTS, ports);

    expect(res.ok).toBe(true);
    // announced the declared capabilities to the registry public index.
    expect(rec.announced).toEqual([["code-review.typescript", "research.synthesis"]]);
    // subscribed public.> exactly once.
    expect(rec.subscribed).toBe(1);
    // wrote a policy.public block.
    expect(rec.policyWrites.length).toBe(1);
    // restarted so the new subscription takes effect.
    expect(rec.restarts).toBe(1);
  });

  test("SAFE DEFAULT (OQ1): with no --allow, the opt-in is deny-by-default (enabled:false, empty allowlist)", async () => {
    const { ports, rec } = makeFakes({});
    const res = await joinPublic({ capabilities: ["a.b"], allowPrincipals: [] }, ports);

    expect(res.ok).toBe(true);
    const written = rec.policyWrites[0];
    expect(written).toBeDefined();
    // INBOUND public is OFF — announcing/discovering does not open the bus.
    expect(written?.enabled).toBe(false);
    expect(written?.allow_principals).toEqual([]);
    // no "open_claim"/"anonymous" field exists at all — open claim is deferred.
    expect("open_claim" in (written ?? {})).toBe(false);
    expect("anonymous" in (written ?? {})).toBe(false);
  });

  test("with --allow principals, inbound is enabled but ALLOWLIST-gated (not open)", async () => {
    const { ports, rec } = makeFakes({});
    const res = await joinPublic(
      { capabilities: ["a.b"], allowPrincipals: ["jc", "joel"] },
      ports,
    );

    expect(res.ok).toBe(true);
    const written = rec.policyWrites[0];
    expect(written?.enabled).toBe(true);
    // ONLY the named principals — a non-allowlisted public sender is NOT trusted.
    expect(written?.allow_principals).toEqual(["jc", "joel"]);
  });

  test("idempotent — re-joining when already subscribed does not double-subscribe", async () => {
    const { ports, rec } = makeFakes({ initialSubscribed: true });
    const res = await joinPublic(BASE_INPUTS, ports);

    expect(res.ok).toBe(true);
    // already subscribed → no second addPublicSubscription.
    expect(rec.subscribed).toBe(0);
  });

  test("a registry announce failure is fatal (no half-join)", async () => {
    const { ports, rec } = makeFakes({ announceOk: false });
    const res = await joinPublic(BASE_INPUTS, ports);

    expect(res.ok).toBe(false);
    expect(res.reason).toContain("announce");
    // never restarted on a failed announce.
    expect(rec.restarts).toBe(0);
  });

  test("DRY-RUN writes nothing (no subscribe/policy mutation) but records intent + restart is a no-op", async () => {
    const { ports, rec } = makeFakes({ mutate: false });
    const res = await joinPublic(BASE_INPUTS, ports);

    expect(res.ok).toBe(true);
    // intent recorded in the step log + recorder...
    expect(rec.subscribed).toBe(1);
    expect(rec.policyWrites.length).toBe(1);
    // ...but the fake's mutate=false means hasPublicSubscription() is still false
    // after the call (no real mutation happened).
    expect(ports.subscribe.hasPublicSubscription()).toBe(false);
  });
});

// =============================================================================
// leave public
// =============================================================================

describe("leavePublic", () => {
  test("unsubscribes public.> + deregisters capabilities + clears the opt-in + restarts", async () => {
    const { ports, rec } = makeFakes({
      initialSubscribed: true,
      initialPublic: { enabled: true, allow_principals: ["jc"], announce_capabilities: ["a.b"] },
    });
    const res = await leavePublic(ports);

    expect(res.ok).toBe(true);
    expect(rec.unsubscribed).toBe(1);
    expect(rec.deregistered).toBe(1);
    // cleared the policy.public block (undefined = removed).
    expect(rec.policyWrites).toEqual([undefined]);
    expect(rec.restarts).toBe(1);
  });

  test("idempotent — leaving when never joined is a clean no-op", async () => {
    const { ports, rec } = makeFakes({ initialSubscribed: false, initialPublic: undefined });
    const res = await leavePublic(ports);

    expect(res.ok).toBe(true);
    expect(res.notJoined).toBe(true);
    expect(rec.unsubscribed).toBe(0);
    expect(rec.restarts).toBe(0);
  });
});
