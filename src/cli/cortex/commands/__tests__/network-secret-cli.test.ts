/**
 * ADR-0018 PR5b — `cortex network secret` CLI dispatch tests.
 *
 * Drives dispatchNetwork end-to-end with an injected secret-ports factory + a
 * real chmod-600 hub-admin seed file. Asserts: grammar validation, dry-run
 * default (no mutation), --apply wiring, --json shape, oob surfacing, and that
 * no secret leaks into the non-oob output.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync, readFileSync, statSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createUser } from "nkeys.js";
import {
  dispatchNetwork,
  __setJoinLeafSecretFetcherForTests,
  __setLeafCredsInstallDirForTests,
  __setDiscordRemoveClientForTests,
  type SecretPortsFactory,
  type KeyRotationPortsFactory,
  type DiscordRemoveClient,
} from "../network";
import type {
  NetworkSecretPorts,
  NetworkKeyRotationPorts,
  AdmittedMember,
} from "../network-secret-ports";
import type { PolicyFederatedNetwork } from "../../../../common/types/cortex-config";
import type { FetchSealedLeafSecretInput } from "../../../../common/registry/fetch-sealed-secret";
import { FAKE_CREDS } from "../../../../common/registry/__tests__/fixtures";

let tmp: string;
let seedPath: string;
// A valid 44-char base64 Ed25519 pubkey (32 bytes → 44 b64 chars, one '=' pad).
const MEMBER = btoa("A".repeat(32));

// A recording fake ports bundle + factory.
interface Calls {
  reads: number;
  writes: string[];
  reloads: number;
  posted: { requestId: string; blob: string }[];
  revoked: string[];
  minted: string[];
}
function fakeFactory(opts: {
  admitted?: { request_id: string; principal_id: string };
  // cortex#1481 — hub-locality fakes. Defaults resolve LOCAL (loopback alias)
  // so every PRE-#1481 test keeps its local-hub-write assumption unchanged.
  hubUrl?: string;
  noHubCache?: boolean;
  localHostname?: string;
  hubHostIsLocalInterface?: boolean;
} = {}): { factory: SecretPortsFactory; calls: Calls; conf: { text: string } } {
  const calls: Calls = { reads: 0, writes: [], reloads: 0, posted: [], revoked: [], minted: [] };
  const conf = { text: "leafnodes {\n  listen: 0.0.0.0:7422\n}\n" };
  let mintN = 0;
  const hubUrl = opts.noHubCache === true ? undefined : (opts.hubUrl ?? "tls://localhost:7422");
  const localHostname = opts.localHostname ?? "localhost";
  const hubHostIsLocalInterface = opts.hubHostIsLocalInterface ?? false;
  const ports: NetworkSecretPorts = {
    hub: {
      confPath: "/fake/hub.conf",
      readConf: async () => { calls.reads += 1; return conf.text; },
      writeConf: async (t: string) => { conf.text = t; calls.writes.push(t); },
      reload: async () => { calls.reloads += 1; },
    },
    admission: { findAdmittedRow: async () => opts.admitted },
    delivery: {
      postSealedSecret: async (requestId: string, blob: string) => { calls.posted.push({ requestId, blob }); },
      revoke: async (requestId: string) => { calls.revoked.push(requestId); },
    },
    crypto: {
      mintPsk: () => { const p = `PSK-${++mintN}`; calls.minted.push(p); return p; },
      seal: async (plaintext: string, pubkey: string) => `SEALED(${pubkey.slice(0, 4)}:${plaintext})`,
    },
    hubLocality: {
      resolveHubUrl: async () => hubUrl,
      localHostname: () => localHostname,
      hubHostIsLocalInterface: async () => hubHostIsLocalInterface,
    },
  };
  return { factory: () => ports, calls, conf };
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "secret-cli-"));
  seedPath = join(tmp, "hub-admin.seed");
  const seed = new TextDecoder().decode(createUser().getSeed());
  writeFileSync(seedPath, seed, { mode: 0o600 });
  chmodSync(seedPath, 0o600);
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  __setDiscordRemoveClientForTests(null);
});

function argv(...args: string[]): string[] {
  return args;
}

describe("cortex network secret — grammar", () => {
  test("unknown action → usage error (exit 2)", async () => {
    const { factory } = fakeFactory();
    const res = await dispatchNetwork(argv("secret", "bogus", "metafactory", MEMBER, "--admin-seed", seedPath), undefined, undefined, undefined, factory);
    expect(res.exitCode).toBe(2);
  });

  test("malformed member pubkey → usage error", async () => {
    const { factory } = fakeFactory();
    const res = await dispatchNetwork(argv("secret", "add-member", "metafactory", "not-a-pubkey", "--admin-seed", seedPath), undefined, undefined, undefined, factory);
    expect(res.exitCode).toBe(2);
  });

  test("rotate + --deliver oob → usage error", async () => {
    const { factory } = fakeFactory();
    const res = await dispatchNetwork(argv("secret", "rotate", "metafactory", MEMBER, "--deliver", "oob", "--admin-seed", seedPath), undefined, undefined, undefined, factory);
    expect(res.exitCode).toBe(2);
  });
});

describe("cortex network secret add-member", () => {
  test("dry-run (default) mutates nothing", async () => {
    const { factory, calls } = fakeFactory({ admitted: { request_id: "req1", principal_id: "alice" } });
    const res = await dispatchNetwork(argv("secret", "add-member", "metafactory", MEMBER, "--admin-seed", seedPath), undefined, undefined, undefined, factory);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("dry-run");
    expect(calls.writes.length).toBe(0);
    expect(calls.reloads).toBe(0);
    expect(calls.posted.length).toBe(0);
  });

  test("--apply sealed: adds hub user + reload + posts sealed blob; no secret in stdout", async () => {
    const { factory, calls } = fakeFactory({ admitted: { request_id: "req1", principal_id: "alice" } });
    const res = await dispatchNetwork(argv("secret", "add-member", "metafactory", MEMBER, "--apply", "--admin-seed", seedPath), undefined, undefined, undefined, factory);
    expect(res.exitCode).toBe(0);
    expect(calls.writes.length).toBe(1);
    expect(calls.reloads).toBe(1);
    expect(calls.posted.length).toBe(1);
    expect(calls.posted[0]!.requestId).toBe("req1");
    // No minted PSK appears in stdout for the sealed path.
    expect(res.stdout).not.toContain(calls.minted[0]!);
  });

  test("--apply oob: surfaces the PSK explicitly, registry untouched", async () => {
    const { factory, calls } = fakeFactory({ admitted: { request_id: "req1", principal_id: "alice" } });
    const res = await dispatchNetwork(argv("secret", "add-member", "metafactory", MEMBER, "--deliver", "oob", "--apply", "--admin-seed", seedPath), undefined, undefined, undefined, factory);
    expect(res.exitCode).toBe(0);
    expect(calls.posted.length).toBe(0); // registry untouched
    expect(res.stdout).toContain("OUT-OF-BAND SECRET");
    expect(res.stdout).toContain(calls.minted[0]!); // the PSK IS surfaced for handover
  });

  test("--json --apply sealed: machine-readable, applied=true, no oob secret key", async () => {
    const { factory } = fakeFactory({ admitted: { request_id: "req1", principal_id: "alice" } });
    const res = await dispatchNetwork(argv("secret", "add-member", "metafactory", MEMBER, "--apply", "--json", "--admin-seed", seedPath), undefined, undefined, undefined, factory);
    expect(res.exitCode).toBe(0);
    const parsed = JSON.parse(res.stdout) as { data: Record<string, string> };
    expect(parsed.data.applied).toBe("true");
    expect(parsed.data.request_id).toBe("req1");
    expect(parsed.data).not.toHaveProperty("oob_leaf_secret");
  });

  test("no ADMITTED row → exit 1", async () => {
    const { factory } = fakeFactory({ admitted: undefined });
    const res = await dispatchNetwork(argv("secret", "add-member", "metafactory", MEMBER, "--apply", "--admin-seed", seedPath), undefined, undefined, undefined, factory);
    expect(res.exitCode).toBe(1);
  });

  // ===========================================================================
  // C-1349 Slice 1 — the hub stack config supplies the payload key K, sealed
  // alongside the PSK. K is a clearly-FAKE all-zero 32-byte key; it must ride the
  // sealed blob but NEVER reach stdout.
  // ===========================================================================
  const FAKE_K = Buffer.alloc(32).toString("base64");

  /** A config reader returning a hub stack config with K on `metafactory`. */
  const loadWithK = ((_path: string) => ({
    policy: {
      federated: {
        networks: [
          { id: "metafactory", payload_key: FAKE_K, payload_key_id: "metafactory/k1" },
        ],
      },
    },
  })) as never;

  test("--apply sealed with hub K configured → seals K + kid; K never in stdout", async () => {
    const { factory, calls } = fakeFactory({ admitted: { request_id: "req1", principal_id: "alice" } });
    const res = await dispatchNetwork(
      argv("secret", "add-member", "metafactory", MEMBER, "--apply", "--admin-seed", seedPath),
      loadWithK, undefined, undefined, factory,
    );
    expect(res.exitCode).toBe(0);
    // The sealed blob (fake seal echoes plaintext) carries payload_key + kid.
    expect(calls.posted.length).toBe(1);
    expect(calls.posted[0]!.blob).toContain("payload_key");
    expect(calls.posted[0]!.blob).toContain("metafactory/k1");
    // K itself NEVER reaches stdout — only the kid + a fingerprint.
    expect(res.stdout).not.toContain(FAKE_K);
    expect(res.stdout).toContain("metafactory/k1");
  });

  test("--apply sealed with NO hub K configured → blob carries no payload_key", async () => {
    const { factory, calls } = fakeFactory({ admitted: { request_id: "req1", principal_id: "alice" } });
    // Inject an explicit reader with NO key for the network (hermetic — never the
    // real ~/.config/cortex, which may carry a live metafactory K).
    const loadNoK = ((_path: string) => ({ policy: { federated: { networks: [] } } })) as never;
    const res = await dispatchNetwork(
      argv("secret", "add-member", "metafactory", MEMBER, "--apply", "--admin-seed", seedPath),
      loadNoK, undefined, undefined, factory,
    );
    expect(res.exitCode).toBe(0);
    expect(calls.posted.length).toBe(1);
    expect(calls.posted[0]!.blob).not.toContain("payload_key");
  });

  test("--json --apply with hub K → payload_key_kid + fingerprint surfaced, K is not", async () => {
    const { factory } = fakeFactory({ admitted: { request_id: "req1", principal_id: "alice" } });
    const res = await dispatchNetwork(
      argv("secret", "add-member", "metafactory", MEMBER, "--apply", "--json", "--admin-seed", seedPath),
      loadWithK, undefined, undefined, factory,
    );
    expect(res.exitCode).toBe(0);
    const parsed = JSON.parse(res.stdout) as { data: Record<string, string> };
    expect(parsed.data.payload_key_kid).toBe("metafactory/k1");
    expect(parsed.data.payload_key_fingerprint).toBeDefined();
    expect(res.stdout).not.toContain(FAKE_K);
  });
});

// =============================================================================
// cortex#1481 (epic #1479, join-2) — hub locality: NEVER write a foreign hub.
// =============================================================================

describe("cortex network secret add-member — hub locality (cortex#1481)", () => {
  test("external hub → no local hub write, artifact printed (human), no secret leak elsewhere", async () => {
    const { factory, calls } = fakeFactory({
      admitted: { request_id: "req1", principal_id: "alice" },
      hubUrl: "tls://andreas-vm.example.com:7422",
      localHostname: "jc-laptop.local",
    });
    const res = await dispatchNetwork(argv("secret", "add-member", "metafactory", MEMBER, "--apply", "--admin-seed", seedPath), undefined, undefined, undefined, factory);
    expect(res.exitCode).toBe(0);
    expect(calls.writes.length).toBe(0);
    expect(calls.reloads).toBe(0);
    expect(calls.posted.length).toBe(1); // registry seal still ran
    expect(res.stdout).toContain("HUB-OWNER ACTION REQUIRED");
    expect(res.stdout).toContain(calls.minted[0]!); // the artifact IS the one place it prints
  });

  test("external hub --json → hub_owner_artifact field carries the snippet + PSK", async () => {
    const { factory, calls } = fakeFactory({
      admitted: { request_id: "req1", principal_id: "alice" },
      hubUrl: "tls://andreas-vm.example.com:7422",
      localHostname: "jc-laptop.local",
    });
    const res = await dispatchNetwork(argv("secret", "add-member", "metafactory", MEMBER, "--apply", "--json", "--admin-seed", seedPath), undefined, undefined, undefined, factory);
    expect(res.exitCode).toBe(0);
    const parsed = JSON.parse(res.stdout) as { data: Record<string, string> };
    expect(parsed.data.hub_owner_artifact).toContain("HUB-OWNER ACTION REQUIRED");
    expect(parsed.data.hub_owner_artifact).toContain(calls.minted[0]);
    expect(parsed.data.hub_locality).toBe("external");
  });

  test("--seal-only forces the artifact path even on a local-looking hub", async () => {
    const { factory, calls } = fakeFactory({ admitted: { request_id: "req1", principal_id: "alice" } });
    const res = await dispatchNetwork(argv("secret", "add-member", "metafactory", MEMBER, "--apply", "--seal-only", "--admin-seed", seedPath), undefined, undefined, undefined, factory);
    expect(res.exitCode).toBe(0);
    expect(calls.writes.length).toBe(0);
    expect(calls.reloads).toBe(0);
    expect(calls.posted.length).toBe(1);
    expect(res.stdout).toContain("HUB-OWNER ACTION REQUIRED");
  });

  test("local hub, no --seal-only → writes exactly as before, no artifact printed", async () => {
    const { factory, calls } = fakeFactory({ admitted: { request_id: "req1", principal_id: "alice" } });
    const res = await dispatchNetwork(argv("secret", "add-member", "metafactory", MEMBER, "--apply", "--admin-seed", seedPath), undefined, undefined, undefined, factory);
    expect(res.exitCode).toBe(0);
    expect(calls.writes.length).toBe(1);
    expect(calls.reloads).toBe(1);
    expect(res.stdout).not.toContain("HUB-OWNER ACTION REQUIRED");
  });

  test("no cached hub descriptor (can't determine locality) → treated as external, fail-safe", async () => {
    const { factory, calls } = fakeFactory({ admitted: { request_id: "req1", principal_id: "alice" }, noHubCache: true });
    const res = await dispatchNetwork(argv("secret", "add-member", "metafactory", MEMBER, "--apply", "--admin-seed", seedPath), undefined, undefined, undefined, factory);
    expect(res.exitCode).toBe(0);
    expect(calls.writes.length).toBe(0);
    expect(calls.reloads).toBe(0);
    expect(res.stdout).toContain("HUB-OWNER ACTION REQUIRED");
  });

  test("--hub-account <A…> rides the printed snippet's account: field", async () => {
    const { factory } = fakeFactory({
      admitted: { request_id: "req1", principal_id: "alice" },
      hubUrl: "tls://andreas-vm.example.com:7422",
      localHostname: "jc-laptop.local",
    });
    const account = "A" + "D".repeat(55);
    const res = await dispatchNetwork(
      argv("secret", "add-member", "metafactory", MEMBER, "--apply", "--hub-account", account, "--admin-seed", seedPath),
      undefined, undefined, undefined, factory,
    );
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain(`account: "${account}"`);
  });

  test("malformed --hub-account → usage error (exit 2)", async () => {
    const { factory } = fakeFactory({ admitted: { request_id: "req1", principal_id: "alice" } });
    const res = await dispatchNetwork(
      argv("secret", "add-member", "metafactory", MEMBER, "--apply", "--hub-account", "not-an-nkey", "--admin-seed", seedPath),
      undefined, undefined, undefined, factory,
    );
    expect(res.exitCode).toBe(2);
  });

  test("external hub dry-run: plan mentions seal-only + external, no mutation, no secret", async () => {
    const { factory, calls } = fakeFactory({
      admitted: { request_id: "req1", principal_id: "alice" },
      hubUrl: "tls://andreas-vm.example.com:7422",
      localHostname: "jc-laptop.local",
    });
    const res = await dispatchNetwork(argv("secret", "add-member", "metafactory", MEMBER, "--admin-seed", seedPath), undefined, undefined, undefined, factory);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("dry-run");
    expect(res.stdout.toLowerCase()).toContain("seal-only");
    expect(calls.writes.length).toBe(0);
    expect(calls.minted.length).toBe(0);
  });
});

describe("cortex network secret revoke-member", () => {
  test("--apply: drops hub user + reload (cut) + registry revoke", async () => {
    const { factory, calls } = fakeFactory({ admitted: { request_id: "req1", principal_id: "alice" } });
    const res = await dispatchNetwork(argv("secret", "revoke-member", "metafactory", MEMBER, "--apply", "--admin-seed", seedPath), undefined, undefined, undefined, factory);
    expect(res.exitCode).toBe(0);
    expect(calls.reloads).toBe(1);
    expect(calls.revoked).toEqual(["req1"]);
  });

  // ===========================================================================
  // C-1350 S3 — Tier-1 de-admission pairing on revoke-member. The role removal
  // is a NON-FATAL step AFTER the hub-cut + registry REVOKE. Discord ids are
  // non-numeric placeholder labels (never a live snowflake).
  // ===========================================================================
  test("--discord-member --apply: removeRole called AFTER the registry revoke; exit 0", async () => {
    const { factory, calls } = fakeFactory({ admitted: { request_id: "req1", principal_id: "alice" } });
    let removed = false;
    const mockDiscord: DiscordRemoveClient = {
      async resolveRoleId(_t, _g, roleName) {
        // The revoke (hub cut + registry) must have committed before we get here.
        expect(calls.revoked).toEqual(["req1"]);
        expect(roleName).toBe("community-fleet");
        return "role-id-123";
      },
      async removeRole(_t, _g, userId, roleId) {
        removed = true;
        expect(userId).toBe("member-snowflake-999");
        expect(roleId).toBe("role-id-123");
        return { success: true };
      },
    };
    __setDiscordRemoveClientForTests(mockDiscord);

    const res = await dispatchNetwork(
      argv("secret", "revoke-member", "metafactory", MEMBER,
        "--discord-member", "member-snowflake-999", "--discord-guild", "guild-123",
        "--apply", "--json", "--admin-seed", seedPath),
      undefined, undefined, undefined, factory,
    );

    expect(res.exitCode).toBe(0);
    expect(removed).toBe(true);
    expect(calls.revoked).toEqual(["req1"]);
    const parsed = JSON.parse(res.stdout) as { data: Record<string, string> };
    expect(parsed.data.discord_status).toBe("removed");
  });

  test("--discord-member: a removeRole failure still exits 0 with a warning (revoke already committed)", async () => {
    const { factory, calls } = fakeFactory({ admitted: { request_id: "req1", principal_id: "alice" } });
    const mockDiscord: DiscordRemoveClient = {
      async resolveRoleId() { return "role-id-123"; },
      async removeRole() { return { success: false, error: "missing_permissions" }; },
    };
    __setDiscordRemoveClientForTests(mockDiscord);

    const res = await dispatchNetwork(
      argv("secret", "revoke-member", "metafactory", MEMBER,
        "--discord-member", "member-999", "--discord-guild", "guild-123",
        "--apply", "--json", "--admin-seed", seedPath),
      undefined, undefined, undefined, factory,
    );

    // The revoke committed (hub cut + registry) → exit 0; Discord failure is a warning.
    expect(res.exitCode).toBe(0);
    expect(calls.revoked).toEqual(["req1"]);
    const parsed = JSON.parse(res.stdout) as { data: Record<string, string> };
    expect(parsed.data.discord_status).toBe("failed");
    expect(parsed.data.discord_warning).toContain("missing_permissions");
  });

  test("--discord-member on a FAILED revoke (no ADMITTED row) removes nothing", async () => {
    const { factory } = fakeFactory({ admitted: undefined });
    let removeCalled = false;
    const mockDiscord: DiscordRemoveClient = {
      async resolveRoleId() { return "role-id-123"; },
      async removeRole() { removeCalled = true; return { success: true }; },
    };
    __setDiscordRemoveClientForTests(mockDiscord);

    const res = await dispatchNetwork(
      argv("secret", "revoke-member", "metafactory", MEMBER,
        "--discord-member", "member-999", "--discord-guild", "guild-123",
        "--apply", "--admin-seed", seedPath),
      undefined, undefined, undefined, factory,
    );

    // No ADMITTED row → the revoke didn't commit → the role removal must NOT run
    // (there is nothing to pair it with).
    expect(res.exitCode).toBe(1);
    expect(removeCalled).toBe(false);
  });

  test("custom --discord-role is forwarded to resolveRoleId (flag-resolution parity with admit)", async () => {
    const { factory } = fakeFactory({ admitted: { request_id: "req1", principal_id: "alice" } });
    let capturedRole = "";
    const mockDiscord: DiscordRemoveClient = {
      async resolveRoleId(_t, _g, roleName) { capturedRole = roleName; return "custom-role-id"; },
      async removeRole() { return { success: true }; },
    };
    __setDiscordRemoveClientForTests(mockDiscord);

    const res = await dispatchNetwork(
      argv("secret", "revoke-member", "metafactory", MEMBER,
        "--discord-member", "member-999", "--discord-guild", "guild-123",
        "--discord-role", "custom-fleet", "--apply", "--admin-seed", seedPath),
      undefined, undefined, undefined, factory,
    );

    expect(res.exitCode).toBe(0);
    expect(capturedRole).toBe("custom-fleet");
  });
});

// =============================================================================
// C-1349 Slice 2 — `cortex network secret rotate-key` (network-wide K rotation).
// K′ is an obviously-FAKE all-zero 32-byte key; it must ride the sealed blob but
// NEVER reach stdout. Placeholder pubkeys are single-repeated-char base64.
// =============================================================================

const K_PRIME_B64 = Buffer.alloc(32).toString("base64"); // what the fake mints.

function fakePubkey(ch: string): string {
  return btoa(ch.repeat(32));
}

function hubConfWith(users: { user: string; psk: string }[]): string {
  const entries = users.map((u) => `      { user: "${u.user}", password: "${u.psk}" }`).join(",\n");
  return (
    "leafnodes {\n" +
    "  # >>> cortex-managed leaf authorization (network secret tooling) — do not hand-edit\n" +
    "  authorization {\n    users: [\n" +
    entries +
    "\n    ]\n  }\n" +
    "  # <<< cortex-managed leaf authorization\n}\n"
  );
}

interface RotationCalls {
  posted: { requestId: string; blob: string }[];
  written: (readonly PolicyFederatedNetwork[])[];
  mints: number;
}

function fakeRotationFactory(opts: {
  admitted: AdmittedMember[];
  hubUsers: { user: string; psk: string }[];
  networks: PolicyFederatedNetwork[];
}): { factory: KeyRotationPortsFactory; calls: RotationCalls } {
  const calls: RotationCalls = { posted: [], written: [], mints: 0 };
  const ports: NetworkKeyRotationPorts = {
    readHubConf: async () => hubConfWith(opts.hubUsers),
    admission: { listAdmittedRows: async () => opts.admitted },
    delivery: {
      postSealedSecret: async (requestId, blob) => { calls.posted.push({ requestId, blob }); },
      revoke: async () => {},
    },
    crypto: {
      mintPayloadKey: () => { calls.mints += 1; return new Uint8Array(32); },
      seal: async (plaintext, pubkey) => `SEALED(${pubkey.slice(0, 4)}:${plaintext})`,
    },
    keyStore: {
      configPath: "/fake/stack.yaml",
      readNetworks: async () => opts.networks,
      writeNetworks: async (networks) => { calls.written.push(networks); },
    },
  };
  return { factory: () => ports, calls };
}

function encNet(): PolicyFederatedNetwork {
  return {
    id: "metafactory",
    encryption: "enabled",
    payload_key: Buffer.alloc(32, 1).toString("base64"),
    payload_key_id: "metafactory/k1",
    peers: [],
  } as unknown as PolicyFederatedNetwork;
}

describe("cortex network secret rotate-key", () => {
  const admitted: AdmittedMember[] = [
    { request_id: "req-alice", principal_id: "alice", peer_pubkey: fakePubkey("1") },
    { request_id: "req-bob", principal_id: "bob", peer_pubkey: fakePubkey("2") },
  ];
  const hubUsers = [{ user: "alice", psk: "PSK-alice" }, { user: "bob", psk: "PSK-bob" }];

  test("dry-run (default) mints/writes/posts NOTHING; prints the plan + next kid", async () => {
    const { factory, calls } = fakeRotationFactory({ admitted, hubUsers, networks: [encNet()] });
    const res = await dispatchNetwork(
      argv("secret", "rotate-key", "metafactory", "--admin-seed", seedPath),
      undefined, undefined, undefined, undefined, undefined, factory,
    );
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("dry-run");
    expect(res.stdout).toContain("metafactory/k2");
    expect(calls.mints).toBe(0);
    expect(calls.posted.length).toBe(0);
    expect(calls.written.length).toBe(0);
  });

  test("--apply re-seals every ADMITTED member + advances hub K; K never in stdout", async () => {
    const { factory, calls } = fakeRotationFactory({ admitted, hubUsers, networks: [encNet()] });
    const res = await dispatchNetwork(
      argv("secret", "rotate-key", "metafactory", "--apply", "--admin-seed", seedPath),
      undefined, undefined, undefined, undefined, undefined, factory,
    );
    expect(res.exitCode).toBe(0);
    expect(calls.mints).toBe(1);
    expect(calls.posted.length).toBe(2);
    expect(calls.written.length).toBe(1);
    const net = calls.written[0]!.find((n) => n.id === "metafactory")!;
    expect(net.payload_key).toBe(K_PRIME_B64);
    expect(net.payload_key_id).toBe("metafactory/k2");
    // K′ never in stdout; the kid IS.
    expect(res.stdout).not.toContain(K_PRIME_B64);
    expect(res.stdout).toContain("metafactory/k2");
    // The member re-join instruction is surfaced.
    expect(res.stdout).toContain("re-run");
  });

  test("--json --apply: machine-readable, resealed_count, no K", async () => {
    const { factory } = fakeRotationFactory({ admitted, hubUsers, networks: [encNet()] });
    const res = await dispatchNetwork(
      argv("secret", "rotate-key", "metafactory", "--apply", "--json", "--admin-seed", seedPath),
      undefined, undefined, undefined, undefined, undefined, factory,
    );
    expect(res.exitCode).toBe(0);
    const parsed = JSON.parse(res.stdout) as { data: Record<string, string> };
    expect(parsed.data.new_kid).toBe("metafactory/k2");
    expect(parsed.data.resealed_count).toBe("2");
    expect(parsed.data.payload_key_fingerprint).toBeDefined();
    expect(res.stdout).not.toContain(K_PRIME_B64);
  });

  test("a network with no hub-side K → exit 1 (rotate-key never mints the first K)", async () => {
    const { factory, calls } = fakeRotationFactory({
      admitted: [], hubUsers: [],
      networks: [{ id: "metafactory", peers: [] } as unknown as PolicyFederatedNetwork],
    });
    const res = await dispatchNetwork(
      argv("secret", "rotate-key", "metafactory", "--apply", "--admin-seed", seedPath),
      undefined, undefined, undefined, undefined, undefined, factory,
    );
    expect(res.exitCode).toBe(1);
    expect(calls.mints).toBe(0);
    expect(calls.written.length).toBe(0);
  });
});

describe("cortex network secret revoke-member — C-1349 rotate-now recommendation", () => {
  const loadWithK = ((_p: string) => ({
    policy: { federated: { networks: [{ id: "metafactory", payload_key: Buffer.alloc(32).toString("base64"), payload_key_id: "metafactory/k1" }] } },
  })) as never;
  const loadNoK = ((_p: string) => ({ policy: { federated: { networks: [] } } })) as never;

  test("on an ENCRYPTION-ENABLED network prints the rotate-now line naming rotate-key", async () => {
    const { factory } = fakeFactory({ admitted: { request_id: "req1", principal_id: "alice" } });
    const res = await dispatchNetwork(
      argv("secret", "revoke-member", "metafactory", MEMBER, "--apply", "--admin-seed", seedPath),
      loadWithK, undefined, undefined, factory,
    );
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("rotate now");
    expect(res.stdout).toContain("rotate-key metafactory");
  });

  test("on a NON-encrypted network prints NO rotate-now line", async () => {
    const { factory } = fakeFactory({ admitted: { request_id: "req1", principal_id: "alice" } });
    const res = await dispatchNetwork(
      argv("secret", "revoke-member", "metafactory", MEMBER, "--apply", "--admin-seed", seedPath),
      loadNoK, undefined, undefined, factory,
    );
    expect(res.exitCode).toBe(0);
    expect(res.stdout).not.toContain("rotate now");
  });
});

// =============================================================================
// ADR-0018 PR5b — join plug-and-play: auto-fetch + unseal the leaf secret
// =============================================================================

describe("cortex network join — plug-and-play leaf-secret auto-fetch", () => {
  afterEach(() => {
    __setJoinLeafSecretFetcherForTests(null);
    __setLeafCredsInstallDirForTests(null);
  });

  test("join with NO configured leaf-secret AUTO-fetches it from the admission gate", async () => {
    // A real joiner seed so materialFromSeedString succeeds.
    const joinerSeed = join(tmp, "joiner.seed");
    writeFileSync(joinerSeed, new TextDecoder().decode(createUser().getSeed()), { mode: 0o600 });
    chmodSync(joinerSeed, 0o600);

    const seen: FetchSealedLeafSecretInput[] = [];
    __setJoinLeafSecretFetcherForTests(async (input) => {
      seen.push(input);
      return { ok: true, kind: "psk", leafPsk: "AUTO-PSK", leafUser: "andreas" };
    });

    // Dry-run join (no --apply): the descriptor fetch will fail against the
    // unreachable registry, but the AUTO-FETCH runs first — we assert it was
    // invoked with the right coordinates (the wiring), which is the PR's claim.
    await dispatchNetwork([
      "join", "metafactory",
      "--principal", "andreas",
      "--registry-url", "http://127.0.0.1:0",
      "--seed-path", joinerSeed,
      "--creds", join(tmp, "andreas.creds"),
      "--account", "A" + "B".repeat(55),
      "--nats-config", join(tmp, "local.conf"),
      "--plist", join(tmp, "nats.plist"),
    ], (() => ({})) as never);

    expect(seen.length).toBe(1);
    expect(seen[0]!.networkId).toBe("metafactory");
    expect(seen[0]!.principalId).toBe("andreas");
    expect(seen[0]!.registryUrl).toBe("http://127.0.0.1:0");
    // #1597 (R7) — the join declares the member's OWN identities so a v2
    // credential minted for a different subject is refused inside the fetch.
    expect(seen[0]!.expectedLeafUsers).toContain("andreas/default");
    expect(seen[0]!.expectedLeafUsers).toContain("andreas");
  });

  // ===========================================================================
  // #1597 (epic #1595) — v2 payload: the delivered per-member credential FILE
  // is installed at the conventional 0600 path before the join renders.
  // ===========================================================================

  /** Write a real joiner seed (so materialFromSeedString succeeds) → its path. */
  function writeJoinerSeed(name: string): string {
    const p = join(tmp, name);
    writeFileSync(p, new TextDecoder().decode(createUser().getSeed()), { mode: 0o600 });
    chmodSync(p, 0o600);
    return p;
  }

  /** The shared dry-run join argv (descriptor fetch fails against the
   *  unreachable registry, but the auto-fetch + install run FIRST). */
  function joinArgs(seedPath: string): string[] {
    return [
      "join", "metafactory",
      "--principal", "andreas",
      "--registry-url", "http://127.0.0.1:0",
      "--seed-path", seedPath,
      "--account", "A" + "B".repeat(55),
      "--nats-config", join(tmp, "local.conf"),
      "--plist", join(tmp, "nats.plist"),
    ];
  }

  function fakeV2Fetcher(creds: string): void {
    __setJoinLeafSecretFetcherForTests(async () => ({
      ok: true,
      kind: "creds",
      creds,
      leafUser: "andreas/default",
      mintedAt: "2026-07-06T00:00:00Z",
    }));
  }

  test("a v2 (credential-file) payload is installed 0600 at the conventional per-network path", async () => {
    const installDir = join(tmp, "nats-install");
    __setLeafCredsInstallDirForTests(installDir);
    fakeV2Fetcher(FAKE_CREDS);

    await dispatchNetwork(joinArgs(writeJoinerSeed("joiner3.seed")), (() => ({})) as never);

    const installed = join(installDir, "metafactory-leaf.creds");
    expect(readFileSync(installed, "utf-8")).toBe(FAKE_CREDS);
    // 0600 — not group- or world-readable (the acceptance bar).
    expect(statSync(installed).mode & 0o777).toBe(0o600);
  });

  test("v2 install REPLACES a pre-existing looser file with different content, ending 0600", async () => {
    // Exercises the WRITE branch against a pre-existing 0644 file (the Sage
    // #1609 window). Asserts the END state only — content replaced, final mode
    // 0600; the no-transit-through-group-readable property is guaranteed by
    // the tmp+rename design in installLeafCreds, not observable from here.
    const installDir = join(tmp, "nats-install-2");
    const installed = join(installDir, "metafactory-leaf.creds");
    mkdirSync(installDir, { recursive: true });
    writeFileSync(installed, "-----BEGIN NATS USER JWT-----\nOLD\n", { mode: 0o644 });

    __setLeafCredsInstallDirForTests(installDir);
    fakeV2Fetcher(FAKE_CREDS);

    await dispatchNetwork(joinArgs(writeJoinerSeed("joiner4.seed")), (() => ({})) as never);

    expect(readFileSync(installed, "utf-8")).toBe(FAKE_CREDS);
    expect(statSync(installed).mode & 0o777).toBe(0o600);
  });

  test("v2 install is byte-stable + re-asserts 0600 on an IDENTICAL pre-existing looser file", async () => {
    // Same content on disk → the write branch is skipped (no mtime churn) and
    // only the trailing chmod tightens the looser pre-existing mode.
    const installDir = join(tmp, "nats-install-3");
    const installed = join(installDir, "metafactory-leaf.creds");
    mkdirSync(installDir, { recursive: true });
    writeFileSync(installed, FAKE_CREDS, { mode: 0o644 });

    __setLeafCredsInstallDirForTests(installDir);
    fakeV2Fetcher(FAKE_CREDS);

    await dispatchNetwork(joinArgs(writeJoinerSeed("joiner5.seed")), (() => ({})) as never);

    expect(readFileSync(installed, "utf-8")).toBe(FAKE_CREDS);
    expect(statSync(installed).mode & 0o777).toBe(0o600);
  });

  test("an explicit --leaf-secret SUPPRESSES the auto-fetch", async () => {
    const joinerSeed = join(tmp, "joiner2.seed");
    writeFileSync(joinerSeed, new TextDecoder().decode(createUser().getSeed()), { mode: 0o600 });
    chmodSync(joinerSeed, 0o600);
    let called = false;
    __setJoinLeafSecretFetcherForTests(async () => { called = true; return { ok: false, reason: "x" }; });

    await dispatchNetwork([
      "join", "metafactory",
      "--principal", "andreas",
      "--registry-url", "http://127.0.0.1:0",
      "--seed-path", joinerSeed,
      "--leaf-secret", "EXPLICIT-PSK",
      "--leaf-user", "andreas",
      "--account", "A" + "B".repeat(55),
      "--nats-config", join(tmp, "local.conf"),
      "--plist", join(tmp, "nats.plist"),
    ], (() => ({})) as never);

    expect(called).toBe(false);
  });
});
