/**
 * S2 (Network Join Control Plane, #736 · epic #733 · spec §6 F2) —
 * config-load federated-peer resolver tests.
 *
 * Covers F2's AC + the three load-bearing design decisions, all against a STUB
 * S1 client (a hand-built `NetworkRosterProvider` double — NO network I/O):
 *
 *   1. DD-5  — a peer with only `principal_id` + `stack_id` (no pubkey) resolves
 *              its `principal_pubkey` from the verified roster, re-encoded to
 *              nkey-U, feeding the SAME gate/verify path a hand-pin feeds.
 *   2. DD-10 — registry unreachable → fall back to the last-known-good cached
 *              roster + emit a loud warning; federation stays configured.
 *   3. DD-11 — a hand-pinned pubkey that DIFFERS from the resolved key →
 *              fail-closed for that peer (dropped from the gate) + alert
 *              (the load-bearing drift/attack-guard test).
 *   4. DD-11 — a hand-pinned pubkey that MATCHES the resolved key → honored
 *              (peer kept, no alert).
 *   5. a registry-only peer that is unresolvable AND uncached → typed error +
 *              the peer is NOT admitted (the gate must never hold a keyless peer).
 *   6. MAJOR-1 (PR #818) — a fully hand-pinned network is cross-checked against
 *              the roster when the registry is reachable (a drifted pin → DD-11
 *              drop), and still survives a total registry outage offline (DD-10).
 *              Only an empty-peers network makes zero registry calls.
 */

import { describe, expect, test } from "bun:test";

import { base64PubkeyToNkey } from "../encoding";
import {
  resolveFederatedPeers,
  type NetworkRosterProvider,
} from "../resolve-federated-peers";
import type { NetworkFetchResult } from "../network-client";
import type { NetworkRosterResult } from "../types";
import type { PolicyFederatedNetwork } from "../../types/cortex-config";

// =============================================================================
// Fixtures — round-trip-valid base64 ⇄ nkey-U key pairs (no crypto at test
// time; these are deterministic 32-byte keys whose nkey-U encodings the
// `encoding` module produces, pinned by encoding.test.ts).
// =============================================================================

/** base64 raw ed25519 (registry surface). */
const PEER_B64_A = "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=";
const PEER_B64_B = "AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI=";
/** nkey-U (config/peers surface) — the DD-8 translation of the above. */
const PEER_NKEY_A = base64PubkeyToNkey(PEER_B64_A)!;
const PEER_NKEY_B = base64PubkeyToNkey(PEER_B64_B)!;

/** A network with a single peer; pubkey filled by the caller per test. */
function networkWith(
  peers: PolicyFederatedNetwork["peers"],
): PolicyFederatedNetwork {
  return {
    id: "research-collab",
    leaf_node: "hub-leaf",
    peers,
    accept_subjects: ["federated.andreas.default.>"],
    deny_subjects: [],
    announce_capabilities: [],
    max_hop: 1,
  };
}

function rosterWith(
  members: NetworkRosterResult["members"],
): NetworkRosterResult {
  return { network_id: "research-collab", members };
}

/**
 * A stub S1 client. `fetchAndCache` returns the scripted live result;
 * `loadCached` returns the scripted cached pair (DD-10 fallback). Records the
 * networks it was asked to resolve so tests can assert no-call / call-once.
 */
function stubProvider(opts: {
  live?: NetworkFetchResult<{ roster: NetworkRosterResult }>;
  cached?: { roster: NetworkRosterResult } | undefined;
}): NetworkRosterProvider & { fetched: string[]; loadedCached: string[] } {
  const fetched: string[] = [];
  const loadedCached: string[] = [];
  return {
    fetched,
    loadedCached,
    async fetchAndCache(networkId) {
      fetched.push(networkId);
      return (
        opts.live ?? { status: "unreachable", reason: "no live result scripted" }
      );
    },
    loadCached(networkId) {
      loadedCached.push(networkId);
      return opts.cached;
    },
  };
}

// =============================================================================
// DD-5 — resolve-by-principal_id from a verified roster
// =============================================================================

describe("resolveFederatedPeers — DD-5 registry resolution", () => {
  test("a pubkey-less peer resolves its key from the roster (re-encoded nkey-U)", async () => {
    const network = networkWith([
      { principal_id: "jc", stack_id: "jc/sage-host" },
    ]);
    const provider = stubProvider({
      live: {
        status: "ok",
        value: {
          roster: rosterWith([
            { principal_id: "jc", principal_pubkey: PEER_B64_A },
          ]),
        },
      },
    });
    const warnings: string[] = [];

    const result = await resolveFederatedPeers([network], provider, {
      warn: (m) => warnings.push(m),
    });

    expect(result.networks).toHaveLength(1);
    expect(result.networks[0]!.peers).toHaveLength(1);
    // Resolved key is the nkey-U translation of the roster's base64 — the
    // SAME shape a hand-pin carries, so the downstream gate/verify path is
    // unchanged.
    expect(result.networks[0]!.peers[0]!.principal_pubkey).toBe(PEER_NKEY_A);
    expect(result.errors).toHaveLength(0);
    expect(provider.fetched).toEqual(["research-collab"]);
  });

  test("multiple pubkey-less peers each resolve independently", async () => {
    const network = networkWith([
      { principal_id: "jc", stack_id: "jc/sage-host" },
      { principal_id: "mel", stack_id: "mel/host" },
    ]);
    const provider = stubProvider({
      live: {
        status: "ok",
        value: {
          roster: rosterWith([
            { principal_id: "jc", principal_pubkey: PEER_B64_A },
            { principal_id: "mel", principal_pubkey: PEER_B64_B },
          ]),
        },
      },
    });

    const result = await resolveFederatedPeers([network], provider, {
      warn: () => {},
    });

    expect(result.networks[0]!.peers.map((p) => p.principal_pubkey)).toEqual([
      PEER_NKEY_A,
      PEER_NKEY_B,
    ]);
    expect(result.errors).toHaveLength(0);
  });
});

// =============================================================================
// DD-10 — registry-down → cached roster + warn, federation stays up
// =============================================================================

describe("resolveFederatedPeers — DD-10 registry-down fallback", () => {
  test("unreachable registry falls back to cached roster, warns, stays configured", async () => {
    const network = networkWith([
      { principal_id: "jc", stack_id: "jc/sage-host" },
    ]);
    const provider = stubProvider({
      live: { status: "unreachable", reason: "network_error" },
      cached: {
        roster: rosterWith([
          { principal_id: "jc", principal_pubkey: PEER_B64_A },
        ]),
      },
    });
    const warnings: string[] = [];

    const result = await resolveFederatedPeers([network], provider, {
      warn: (m) => warnings.push(m),
    });

    // Federation stays up on last-known-good.
    expect(result.networks[0]!.peers).toHaveLength(1);
    expect(result.networks[0]!.peers[0]!.principal_pubkey).toBe(PEER_NKEY_A);
    expect(result.errors).toHaveLength(0);
    // Loud warning emitted (DD-10).
    expect(warnings.some((w) => /cache|last-known-good|unreachable/i.test(w))).toBe(
      true,
    );
    expect(provider.loadedCached).toEqual(["research-collab"]);
  });

  test("unreachable AND uncached registry-only peer → typed error, peer NOT admitted", async () => {
    const network = networkWith([
      { principal_id: "jc", stack_id: "jc/sage-host" },
    ]);
    const provider = stubProvider({
      live: { status: "unreachable", reason: "network_error" },
      cached: undefined,
    });
    const warnings: string[] = [];

    const result = await resolveFederatedPeers([network], provider, {
      warn: (m) => warnings.push(m),
    });

    // The keyless peer cannot be admitted — the gate must never hold a peer
    // with no key (can't fail open).
    expect(result.networks[0]!.peers).toHaveLength(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!.kind).toBe("unresolved");
    expect(result.errors[0]!.principalId).toBe("jc");
    expect(result.errors[0]!.networkId).toBe("research-collab");
  });
});

// =============================================================================
// DD-11 — pinned-vs-resolved mismatch → fail-closed (load-bearing)
// =============================================================================

describe("resolveFederatedPeers — DD-11 mismatch fail-closed", () => {
  test("hand-pinned key DIFFERS from resolved → peer rejected + alert", async () => {
    // A mixed network: `mel` is registry-only (triggers the roster fetch),
    // and `jc` carries a STALE hand-pinned nkey (A) while the registry now
    // serves a DIFFERENT key (B) for it. A divergence is a drift/attack
    // signal, not a merge — `jc` fails closed; `mel` still resolves.
    const network = networkWith([
      {
        principal_id: "jc",
        stack_id: "jc/sage-host",
        principal_pubkey: PEER_NKEY_A,
      },
      { principal_id: "mel", stack_id: "mel/host" },
    ]);
    const provider = stubProvider({
      live: {
        status: "ok",
        value: {
          roster: rosterWith([
            { principal_id: "jc", principal_pubkey: PEER_B64_B },
            { principal_id: "mel", principal_pubkey: PEER_B64_B },
          ]),
        },
      },
    });
    const warnings: string[] = [];

    const result = await resolveFederatedPeers([network], provider, {
      warn: (m) => warnings.push(m),
    });

    // Fail-closed: the mismatched peer is DROPPED from the gate; the
    // registry-only peer is still admitted.
    expect(result.networks[0]!.peers.map((p) => p.principal_id)).toEqual([
      "mel",
    ]);
    // Typed mismatch error surfaced for alerting.
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!.kind).toBe("pin_mismatch");
    expect(result.errors[0]!.principalId).toBe("jc");
    // Loud alert emitted.
    expect(
      warnings.some((w) => /mismatch|drift|fail-closed|tamper/i.test(w)),
    ).toBe(true);
  });

  test("hand-pinned key MATCHES resolved → honored, no alert, no error", async () => {
    // Mixed network so the roster is fetched: `jc`'s hand-pin matches the
    // registry (no-op honored), `mel` is registry-resolved.
    const network = networkWith([
      {
        principal_id: "jc",
        stack_id: "jc/sage-host",
        principal_pubkey: PEER_NKEY_A,
      },
      { principal_id: "mel", stack_id: "mel/host" },
    ]);
    const provider = stubProvider({
      live: {
        status: "ok",
        value: {
          roster: rosterWith([
            { principal_id: "jc", principal_pubkey: PEER_B64_A },
            { principal_id: "mel", principal_pubkey: PEER_B64_B },
          ]),
        },
      },
    });
    const warnings: string[] = [];

    const result = await resolveFederatedPeers([network], provider, {
      warn: (m) => warnings.push(m),
    });

    expect(result.networks[0]!.peers.map((p) => p.principal_id)).toEqual([
      "jc",
      "mel",
    ]);
    expect(result.networks[0]!.peers[0]!.principal_pubkey).toBe(PEER_NKEY_A);
    expect(result.networks[0]!.peers[1]!.principal_pubkey).toBe(PEER_NKEY_B);
    expect(result.errors).toHaveLength(0);
    expect(warnings).toHaveLength(0);
  });
});

// =============================================================================
// Back-compat — hand-pinned-only configs resolve offline, unchanged
// =============================================================================

describe("resolveFederatedPeers — fully hand-pinned cross-check (MAJOR-1) + back-compat", () => {
  test("a fully hand-pinned network IS cross-checked when the registry is reachable; matching pins kept", async () => {
    // PR #818 review MAJOR-1: a fully hand-pinned network is NO LONGER a
    // zero-call fast path. When a registry (client) is available, the roster IS
    // fetched and every hand-pin is cross-checked (DD-11). Matching pins are
    // honored (no-op); a drifted pin would be dropped (covered below).
    const network = networkWith([
      { principal_id: "jc", stack_id: "jc/sage-host", principal_pubkey: PEER_NKEY_A },
      { principal_id: "mel", stack_id: "mel/host", principal_pubkey: PEER_NKEY_B },
    ]);
    const provider = stubProvider({
      live: {
        status: "ok",
        value: {
          roster: rosterWith([
            { principal_id: "jc", principal_pubkey: PEER_B64_A },
            { principal_id: "mel", principal_pubkey: PEER_B64_B },
          ]),
        },
      },
    });
    const warnings: string[] = [];

    const result = await resolveFederatedPeers([network], provider, {
      warn: (m) => warnings.push(m),
    });

    // The roster IS fetched now (the MAJOR-1 fix), and the matching pins are
    // kept unchanged.
    expect(provider.fetched).toEqual(["research-collab"]);
    expect(result.errors).toHaveLength(0);
    expect(warnings).toHaveLength(0);
    expect(result.networks[0]!.peers).toEqual(network.peers);
  });

  test("MAJOR-1 — a fully hand-pinned network with a DRIFTED pin → peer dropped (pin_mismatch)", async () => {
    // The regression guard: jc is hand-pinned to A, but the registry now serves
    // B for jc (rotation / tamper). DD-11 must fire even though every peer is
    // hand-pinned — the peer is DROPPED, not admitted on the stale pin.
    const network = networkWith([
      { principal_id: "jc", stack_id: "jc/sage-host", principal_pubkey: PEER_NKEY_A },
    ]);
    const provider = stubProvider({
      live: {
        status: "ok",
        value: {
          roster: rosterWith([{ principal_id: "jc", principal_pubkey: PEER_B64_B }]),
        },
      },
    });
    const warnings: string[] = [];

    const result = await resolveFederatedPeers([network], provider, {
      warn: (m) => warnings.push(m),
    });

    expect(provider.fetched).toEqual(["research-collab"]);
    expect(result.networks[0]!.peers).toHaveLength(0); // dropped, not kept
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!.kind).toBe("pin_mismatch");
  });

  test("MAJOR-1 — a fully hand-pinned network survives a total registry outage (DD-10 offline)", async () => {
    // The MAJOR-1 fix does NOT break "hand-pins always resolve offline": a fetch
    // that is unreachable + uncached leaves the roster undefined, and a
    // hand-pinned peer with no registry value to cross-check is admitted as-is.
    const network = networkWith([
      { principal_id: "jc", stack_id: "jc/sage-host", principal_pubkey: PEER_NKEY_A },
      { principal_id: "mel", stack_id: "mel/host", principal_pubkey: PEER_NKEY_B },
    ]);
    const provider = stubProvider({
      live: { status: "unreachable", reason: "ECONNREFUSED" },
      cached: undefined,
    });
    const warnings: string[] = [];

    const result = await resolveFederatedPeers([network], provider, {
      warn: (m) => warnings.push(m),
    });

    // The fetch is attempted (and falls back), but the hand-pins survive.
    expect(provider.fetched).toEqual(["research-collab"]);
    expect(result.errors).toHaveLength(0);
    expect(result.networks[0]!.peers).toEqual(network.peers);
    // A loud DD-10 warning is emitted (registry unreachable + no cache).
    expect(warnings.some((w) => w.includes("unreachable"))).toBe(true);
  });

  test("a network with no peers is a no-op (no registry calls)", async () => {
    const network = networkWith([]);
    const provider = stubProvider({});

    const result = await resolveFederatedPeers([network], provider, {
      warn: () => {},
    });

    expect(provider.fetched).toEqual([]);
    expect(result.networks[0]!.peers).toEqual([]);
    expect(result.errors).toHaveLength(0);
  });

  test("a roster missing the requested peer → typed unresolved error, peer dropped", async () => {
    const network = networkWith([
      { principal_id: "jc", stack_id: "jc/sage-host" },
    ]);
    const provider = stubProvider({
      live: {
        status: "ok",
        value: {
          // Roster verified but does not contain `jc`.
          roster: rosterWith([
            { principal_id: "someone-else", principal_pubkey: PEER_B64_B },
          ]),
        },
      },
    });
    const warnings: string[] = [];

    const result = await resolveFederatedPeers([network], provider, {
      warn: (m) => warnings.push(m),
    });

    expect(result.networks[0]!.peers).toHaveLength(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!.kind).toBe("unresolved");
  });

  test("a roster pubkey that is not valid base64 → peer dropped, typed error", async () => {
    const network = networkWith([
      { principal_id: "jc", stack_id: "jc/sage-host" },
    ]);
    const provider = stubProvider({
      live: {
        status: "ok",
        value: {
          roster: rosterWith([
            // Structurally a string but not a valid 32-byte base64 key.
            { principal_id: "jc", principal_pubkey: "not-a-real-key" },
          ]),
        },
      },
    });

    const result = await resolveFederatedPeers([network], provider, {
      warn: () => {},
    });

    expect(result.networks[0]!.peers).toHaveLength(0);
    expect(result.errors[0]!.kind).toBe("unresolved");
  });
});
