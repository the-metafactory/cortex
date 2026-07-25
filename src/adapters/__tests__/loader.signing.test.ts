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
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createUser } from "nkeys.js";

import { discoverPluginBundles, loadExternalPlugins, reimportRendererPlugin, type ArcListRunResult } from "../loader";
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

// =============================================================================
// reimportRendererPlugin — reload re-verification (cortex#2347 follow-up,
// adversarial review DO-NOT-MERGE finding: a bundle that verified once at
// boot must NOT get a lifetime pass — `reimportRendererPlugin` is a SECOND,
// independent `import()` call site and must re-verify from CURRENT on-disk
// bytes at reload time, not trust whatever verified at boot).
// =============================================================================

/** Renderer entry whose top-level code has a real, observable, EXECUTION
 *  side effect (an `appendFileSync` at MODULE-EVALUATION time, not inside
 *  any function) — so a test can prove "this code ran" by checking the
 *  sentinel file's CONTENT, not merely "no error was thrown". `marker` is
 *  embedded in the appended line so the ORIGINAL and TAMPERED versions of
 *  the same file are trivially distinguishable in the sentinel's content. */
function rendererIndexWithExecutionMarker(id: string, sentinelPath: string, marker: string): string {
  return [
    "import { appendFileSync } from \"fs\";",
    // Runs at IMPORT time — this is the exact statement that must never
    // execute for a bundle refused before `import()`.
    `appendFileSync(${JSON.stringify(sentinelPath)}, ${JSON.stringify(marker)} + "\\n");`,
    "const plugin = {",
    "  kind: \"renderer\",",
    `  id: ${JSON.stringify(id)},`,
    `  rendererKind: ${JSON.stringify(id)},`,
    "  configSchema: { safeParse: (v) => ({ success: true, data: v }) },",
    "  createRenderer: (config) => ({",
    `    kind: ${JSON.stringify(id)},`,
    `    id: ${JSON.stringify(id)},`,
    "    subjects: [\"local.andreas.>\"],",
    "    async start() {},",
    "    async stop() {},",
    "    get surfaceConfig() { return { id: this.id, subjects: this.subjects, render: () => this.render() }; },",
    "    async render() {},",
    "  }),",
    "};",
    "export default plugin;",
    "",
  ].join("\n");
}

describe("reimportRendererPlugin — reload re-verification (cortex#2347 follow-up)", () => {
  test("a bundle that verified at BOOT but is TAMPERED before RELOAD is refused, and the tampered code NEVER EXECUTES", async () => {
    const pkgRoot = mkdtempSync(join(tmpdir(), "cortex-signing-reload-tamper-"));
    const sentinelPath = join(pkgRoot, "executed.marker");
    try {
      const signer = freshKeypair();
      const dir = join(pkgRoot, "reload-bundle");
      const { mkdirSync } = await import("fs");
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, "cortex-plugin.yaml"),
        "kind: renderer\nid: reload-fixture\nentry: ./index.ts\nsdkRange: \"^1\"\n",
      );
      writeFileSync(join(dir, "index.ts"), rendererIndexWithExecutionMarker("reload-fixture", sentinelPath, "ORIGINAL"));

      // Sign the ORIGINAL content.
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

      const pkg: ArcPackage = {
        name: "reload-bundle",
        version: "0.0.0",
        type: "component",
        status: "active",
        tier: "community",
        repoUrl: TRUSTED_REPO,
        installPath: dir,
      };
      const trustedSigners = new Set([signer.pubkey]);

      // 1. BOOT — loads under enforce; the ORIGINAL code legitimately runs
      //    once (proves the harness itself is sound, not just the refusal).
      const registry = new SurfacePluginRegistry();
      const bootResult = await loadExternalPlugins({
        registry,
        externalEnabled: true,
        pkgRoot,
        runner: runnerFor([pkg]),
        pluginSigning: "enforce",
        pluginTrustedSigners: trustedSigners,
      });
      expect(bootResult.failed).toEqual([]);
      expect(bootResult.loaded.map((l) => l.id)).toEqual(["reload-fixture"]);
      expect(existsSync(sentinelPath)).toBe(true);
      expect(readFileSync(sentinelPath, "utf-8")).toBe("ORIGINAL\n");

      // 2. TAMPER — mutate the entry file ON DISK after boot. The signature
      //    file is untouched, so it now names a STALE digest. Also swap the
      //    marker so any execution would be unmistakable in the sentinel.
      writeFileSync(join(dir, "index.ts"), rendererIndexWithExecutionMarker("reload-fixture", sentinelPath, "TAMPERED-EXECUTED"));

      // 3. RELOAD — re-discover the SAME bundle (as `reloadLivePlugin` does)
      //    and call `reimportRendererPlugin` with the SAME posture + trust
      //    root the boot call used.
      const { bundles } = await discoverPluginBundles({ pkgRoot, runner: runnerFor([pkg]) });
      const bundle = bundles.find((b) => b.bundleName === "reload-bundle");
      if (!bundle) throw new Error("test setup: bundle not discoverable for reload");

      const reimportResult = await reimportRendererPlugin(bundle, {
        bust: true,
        pluginSigning: "enforce",
        pluginTrustedSigners: trustedSigners,
      });

      // ASSERTION 1 — the reload is REFUSED (not merely "an error", the
      // SPECIFIC signature-verify stage this fix adds).
      expect(reimportResult.ok).toBe(false);
      if (!reimportResult.ok) {
        expect(reimportResult.stage).toBe("signature_verify:digest_mismatch");
      }

      // ASSERTION 2 — the tampered code NEVER EXECUTED. This is the sharp
      // assertion the review specifically asked for: not "no plugin object
      // was returned" (which a refusal-before-import trivially satisfies by
      // construction) but "the file's top-level side effect never ran" —
      // proof `import()` itself was never reached for the tampered bytes.
      // If it HAD executed, the sentinel would now read
      // "ORIGINAL\nTAMPERED-EXECUTED\n"; it must be UNCHANGED from step 1.
      expect(readFileSync(sentinelPath, "utf-8")).toBe("ORIGINAL\n");
    } finally {
      rmSync(pkgRoot, { recursive: true, force: true });
    }
  });

  test("a bundle that is NOT tampered reloads fine under enforce (still loads the good one — same lesson as boot)", async () => {
    const pkgRoot = mkdtempSync(join(tmpdir(), "cortex-signing-reload-good-"));
    const sentinelPath = join(pkgRoot, "executed.marker");
    try {
      const signer = freshKeypair();
      const dir = join(pkgRoot, "reload-bundle");
      const { mkdirSync } = await import("fs");
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, "cortex-plugin.yaml"),
        "kind: renderer\nid: reload-fixture-good\nentry: ./index.ts\nsdkRange: \"^1\"\n",
      );
      writeFileSync(
        join(dir, "index.ts"),
        rendererIndexWithExecutionMarker("reload-fixture-good", sentinelPath, "RUN"),
      );
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
      const pkg: ArcPackage = {
        name: "reload-bundle",
        version: "0.0.0",
        type: "component",
        status: "active",
        tier: "community",
        repoUrl: TRUSTED_REPO,
        installPath: dir,
      };
      const trustedSigners = new Set([signer.pubkey]);

      const { bundles } = await discoverPluginBundles({ pkgRoot, runner: runnerFor([pkg]) });
      const bundle = bundles.find((b) => b.bundleName === "reload-bundle");
      if (!bundle) throw new Error("test setup: bundle not discoverable for reload");

      const reimportResult = await reimportRendererPlugin(bundle, {
        bust: true,
        pluginSigning: "enforce",
        pluginTrustedSigners: trustedSigners,
      });

      expect(reimportResult.ok).toBe(true);
      if (reimportResult.ok) {
        expect(reimportResult.plugin.id).toBe("reload-fixture-good");
      }
      // Executed exactly once — this reload's import.
      expect(readFileSync(sentinelPath, "utf-8")).toBe("RUN\n");
    } finally {
      rmSync(pkgRoot, { recursive: true, force: true });
    }
  });

  test("reload with pluginSigning 'off' skips verification entirely (byte-identical pre-fix behaviour when posture is off)", async () => {
    const pkgRoot = mkdtempSync(join(tmpdir(), "cortex-signing-reload-off-"));
    try {
      const dir = join(pkgRoot, "unsigned-reload-bundle");
      const { mkdirSync } = await import("fs");
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, "cortex-plugin.yaml"),
        "kind: renderer\nid: reload-fixture-off\nentry: ./index.ts\nsdkRange: \"^1\"\n",
      );
      writeFileSync(
        join(dir, "index.ts"),
        "const plugin = { kind: \"renderer\", id: \"reload-fixture-off\", rendererKind: \"reload-fixture-off\", " +
          "configSchema: { safeParse: (v) => ({ success: true, data: v }) }, createRenderer: (c) => ({ " +
          "kind: \"reload-fixture-off\", id: \"reload-fixture-off\", subjects: [], async start(){}, async stop(){}, " +
          "get surfaceConfig(){return {id:this.id, subjects:this.subjects, render:()=>this.render()};}, async render(){} }) };\n" +
          "export default plugin;\n",
      );
      const pkg: ArcPackage = {
        name: "unsigned-reload-bundle",
        version: "0.0.0",
        type: "component",
        status: "active",
        tier: "community",
        repoUrl: TRUSTED_REPO,
        installPath: dir,
      };
      const { bundles } = await discoverPluginBundles({ pkgRoot, runner: runnerFor([pkg]) });
      const bundle = bundles.find((b) => b.bundleName === "unsigned-reload-bundle");
      if (!bundle) throw new Error("test setup: bundle not discoverable for reload");

      // No cortex-plugin.sig anywhere — under any non-"off" posture this
      // would refuse at signature_missing. Under "off" it must load fine.
      const reimportResult = await reimportRendererPlugin(bundle, { bust: true, pluginSigning: "off" });
      expect(reimportResult.ok).toBe(true);
      if (reimportResult.ok) {
        expect(reimportResult.plugin.id).toBe("reload-fixture-off");
      }
    } finally {
      rmSync(pkgRoot, { recursive: true, force: true });
    }
  });
});
