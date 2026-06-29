/**
 * #747 — `cortex network create` (signed-admin network create/update) CLI tests.
 *
 * Coverage:
 *   1. usage validation (bad network id, missing --hub / --admin-seed, bad port).
 *   2. dry-run (DEFAULT) prints the signed claim it WOULD POST and performs NO
 *      network I/O (an unreachable registry would hang/fail an apply, but dry-run
 *      never touches it).
 *   3. dry-run builds a WELL-FORMED signed body: admin_pubkey derived from the
 *      seed, network_id/hub_url/leaf_port present, base64 signature attached.
 *   4. --apply POSTs the signed body through the REAL registry route (via an
 *      injected global fetch) and the registry accepts it (admin on allowlist).
 *   5. --apply against a registry with NO admin allowlist surfaces the 503
 *      admin_not_configured error verbatim (exit 1).
 *
 * The admin seed is a real nkey SU… seed minted via `cortex provision-stack
 * generate` — the same key shape the create flow derives admin_pubkey from.
 */

import { describe, test, expect, afterEach, beforeEach } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { dispatchNetwork } from "../network";
import { dispatchProvisionStack } from "../provision-stack";

import registryApp from "../../../../services/network-registry/src/index";
import type { Env } from "../../../../services/network-registry/src/index";
import {
  makeRegistryKey,
  resetStores,
} from "../../../../services/network-registry/__tests__/helpers";
import { getStore } from "../../../../services/network-registry/src/store";

const tmpDirs: string[] = [];
function freshDir(): string {
  const d = mkdtempSync(join(tmpdir(), "c747-netcreate-cli-"));
  tmpDirs.push(d);
  return d;
}

/**
 * Mint a real admin nkey seed on disk (chmod 600) via provision-stack and
 * return both the path and the derived base64 admin pubkey (read off the
 * generate JSON envelope) so a test can put it on the registry allowlist.
 */
async function mintAdminSeed(): Promise<{ seedPath: string; adminPubkey: string }> {
  const seedPath = join(freshDir(), "admin.nk");
  const res = await dispatchProvisionStack([
    "generate",
    "andreas",
    "--seed-path",
    seedPath,
    "--json",
  ]);
  expect(res.exitCode).toBe(0);
  const env = JSON.parse(res.stdout) as { data: { pubkey_b64: string } };
  return { seedPath, adminPubkey: env.data.pubkey_b64 };
}

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  while (tmpDirs.length > 0) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
  resetStores();
});

// =============================================================================
// Usage validation
// =============================================================================

describe("create usage", () => {
  test("rejects a bad network id (exit 2)", async () => {
    const res = await dispatchNetwork([
      "create", "BAD_CAPS",
      "--hub", "tls://hub:7422", "--leaf-port", "7422", "--admin-seed", "/tmp/x",
    ]);
    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain("must be lowercase");
  });

  test("missing --hub (exit 2)", async () => {
    const res = await dispatchNetwork([
      "create", "research-collab", "--leaf-port", "7422", "--admin-seed", "/tmp/x",
    ]);
    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain("--hub");
  });

  test("missing --admin-seed (exit 2)", async () => {
    const res = await dispatchNetwork([
      "create", "research-collab", "--hub", "tls://hub:7422", "--leaf-port", "7422",
    ]);
    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain("--admin-seed");
  });

  test("leaf_port out of range (exit 2)", async () => {
    const res = await dispatchNetwork([
      "create", "research-collab", "--hub", "tls://hub:7422", "--leaf-port", "70000", "--admin-seed", "/tmp/x",
    ]);
    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain("1..65535");
  });

  test("--apply and --dry-run mutually exclusive (exit 2)", async () => {
    const res = await dispatchNetwork([
      "create", "research-collab", "--hub", "tls://hub:7422", "--leaf-port", "7422",
      "--admin-seed", "/tmp/x", "--apply", "--dry-run",
    ]);
    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain("mutually exclusive");
  });

  test("missing seed file surfaces a clear op-error (exit 1)", async () => {
    const res = await dispatchNetwork([
      "create", "research-collab", "--hub", "tls://hub:7422", "--leaf-port", "7422",
      "--admin-seed", join(freshDir(), "does-not-exist.nk"),
    ]);
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain("not found");
  });

  test("--network-admins with a malformed pubkey (exit 2)", async () => {
    const { seedPath } = await mintAdminSeed();
    const res = await dispatchNetwork([
      "create", "research-collab", "--hub", "tls://hub:7422", "--leaf-port", "7422",
      "--admin-seed", seedPath, "--network-admins", "not-a-valid-pubkey",
    ]);
    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain("--network-admins");
  });

  test("--network-admins with only blanks/commas (exit 2)", async () => {
    const { seedPath } = await mintAdminSeed();
    const res = await dispatchNetwork([
      "create", "research-collab", "--hub", "tls://hub:7422", "--leaf-port", "7422",
      "--admin-seed", seedPath, "--network-admins", " , , ",
    ]);
    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain("at least one");
  });
});

// =============================================================================
// #1321 — --network-admins (per-network admin allowlist)
// =============================================================================

describe("create --network-admins (#1321)", () => {
  test("dry-run: a valid --network-admins lands in the signed claim (normalised)", async () => {
    const { seedPath } = await mintAdminSeed();
    const { adminPubkey: pna } = await mintAdminSeed();

    globalThis.fetch = (() => {
      throw new Error("dry-run must not perform network I/O");
    }) as unknown as typeof globalThis.fetch;

    const res = await dispatchNetwork([
      "create", "research-collab",
      "--hub", "tls://hub.meta-factory.ai:7422", "--leaf-port", "7422",
      "--admin-seed", seedPath,
      "--network-admins", ` ${pna} , `, // whitespace + trailing comma → normalised
      "--json",
    ]);
    expect(res.exitCode).toBe(0);
    const env = JSON.parse(res.stdout) as { items: { claim: Record<string, unknown> }[] };
    expect(env.items[0]!.claim.admin_pubkeys).toBe(pna);
  });

  test("dry-run: omitting --network-admins leaves admin_pubkeys absent (back-compat)", async () => {
    const { seedPath } = await mintAdminSeed();
    globalThis.fetch = (() => {
      throw new Error("dry-run must not perform network I/O");
    }) as unknown as typeof globalThis.fetch;

    const res = await dispatchNetwork([
      "create", "research-collab",
      "--hub", "tls://hub:7422", "--leaf-port", "7422", "--admin-seed", seedPath, "--json",
    ]);
    expect(res.exitCode).toBe(0);
    const env = JSON.parse(res.stdout) as { items: { claim: Record<string, unknown> }[] };
    expect(env.items[0]!.claim.admin_pubkeys).toBeUndefined();
  });

  test("--apply: a global admin's --network-admins persists to the network record", async () => {
    const { seedPath, adminPubkey } = await mintAdminSeed();
    const { adminPubkey: pna } = await mintAdminSeed();
    const reg = await makeRegistryKey();
    const registryEnv: Env = {
      REGISTRY_SIGNING_KEY: reg.signingKey,
      REGISTRY_PUBLIC_KEY: reg.publicKey,
      REGISTRY_ADMIN_PUBKEYS: adminPubkey,
      ENVIRONMENT: "test",
    };
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = input instanceof Request ? input : new Request(input, init);
      return registryApp.fetch(req, registryEnv);
    }) as typeof globalThis.fetch;

    const res = await dispatchNetwork([
      "create", "research-collab",
      "--hub", "tls://hub.meta-factory.ai:7422", "--leaf-port", "7422",
      "--admin-seed", seedPath,
      "--network-admins", pna,
      "--registry-url", "https://network.test",
      "--apply",
    ]);
    expect(res.exitCode).toBe(0);

    // The per-network admin set is persisted on the network record (end-to-end:
    // CLI → signed claim → real registry route → store).
    const stored = await getStore(registryEnv).getNetwork("research-collab");
    expect(stored?.admin_pubkeys).toBe(pna);
  });
});

// =============================================================================
// Dry-run (default) — prints the claim, no network I/O
// =============================================================================

describe("create dry-run (default)", () => {
  test("prints a well-formed signed claim WITHOUT POSTing", async () => {
    const { seedPath, adminPubkey } = await mintAdminSeed();

    // Trap any network I/O: if dry-run POSTs, this throws.
    globalThis.fetch = (() => {
      throw new Error("dry-run must not perform network I/O");
    }) as unknown as typeof globalThis.fetch;

    const res = await dispatchNetwork([
      "create", "research-collab",
      "--hub", "tls://hub.meta-factory.ai:7422",
      "--leaf-port", "7422",
      "--admin-seed", seedPath,
      "--json",
    ]);
    expect(res.exitCode).toBe(0);
    const env = JSON.parse(res.stdout) as {
      status: string;
      items: { claim: Record<string, unknown>; signature: string }[];
      data: { applied: string };
    };
    expect(env.status).toBe("ok");
    expect(env.data.applied).toBe("false");
    const body = env.items[0]!;
    expect(body.claim.network_id).toBe("research-collab");
    expect(body.claim.hub_url).toBe("tls://hub.meta-factory.ai:7422");
    expect(body.claim.leaf_port).toBe(7422);
    expect(body.claim.admin_pubkey).toBe(adminPubkey);
    expect(typeof body.claim.nonce).toBe("string");
    expect(typeof body.claim.issued_at).toBe("string");
    expect(body.signature.length).toBeGreaterThan(0);
  });

  test("human dry-run output carries the banner + the would-POST URL", async () => {
    const { seedPath } = await mintAdminSeed();
    const res = await dispatchNetwork([
      "create", "research-collab",
      "--hub", "tls://hub:7422", "--leaf-port", "7422",
      "--admin-seed", seedPath,
      "--registry-url", "https://network-dev.meta-factory.ai",
    ]);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("dry-run");
    expect(res.stdout).toContain("https://network-dev.meta-factory.ai/networks/research-collab");
  });
});

// =============================================================================
// --apply — POST through the REAL registry route
// =============================================================================

describe("create --apply (live registry route)", () => {
  let registryEnv: Env;

  /** Route global fetch to the in-process registry Worker. */
  function routeFetchToRegistry(env: Env): void {
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = input instanceof Request ? input : new Request(input, init);
      return registryApp.fetch(req, env);
    }) as typeof globalThis.fetch;
  }

  beforeEach(() => {
    resetStores();
  });

  test("allowlisted admin → registry accepts (exit 0)", async () => {
    const { seedPath, adminPubkey } = await mintAdminSeed();
    const reg = await makeRegistryKey();
    registryEnv = {
      REGISTRY_SIGNING_KEY: reg.signingKey,
      REGISTRY_PUBLIC_KEY: reg.publicKey,
      REGISTRY_ADMIN_PUBKEYS: adminPubkey, // admin on the allowlist
      ENVIRONMENT: "test",
    };
    routeFetchToRegistry(registryEnv);

    const res = await dispatchNetwork([
      "create", "research-collab",
      "--hub", "tls://hub.meta-factory.ai:7422",
      "--leaf-port", "7422",
      "--admin-seed", seedPath,
      "--registry-url", "https://network.test",
      "--apply",
    ]);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("created/updated");
    expect(res.stdout).toContain("HTTP 201");
  });

  test("registry with NO admin allowlist → 503 surfaced verbatim (exit 1)", async () => {
    const { seedPath } = await mintAdminSeed();
    const reg = await makeRegistryKey();
    registryEnv = {
      REGISTRY_SIGNING_KEY: reg.signingKey,
      REGISTRY_PUBLIC_KEY: reg.publicKey,
      // REGISTRY_ADMIN_PUBKEYS deliberately unset → fail-closed.
      ENVIRONMENT: "test",
    };
    routeFetchToRegistry(registryEnv);

    const res = await dispatchNetwork([
      "create", "research-collab",
      "--hub", "tls://hub:7422", "--leaf-port", "7422",
      "--admin-seed", seedPath,
      "--registry-url", "https://network.test",
      "--apply",
    ]);
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain("admin_not_configured");
    expect(res.stderr).toContain("HTTP 503");
  });
});
