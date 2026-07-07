/**
 * FLG-7 — hub-locality guard tests (§4.D / §6 invariant 7).
 *
 * The three required cases are covered explicitly and labelled:
 *   - is-hub          → a positive declaration that agrees with the registry.
 *   - is-not-hub      → no declaration (member) / different network.
 *   - indeterminate ⇒ DENY → any un-parseable / malformed input NEVER authorizes.
 *
 * Plus the adversarial edges the [frontier-review] pass will hammer: the
 * 2026-07-04 wrong-hub-seal class (declared-local vs registry-public), empty-vs-
 * empty non-matching, port drift, and localhost≠127.0.0.1 (no fuzzy aliasing).
 */

import { describe, expect, test } from "bun:test";
import {
  evaluateHubLocality,
  guardHubLocality,
  hubLocalityDenial,
  parseHubEndpoint,
  type HubEndpoint,
  type LocalHubIdentity,
} from "../hub-locality-guard";

const NET = "n-metafactory";

function descriptor(hub_url: string, leaf_port = 7422, network_id = NET) {
  return { network_id, hub_url, leaf_port };
}

function localHub(networkId: string, endpoint: HubEndpoint): LocalHubIdentity {
  return { hubbedNetworks: { [networkId]: endpoint } };
}

// ---------------------------------------------------------------------------
// is-hub
// ---------------------------------------------------------------------------
describe("evaluateHubLocality — is-hub", () => {
  test("positive declaration matching the registry host+port ⇒ isHub", () => {
    const r = evaluateHubLocality(
      descriptor("tls://hub.meta-factory.ai:7422"),
      localHub(NET, { host: "hub.meta-factory.ai", port: 7422 }),
    );
    expect(r).toEqual({ isHub: true, endpoint: { host: "hub.meta-factory.ai", port: 7422 } });
  });

  test("hub_url without a port ⇒ leaf_port is authoritative and matches", () => {
    const r = evaluateHubLocality(
      descriptor("tls://hub.meta-factory.ai", 7422),
      localHub(NET, { host: "hub.meta-factory.ai", port: 7422 }),
    );
    expect(r.isHub).toBe(true);
  });

  test("bare host (no scheme) still resolves and matches", () => {
    const r = evaluateHubLocality(
      descriptor("hub.meta-factory.ai:7422"),
      localHub(NET, { host: "hub.meta-factory.ai", port: 7422 }),
    );
    expect(r.isHub).toBe(true);
  });

  test("host comparison is case-insensitive", () => {
    const r = evaluateHubLocality(
      descriptor("tls://HUB.Meta-Factory.AI:7422"),
      localHub(NET, { host: "hub.meta-factory.ai", port: 7422 }),
    );
    expect(r.isHub).toBe(true);
  });

  test("a trailing FQDN-root dot normalizes equal", () => {
    const r = evaluateHubLocality(
      descriptor("tls://hub.meta-factory.ai.:7422"),
      localHub(NET, { host: "hub.meta-factory.ai", port: 7422 }),
    );
    expect(r.isHub).toBe(true);
  });

  test("a genuinely-local single-host hub (declared==registry) is the hub", () => {
    // A stack that legitimately hosts its own hub on loopback: registry AND config
    // agree on 127.0.0.1 — this is a real match, not the wrong-hub class.
    const r = evaluateHubLocality(
      descriptor("tls://127.0.0.1:7422"),
      localHub(NET, { host: "127.0.0.1", port: 7422 }),
    );
    expect(r.isHub).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// is-not-hub
// ---------------------------------------------------------------------------
describe("evaluateHubLocality — is-not-hub", () => {
  test("no hub role at all (undefined identity — the member case) ⇒ not-hub", () => {
    const r = evaluateHubLocality(descriptor("tls://hub.meta-factory.ai:7422"), undefined);
    expect(r).toMatchObject({ isHub: false, code: "not-hub" });
  });

  test("empty hubbedNetworks ⇒ not-hub", () => {
    const r = evaluateHubLocality(descriptor("tls://hub.meta-factory.ai:7422"), {
      hubbedNetworks: {},
    });
    expect(r).toMatchObject({ isHub: false, code: "not-hub" });
  });

  test("declares a DIFFERENT network but not this one ⇒ not-hub", () => {
    const r = evaluateHubLocality(
      descriptor("tls://hub.meta-factory.ai:7422"),
      localHub("n-other", { host: "hub.meta-factory.ai", port: 7422 }),
    );
    expect(r).toMatchObject({ isHub: false, code: "not-hub" });
  });
});

// ---------------------------------------------------------------------------
// hub-endpoint-drift — the 2026-07-04 wrong-hub-seal class
// ---------------------------------------------------------------------------
describe("evaluateHubLocality — hub-endpoint-drift (anti wrong-hub-seal)", () => {
  test("declared LOCAL nats but registry hub is a PUBLIC host ⇒ drift DENY", () => {
    // The exact storm: config points at the local nats, the network's real hub is
    // JC's public server. Sealing here would land on the wrong machine.
    const r = evaluateHubLocality(
      descriptor("tls://nats.meta-factory.dev:7422"),
      localHub(NET, { host: "127.0.0.1", port: 7422 }),
    );
    expect(r).toMatchObject({ isHub: false, code: "hub-endpoint-drift" });
  });

  test("same host, different port ⇒ drift DENY", () => {
    const r = evaluateHubLocality(
      descriptor("tls://hub.meta-factory.ai:7422"),
      localHub(NET, { host: "hub.meta-factory.ai", port: 7500 }),
    );
    expect(r).toMatchObject({ isHub: false, code: "hub-endpoint-drift" });
  });

  test("localhost is NOT fuzzy-aliased to 127.0.0.1 ⇒ drift DENY (fail-closed direction)", () => {
    const r = evaluateHubLocality(
      descriptor("tls://127.0.0.1:7422"),
      localHub(NET, { host: "localhost", port: 7422 }),
    );
    expect(r).toMatchObject({ isHub: false, code: "hub-endpoint-drift" });
  });
});

// ---------------------------------------------------------------------------
// indeterminate ⇒ DENY — the security-critical default
// ---------------------------------------------------------------------------
describe("evaluateHubLocality — indeterminate ⇒ DENY", () => {
  test("empty registry hub_url ⇒ indeterminate (never isHub)", () => {
    const r = evaluateHubLocality(
      descriptor(""),
      localHub(NET, { host: "hub.meta-factory.ai", port: 7422 }),
    );
    expect(r).toMatchObject({ isHub: false, code: "indeterminate" });
  });

  test("unparseable registry hub_url ⇒ indeterminate", () => {
    const r = evaluateHubLocality(
      descriptor("tls://:::not a url"),
      localHub(NET, { host: "hub.meta-factory.ai", port: 7422 }),
    );
    expect(r).toMatchObject({ isHub: false, code: "indeterminate" });
  });

  test("registry hub_url without a port AND invalid leaf_port ⇒ indeterminate", () => {
    const r = evaluateHubLocality(
      descriptor("tls://hub.meta-factory.ai", 0),
      localHub(NET, { host: "hub.meta-factory.ai", port: 7422 }),
    );
    expect(r).toMatchObject({ isHub: false, code: "indeterminate" });
  });

  test("declared endpoint with an EMPTY host ⇒ indeterminate (NOT a match vs any registry)", () => {
    const r = evaluateHubLocality(
      descriptor("tls://hub.meta-factory.ai:7422"),
      localHub(NET, { host: "", port: 7422 }),
    );
    expect(r).toMatchObject({ isHub: false, code: "indeterminate" });
  });

  test("CRITICAL: empty declared host vs empty registry host does NOT authorize", () => {
    // Both sides "empty" must never collapse to a match. The registry side fails
    // first (indeterminate), and even if it didn't, the declared side is validated
    // independently. Either way: DENY, never isHub.
    const r = evaluateHubLocality(descriptor(""), localHub(NET, { host: "", port: 7422 }));
    expect(r.isHub).toBe(false);
  });

  test("declared endpoint with an out-of-range port ⇒ indeterminate", () => {
    for (const badPort of [0, -1, 70000, 3.14, Number.NaN]) {
      const r = evaluateHubLocality(
        descriptor("tls://hub.meta-factory.ai:7422"),
        localHub(NET, { host: "hub.meta-factory.ai", port: badPort }),
      );
      expect(r).toMatchObject({ isHub: false, code: "indeterminate" });
    }
  });
});

// ---------------------------------------------------------------------------
// parseHubEndpoint — the parsing primitive
// ---------------------------------------------------------------------------
describe("parseHubEndpoint", () => {
  test("full tls URL with port", () => {
    expect(parseHubEndpoint("tls://hub.example.ai:7422", 1)).toEqual({
      ok: true,
      endpoint: { host: "hub.example.ai", port: 7422 },
    });
  });

  test("url port wins over leaf_port", () => {
    const r = parseHubEndpoint("tls://hub.example.ai:9999", 7422);
    expect(r).toMatchObject({ ok: true, endpoint: { port: 9999 } });
  });

  test("no url port ⇒ leaf_port used", () => {
    const r = parseHubEndpoint("tls://hub.example.ai", 7422);
    expect(r).toMatchObject({ ok: true, endpoint: { port: 7422 } });
  });

  for (const [label, url, leaf] of [
    ["empty", "", 7422],
    ["whitespace", "   ", 7422],
    ["no host", "tls://:7422", 7422],
    ["no port + bad leaf", "tls://hub.example.ai", 0],
    ["non-string", 42 as unknown as string, 7422],
  ] as const) {
    test(`rejects ${label} ⇒ ok:false`, () => {
      expect(parseHubEndpoint(url, leaf as number).ok).toBe(false);
    });
  }
});

// ---------------------------------------------------------------------------
// hubLocalityDenial + guardHubLocality — the decider-facing helpers
// ---------------------------------------------------------------------------
describe("hubLocalityDenial", () => {
  test("returns null when the daemon IS the hub", () => {
    const denial = hubLocalityDenial(NET, { isHub: true, endpoint: { host: "h", port: 7422 } });
    expect(denial).toBeNull();
  });

  test("returns an honest 403 for every deny code", () => {
    for (const code of ["not-hub", "hub-endpoint-drift", "indeterminate"] as const) {
      const denial = hubLocalityDenial(NET, { isHub: false, code, reason: "because" });
      expect(denial).toEqual({ status: 403, error: "not_the_hub", code, network: NET, detail: "because" });
    }
  });
});

describe("guardHubLocality", () => {
  test("authorized:true with the endpoint when the daemon is the hub", () => {
    const g = guardHubLocality(
      descriptor("tls://hub.meta-factory.ai:7422"),
      localHub(NET, { host: "hub.meta-factory.ai", port: 7422 }),
    );
    expect(g).toEqual({ authorized: true, endpoint: { host: "hub.meta-factory.ai", port: 7422 } });
  });

  test("authorized:false with a ready-to-emit 403 when not the hub", () => {
    const g = guardHubLocality(descriptor("tls://hub.meta-factory.ai:7422"), undefined);
    expect(g.authorized).toBe(false);
    if (!g.authorized) {
      expect(g.denial.status).toBe(403);
      expect(g.denial.error).toBe("not_the_hub");
      expect(g.denial.code).toBe("not-hub");
    }
  });

  test("fail-closed: an indeterminate input yields authorized:false, never true", () => {
    const g = guardHubLocality(
      descriptor(""),
      localHub(NET, { host: "hub.meta-factory.ai", port: 7422 }),
    );
    expect(g.authorized).toBe(false);
  });
});
