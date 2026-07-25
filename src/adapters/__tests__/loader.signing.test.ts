/**
 * cortex#2347 (EBH-5, ADR-0024 D4) — loader-pipeline integration tests for
 * `system.plugins.signing`. Unit-level digest/signature-primitive tests
 * live in `plugin-signing.test.ts`; this file proves the STAGED POSTURE
 * composes correctly with the existing discover → gate → import → register
 * pipeline: off is a byte-identical no-op, permissive verifies-and-logs
 * without ever refusing, and enforce actually refuses a bad bundle while
 * still loading a good one (a gate without a "still loads the good one"
 * test is how a control silently dies — repo lesson, EBH task brief).
 *
 * No network: `arc list --json` is fully injected via `runner`, same
 * convention as `loader.test.ts`.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createUser } from "nkeys.js";

import { loadExternalPlugins, type ArcListRunResult } from "../loader";
import {
  computeBundleDigest,
  PLUGIN_SIGNATURE_FILENAME,
  renderSignatureFile,
  signBundleDigest,
} from "../plugin-signing";
import { SurfacePluginRegistry } from "../registry";
import type { ArcPackage } from "../../common/types/plugin-manifest";

const TRUSTED_REPO = "https://github.com/the-metafactory/metafactory-fixture-plugins";

function freshKeypair(): { seed: string; pubkey: string } {
  const kp = createUser();
  return { seed: new TextDecoder().decode(kp.getSeed()), pubkey: kp.getPublicKey() };
}

function runnerFor(packages: ArcPackage[]): () => Promise<ArcListRunResult> {
  return async () => ({ stdout: JSON.stringify({ packages }), stderr: "", exitCode: 0 });
}

/** Build a minimal, real renderer bundle directory (manifest + entry that
 *  actually satisfies `RendererPlugin`'s shape) under `pkgRoot`, optionally
 *  signed. Returns the ArcPackage record a fake `arc list --json` run would
 *  report for it. */
async function writeBundle(
  pkgRoot: string,
  dirName: string,
  opts: { id: string; sign?: { seed: string; pubkey: string }; tamperAfterSigning?: boolean },
): Promise<ArcPackage> {
  const dir = join(pkgRoot, dirName);
  const { mkdirSync } = await import("fs");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "cortex-plugin.yaml"),
    `kind: renderer\nid: ${opts.id}\nentry: ./index.ts\nsdkRange: "^1"\n`,
  );
  // Deliberately ZERO external imports (no `zod`, no cortex-internal path) —
  // these bundles are written under the OS tmpdir, outside the repo tree, so
  // there is no `node_modules` for Bun to resolve a real dependency against.
  // `configSchema` is a plain object exposing the one method the loader's
  // `isRendererPluginShape` checks (`typeof configSchema.safeParse ===
  // "function"`), mirroring `loader.test.ts`'s own `makeInTreeDiscordStub`
  // stub-schema pattern.
  writeFileSync(
    join(dir, "index.ts"),
    [
      "const plugin = {",
      "  kind: \"renderer\",",
      `  id: ${JSON.stringify(opts.id)},`,
      `  rendererKind: ${JSON.stringify(opts.id)},`,
      "  configSchema: { safeParse: (v) => ({ success: true, data: v }) },",
      "  createRenderer: (config) => ({",
      `    kind: ${JSON.stringify(opts.id)},`,
      `    id: ${JSON.stringify(opts.id)},`,
      "    subjects: [\"local.andreas.>\"],",
      "    async start() {},",
      "    async stop() {},",
      "    get surfaceConfig() { return { id: this.id, subjects: this.subjects, render: () => this.render() }; },",
      "    async render() {},",
      "  }),",
      "};",
      "export default plugin;",
      "",
    ].join("\n"),
  );

  if (opts.sign) {
    const digestResult = computeBundleDigest(dir);
    if (!digestResult.ok) throw new Error(`test setup: digest failed: ${digestResult.reason}`);
    const signature = await signBundleDigest(opts.sign.seed, digestResult.digest);
    writeFileSync(
      join(dir, PLUGIN_SIGNATURE_FILENAME),
      renderSignatureFile({
        version: 1,
        algorithm: "ed25519",
        signer: opts.sign.pubkey,
        digest: digestResult.digest,
        signature,
      }),
    );
  }

  if (opts.tamperAfterSigning) {
    writeFileSync(join(dir, "index.ts"), (await Bun.file(join(dir, "index.ts")).text()) + "// tampered\n");
  }

  return {
    name: dirName,
    version: "0.0.0",
    type: "component",
    status: "active",
    tier: "community",
    repoUrl: TRUSTED_REPO,
    installPath: dir,
  };
}

describe("loadExternalPlugins — system.plugins.signing (cortex#2347, EBH-5)", () => {
  test("default (posture unset / 'off') loads an UNSIGNED bundle exactly as before — byte-identical no-op", async () => {
    const pkgRoot = mkdtempSync(join(tmpdir(), "cortex-signing-off-"));
    try {
      const pkg = await writeBundle(pkgRoot, "unsigned-bundle", { id: "sig-fixture-off" });
      const registry = new SurfacePluginRegistry();
      const result = await loadExternalPlugins({
        registry,
        externalEnabled: true,
        pkgRoot,
        runner: runnerFor([pkg]),
        // pluginSigning intentionally omitted — must default to "off".
      });
      expect(result.failed).toEqual([]);
      expect(result.loaded.map((l) => l.id)).toEqual(["sig-fixture-off"]);
    } finally {
      rmSync(pkgRoot, { recursive: true, force: true });
    }
  });

  test("'off' loads a TAMPERED/mismatched bundle too — posture off never even reads the signature file", async () => {
    const pkgRoot = mkdtempSync(join(tmpdir(), "cortex-signing-off-tamper-"));
    try {
      const signer = freshKeypair();
      const pkg = await writeBundle(pkgRoot, "tampered-but-off", {
        id: "sig-fixture-off-tamper",
        sign: signer,
        tamperAfterSigning: true,
      });
      const registry = new SurfacePluginRegistry();
      const result = await loadExternalPlugins({
        registry,
        externalEnabled: true,
        pkgRoot,
        runner: runnerFor([pkg]),
        pluginSigning: "off",
        pluginTrustedSigners: new Set([signer.pubkey]),
      });
      expect(result.failed).toEqual([]);
      expect(result.loaded.map((l) => l.id)).toEqual(["sig-fixture-off-tamper"]);
    } finally {
      rmSync(pkgRoot, { recursive: true, force: true });
    }
  });

  test("'enforce': a VALIDLY signed bundle from a trusted signer loads", async () => {
    const pkgRoot = mkdtempSync(join(tmpdir(), "cortex-signing-enforce-good-"));
    try {
      const signer = freshKeypair();
      const pkg = await writeBundle(pkgRoot, "good-signed-bundle", {
        id: "sig-fixture-enforce-good",
        sign: signer,
      });
      const registry = new SurfacePluginRegistry();
      const result = await loadExternalPlugins({
        registry,
        externalEnabled: true,
        pkgRoot,
        runner: runnerFor([pkg]),
        pluginSigning: "enforce",
        pluginTrustedSigners: new Set([signer.pubkey]),
      });
      expect(result.failed).toEqual([]);
      expect(result.loaded.map((l) => l.id)).toEqual(["sig-fixture-enforce-good"]);
      expect(registry.getRenderer("sig-fixture-enforce-good")).toBeDefined();
    } finally {
      rmSync(pkgRoot, { recursive: true, force: true });
    }
  });

  test("'enforce': an UNSIGNED bundle is refused BEFORE import — the good bundle in the SAME load still loads", async () => {
    const pkgRoot = mkdtempSync(join(tmpdir(), "cortex-signing-enforce-mixed-"));
    try {
      const signer = freshKeypair();
      const goodPkg = await writeBundle(pkgRoot, "good-signed-bundle", {
        id: "sig-fixture-mixed-good",
        sign: signer,
      });
      const unsignedPkg = await writeBundle(pkgRoot, "unsigned-bundle", { id: "sig-fixture-mixed-unsigned" });
      const registry = new SurfacePluginRegistry();
      const result = await loadExternalPlugins({
        registry,
        externalEnabled: true,
        pkgRoot,
        runner: runnerFor([goodPkg, unsignedPkg]),
        pluginSigning: "enforce",
        pluginTrustedSigners: new Set([signer.pubkey]),
      });
      expect(result.loaded.map((l) => l.id).sort()).toEqual(["sig-fixture-mixed-good"]);
      expect(result.failed).toHaveLength(1);
      expect(result.failed[0]?.bundleName).toBe("unsigned-bundle");
      expect(result.failed[0]?.stage).toBe("signature_verify:signature_missing");
      // Proves it never even reached import: the OTHER bundle registered fine
      // and there is no "import" stage failure recorded.
      expect(registry.getRenderer("sig-fixture-mixed-good")).toBeDefined();
      expect(registry.getRenderer("sig-fixture-mixed-unsigned")).toBeUndefined();
    } finally {
      rmSync(pkgRoot, { recursive: true, force: true });
    }
  });

  test("'enforce': a bundle tampered with AFTER signing is refused (digest_mismatch)", async () => {
    const pkgRoot = mkdtempSync(join(tmpdir(), "cortex-signing-enforce-tamper-"));
    try {
      const signer = freshKeypair();
      const pkg = await writeBundle(pkgRoot, "tampered-bundle", {
        id: "sig-fixture-enforce-tamper",
        sign: signer,
        tamperAfterSigning: true,
      });
      const registry = new SurfacePluginRegistry();
      const result = await loadExternalPlugins({
        registry,
        externalEnabled: true,
        pkgRoot,
        runner: runnerFor([pkg]),
        pluginSigning: "enforce",
        pluginTrustedSigners: new Set([signer.pubkey]),
      });
      expect(result.loaded).toEqual([]);
      expect(result.failed).toHaveLength(1);
      expect(result.failed[0]?.stage).toBe("signature_verify:digest_mismatch");
    } finally {
      rmSync(pkgRoot, { recursive: true, force: true });
    }
  });

  test("'enforce': a well-signed bundle whose signer is NOT in the trust root is refused (signer_not_trusted)", async () => {
    const pkgRoot = mkdtempSync(join(tmpdir(), "cortex-signing-enforce-untrusted-"));
    try {
      const signer = freshKeypair();
      const someoneElse = freshKeypair();
      const pkg = await writeBundle(pkgRoot, "wrong-signer-bundle", {
        id: "sig-fixture-enforce-untrusted",
        sign: signer,
      });
      const registry = new SurfacePluginRegistry();
      const result = await loadExternalPlugins({
        registry,
        externalEnabled: true,
        pkgRoot,
        runner: runnerFor([pkg]),
        pluginSigning: "enforce",
        pluginTrustedSigners: new Set([someoneElse.pubkey]),
      });
      expect(result.loaded).toEqual([]);
      expect(result.failed).toHaveLength(1);
      expect(result.failed[0]?.stage).toBe("signature_verify:signer_not_trusted");
    } finally {
      rmSync(pkgRoot, { recursive: true, force: true });
    }
  });

  test("'permissive': an unsigned bundle still LOADS (verify + log, never refuse)", async () => {
    const pkgRoot = mkdtempSync(join(tmpdir(), "cortex-signing-permissive-"));
    try {
      const pkg = await writeBundle(pkgRoot, "unsigned-bundle", { id: "sig-fixture-permissive" });
      const registry = new SurfacePluginRegistry();
      const result = await loadExternalPlugins({
        registry,
        externalEnabled: true,
        pkgRoot,
        runner: runnerFor([pkg]),
        pluginSigning: "permissive",
        pluginTrustedSigners: new Set(),
      });
      expect(result.failed).toEqual([]);
      expect(result.loaded.map((l) => l.id)).toEqual(["sig-fixture-permissive"]);
    } finally {
      rmSync(pkgRoot, { recursive: true, force: true });
    }
  });

  test("'permissive': a TAMPERED bundle still LOADS (fail-open by design, unlike enforce)", async () => {
    const pkgRoot = mkdtempSync(join(tmpdir(), "cortex-signing-permissive-tamper-"));
    try {
      const signer = freshKeypair();
      const pkg = await writeBundle(pkgRoot, "tampered-bundle", {
        id: "sig-fixture-permissive-tamper",
        sign: signer,
        tamperAfterSigning: true,
      });
      const registry = new SurfacePluginRegistry();
      const result = await loadExternalPlugins({
        registry,
        externalEnabled: true,
        pkgRoot,
        runner: runnerFor([pkg]),
        pluginSigning: "permissive",
        pluginTrustedSigners: new Set([signer.pubkey]),
      });
      expect(result.failed).toEqual([]);
      expect(result.loaded.map((l) => l.id)).toEqual(["sig-fixture-permissive-tamper"]);
    } finally {
      rmSync(pkgRoot, { recursive: true, force: true });
    }
  });

  test("org-trust gate still refuses a non-the-metafactory repo BEFORE signature verification runs, even under 'enforce'", async () => {
    const pkgRoot = mkdtempSync(join(tmpdir(), "cortex-signing-org-trust-"));
    try {
      const signer = freshKeypair();
      const pkg = await writeBundle(pkgRoot, "attacker-bundle", {
        id: "sig-fixture-org-trust",
        sign: signer,
      });
      pkg.repoUrl = "https://github.com/attacker/sig-fixture-org-trust";
      const registry = new SurfacePluginRegistry();
      const result = await loadExternalPlugins({
        registry,
        externalEnabled: true,
        pkgRoot,
        runner: runnerFor([pkg]),
        pluginSigning: "enforce",
        pluginTrustedSigners: new Set([signer.pubkey]),
      });
      expect(result.loaded).toEqual([]);
      expect(result.failed).toHaveLength(1);
      // Refused at org_trust, NOT at any signature_verify stage — proves
      // signing composes with (never bypasses or is bypassed by) the
      // existing gate ordering.
      expect(result.failed[0]?.stage).toBe("org_trust");
    } finally {
      rmSync(pkgRoot, { recursive: true, force: true });
    }
  });

  test("external-flag gate still skips a non-first-party bundle BEFORE signature verification, even under 'enforce'", async () => {
    const pkgRoot = mkdtempSync(join(tmpdir(), "cortex-signing-external-flag-"));
    try {
      const signer = freshKeypair();
      // Deliberately UNSIGNED — if signature verification ran here it would
      // FAIL (missing sig), which would show up as `failed`, not `skipped`.
      const pkg = await writeBundle(pkgRoot, "no-external-bundle", { id: "sig-fixture-external-flag" });
      const registry = new SurfacePluginRegistry();
      const result = await loadExternalPlugins({
        registry,
        externalEnabled: false,
        pkgRoot,
        runner: runnerFor([pkg]),
        pluginSigning: "enforce",
        pluginTrustedSigners: new Set([signer.pubkey]),
      });
      expect(result.loaded).toEqual([]);
      expect(result.failed).toEqual([]);
      expect(result.skipped.map((s) => s.bundleName)).toEqual(["no-external-bundle"]);
    } finally {
      rmSync(pkgRoot, { recursive: true, force: true });
    }
  });
});
