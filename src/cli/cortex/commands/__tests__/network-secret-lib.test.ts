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
import { createAccount, createUser } from "@nats-io/nkeys";
import { nkeyToBase64Pubkey } from "../../../../common/registry/encoding";
import { toBase64Pubkey } from "../../../../common/registry/pubkey-normalize";
import {
  runNetworkSecret,
  runNetworkKeyRotation,
  computeNextKid,
  decideHubLocality,
  renderHubOwnerArtifact,
  type SecretInputs,
  type KeyRotationInputs,
} from "../network-secret-lib";
import type {
  NetworkSecretPorts,
  NetworkKeyRotationPorts,
  AdmittedMember,
} from "../network-secret-ports";
import type { PolicyFederatedNetwork } from "../../../../common/types/cortex-config";
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

function makePorts(opts: {
  admitted?: { request_id: string; principal_id: string };
  startConf?: string;
  // cortex#1481 — hub-locality fakes. Defaults resolve LOCAL (loopback alias)
  // so every PRE-#1481 test keeps its local-hub-write assumption unchanged.
  /** Cached hub_url the fake `resolveHubUrl` returns. Default: loopback (LOCAL). */
  hubUrl?: string;
  /** true ⇒ resolveHubUrl resolves undefined (no cached descriptor — "can't determine"). */
  noHubCache?: boolean;
  /** This machine's fake hostname. Default "localhost" (irrelevant when hubUrl is a loopback alias). */
  localHostname?: string;
  /** Sage review Important 2 — fake DNS→local-interface signal. Default false
   *  (the loopback-alias default already resolves LOCAL without it). */
  hubHostIsLocalInterface?: boolean;
} = {}): Recorder {
  const hubConf = { text: opts.startConf ?? "leafnodes {\n  listen: 0.0.0.0:7422\n}\n" };
  const writes: string[] = [];
  let reloads = 0;
  const posted: { requestId: string; blob: string }[] = [];
  const revoked: string[] = [];
  const minted: string[] = [];
  let mintCounter = 0;
  const hubUrl = opts.noHubCache === true ? undefined : (opts.hubUrl ?? "tls://localhost:7422");
  const localHostname = opts.localHostname ?? "localhost";
  const hubHostIsLocalInterface = opts.hubHostIsLocalInterface ?? false;

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
    hubLocality: {
      resolveHubUrl: async () => hubUrl,
      localHostname: () => localHostname,
      hubHostIsLocalInterface: async () => hubHostIsLocalInterface,
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

// ===========================================================================
// cortex#1482 (epic #1479, join-3) — Pair 1: registered/PoP pubkey ⟷ FED
// account (seal-target ≠ leaf-account, ADR-0018). NKEY <-> base64
// auto-convert at the admission lookup + the loud "wrong representation"
// explanation instead of a bare "no ADMITTED row" error.
// ===========================================================================

describe("cortex#1482 — Pair 1: registered pubkey ⟷ FED account", () => {
  test("an nkey-account-shaped member with no ADMITTED row gets the ADR-0018 explanation, not a bare error", async () => {
    const r = makePorts({ admitted: undefined });
    // Grammar-valid (A + 55 base32 chars), checksum-invalid — the SAME fixture
    // style used across the existing --hub-account tests; the explanation is a
    // grammar-only HINT (looksLikeNkeyRole), so it fires regardless.
    const fakeAccountNkey = "A" + "D".repeat(55);
    const report = await runNetworkSecret(inputs({ memberPubkey: fakeAccountNkey, apply: true }), r.ports);
    expect(report.ok).toBe(false);
    expect(report.reason).toContain("FED account nkey");
    expect(report.reason).toContain("seal-target ≠ leaf-account");
    expect(report.reason).toContain("ADR-0018");
    expect(report.reason).toContain("--hub-account");
    // The bare message is still the PREFIX (nothing removed, only appended).
    expect(report.reason).toContain("no ADMITTED admission row for that member");
  });

  test("a base64 member with no ADMITTED row gets the BARE message (no representation claim we can't back)", async () => {
    const r = makePorts({ admitted: undefined });
    const report = await runNetworkSecret(inputs({ apply: true }), r.ports); // default MEMBER_PUBKEY is base64
    expect(report.ok).toBe(false);
    expect(report.reason).not.toContain("FED account nkey");
    expect(report.reason).toContain("no ADMITTED admission row for that member");
  });

  test("revoke-member: the SAME explanation fires on the wrong-representation path", async () => {
    const r = makePorts({ admitted: undefined });
    const fakeAccountNkey = "A" + "E".repeat(55);
    const report = await runNetworkSecret(
      inputs({ action: "revoke-member", memberPubkey: fakeAccountNkey, apply: true }),
      r.ports,
    );
    expect(report.ok).toBe(false);
    expect(report.reason).toContain("FED account nkey");
    expect(report.reason).toContain("nothing to revoke");
  });

  test("an nkey-user member is auto-converted to base64 for the admission lookup + the seal", async () => {
    const nkeyU = createUser().getPublicKey();
    const expectedB64 = nkeyToBase64Pubkey(nkeyU)!;
    let lookedUpWith: string | undefined;
    const r = makePorts({ admitted: { request_id: "req1", principal_id: "alice" } });
    const originalFind = r.ports.admission.findAdmittedRow;
    r.ports.admission.findAdmittedRow = async (networkId: string, memberPubkey: string) => {
      lookedUpWith = memberPubkey;
      return originalFind(networkId, memberPubkey);
    };

    const report = await runNetworkSecret(inputs({ memberPubkey: nkeyU, apply: true }), r.ports);

    expect(report.ok).toBe(true);
    expect(lookedUpWith).toBe(expectedB64);
    // The fingerprint printed in steps/data is derived from the NORMALIZED
    // (base64) form too, not the raw nkey string.
    expect(report.data.member_fingerprint).toBe(expectedB64.slice(0, 12));
  });

  test("an nkey-account member (the WRONG representation) is still converted to base64 for the lookup — the explanation only fires when that lookup MISSES", async () => {
    // If an admission row genuinely exists keyed to these (unusual) bytes, the
    // lookup succeeds and no explanation is needed — normalize-then-lookup
    // never refuses solely because the input LOOKED like an account nkey.
    const nkeyA = createAccount().getPublicKey();
    const expectedB64 = toBase64Pubkey(nkeyA)!;
    const r = makePorts({ admitted: { request_id: "req1", principal_id: "alice" } });
    const report = await runNetworkSecret(inputs({ memberPubkey: nkeyA, apply: true }), r.ports);
    expect(report.ok).toBe(true);
    expect(report.data.member_fingerprint).toBe(expectedB64.slice(0, 12));
  });
});

// ===========================================================================
// cortex#1481 (epic #1479, join-2) — hub locality: NEVER write a foreign hub.
//
// The #1 storm cause: `--hub-config` defaults to the LOCAL nats, so when a
// network's hub is ANOTHER principal's server, add-member/rotate wrote the
// leaf authorization onto the wrong machine — the real hub never saw it, and
// the joiner's leaf Authorization-Violation-storms. These tests prove: (a) an
// external hub never gets the local write (registry seal still runs, artifact
// emitted); (b) --seal-only forces the same path even on a local-looking hub;
// (c) a genuinely local hub (loopback/exact-hostname) still writes as before;
// (c') a hub cached as an FQDN that resolves to a local interface ALSO writes
// locally (the real hub-owner deployment — Sage review Important 2); (d) an
// unresolved hub_url (no cached descriptor) is treated as external — fail-safe.
// ===========================================================================

describe("decideHubLocality (pure)", () => {
  // Convenience: the common "no interface signal" input.
  const notLocalIface = (localHostname: string) => ({ localHostname, hubHostIsLocalInterface: false });

  test("loopback alias → local (no interface signal needed)", () => {
    expect(decideHubLocality("tls://localhost:7422", notLocalIface("some-other-hostname")).kind).toBe("local");
    expect(decideHubLocality("tls://127.0.0.1:7422", notLocalIface("some-other-hostname")).kind).toBe("local");
    expect(decideHubLocality("tls://[::1]:7422", notLocalIface("some-other-hostname")).kind).toBe("local");
  });

  test("exact case-insensitive hostname match → local", () => {
    expect(decideHubLocality("tls://Andreas-VM.local:7422", notLocalIface("andreas-vm.local")).kind).toBe("local");
  });

  test("Sage Important 2 — FQDN hub that resolves to a LOCAL INTERFACE → local (short hostname mismatch)", () => {
    // The real-deployment case: hub cached as an FQDN, os.hostname() a short
    // name — neither loopback nor exact-hostname fires, but the interface probe
    // confirms it's this machine's own hub VM.
    const v = decideHubLocality("tls://nats.meta-factory.dev:7422", {
      localHostname: "macjcf",
      hubHostIsLocalInterface: true,
    });
    expect(v.kind).toBe("local");
  });

  test("Sage Important 2 — FQDN hub, NOT a local interface → external", () => {
    const v = decideHubLocality("tls://nats.meta-factory.dev:7422", {
      localHostname: "macjcf",
      hubHostIsLocalInterface: false,
    });
    expect(v.kind).toBe("external");
    if (v.kind === "external") {
      expect(v.hubUrl).toBe("tls://nats.meta-factory.dev:7422");
      expect(v.reason).toContain("nats.meta-factory.dev");
      expect(v.reason).toContain("local network interface");
    }
  });

  test("a genuinely different host (no interface match) → external, with a reason", () => {
    const v = decideHubLocality("tls://andreas-vm.example.com:7422", notLocalIface("jc-laptop.local"));
    expect(v.kind).toBe("external");
    if (v.kind === "external") {
      expect(v.hubUrl).toBe("tls://andreas-vm.example.com:7422");
      expect(v.reason).toContain("andreas-vm.example.com");
    }
  });

  test("no cached hub_url at all → external (fail-safe, cannot determine)", () => {
    const v = decideHubLocality(undefined, notLocalIface("jc-laptop.local"));
    expect(v.kind).toBe("external");
    if (v.kind === "external") {
      expect(v.hubUrl).toBeUndefined();
      expect(v.reason).toContain("no cached network descriptor");
    }
  });

  test("an unparseable hub_url → external (fail-safe)", () => {
    const v = decideHubLocality("not a url at all :::", notLocalIface("jc-laptop.local"));
    expect(v.kind).toBe("external");
  });
});

describe("renderHubOwnerArtifact (pure)", () => {
  test("carries the exact leafnodes{} authorization snippet + the PSK", () => {
    const lines = renderHubOwnerArtifact({
      networkId: "metafactory",
      leafUser: "andreas",
      psk: "PSK-for-the-hub-owner",
      hubUrl: "tls://andreas-vm.example.com:7422",
    }).join("\n");
    expect(lines).toContain("leafnodes {");
    expect(lines).toContain("authorization {");
    expect(lines).toContain('"andreas"');
    expect(lines).toContain("PSK-for-the-hub-owner");
    expect(lines).toContain("tls://andreas-vm.example.com:7422");
    // No account known → the user entry itself carries NO account: field...
    expect(lines).toContain('{ user: "andreas", password: "PSK-for-the-hub-owner" }');
    // ...but an advisory note points the hub owner at --hub-account.
    expect(lines).toContain("--hub-account");
  });

  test("account-bound when --hub-account is known", () => {
    const lines = renderHubOwnerArtifact({
      networkId: "metafactory",
      leafUser: "andreas",
      psk: "PSK-x",
      account: "A" + "B".repeat(55),
    }).join("\n");
    expect(lines).toContain(`account: "A${"B".repeat(55)}"`);
  });

  test("hub_url unknown → says so instead of fabricating one", () => {
    const lines = renderHubOwnerArtifact({ networkId: "metafactory", leafUser: "andreas", psk: "PSK-x" }).join("\n");
    expect(lines).toContain("could not be confirmed");
  });
});

describe("add-member — hub locality gate (apply)", () => {
  test("(a) external hub → NO local hub write/reload, artifact emitted, seal still posted", async () => {
    const r = makePorts({
      admitted: { request_id: "req1", principal_id: "alice" },
      hubUrl: "tls://andreas-vm.example.com:7422",
      localHostname: "jc-laptop.local",
    });
    const report = await runNetworkSecret(inputs({ apply: true }), r.ports);

    expect(report.ok).toBe(true);
    expect(report.applied).toBe(true);
    // The local hub port's write/reload were NEVER called (spy assertion).
    expect(r.writes.length).toBe(0);
    expect(r.reloads).toBe(0);
    // The registry seal still ran (machine-independent).
    expect(r.posted.length).toBe(1);
    expect(r.posted[0]!.requestId).toBe("req1");
    // The hub-owner artifact carries the PSK + is distinct from steps/data.
    expect(report.hubOwnerArtifact).toBeDefined();
    const artifact = report.hubOwnerArtifact!.join("\n");
    expect(artifact).toContain(r.minted[0]!);
    expect(artifact).toContain("tls://andreas-vm.example.com:7422");
    assertNoSecretLeak(report.steps, report.data, r.minted[0]!);
    expect(report.data.hub_locality).toBe("external");
  });

  test("(b) --seal-only on a LOCAL-looking hub → still no write + artifact emitted", async () => {
    // hubUrl/localHostname default to the SAME loopback alias (would resolve
    // local without the flag) — --seal-only must override that.
    const r = makePorts({ admitted: { request_id: "req1", principal_id: "alice" } });
    const report = await runNetworkSecret(inputs({ apply: true, sealOnly: true }), r.ports);

    expect(report.ok).toBe(true);
    expect(r.writes.length).toBe(0);
    expect(r.reloads).toBe(0);
    expect(r.posted.length).toBe(1);
    expect(report.hubOwnerArtifact).toBeDefined();
    expect(report.data.hub_locality).toBe("external");
  });

  test("(c) local hub, no --seal-only → writes exactly as before, no artifact", async () => {
    const r = makePorts({ admitted: { request_id: "req1", principal_id: "alice" } });
    const report = await runNetworkSecret(inputs({ apply: true }), r.ports);

    expect(report.ok).toBe(true);
    expect(r.writes.length).toBe(1);
    expect(r.reloads).toBe(1);
    expect(listHubLeafUsers(r.hubConf.text)).toEqual([{ user: "alice", secret: "PSK-1" }]);
    expect(report.hubOwnerArtifact).toBeUndefined();
    expect(report.data.hub_locality).toBe("local");
  });

  test("(c') Sage Important 2 — FQDN hub that resolves to a local interface → writes locally (hostname mismatch)", async () => {
    // The real hub-owner deployment: hub cached as an FQDN, os.hostname() a
    // short name — the DNS→local-interface signal is what keeps the auto-write
    // alive. Without it this would (wrongly) fall to the artifact path.
    const r = makePorts({
      admitted: { request_id: "req1", principal_id: "alice" },
      hubUrl: "tls://nats.meta-factory.dev:7422",
      localHostname: "macjcf",
      hubHostIsLocalInterface: true,
    });
    const report = await runNetworkSecret(inputs({ apply: true }), r.ports);

    expect(report.ok).toBe(true);
    expect(r.writes.length).toBe(1);
    expect(r.reloads).toBe(1);
    expect(report.hubOwnerArtifact).toBeUndefined();
    expect(report.data.hub_locality).toBe("local");
  });

  test("(d) no cached descriptor (can't determine locality) → treated as EXTERNAL, fail-safe", async () => {
    const r = makePorts({ admitted: { request_id: "req1", principal_id: "alice" }, noHubCache: true });
    const report = await runNetworkSecret(inputs({ apply: true }), r.ports);

    expect(report.ok).toBe(true);
    expect(r.writes.length).toBe(0);
    expect(r.reloads).toBe(0);
    expect(r.posted.length).toBe(1);
    expect(report.hubOwnerArtifact).toBeDefined();
    expect(report.data.hub_locality).toBe("external");
  });

  test("external hub + oob delivery → BOTH surfaced (member handover) AND hubOwnerArtifact (hub handover)", async () => {
    const r = makePorts({
      admitted: { request_id: "req1", principal_id: "alice" },
      hubUrl: "tls://andreas-vm.example.com:7422",
      localHostname: "jc-laptop.local",
    });
    const report = await runNetworkSecret(inputs({ apply: true, deliver: "oob" }), r.ports);

    expect(r.writes.length).toBe(0);
    expect(r.reloads).toBe(0);
    expect(r.posted.length).toBe(0); // oob never touches the registry
    expect(report.surfaced).toEqual({ leafUser: "alice", psk: r.minted[0]! });
    expect(report.hubOwnerArtifact).toBeDefined();
  });

  test("rotate on an external hub → no local hub write, re-seal still posted, artifact emitted", async () => {
    const start = 'leafnodes {\n  # >>> cortex-managed leaf authorization (network secret tooling) — do not hand-edit\n  authorization {\n    users: [\n      { user: "alice", password: "PSK-old" }\n    ]\n  }\n  # <<< cortex-managed leaf authorization\n}\n';
    const r = makePorts({
      admitted: { request_id: "req1", principal_id: "alice" },
      startConf: start,
      hubUrl: "tls://andreas-vm.example.com:7422",
      localHostname: "jc-laptop.local",
    });
    const report = await runNetworkSecret(inputs({ action: "rotate", apply: true }), r.ports);

    expect(report.ok).toBe(true);
    expect(r.writes.length).toBe(0);
    expect(r.reloads).toBe(0);
    // The OLD hub-side entry is untouched (we never wrote it).
    expect(r.hubConf.text).toContain("PSK-old");
    expect(r.posted.length).toBe(1);
    expect(report.hubOwnerArtifact).toBeDefined();
  });

  test("--hub-account rides the artifact's account: field", async () => {
    const r = makePorts({
      admitted: { request_id: "req1", principal_id: "alice" },
      hubUrl: "tls://andreas-vm.example.com:7422",
      localHostname: "jc-laptop.local",
    });
    const account = "A" + "C".repeat(55);
    const report = await runNetworkSecret(inputs({ apply: true, hubAccount: account }), r.ports);
    expect(report.hubOwnerArtifact!.join("\n")).toContain(`account: "${account}"`);
  });
});

describe("add-member — hub locality gate (dry-run)", () => {
  test("external hub dry-run: plan says SEAL-ONLY + emit artifact, no secret, no mutation", async () => {
    const r = makePorts({
      admitted: { request_id: "req1", principal_id: "alice" },
      hubUrl: "tls://andreas-vm.example.com:7422",
      localHostname: "jc-laptop.local",
    });
    const report = await runNetworkSecret(inputs({ apply: false }), r.ports);
    expect(report.applied).toBe(false);
    expect(r.writes.length).toBe(0);
    expect(r.reloads).toBe(0);
    expect(r.posted.length).toBe(0);
    expect(report.steps.join("\n").toLowerCase()).toContain("seal-only");
    expect(report.steps.join("\n").toLowerCase()).toContain("external");
    expect(report.data.hub_locality).toBe("external");
  });

  test("--seal-only dry-run on a local-looking hub: plan still says SEAL-ONLY", async () => {
    const r = makePorts({ admitted: { request_id: "req1", principal_id: "alice" } });
    const report = await runNetworkSecret(inputs({ apply: false, sealOnly: true }), r.ports);
    expect(report.data.hub_locality).toBe("external");
    expect(report.steps.join("\n").toLowerCase()).toContain("seal-only");
  });

  test("local hub dry-run: plan is unchanged from pre-#1481 wording", async () => {
    const r = makePorts({ admitted: { request_id: "req1", principal_id: "alice" } });
    const report = await runNetworkSecret(inputs({ apply: false }), r.ports);
    expect(report.data.hub_locality).toBe("local");
    expect(report.steps.join("\n")).toContain('add hub authorization user "alice"');
  });
});

// ===========================================================================
// C-1349 Slice 2 — network-wide payload-key (K) rotation (`rotate-key`).
//
// Fixtures: all-same-digit placeholder pubkeys; an obviously-FAKE mint key (the
// fake mintPayloadKey returns 32 ZERO bytes → base64 all-A). K′ must ride the
// (fake-echoed) sealed blob but NEVER reach steps/data/members.
// ===========================================================================

/** A 44-char base64 pubkey from a single repeated char (obviously placeholder). */
function fakePubkey(ch: string): string {
  return btoa(ch.repeat(32));
}
const K_PRIME_B64 = Buffer.alloc(32).toString("base64"); // 32 zero bytes → what the fake mints.

/** Hub conf carrying the cortex-managed leaf users (user → psk). */
function hubConfWith(users: { user: string; psk: string }[]): string {
  const entries = users
    .map((u) => `      { user: "${u.user}", password: "${u.psk}" }`)
    .join(",\n");
  return (
    "leafnodes {\n" +
    "  # >>> cortex-managed leaf authorization (network secret tooling) — do not hand-edit\n" +
    "  authorization {\n" +
    "    users: [\n" +
    entries +
    "\n    ]\n" +
    "  }\n" +
    "  # <<< cortex-managed leaf authorization\n" +
    "}\n"
  );
}

interface RotationRecorder {
  ports: NetworkKeyRotationPorts;
  posted: { requestId: string; blob: string }[];
  written: (readonly PolicyFederatedNetwork[])[];
  mints: number;
}

function makeRotationPorts(opts: {
  admitted: AdmittedMember[];
  hubUsers: { user: string; psk: string }[];
  networks: PolicyFederatedNetwork[];
  sealThrowsForPub?: string;
  writeThrows?: boolean;
  listThrows?: boolean;
}): RotationRecorder {
  const posted: { requestId: string; blob: string }[] = [];
  const written: (readonly PolicyFederatedNetwork[])[] = [];
  let mints = 0;
  const ports: NetworkKeyRotationPorts = {
    readHubConf: async () => hubConfWith(opts.hubUsers),
    admission: {
      listAdmittedRows: async () => {
        if (opts.listThrows) throw new Error("registry 403 (fake)");
        return opts.admitted;
      },
    },
    delivery: {
      postSealedSecret: async (requestId: string, blob: string) => {
        posted.push({ requestId, blob });
      },
      revoke: async () => {
        /* unused by rotate-key */
      },
    },
    crypto: {
      mintPayloadKey: () => {
        mints += 1;
        return new Uint8Array(32); // 32 zero bytes → the obviously-fake K′.
      },
      seal: async (plaintext: string, pubkey: string) => {
        if (opts.sealThrowsForPub !== undefined && pubkey === opts.sealThrowsForPub) {
          throw new Error("seal failed (fake)");
        }
        return `SEALED(${pubkey.slice(0, 6)}:${plaintext})`;
      },
    },
    keyStore: {
      configPath: "/fake/stack.yaml",
      readNetworks: async () => opts.networks,
      writeNetworks: async (networks) => {
        if (opts.writeThrows) throw new Error("guarded write failed (fake)");
        written.push(networks);
      },
    },
  };
  return { ports, posted, written, get mints() { return mints; } };
}

function rotationInputs(over: Partial<KeyRotationInputs> = {}): KeyRotationInputs {
  return { networkId: "metafactory", apply: true, nowIso: "2026-07-03", ...over };
}

/** A network carrying K + an explicit kid (encryption enabled). */
function encNetwork(over: Partial<PolicyFederatedNetwork> = {}): PolicyFederatedNetwork {
  return {
    id: "metafactory",
    encryption: "enabled",
    payload_key: Buffer.alloc(32, 1).toString("base64"), // OLD K (all-ones, obviously fake).
    payload_key_id: "metafactory/k1",
    peers: [],
    ...over,
  } as unknown as PolicyFederatedNetwork;
}

function assertNoK(report: { steps: string[]; data: Record<string, string>; members: unknown[] }): void {
  expect(JSON.stringify(report.steps)).not.toContain(K_PRIME_B64);
  expect(JSON.stringify(report.data)).not.toContain(K_PRIME_B64);
  expect(JSON.stringify(report.members)).not.toContain(K_PRIME_B64);
}

describe("computeNextKid", () => {
  test("standard k<n> → k<n+1>", () => {
    expect(computeNextKid("metafactory", "metafactory/k1", "2026-07-03")).toBe("metafactory/k2");
    expect(computeNextKid("metafactory", "metafactory/k9", "2026-07-03")).toBe("metafactory/k10");
  });
  test("non-standard kid → date fallback", () => {
    expect(computeNextKid("metafactory", "metafactory/k-2026-01-01", "2026-07-03")).toBe("metafactory/k-2026-07-03");
    expect(computeNextKid("metafactory", "custom-label", "2026-07-03")).toBe("metafactory/k-2026-07-03");
    expect(computeNextKid("metafactory", undefined, "2026-07-03")).toBe("metafactory/k-2026-07-03");
  });
  test("mismatched network prefix → date fallback (never bumps another net's counter)", () => {
    expect(computeNextKid("metafactory", "other/k5", "2026-07-03")).toBe("metafactory/k-2026-07-03");
  });
});

describe("rotate-key — apply", () => {
  test("re-seals EVERY ADMITTED member with K′ + new kid; advances the hub K store; K never printed", async () => {
    const admitted: AdmittedMember[] = [
      { request_id: "req-alice", principal_id: "alice", peer_pubkey: fakePubkey("1") },
      { request_id: "req-bob", principal_id: "bob", peer_pubkey: fakePubkey("2") },
    ];
    const r = makeRotationPorts({
      admitted,
      hubUsers: [{ user: "alice", psk: "PSK-alice" }, { user: "bob", psk: "PSK-bob" }],
      networks: [encNetwork()],
    });
    const report = await runNetworkKeyRotation(rotationInputs(), r.ports);

    expect(report.ok).toBe(true);
    expect(report.applied).toBe(true);
    expect(r.mints).toBe(1);
    expect(report.newKid).toBe("metafactory/k2");

    // Both members re-sealed; leaf_psk UNCHANGED; K′ + new kid present in the
    // (fake-echoed, i.e. UNSEALED) blob.
    expect(r.posted.length).toBe(2);
    const aliceBlob = r.posted.find((p) => p.requestId === "req-alice")!.blob;
    expect(aliceBlob).toContain("PSK-alice"); // leaf_psk preserved
    expect(aliceBlob).toContain("payload_key");
    expect(aliceBlob).toContain("metafactory/k2"); // new kid
    expect(report.members.every((m) => m.resealed)).toBe(true);

    // Hub K store advanced to K′ + new kid on the target network.
    expect(r.written.length).toBe(1);
    const net = r.written[0]!.find((n) => n.id === "metafactory")!;
    expect(net.payload_key).toBe(K_PRIME_B64);
    expect(net.payload_key_id).toBe("metafactory/k2");

    // K′ never in any printable output; only the kid + a fingerprint.
    assertNoK(report);
    expect(report.keyFingerprint).toBeDefined();
    expect(report.data.new_kid).toBe("metafactory/k2");
  });

  test("REVOKED / DEPARTED rows are NOT enumerated → never re-sealed (ADMITTED-only)", async () => {
    // The port only ever returns ADMITTED rows (the live adapter filters status
    // === ADMITTED). Model that: only alice is ADMITTED; a revoked bob + departed
    // carol are absent from the list, so neither is re-sealed.
    const admitted: AdmittedMember[] = [
      { request_id: "req-alice", principal_id: "alice", peer_pubkey: fakePubkey("1") },
    ];
    const r = makeRotationPorts({
      admitted,
      hubUsers: [{ user: "alice", psk: "PSK-alice" }],
      networks: [encNetwork()],
    });
    const report = await runNetworkKeyRotation(rotationInputs(), r.ports);

    expect(report.ok).toBe(true);
    expect(r.posted.length).toBe(1);
    expect(r.posted[0]!.requestId).toBe("req-alice");
    // The evicted bob's pubkey is never a seal target / POST target.
    expect(r.posted.some((p) => p.requestId === "req-bob")).toBe(false);
    expect(r.written.length).toBe(1); // hub K advanced (rotation succeeded)
  });

  test("an INERT ADMITTED member (no hub user) is skipped, not a failure; commit still proceeds", async () => {
    const admitted: AdmittedMember[] = [
      { request_id: "req-alice", principal_id: "alice", peer_pubkey: fakePubkey("1") },
      { request_id: "req-ghost", principal_id: "ghost", peer_pubkey: fakePubkey("3") },
    ];
    const r = makeRotationPorts({
      admitted,
      hubUsers: [{ user: "alice", psk: "PSK-alice" }], // ghost has NO hub user.
      networks: [encNetwork()],
    });
    const report = await runNetworkKeyRotation(rotationInputs(), r.ports);

    expect(report.ok).toBe(true);
    expect(r.posted.length).toBe(1); // only alice re-sealed
    const ghost = report.members.find((m) => m.requestId === "req-ghost")!;
    expect(ghost.resealed).toBe(false);
    expect(ghost.note).toContain("inert");
    // Commit still happened (inert is not a failure).
    expect(r.written.length).toBe(1);
  });

  test("a genuine re-seal FAILURE blocks the hub-K commit (OLD K retained, re-runnable)", async () => {
    const admitted: AdmittedMember[] = [
      { request_id: "req-alice", principal_id: "alice", peer_pubkey: fakePubkey("1") },
      { request_id: "req-bob", principal_id: "bob", peer_pubkey: fakePubkey("2") },
    ];
    const r = makeRotationPorts({
      admitted,
      hubUsers: [{ user: "alice", psk: "PSK-alice" }, { user: "bob", psk: "PSK-bob" }],
      networks: [encNetwork()],
      sealThrowsForPub: fakePubkey("2"), // bob's seal fails
    });
    const report = await runNetworkKeyRotation(rotationInputs(), r.ports);

    expect(report.ok).toBe(false);
    // Hub K NOT advanced — the OLD K stays authoritative.
    expect(r.written.length).toBe(0);
    const bob = report.members.find((m) => m.requestId === "req-bob")!;
    expect(bob.resealed).toBe(false);
    expect(bob.note).toContain("error");
    expect(report.reason?.toLowerCase()).toContain("re-run");
    assertNoK(report);
  });

  test("a network with NO hub-side K is refused (rotate-key rotates, never mints the first K)", async () => {
    const r = makeRotationPorts({
      admitted: [],
      hubUsers: [],
      networks: [{ id: "metafactory", peers: [] } as unknown as PolicyFederatedNetwork], // no payload_key
    });
    const report = await runNetworkKeyRotation(rotationInputs(), r.ports);
    expect(report.ok).toBe(false);
    expect(report.reason).toContain("no payload key configured");
    expect(r.mints).toBe(0);
    expect(r.written.length).toBe(0);
  });
});

describe("rotate-key — dry-run (default)", () => {
  test("mints NOTHING, writes NOTHING, posts NOTHING; prints the plan + count + next kid", async () => {
    const admitted: AdmittedMember[] = [
      { request_id: "req-alice", principal_id: "alice", peer_pubkey: fakePubkey("1") },
      { request_id: "req-bob", principal_id: "bob", peer_pubkey: fakePubkey("2") },
    ];
    const r = makeRotationPorts({
      admitted,
      hubUsers: [{ user: "alice", psk: "PSK-alice" }, { user: "bob", psk: "PSK-bob" }],
      networks: [encNetwork()],
    });
    const report = await runNetworkKeyRotation(rotationInputs({ apply: false }), r.ports);

    expect(report.ok).toBe(true);
    expect(report.applied).toBe(false);
    expect(r.mints).toBe(0);
    expect(r.posted.length).toBe(0);
    expect(r.written.length).toBe(0);
    expect(report.newKid).toBe("metafactory/k2");
    expect(report.memberCount).toBe(2);
    expect(report.steps.join("\n")).toContain("2 ADMITTED");
    // No K anywhere (nothing was even minted).
    assertNoK(report);
    expect(report.keyFingerprint).toBeUndefined();
  });
});
