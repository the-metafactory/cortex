/**
 * cortex#2347 (EBH-5, ADR-0024 D4) — unit tests for
 * `src/adapters/plugin-signing.ts`: the bundle content digest and the
 * signature-verification primitive, independent of the loader pipeline
 * (loader-level integration tests live in `loader.signing.test.ts`).
 *
 * No network, no `arc list` — everything here operates on a throwaway
 * temp directory + a freshly generated ed25519 keypair (via `nkeys.js`,
 * the same library `src/bus/stack-provisioning.ts` uses for stack
 * signing identities).
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createUser } from "nkeys.js";

import {
  computeBundleDigest,
  PLUGIN_SIGNATURE_FILENAME,
  renderSignatureFile,
  signBundleDigest,
  verifyBundleSignature,
} from "../plugin-signing";

function freshKeypair(): { seed: string; pubkey: string } {
  const kp = createUser();
  return {
    seed: new TextDecoder().decode(kp.getSeed()),
    pubkey: kp.getPublicKey(),
  };
}

function makeBundleDir(): string {
  return mkdtempSync(join(tmpdir(), "cortex-plugin-signing-"));
}

/** Write a minimal two-file bundle (manifest + entry) and sign it with
 *  `signer`. Returns the dir so the caller can further mutate it. */
async function makeSignedBundle(
  dir: string,
  signer: { seed: string; pubkey: string },
): Promise<void> {
  writeFileSync(
    join(dir, "cortex-plugin.yaml"),
    "kind: renderer\nid: signing-fixture\nentry: ./index.ts\nsdkRange: \"^1\"\n",
  );
  writeFileSync(join(dir, "index.ts"), "export default { hello: 'world' };\n");
  const digestResult = computeBundleDigest(dir);
  if (!digestResult.ok) throw new Error(`test setup: digest failed: ${digestResult.reason}`);
  const signature = await signBundleDigest(signer.seed, digestResult.digest);
  writeFileSync(
    join(dir, PLUGIN_SIGNATURE_FILENAME),
    renderSignatureFile({
      version: 1,
      algorithm: "ed25519",
      signer: signer.pubkey,
      digest: digestResult.digest,
      signature,
    }),
  );
}

describe("computeBundleDigest (cortex#2347)", () => {
  test("is deterministic for identical content", () => {
    const dir = makeBundleDir();
    try {
      writeFileSync(join(dir, "cortex-plugin.yaml"), "kind: renderer\nid: x\nentry: ./index.ts\nsdkRange: \"^1\"\n");
      writeFileSync(join(dir, "index.ts"), "export default {};\n");
      const a = computeBundleDigest(dir);
      const b = computeBundleDigest(dir);
      expect(a).toEqual(b);
      expect(a.ok).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("changes when any file's content changes", () => {
    const dir = makeBundleDir();
    try {
      writeFileSync(join(dir, "cortex-plugin.yaml"), "kind: renderer\nid: x\nentry: ./index.ts\nsdkRange: \"^1\"\n");
      writeFileSync(join(dir, "index.ts"), "export default {};\n");
      const before = computeBundleDigest(dir);
      writeFileSync(join(dir, "index.ts"), "export default { tampered: true };\n");
      const after = computeBundleDigest(dir);
      expect(before.ok && after.ok).toBe(true);
      if (before.ok && after.ok) {
        expect(before.digest).not.toBe(after.digest);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("changes when the MANIFEST changes (not just the entry file)", () => {
    const dir = makeBundleDir();
    try {
      writeFileSync(join(dir, "cortex-plugin.yaml"), "kind: renderer\nid: x\nentry: ./index.ts\nsdkRange: \"^1\"\n");
      writeFileSync(join(dir, "index.ts"), "export default {};\n");
      const before = computeBundleDigest(dir);
      writeFileSync(join(dir, "cortex-plugin.yaml"), "kind: renderer\nid: x\nentry: ./index.ts\nsdkRange: \"^2\"\n");
      const after = computeBundleDigest(dir);
      expect(before.ok && after.ok).toBe(true);
      if (before.ok && after.ok) {
        expect(before.digest).not.toBe(after.digest);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("excludes the signature file itself from the digest", () => {
    const dir = makeBundleDir();
    try {
      writeFileSync(join(dir, "cortex-plugin.yaml"), "kind: renderer\nid: x\nentry: ./index.ts\nsdkRange: \"^1\"\n");
      writeFileSync(join(dir, "index.ts"), "export default {};\n");
      const before = computeBundleDigest(dir);
      writeFileSync(join(dir, PLUGIN_SIGNATURE_FILENAME), "version: 1\nalgorithm: ed25519\nsigner: whatever\ndigest: whatever\nsignature: whatever\n");
      const after = computeBundleDigest(dir);
      expect(before).toEqual(after);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("refuses (fails closed) when the bundle contains a nested symlink", () => {
    const dir = makeBundleDir();
    const outside = makeBundleDir();
    try {
      writeFileSync(join(dir, "cortex-plugin.yaml"), "kind: renderer\nid: x\nentry: ./index.ts\nsdkRange: \"^1\"\n");
      writeFileSync(join(outside, "sneaky.ts"), "export default {};\n");
      symlinkSync(join(outside, "sneaky.ts"), join(dir, "index.ts"));
      const result = computeBundleDigest(dir);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toMatch(/symlink/);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe("verifyBundleSignature (cortex#2347) — both directions", () => {
  test("a validly signed bundle from a TRUSTED signer verifies", async () => {
    const dir = makeBundleDir();
    try {
      const signer = freshKeypair();
      await makeSignedBundle(dir, signer);
      const result = await verifyBundleSignature({
        installPath: dir,
        trustedSigners: new Set([signer.pubkey]),
      });
      expect(result).toEqual({ ok: true, signer: signer.pubkey });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a bundle with NO signature file is refused (signature_missing)", async () => {
    const dir = makeBundleDir();
    try {
      writeFileSync(join(dir, "cortex-plugin.yaml"), "kind: renderer\nid: x\nentry: ./index.ts\nsdkRange: \"^1\"\n");
      writeFileSync(join(dir, "index.ts"), "export default {};\n");
      const result = await verifyBundleSignature({ installPath: dir, trustedSigners: new Set() });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.stage).toBe("signature_missing");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a well-formed signature from a signer NOT in the trust root is refused (signer_not_trusted)", async () => {
    const dir = makeBundleDir();
    try {
      const signer = freshKeypair();
      const someoneElse = freshKeypair();
      await makeSignedBundle(dir, signer);
      const result = await verifyBundleSignature({
        installPath: dir,
        trustedSigners: new Set([someoneElse.pubkey]),
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.stage).toBe("signer_not_trusted");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a bundle tampered with AFTER signing is refused (digest_mismatch), even though the signer is trusted", async () => {
    const dir = makeBundleDir();
    try {
      const signer = freshKeypair();
      await makeSignedBundle(dir, signer);
      // Mutate content after signing — signature file is untouched, so it
      // still names the OLD (now-stale) digest.
      writeFileSync(join(dir, "index.ts"), "export default { tampered: true };\n");
      const result = await verifyBundleSignature({
        installPath: dir,
        trustedSigners: new Set([signer.pubkey]),
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.stage).toBe("digest_mismatch");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a corrupted signature (right digest, forged signature bytes) is refused (signature_invalid)", async () => {
    const dir = makeBundleDir();
    try {
      const signer = freshKeypair();
      await makeSignedBundle(dir, signer);
      writeFileSync(
        join(dir, PLUGIN_SIGNATURE_FILENAME),
        renderSignatureFile({
          version: 1,
          algorithm: "ed25519",
          signer: signer.pubkey,
          digest: computeBundleDigest(dir).ok
            ? (computeBundleDigest(dir) as { ok: true; digest: string }).digest
            : "0".repeat(64),
          // Well-formed base64, but not a valid signature over the digest.
          signature: Buffer.alloc(64, 7).toString("base64"),
        }),
      );
      const result = await verifyBundleSignature({
        installPath: dir,
        trustedSigners: new Set([signer.pubkey]),
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.stage).toBe("signature_invalid");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a malformed signature file (schema violation) is refused (signature_parse)", async () => {
    const dir = makeBundleDir();
    try {
      writeFileSync(join(dir, "cortex-plugin.yaml"), "kind: renderer\nid: x\nentry: ./index.ts\nsdkRange: \"^1\"\n");
      writeFileSync(join(dir, "index.ts"), "export default {};\n");
      writeFileSync(join(dir, PLUGIN_SIGNATURE_FILENAME), "not: valid\nsignature: shape\n");
      const result = await verifyBundleSignature({ installPath: dir, trustedSigners: new Set() });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.stage).toBe("signature_parse");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a symlinked signature file escaping the bundle directory is refused (signature_containment)", async () => {
    const dir = makeBundleDir();
    const outside = makeBundleDir();
    try {
      writeFileSync(join(dir, "cortex-plugin.yaml"), "kind: renderer\nid: x\nentry: ./index.ts\nsdkRange: \"^1\"\n");
      writeFileSync(join(dir, "index.ts"), "export default {};\n");
      const secretSig = join(outside, "not-really-a-sig.yaml");
      writeFileSync(
        secretSig,
        "version: 1\nalgorithm: ed25519\nsigner: \"U0000000000000000000000000000000000000000000000000000\"\ndigest: \"" +
          "0".repeat(64) +
          "\"\nsignature: \"aaaa\"\n",
      );
      symlinkSync(secretSig, join(dir, PLUGIN_SIGNATURE_FILENAME));
      const result = await verifyBundleSignature({ installPath: dir, trustedSigners: new Set() });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.stage).toBe("signature_containment");
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("verifying twice against an unmodified signed bundle is stable (no flakiness)", async () => {
    const dir = makeBundleDir();
    try {
      const signer = freshKeypair();
      await makeSignedBundle(dir, signer);
      const trustedSigners = new Set([signer.pubkey]);
      const first = await verifyBundleSignature({ installPath: dir, trustedSigners });
      const second = await verifyBundleSignature({ installPath: dir, trustedSigners });
      expect(first).toEqual(second);
      expect(first.ok).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// Sanity: mkdirSync import is unused-otherwise; keep tree-shaking honest by
// referencing it in a trivial smoke test rather than leaving an unused import
// (the loader test file suite does the same pattern for its fixtures).
describe("test-helper sanity", () => {
  test("makeBundleDir + mkdirSync both usable for nested-fixture tests", () => {
    const dir = makeBundleDir();
    try {
      mkdirSync(join(dir, "nested"));
      const result = computeBundleDigest(dir);
      expect(result.ok).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
