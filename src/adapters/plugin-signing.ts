/**
 * cortex#2347 (EBH-5, ADR-0024 D4 "named future escalation: registry
 * signing") — cryptographic signature verification for surface-plugin
 * bundles, at load time, from bytes on disk.
 *
 * ## Why this exists
 *
 * `loader.ts`'s org-trust gate (`isTrustedOrgRepo`) and first-party
 * exemption (`isFirstPartyBundle`) both rest on `arc list --json`'s
 * self-reported `repoUrl` — a fact `loader.ts` itself flags as
 * un-independently-verifiable (see its `readCortexDeclaredAdapterRepos`
 * doc, "Threat-model note"): if arc ever recorded a `repoUrl` decoupled
 * from the package's real clone source, both gates would fall together.
 * ADR-0024 D4 names the fix directly: **"registry signing … mirrors
 * ADR-0018/0023"**. This module is that mechanism: an independent,
 * additive gate that verifies a bundle's on-disk content was signed by a
 * key on cortex's trust root, checked from bytes on disk BEFORE the
 * bundle's entry module is ever `import()`-ed.
 *
 * **This does NOT replace the org-trust/first-party gates.** Composing
 * ADD (this module ANDs with the existing gates, never substitutes for
 * them) is deliberate: no production bundle in the ecosystem is signed
 * yet (see "Open question" below), so making signature-based trust the
 * SOLE gate today would either refuse every bundle (under `enforce`) or
 * do nothing (under `off`) — neither improves on today. What changes is
 * additive: once a publisher signs, `enforce` gives cortex a real,
 * checkable fact to gate on, on top of the assumption that already
 * existed. `isFirstPartyBundle` / `isFirstPartyAdapterBundle` /
 * `isFirstPartyRendererBundle` / `readCortexDeclaredAdapterRepos` /
 * `readCortexDeclaredRendererRepos` are UNTOUCHED by this module.
 *
 * ## Format
 *
 * A bundle's install directory MAY carry a sibling signature file,
 * {@link PLUGIN_SIGNATURE_FILENAME} (`cortex-plugin.sig`), alongside
 * `cortex-plugin.yaml`:
 *
 * ```yaml
 * version: 1
 * algorithm: ed25519
 * signer: "U..."          # NKey public key (matches agent.nkey_pub / stack.nkey_pub format)
 * digest: "<64-hex sha256>"  # see computeBundleDigest
 * signature: "<base64 64-byte ed25519 signature>"
 * ```
 *
 * The signer identifies itself by NKey (the same `U`-prefixed base32
 * encoding cortex already uses for agent and stack signing identities —
 * `src/common/types/nkey.ts`), not a bare base64 pubkey, so a plugin
 * publisher's key can be generated, stored, and reasoned about with the
 * exact same tooling (`nk`, `generateStackIdentity`) cortex already
 * documents for every other signing identity in the system.
 *
 * `digest` is a deterministic content digest over the ENTIRE bundle
 * tree (every regular file under `installPath`, sorted by relative
 * path, EXCLUDING the signature file itself) — see
 * {@link computeBundleDigest}. Signing only the manifest (or only the
 * declared `entry` file) would leave a hole: `entry` can import sibling
 * files the signature would then not cover. Signing the whole tree
 * closes that — any file changed after signing invalidates the
 * signature, including the manifest.
 *
 * `signature` covers a domain-separated message
 * (`SIGNATURE_DOMAIN_PREFIX + digest`), not the raw digest bytes —
 * ordinary signing hygiene so a plugin-bundle signature can never be
 * replayed as a signature over an unrelated protocol that happens to
 * sign the same 64 hex characters.
 *
 * ## Trust root — where it lives and why
 *
 * {@link PLUGIN_TRUST_ROOT} is an in-tree, PR-reviewed `ReadonlySet`
 * of NKey public keys — the SAME shape of anchor as
 * `TRUSTED_ORG_REPO_RE` and the original `FIRST_PARTY_RENDERER_REPOS`
 * in `loader.ts`: changeable only by a reviewed cortex source change +
 * release, never by bundle-author-controlled or deployment-mutable
 * data. This is deliberate, not incidental — a trust root that lived in
 * a deployment config file (`~/.config/metafactory/cortex/...`) would
 * be *editable by anything with the daemon's own filesystem access*,
 * which under ADR-0024 D4's accepted full-authority model includes an
 * already-loaded plugin (the exact self-rewrite risk `loader.ts`'s
 * `readCortexDeclaredAdapterRepos` doc already records for
 * `arc-manifest.yaml`). An in-tree constant requires a REBUILD to
 * change, which is a strictly higher bar.
 *
 * **Open question this module deliberately does NOT resolve (flagged,
 * not silently decided):** {@link PLUGIN_TRUST_ROOT} ships EMPTY. No
 * bundle in the ecosystem is signed today, and there is no arc/CI
 * pipeline that produces a `cortex-plugin.sig` for a published bundle.
 * Populating the trust root with a real production key — and deciding
 * WHO holds the corresponding private seed and HOW/WHEN a bundle gets
 * signed (an `arc publish` pipeline step? a manual `cortex plugin sign`
 * CLI, not built here?) — is an ecosystem/operational decision, not a
 * cortex-code decision, and is out of scope for this slice. Shipping
 * with an empty trust root is safe under `off` (the default) and
 * `permissive` (verify-and-log, never refuses). It is NOT automatically
 * safe under `enforce` — an empty trust root there refuses every bundle,
 * including a FIRST-PARTY one a stack may depend on for the ADR-0024
 * §OQ9 renderer-coverage floor (see `docs/security/hardening-plan.md`),
 * which downstream surfaces as an unrelated-looking boot crash at the
 * coverage guard. {@link assertPluginSigningTrustRootConfigured} is the
 * boot-time guard that catches this BEFORE it reaches that point — see
 * its own doc for why this is a "make the failure loud and immediate,"
 * not a "prevent the failure" fix (`enforce` with nothing to verify
 * against genuinely cannot safely proceed; that refusal is correct, not
 * a bug — only its confusing, three-layers-downstream presentation was).
 *
 * ## Posture (mirrors `security.signing`, `src/common/types/config.ts`)
 *
 * `system.plugins.signing`: `off` (default, byte-identical to
 * pre-EBH-5 behaviour — this module is never consulted) · `permissive`
 * (verify + log, NEVER refuse — the shadow rung to prove verification
 * against live bundles before gating) · `enforce` (refuse any bundle
 * whose signature is missing, malformed, tampered, or signed by a key
 * outside {@link PLUGIN_TRUST_ROOT}). This module only ever answers
 * "does this bundle verify right now", never "what should happen if it
 * doesn't" — that branch lives at EVERY call site listed in "Coverage"
 * below, independently, because each is a distinct point where plugin
 * code is about to execute.
 *
 * ## Coverage — every `import()` call site that loads plugin bundle code
 *
 * There are exactly two, both in `loader.ts`, both verified (audited
 * cortex#2347 follow-up, adversarial-review finding — a bundle that
 * verified once must NOT get a lifetime pass):
 *
 *   1. **Boot** — `loadOneBundle` (called from `loadExternalPlugins`).
 *      Verifies once, at first load, before that bundle's entry module
 *      is ever imported for this daemon process's lifetime.
 *   2. **Reload** — `reimportRendererPlugin` (called from
 *      `src/gateway/plugin-runtime.ts`'s `reloadLivePlugin`/
 *      `loadLivePlugin`, reachable via the `system.plugin.control-request`
 *      bus subject and the `cortex plugin reload`/`load` CLI). This is a
 *      SEPARATE, later `import()` of the SAME bundle's entry module — the
 *      file on disk may have changed since boot (that is the entire point
 *      of a reload command). It therefore RE-VERIFIES from CURRENT on-disk
 *      bytes, every time, using the same posture + trust root as boot —
 *      never "trusts" a boot-time result that has gone stale. A bundle
 *      tampered with after boot is refused at reload under `enforce`, and
 *      its (tampered) code is never imported.
 *
 * Every other `import()`/`require()`/`eval()`-shaped call in the codebase
 * (audited alongside this fix — `grep -rn "await import(" src/` minus
 * `__tests__`) loads a static npm dependency (`@metafactory/content-filter`,
 * `bun`, `fs`, `fs/promises`) or an internal cortex module by literal
 * path — never third-party bundle code reached through the plugin loader.
 * If a THIRD call site is ever added (a future runtime-adapter-reload verb,
 * cortex#1896's tracked follow-up, is the most likely candidate), it MUST
 * verify through this module before importing, and this list MUST grow to
 * three — a call site missing from this list is the bug class this note
 * exists to prevent recurring.
 *
 * ## What this module does NOT do
 *
 * It does not sandbox or isolate plugin execution — that is the
 * trigger-gated, deferred half of cortex#2347 (EBH-5), designed but not
 * built at `docs/design-plugin-isolation.md`. A validly-signed bundle
 * still runs in-process with full daemon authority (ADR-0024 D4
 * unchanged). Signature verification answers "is this the bundle a
 * trusted publisher produced", not "what can this bundle do once it
 * runs". It does NOT protect against a bundle that re-signs itself with
 * a DIFFERENT, still-trusted key between boot and reload — that is not a
 * gap, it is the system working as designed (a trusted publisher legally
 * re-publishing); what it defends against is untrusted or tampered bytes
 * being imported, at every point bytes are about to become code.
 */

import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, realpathSync } from "fs";
import { join, relative, sep } from "path";
import { parse as parseYaml } from "yaml";
import { z } from "zod/v4";

import { NKEY_PUBKEY_ERROR_MESSAGE, NKEY_PUBKEY_REGEX } from "../common/types/nkey";
import { verifyEd25519 } from "../common/registry/signing";
import { nkeyToBase64Pubkey } from "../bus/verify-signed-by-chain";
import { signClaimWithSeed } from "../bus/stack-provisioning";

/**
 * The three settable `system.plugins.signing` postures — re-exported here
 * (mirroring `SigningPosture` in `src/bus/verifier-self-check.ts`) so
 * `loader.ts` can import the type from the module that owns the
 * verification semantics rather than re-declaring the literal union.
 */
export type PluginSigningPosture = "off" | "permissive" | "enforce";

// =============================================================================
// Trust root
// =============================================================================

/**
 * cortex#2347 (EBH-5) — the plugin-bundle signing trust root. See the
 * module doc "Open question" section: INTENTIONALLY EMPTY until a
 * production signing key is provisioned and the principal decides who
 * holds it. Populating this set is a plain cortex source PR, exactly
 * like `FIRST_PARTY_RENDERER_REPOS` in `loader.ts` — never a config
 * change, never derived from anything a bundle or its manifest can
 * influence.
 */
export const PLUGIN_TRUST_ROOT: ReadonlySet<string> = new Set([
  // INTENTIONALLY EMPTY — see module doc header.
]);

/**
 * cortex#2347 (EBH-5 follow-up, adversarial review Finding 2 — availability)
 * — boot-time precondition: `system.plugins.signing === "enforce"` with an
 * EMPTY effective trust root cannot deliver a working boot. Under `enforce`
 * EVERY bundle fails to verify (there is nothing to verify against),
 * including a FIRST-PARTY bundle a stack may depend on for the ADR-0024
 * §OQ9 renderer-coverage floor (today: `metafactory-cortex-renderer-pagerduty`
 * — see `docs/security/hardening-plan.md`). Left unchecked, THIS function's
 * absence is exactly how that surfaces: several boot-stages later, as an
 * uncaught `RendererCoverageInstallStateError` (`src/renderers/coverage.ts`)
 * that names a coverage shortfall, not the `signing` flag that actually
 * caused it — a confusing, accidental-looking outage from a config change
 * that was one field, in one place, days or commits away from the crash.
 *
 * This function turns that into an IMMEDIATE, NAMED, actionable refusal,
 * called from `src/cortex.ts` BEFORE `loadExternalPlugins` even runs — the
 * earliest point the boot sequence can know both facts (the resolved
 * posture, and the trust root it will verify against). It deliberately does
 * NOT:
 *   - weaken `enforce`'s semantics (a stack genuinely cannot safely verify
 *     anything against an empty trust root — refusing to boot IS correct;
 *     only the previous failure's presentation was the bug), or
 *   - auto-exempt first-party bundles from signature verification (that
 *     would be exactly the "solve availability by widening trust" shape
 *     this review explicitly forbids — see `plugin-signing.ts`'s own
 *     "Coverage" section: EVERY bundle verifies, first-party included).
 * It only makes the SAME necessary refusal loud and immediate instead of
 * an accidental-looking crash three layers downstream.
 *
 * `permissive` is deliberately EXEMPT from this hard-fail: it never refuses
 * a bundle (verify-and-log only), so an empty trust root under `permissive`
 * cannot cause an availability outage — `loadExternalPlugins` already logs
 * a one-line heads-up for that case (see its own "empty trust root" check).
 * `off` is exempt because this module is never consulted under `off`.
 *
 * @throws a plain `Error` (matching this codebase's `bootVerifierSelfCheck`
 *   "REFUSING TO BOOT" convention, `src/bus/verifier-self-check.ts`) when
 *   `posture === "enforce"` and `trustedSigners.size === 0`. Never throws
 *   otherwise.
 */
export function assertPluginSigningTrustRootConfigured(
  posture: PluginSigningPosture,
  trustedSigners: ReadonlySet<string>,
): void {
  if (posture !== "enforce") return;
  if (trustedSigners.size > 0) return;
  throw new Error(
    `cortex plugin-loader: REFUSING TO BOOT — system.plugins.signing="enforce" but the plugin ` +
      `trust root is EMPTY (src/adapters/plugin-signing.ts PLUGIN_TRUST_ROOT has zero entries). ` +
      `Every bundle's signature would fail to verify, INCLUDING first-party bundles this stack may ` +
      `depend on for ADR-0024 §OQ9 renderer coverage (e.g. metafactory-cortex-renderer-pagerduty) — ` +
      `left unchecked this crashes several boot-stages later at the renderer-coverage guard with an ` +
      `error that looks unrelated to this setting. Populate PLUGIN_TRUST_ROOT with a real production ` +
      `signing key before enabling enforce, or set system.plugins.signing to "off" or "permissive" ` +
      `until one is provisioned. See plugin-signing.ts's module doc "Open question" section.`,
  );
}

// =============================================================================
// Signature file schema
// =============================================================================

/** Sibling file to `cortex-plugin.yaml` inside a bundle's install dir. */
export const PLUGIN_SIGNATURE_FILENAME = "cortex-plugin.sig";

/** Domain separator prepended to the digest before signing/verifying —
 *  ordinary signing hygiene so a plugin-bundle signature can't be replayed
 *  as a signature over an unrelated protocol. */
const SIGNATURE_DOMAIN_PREFIX = "cortex-plugin-bundle-v1\0";

function signedMessage(digestHex: string): Uint8Array {
  return new TextEncoder().encode(SIGNATURE_DOMAIN_PREFIX + digestHex);
}

const SHA256_HEX_RE = /^[0-9a-f]{64}$/;

export const PluginSignatureSchema = z
  .object({
    version: z.literal(1),
    algorithm: z.literal("ed25519"),
    /** NKey public key — same `U`-prefixed base32 encoding as
     *  `agent.nkey_pub` / `stack.nkey_pub`. */
    signer: z.string().regex(NKEY_PUBKEY_REGEX, NKEY_PUBKEY_ERROR_MESSAGE),
    /** sha256 hex digest of the bundle tree — see {@link computeBundleDigest}. */
    digest: z
      .string()
      .regex(SHA256_HEX_RE, "digest must be a 64-char lowercase sha256 hex digest"),
    /** base64-encoded 64-byte ed25519 signature over the domain-separated digest. */
    signature: z.string().min(1, "signature is required"),
  })
  .strict();

export type PluginSignature = z.infer<typeof PluginSignatureSchema>;

// =============================================================================
// Bundle content digest
// =============================================================================

export type BundleDigestResult = { ok: true; digest: string } | { ok: false; reason: string };

/**
 * Recursively collect every REGULAR file under `dir` (relative to `root`),
 * refusing on any symlink or unexpected entry type. Returns an error
 * string on failure, `undefined` on success; entries are pushed into
 * `out` as `"<relPath>\0<sha256hex>"` in no particular order — the caller
 * sorts the full collection before hashing, so traversal order never
 * affects the result.
 *
 * Symlinks are refused, not silently skipped or dereferenced: a nested
 * symlink inside an already-contained bundle directory could point
 * outside it (mirrors the `cortex-plugin.yaml`/`entry` symlink defenses
 * in `loader.ts`) and be swapped without changing this digest if we
 * either ignored it or hashed only its target string. A legitimate
 * bundle has no reason to ship one.
 */
function collectFileHashes(
  dir: string,
  root: string,
  exclude: ReadonlySet<string>,
  out: string[],
): string | undefined {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    return `failed to read directory "${dir}": ${err instanceof Error ? err.message : String(err)}`;
  }
  for (const entry of entries) {
    const abs = join(dir, entry.name);
    const rel = relative(root, abs).split(sep).join("/");
    if (exclude.has(rel)) continue;

    let stat;
    try {
      stat = lstatSync(abs);
    } catch (err) {
      return `failed to stat "${rel}": ${err instanceof Error ? err.message : String(err)}`;
    }

    if (stat.isSymbolicLink()) {
      return `bundle contains a symlink at "${rel}" — refusing to compute a digest over an untrusted symlink`;
    }
    if (stat.isDirectory()) {
      const err = collectFileHashes(abs, root, exclude, out);
      if (err !== undefined) return err;
      continue;
    }
    if (!stat.isFile()) {
      return `unexpected filesystem entry type at "${rel}" (not a regular file, directory, or symlink)`;
    }

    let content: Buffer;
    try {
      content = readFileSync(abs);
    } catch (err) {
      return `failed to read "${rel}": ${err instanceof Error ? err.message : String(err)}`;
    }
    const fileHash = createHash("sha256").update(content).digest("hex");
    out.push(`${rel}\0${fileHash}`);
  }
  return undefined;
}

/**
 * Compute a deterministic sha256 digest over the ENTIRE bundle tree
 * rooted at `installPath` (every regular file, sorted by relative path),
 * excluding {@link PLUGIN_SIGNATURE_FILENAME} at the ROOT (it can't sign
 * itself). `cortex-plugin.yaml` is INCLUDED — tampering with the manifest
 * after signing must invalidate the signature too.
 *
 * Never throws: any read/stat failure, or a nested symlink, is returned
 * as `{ ok: false, reason }` — a failed digest computation is treated by
 * the caller as a verification failure, never as "no opinion".
 */
export function computeBundleDigest(installPath: string): BundleDigestResult {
  const exclude = new Set<string>([PLUGIN_SIGNATURE_FILENAME]);
  const out: string[] = [];
  const err = collectFileHashes(installPath, installPath, exclude, out);
  if (err !== undefined) return { ok: false, reason: err };
  out.sort();
  const digest = createHash("sha256").update(out.join("\n")).digest("hex");
  return { ok: true, digest };
}

// =============================================================================
// Verification
// =============================================================================

export type VerifyBundleSignatureResult =
  | { ok: true; signer: string }
  | { ok: false; stage: string; reason: string };

export interface VerifyBundleSignatureOptions {
  /** Realpath'd, containment-verified bundle install directory (the SAME
   *  value `loader.ts`'s `DiscoveredBundle.installPath` carries). */
  installPath: string;
  /** The trust root to check the signer against. Production callers pass
   *  {@link PLUGIN_TRUST_ROOT}; tests inject their own throwaway keypair's
   *  pubkey. No internal default — explicit only, mirroring
   *  `isFirstPartyAdapterBundle`'s no-default convention in `loader.ts`. */
  trustedSigners: ReadonlySet<string>;
}

/**
 * Verify a bundle's {@link PLUGIN_SIGNATURE_FILENAME} against
 * `opts.trustedSigners`, entirely from bytes on disk — no `import()`,
 * directly or indirectly. Never throws.
 *
 * Failure stages (all refuse; the caller decides what "refuse" means for
 * the active posture — see `loader.ts`):
 *   - `signature_missing` — no `cortex-plugin.sig` in the bundle.
 *   - `signature_containment` — the sig file is a symlink escaping the
 *     bundle directory (mirrors the manifest-file defense in `loader.ts`).
 *   - `signature_parse` — the file isn't valid YAML matching
 *     {@link PluginSignatureSchema}.
 *   - `signer_not_trusted` — the file parses fine but `signer` is not in
 *     `trustedSigners`.
 *   - `digest_compute` — {@link computeBundleDigest} failed (unreadable
 *     file, nested symlink, …).
 *   - `digest_mismatch` — the bundle's current content digest does not
 *     match the signed `digest` — content changed since signing.
 *   - `signer_malformed` — `signer` is a well-formed NKey string but could
 *     not be decoded to a raw ed25519 pubkey (defensive; the regex should
 *     already prevent this).
 *   - `signature_invalid` — the ed25519 signature does not verify against
 *     the claimed signer's pubkey over the domain-separated digest.
 */
export async function verifyBundleSignature(
  opts: VerifyBundleSignatureOptions,
): Promise<VerifyBundleSignatureResult> {
  const { installPath, trustedSigners } = opts;

  // Realpath the install dir itself before comparing containment — the
  // production caller (`loader.ts`'s `DiscoveredBundle.installPath`) has
  // ALREADY realpath'd this, but this function is defensive regardless
  // (and on macOS, `/var` is itself a symlink to `/private/var`, so even
  // an already-"resolved" tmp path can still differ from its OWN realpath
  // by that prefix — comparing two un-normalized strings would false-flag).
  let realInstallPath: string;
  try {
    realInstallPath = realpathSync(installPath);
  } catch (err) {
    return {
      ok: false,
      stage: "install_path_unreadable",
      reason: `bundle install path "${installPath}" does not resolve: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const sigPath = join(realInstallPath, PLUGIN_SIGNATURE_FILENAME);

  let realSigPath: string;
  try {
    realSigPath = realpathSync(sigPath);
  } catch {
    return {
      ok: false,
      stage: "signature_missing",
      reason: `no ${PLUGIN_SIGNATURE_FILENAME} found in the bundle`,
    };
  }

  // Symlinked-signature-file defense — mirrors `loader.ts` discovery's
  // symlinked-manifest defense: the install DIRECTORY is already
  // realpath'd + containment-verified by the caller, but the signature
  // FILE inside it could itself be a symlink pointing outside.
  const contained = realSigPath === realInstallPath || realSigPath.startsWith(realInstallPath + sep);
  if (!contained) {
    return {
      ok: false,
      stage: "signature_containment",
      reason: `${PLUGIN_SIGNATURE_FILENAME} (resolved: "${realSigPath}") escapes the trusted bundle directory "${realInstallPath}" — refused`,
    };
  }

  let raw: unknown;
  try {
    const text = readFileSync(realSigPath, "utf-8");
    raw = parseYaml(text);
  } catch (err) {
    return {
      ok: false,
      stage: "signature_parse",
      reason: `${PLUGIN_SIGNATURE_FILENAME} could not be read/parsed as YAML: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const parsed = PluginSignatureSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      stage: "signature_parse",
      reason: `${PLUGIN_SIGNATURE_FILENAME} is invalid: ${parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")}`,
    };
  }
  const sig = parsed.data;

  if (!trustedSigners.has(sig.signer)) {
    return {
      ok: false,
      stage: "signer_not_trusted",
      reason: `signer "${sig.signer.slice(0, 12)}…" is not in the plugin trust root`,
    };
  }

  const digestResult = computeBundleDigest(realInstallPath);
  if (!digestResult.ok) {
    return { ok: false, stage: "digest_compute", reason: digestResult.reason };
  }
  if (digestResult.digest !== sig.digest) {
    return {
      ok: false,
      stage: "digest_mismatch",
      reason:
        "bundle content digest does not match the signed digest — the bundle has been modified since signing (or this signature belongs to a different bundle)",
    };
  }

  const pubkeyB64 = nkeyToBase64Pubkey(sig.signer);
  if (pubkeyB64 === undefined) {
    return {
      ok: false,
      stage: "signer_malformed",
      reason: `signer NKey "${sig.signer.slice(0, 12)}…" could not be decoded to a raw ed25519 pubkey`,
    };
  }

  const verified = await verifyEd25519(pubkeyB64, sig.signature, signedMessage(sig.digest));
  if (!verified) {
    return {
      ok: false,
      stage: "signature_invalid",
      reason: "ed25519 signature verification failed — signature does not match the digest under the claimed signer key",
    };
  }

  return { ok: true, signer: sig.signer };
}

// =============================================================================
// Authoring helper (test / future-tooling use — NOT wired into any CLI here)
// =============================================================================

/**
 * Sign a bundle digest with an NKey seed (`SU…`). Pairs with
 * {@link verifyBundleSignature} / {@link computeBundleDigest} to build a
 * {@link PLUGIN_SIGNATURE_FILENAME}'s `signature` field.
 *
 * NOT wired into any CLI or production caller in this slice — production
 * bundle signing (an `arc publish` pipeline step, or a future
 * `cortex plugin sign` command) is the operational/ecosystem decision
 * flagged in the module doc "Open question" section, out of scope here.
 * Exists so tests (and, later, whatever tooling implements that decision)
 * have a single correct implementation of "what does signing a bundle
 * digest mean" rather than each reinventing the domain-separation +
 * NKey-seed bridge.
 */
export async function signBundleDigest(seed: string, digestHex: string): Promise<string> {
  return signClaimWithSeed(seed, signedMessage(digestHex));
}

/** Render a {@link PluginSignature} as the YAML text `cortex-plugin.sig`
 *  expects. Authoring helper — see {@link signBundleDigest}'s doc. */
export function renderSignatureFile(sig: PluginSignature): string {
  return (
    `version: ${String(sig.version)}\n` +
    `algorithm: ${sig.algorithm}\n` +
    `signer: "${sig.signer}"\n` +
    `digest: "${sig.digest}"\n` +
    `signature: "${sig.signature}"\n`
  );
}
