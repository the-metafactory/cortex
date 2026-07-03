/**
 * ADR-0018 PR5b — `cortex network secret` CLI dispatch tests.
 *
 * Drives dispatchNetwork end-to-end with an injected secret-ports factory + a
 * real chmod-600 hub-admin seed file. Asserts: grammar validation, dry-run
 * default (no mutation), --apply wiring, --json shape, oob surfacing, and that
 * no secret leaks into the non-oob output.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createUser } from "nkeys.js";
import {
  dispatchNetwork,
  __setJoinLeafSecretFetcherForTests,
  __setDiscordRemoveClientForTests,
  type SecretPortsFactory,
  type DiscordRemoveClient,
} from "../network";
import type { NetworkSecretPorts } from "../network-secret-ports";
import type { FetchSealedLeafSecretInput } from "../../../../common/registry/fetch-sealed-secret";

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
function fakeFactory(opts: { admitted?: { request_id: string; principal_id: string } } = {}): { factory: SecretPortsFactory; calls: Calls; conf: { text: string } } {
  const calls: Calls = { reads: 0, writes: [], reloads: 0, posted: [], revoked: [], minted: [] };
  const conf = { text: "leafnodes {\n  listen: 0.0.0.0:7422\n}\n" };
  let mintN = 0;
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
// ADR-0018 PR5b — join plug-and-play: auto-fetch + unseal the leaf secret
// =============================================================================

describe("cortex network join — plug-and-play leaf-secret auto-fetch", () => {
  afterEach(() => __setJoinLeafSecretFetcherForTests(null));

  test("join with NO configured leaf-secret AUTO-fetches it from the admission gate", async () => {
    // A real joiner seed so materialFromSeedString succeeds.
    const joinerSeed = join(tmp, "joiner.seed");
    writeFileSync(joinerSeed, new TextDecoder().decode(createUser().getSeed()), { mode: 0o600 });
    chmodSync(joinerSeed, 0o600);

    const seen: FetchSealedLeafSecretInput[] = [];
    __setJoinLeafSecretFetcherForTests(async (input) => {
      seen.push(input);
      return { ok: true, leafPsk: "AUTO-PSK", leafUser: "andreas" };
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
