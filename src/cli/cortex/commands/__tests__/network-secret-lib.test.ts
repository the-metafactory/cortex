/**
 * ADR-0018 PR5b — `cortex network secret` orchestrator tests (fake ports).
 *
 * Proves the trust-path behaviours over injected ports:
 *   - add-member sealed: mints PSK → adds hub user + reload → seals to the
 *     member pubkey + posts to the admission row; NO secret in steps/data
 *   - add-member oob: surfaces the PSK, registry untouched
 *   - revoke-member: drops the hub user + reload (cuts transport) → registry revoke
 *   - rotate: re-mints + re-writes the hub user + replaces the sealed blob
 *   - dry-run (default) mutates NOTHING
 *   - no ADMITTED row → ok:false, no mutation
 */

import { describe, test, expect } from "bun:test";
import { runNetworkSecret, type SecretInputs } from "../network-secret-lib";
import type { NetworkSecretPorts } from "../network-secret-ports";
import { listHubLeafUsers } from "../../../../common/nats/hub-leaf-authorization";

interface Recorder {
  ports: NetworkSecretPorts;
  hubConf: { text: string };
  writes: string[];
  reloads: number;
  posted: { requestId: string; blob: string }[];
  revoked: string[];
  minted: string[];
}

function makePorts(opts: { admitted?: { request_id: string; principal_id: string }; startConf?: string } = {}): Recorder {
  const hubConf = { text: opts.startConf ?? "leafnodes {\n  listen: 0.0.0.0:7422\n}\n" };
  const writes: string[] = [];
  let reloads = 0;
  const posted: { requestId: string; blob: string }[] = [];
  const revoked: string[] = [];
  const minted: string[] = [];
  let mintCounter = 0;

  const ports: NetworkSecretPorts = {
    hub: {
      confPath: "/fake/hub.conf",
      readConf: async () => hubConf.text,
      writeConf: async (text: string) => {
        hubConf.text = text;
        writes.push(text);
      },
      reload: async () => {
        reloads += 1;
      },
    },
    admission: {
      findAdmittedRow: async () => opts.admitted,
    },
    delivery: {
      postSealedSecret: async (requestId: string, blob: string) => {
        posted.push({ requestId, blob });
      },
      revoke: async (requestId: string) => {
        revoked.push(requestId);
      },
    },
    crypto: {
      mintPsk: () => {
        const p = `PSK-${++mintCounter}`;
        minted.push(p);
        return p;
      },
      seal: async (plaintext: string, pubkey: string) => `SEALED(${pubkey.slice(0, 6)}:${plaintext})`,
    },
  };
  return {
    ports,
    hubConf,
    writes,
    get reloads() {
      return reloads;
    },
    posted,
    revoked,
    minted,
  };
}

const MEMBER_PUBKEY = "QkFTRTY0LU1FTUJFUi1QVUJLRVktNDQtY2hhcnMtZXhhY3Q=";

function inputs(over: Partial<SecretInputs>): SecretInputs {
  return {
    action: "add-member",
    networkId: "metafactory",
    memberPubkey: MEMBER_PUBKEY,
    deliver: "sealed",
    apply: true,
    ...over,
  };
}

function assertNoSecretLeak(steps: string[], data: Record<string, string>, psk: string): void {
  expect(steps.join("\n")).not.toContain(psk);
  expect(JSON.stringify(data)).not.toContain(psk);
}

describe("add-member (sealed)", () => {
  test("mints → adds hub user + reload → seals + posts to the admission row; no secret leak", async () => {
    const r = makePorts({ admitted: { request_id: "req1", principal_id: "alice" } });
    const report = await runNetworkSecret(inputs({ apply: true }), r.ports);

    expect(report.ok).toBe(true);
    expect(report.applied).toBe(true);
    // Hub user added + reloaded
    expect(listHubLeafUsers(r.hubConf.text)).toEqual([{ user: "alice", secret: "PSK-1" }]);
    expect(r.writes.length).toBe(1);
    expect(r.reloads).toBe(1);
    // Sealed blob posted to the row (the envelope was sealed to the member pubkey)
    expect(r.posted.length).toBe(1);
    expect(r.posted[0]!.requestId).toBe("req1");
    expect(r.posted[0]!.blob).toContain("leaf_psk");
    // No revoke
    expect(r.revoked.length).toBe(0);
    // No PSK in the report surfaces
    expect(report.surfaced).toBeUndefined();
    assertNoSecretLeak(report.steps, report.data, "PSK-1");
  });

  test("--leaf-user override is honoured as the hub user", async () => {
    const r = makePorts({ admitted: { request_id: "req1", principal_id: "alice" } });
    await runNetworkSecret(inputs({ leafUserOverride: "alice-laptop" }), r.ports);
    expect(listHubLeafUsers(r.hubConf.text)[0]!.user).toBe("alice-laptop");
  });
});

// C-1349 Slice 1 — clearly-FAKE payload key (K) material. Never realistic bytes.
const FAKE_K = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const FAKE_KID = "metafactory/k1";

describe("add-member (sealed) — C-1349 payload key delivery", () => {
  test("seals payload_key + payload_key_kid into the envelope when hub K is supplied", async () => {
    const r = makePorts({ admitted: { request_id: "req1", principal_id: "alice" } });
    const report = await runNetworkSecret(
      inputs({ payloadKey: FAKE_K, payloadKeyKid: FAKE_KID }),
      r.ports,
    );
    expect(report.ok).toBe(true);
    expect(report.applied).toBe(true);
    // The UNSEALED envelope (the fake seal echoes plaintext) carries BOTH fields.
    expect(r.posted.length).toBe(1);
    expect(r.posted[0]!.blob).toContain("payload_key");
    expect(r.posted[0]!.blob).toContain("payload_key_kid");
    expect(r.posted[0]!.blob).toContain(FAKE_KID);
    // K itself legitimately rides the SEALED blob, but must NEVER reach steps/data.
    expect(report.steps.join("\n")).not.toContain(FAKE_K);
    expect(JSON.stringify(report.data)).not.toContain(FAKE_K);
    // The kid + a fingerprint are printable identifiers.
    expect(report.data.payload_key_kid).toBe(FAKE_KID);
    expect(report.data.payload_key_fingerprint).toBeDefined();
    expect(report.data.payload_key_fingerprint).not.toContain(FAKE_K);
  });

  test("no hub K → envelope carries NO payload fields; an info step points at the SOP", async () => {
    const r = makePorts({ admitted: { request_id: "req1", principal_id: "alice" } });
    const report = await runNetworkSecret(inputs({}), r.ports);
    expect(report.ok).toBe(true);
    expect(r.posted.length).toBe(1);
    expect(r.posted[0]!.blob).not.toContain("payload_key");
    // No fingerprint / kid data when no K.
    expect(report.data.payload_key_kid).toBeUndefined();
    expect(report.data.payload_key_fingerprint).toBeUndefined();
    // A single info line points the admin at the manual-handoff fallback.
    expect(report.steps.join("\n").toLowerCase()).toContain("no payload key");
  });
});

describe("rotate — C-1349 payload key delivery", () => {
  test("re-seals with the CURRENT hub K included", async () => {
    const start =
      'leafnodes {\n  # >>> cortex-managed leaf authorization (network secret tooling) — do not hand-edit\n  authorization {\n    users: [\n      { user: "alice", password: "PSK-old" }\n    ]\n  }\n  # <<< cortex-managed leaf authorization\n}\n';
    const r = makePorts({ admitted: { request_id: "req1", principal_id: "alice" }, startConf: start });
    const report = await runNetworkSecret(
      inputs({ action: "rotate", payloadKey: FAKE_K, payloadKeyKid: FAKE_KID }),
      r.ports,
    );
    expect(report.applied).toBe(true);
    expect(r.posted.length).toBe(1);
    expect(r.posted[0]!.blob).toContain("payload_key_kid");
    expect(r.posted[0]!.blob).toContain(FAKE_KID);
    expect(report.steps.join("\n")).not.toContain(FAKE_K);
  });
});

describe("add-member (oob)", () => {
  test("surfaces the PSK and leaves the registry untouched", async () => {
    const r = makePorts({ admitted: { request_id: "req1", principal_id: "alice" } });
    const report = await runNetworkSecret(inputs({ deliver: "oob" }), r.ports);
    expect(report.applied).toBe(true);
    // Hub user added + reloaded (transport allowed)
    expect(r.reloads).toBe(1);
    // Registry untouched (no sealed post)
    expect(r.posted.length).toBe(0);
    // PSK surfaced for the hub-admin's out-of-band handover
    expect(report.surfaced).toEqual({ leafUser: "alice", psk: "PSK-1" });
    // ...but NOT in the regular steps/data
    assertNoSecretLeak(report.steps, report.data, "PSK-1");
  });
});

describe("revoke-member", () => {
  test("drops the hub user + reload (cuts transport) → registry revoke", async () => {
    // Start with the member already authorized in the hub config.
    const start = "leafnodes {\n  # >>> cortex-managed leaf authorization (network secret tooling) — do not hand-edit\n  authorization {\n    users: [\n      { user: \"alice\", password: \"PSK-old\" }\n    ]\n  }\n  # <<< cortex-managed leaf authorization\n  listen: 0.0.0.0:7422\n}\n";
    const r = makePorts({ admitted: { request_id: "req1", principal_id: "alice" }, startConf: start });
    const report = await runNetworkSecret(inputs({ action: "revoke-member" }), r.ports);

    expect(report.ok).toBe(true);
    expect(report.applied).toBe(true);
    // Hub user gone (transport cut) + reloaded
    expect(listHubLeafUsers(r.hubConf.text)).toEqual([]);
    expect(r.hubConf.text).not.toContain("PSK-old");
    expect(r.reloads).toBe(1);
    // Registry revoke fired
    expect(r.revoked).toEqual(["req1"]);
  });
});

describe("rotate", () => {
  test("re-mints + replaces the hub user + replaces the sealed blob", async () => {
    const start = "leafnodes {\n  # >>> cortex-managed leaf authorization (network secret tooling) — do not hand-edit\n  authorization {\n    users: [\n      { user: \"alice\", password: \"PSK-old\" }\n    ]\n  }\n  # <<< cortex-managed leaf authorization\n}\n";
    const r = makePorts({ admitted: { request_id: "req1", principal_id: "alice" }, startConf: start });
    const report = await runNetworkSecret(inputs({ action: "rotate" }), r.ports);
    expect(report.applied).toBe(true);
    // Hub user replaced with the new PSK; old inert
    expect(listHubLeafUsers(r.hubConf.text)).toEqual([{ user: "alice", secret: "PSK-1" }]);
    expect(r.hubConf.text).not.toContain("PSK-old");
    // New sealed blob posted (replaces)
    expect(r.posted.length).toBe(1);
  });
});

describe("dry-run (default) + guards", () => {
  test("dry-run mutates nothing", async () => {
    const r = makePorts({ admitted: { request_id: "req1", principal_id: "alice" } });
    const report = await runNetworkSecret(inputs({ apply: false }), r.ports);
    expect(report.ok).toBe(true);
    expect(report.applied).toBe(false);
    expect(r.writes.length).toBe(0);
    expect(r.reloads).toBe(0);
    expect(r.posted.length).toBe(0);
    expect(r.revoked.length).toBe(0);
  });

  test("no ADMITTED row → ok:false, no mutation", async () => {
    const r = makePorts({ admitted: undefined });
    const report = await runNetworkSecret(inputs({ apply: true }), r.ports);
    expect(report.ok).toBe(false);
    expect(r.writes.length).toBe(0);
    expect(r.posted.length).toBe(0);
  });
});
