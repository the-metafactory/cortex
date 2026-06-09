/**
 * Tests for `buildPingSignerFromConfig` (PR #822 review, MAJOR-1).
 *
 * Proves the posture-gated stack-signer build that lets `cortex network ping`
 * carry a signed request to an `enforce`-posture peer (spec §9 close-criterion):
 *   - `enforce` / `permissive` posture + a valid SU seed → a signer whose
 *     `principal` DID == `did:mf:{principal}-{stack}` and whose `rawSeedBytes`
 *     round-trip to the seed's keypair (so the probe is signed like every
 *     other federated dispatch);
 *   - `off` posture → `undefined` (publish unsigned, byte-identical to pre-#822);
 *   - `enforce` but NO seed → `undefined` (fail-closed, unsigned);
 *   - a pubkey-consistency mismatch → `undefined` (fail-closed, logged).
 *
 * Seeds are generated fresh per-test (createUser) at chmod 600 — no real key
 * material in the repo, same discipline as stack-signing-key.test.ts.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { createUser } from "nkeys.js";

import type { LoadedConfig } from "../../../../common/config/loader";
import type { AgentConfig } from "../../../../common/types/config";
import { buildPingSignerFromConfig } from "../network-ping-signer";

let testDir: string;

beforeEach(() => {
  testDir = join(
    tmpdir(),
    `cortex-ping-signer-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(testDir, { recursive: true });
});
afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

function writeSeed(): { path: string; pubkey: string; rawSeed: Uint8Array } {
  const kp = createUser();
  const seed = new TextDecoder().decode(kp.getSeed());
  const path = join(testDir, "stack.nk");
  writeFileSync(path, seed);
  chmodSync(path, 0o600);
  // `getRawSeed()` is the 32-byte ed25519 seed — the SAME shape the signer
  // exposes as `rawSeedBytes` (MyelinRuntime base64-encodes it for signEnvelope).
  const rawSeed = (kp as unknown as { getRawSeed(): Uint8Array }).getRawSeed();
  return { path, pubkey: kp.getPublicKey(), rawSeed };
}

function cfg(opts: {
  signing: "off" | "permissive" | "enforce";
  seedPath?: string;
  nkeyPub?: string;
  stackId?: string;
}): LoadedConfig {
  return {
    config: {
      security: { signing: opts.signing },
    } as unknown as AgentConfig,
    inlineAgents: [],
    principal: { id: "andreas" },
    stack: {
      id: opts.stackId ?? "andreas/community",
      ...(opts.seedPath !== undefined && { nkey_seed_path: opts.seedPath }),
      ...(opts.nkeyPub !== undefined && { nkey_pub: opts.nkeyPub }),
    },
  };
}

describe("buildPingSignerFromConfig", () => {
  test("MAJOR-1: enforce posture + valid seed → a signer with the right DID", async () => {
    const { path, pubkey } = writeSeed();
    const signer = await buildPingSignerFromConfig(
      cfg({ signing: "enforce", seedPath: path, nkeyPub: pubkey }),
    );
    expect(signer).toBeDefined();
    expect(signer?.principal).toBe("did:mf:andreas-community");
    // rawSeedBytes round-trip: re-deriving the keypair from the seed file's
    // bytes yields the SAME public key the signer will stamp with.
    expect(signer?.rawSeedBytes).toBeInstanceOf(Uint8Array);
  });

  test("permissive posture also attaches a signer", async () => {
    const { path } = writeSeed();
    const signer = await buildPingSignerFromConfig(
      cfg({ signing: "permissive", seedPath: path }),
    );
    expect(signer).toBeDefined();
    expect(signer?.principal).toBe("did:mf:andreas-community");
  });

  test("off posture → undefined (publish unsigned)", async () => {
    const { path } = writeSeed();
    const signer = await buildPingSignerFromConfig(
      cfg({ signing: "off", seedPath: path }),
    );
    expect(signer).toBeUndefined();
  });

  test("enforce posture but NO seed → undefined (fail-closed)", async () => {
    const signer = await buildPingSignerFromConfig(cfg({ signing: "enforce" }));
    expect(signer).toBeUndefined();
  });

  test("pubkey-consistency mismatch → undefined (fail-closed)", async () => {
    const { path } = writeSeed();
    // Declare a DIFFERENT pubkey than the seed derives → split-brain guard.
    const other = createUser().getPublicKey();
    const signer = await buildPingSignerFromConfig(
      cfg({ signing: "enforce", seedPath: path, nkeyPub: other }),
    );
    expect(signer).toBeUndefined();
  });

  test("DID derivation handles a hyphenated stack slug", async () => {
    const { path } = writeSeed();
    const signer = await buildPingSignerFromConfig(
      cfg({ signing: "enforce", seedPath: path, stackId: "andreas/meta-factory" }),
    );
    expect(signer?.principal).toBe("did:mf:andreas-meta-factory");
  });

  test("the signer's rawSeedBytes match the on-disk seed", async () => {
    const { path, rawSeed } = writeSeed();
    const signer = await buildPingSignerFromConfig(
      cfg({ signing: "enforce", seedPath: path }),
    );
    expect(signer).toBeDefined();
    if (signer === undefined) return;
    // The signer carries the EXACT 32-byte raw ed25519 seed from the file —
    // same bytes MyelinRuntime base64-encodes for signEnvelope, so the probe
    // is signed by this stack's real identity.
    expect(Array.from(signer.rawSeedBytes)).toEqual(Array.from(rawSeed));
  });
});
