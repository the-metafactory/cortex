/**
 * G1a — cortex network create --hub-account <A…> CLI tests (cortex#1117).
 *
 * Coverage:
 *   1. --hub-account absent → claim has no hub_account field (back-compat).
 *   2. --hub-account valid  → claim includes it; registry stores + returns it.
 *   3. --hub-account malformed → usage error, exit 2, no registry I/O.
 *   4. --apply with hub_account → registry accepts; GET descriptor returns it.
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
import type { NetworkDescriptor, SignedAssertion } from "../../../../services/network-registry/src/types";

// A syntactically valid nkey-U account pubkey (A + 55 uppercase base32 chars).
// Total length = 56 chars. Satisfies /^A[A-Z2-7]{55}$/.
const VALID_HUB_ACCOUNT = "ACGYOGQ7OL6E6ZP6XFNGHPUWTYZ7CHOSZMFMZKYNUAMBYMDB7VK5NVDQ";

const tmpDirs: string[] = [];
function freshDir(): string {
  const d = mkdtempSync(join(tmpdir(), "g1a-create-cli-"));
  tmpDirs.push(d);
  return d;
}

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
// Back-compat: no --hub-account
// =============================================================================

describe("create without --hub-account (back-compat)", () => {
  test("dry-run claim has no hub_account field", async () => {
    const { seedPath } = await mintAdminSeed();

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
      items: { claim: Record<string, unknown> }[];
    };
    const claim = env.items[0]!.claim;
    // hub_account must not be present when the flag is not passed
    expect(claim.hub_account).toBeUndefined();
  });
});

// =============================================================================
// --hub-account valid
// =============================================================================

describe("create with --hub-account (valid)", () => {
  test("dry-run claim includes hub_account", async () => {
    const { seedPath } = await mintAdminSeed();

    globalThis.fetch = (() => {
      throw new Error("dry-run must not perform network I/O");
    }) as unknown as typeof globalThis.fetch;

    const res = await dispatchNetwork([
      "create", "research-collab",
      "--hub", "tls://hub.meta-factory.ai:7422",
      "--leaf-port", "7422",
      "--admin-seed", seedPath,
      "--hub-account", VALID_HUB_ACCOUNT,
      "--json",
    ]);
    expect(res.exitCode).toBe(0);
    const parsed = JSON.parse(res.stdout) as {
      items: { claim: Record<string, unknown> }[];
    };
    expect(parsed.items[0]!.claim.hub_account).toBe(VALID_HUB_ACCOUNT);
  });

  test("--apply stores hub_account; GET descriptor returns it", async () => {
    const { seedPath, adminPubkey } = await mintAdminSeed();
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

    // POST with hub_account
    const createRes = await dispatchNetwork([
      "create", "research-collab",
      "--hub", "tls://hub.meta-factory.ai:7422",
      "--leaf-port", "7422",
      "--admin-seed", seedPath,
      "--hub-account", VALID_HUB_ACCOUNT,
      "--registry-url", "https://network.test",
      "--apply",
    ]);
    expect(createRes.exitCode).toBe(0);

    // Verify GET returns hub_account in descriptor
    const getRes = await registryApp.fetch(
      new Request("http://network.test/networks/research-collab"),
      registryEnv,
    );
    expect(getRes.status).toBe(200);
    const desc = (await getRes.json()) as SignedAssertion<NetworkDescriptor & { hub_account?: string }>;
    expect(desc.payload.hub_account).toBe(VALID_HUB_ACCOUNT);
  });
});

// =============================================================================
// --hub-account malformed → validation error, exit 2
// =============================================================================

describe("create with --hub-account (malformed)", () => {
  test("empty string → usage error (exit 2)", async () => {
    const { seedPath } = await mintAdminSeed();
    const res = await dispatchNetwork([
      "create", "research-collab",
      "--hub", "tls://hub:7422",
      "--leaf-port", "7422",
      "--admin-seed", seedPath,
      "--hub-account", "",
    ]);
    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain("hub-account");
  });

  test("S-prefix (seed not pubkey) → usage error (exit 2)", async () => {
    const { seedPath } = await mintAdminSeed();
    const seedLike = "SCGYOGQ7OL6E6ZP6XFNGHPUWTYZ7CHOSZMFMZKYNUAMBYMDB7VK5NVDQ";
    const res = await dispatchNetwork([
      "create", "research-collab",
      "--hub", "tls://hub:7422",
      "--leaf-port", "7422",
      "--admin-seed", seedPath,
      "--hub-account", seedLike,
    ]);
    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain("hub-account");
  });

  test("too short → usage error (exit 2)", async () => {
    const { seedPath } = await mintAdminSeed();
    const res = await dispatchNetwork([
      "create", "research-collab",
      "--hub", "tls://hub:7422",
      "--leaf-port", "7422",
      "--admin-seed", seedPath,
      "--hub-account", "ASHORT",
    ]);
    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain("hub-account");
  });
});
