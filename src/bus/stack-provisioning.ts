/**
 * TC-1b (Trust & Confidentiality, #632) — stack-identity provisioning.
 *
 * Design: `docs/design-trust-confidentiality.md` §4 Phase 1.1b — "Ensure
 * every deployed stack has `stack.nkey_seed_path` + registered `nkey_pub`".
 * This is the CODE side of making SIGNED operation real: without a
 * provisioned stack signing identity AND its pubkey registered in the
 * network-registry, `signing: enforce` has nothing to verify against, and
 * the boot `verifier-self-check` (cortex#480) cannot pass.
 *
 * ## What provisioning produces
 *
 *   1. A fresh NATS NKey **user-class** signing identity (ed25519 seed,
 *      `SU…`). This is the SAME key the stack signs bus envelopes with —
 *      design invariant §2.4 "no new long-term keys" — so there is exactly
 *      ONE root of secret material per stack.
 *   2. The seed written to the configured `stack.nkey_seed_path`, chmod
 *      `600` (matching the TC-4a/4b file-mode hardening — `enforceChmod600`).
 *   3. The matching NKey public key (`U…`, 56-char base32) for
 *      `cortex.yaml stack.nkey_pub`.
 *   4. A **signed registration claim** for `POST /principals/{id}/register`,
 *      where the claim is signed with the SAME ed25519 key. This proves
 *      possession (the registry verifies the signature against the declared
 *      `principal_pubkey`; a silent key swap is rejected by the route's
 *      rotation guard — `routes/principals.ts:118`).
 *
 * ## Key-shape bridge (load-bearing)
 *
 * The bus identity is a NATS NKey (`U…`/`SU…`, base32). The network-registry
 * proof-of-possession contract is WebCrypto Ed25519 over **base64 raw 32-byte
 * pubkey** + **base64 raw 64-byte signature** of `canonicalJSON(claim)`.
 * These are the same ed25519 primitive under two encodings:
 *
 *   - `nkey.getPublicKey()` → `U…` → `nkeyToBase64Pubkey` → base64 raw pubkey
 *     (the `claim.principal_pubkey` the registry stores + verifies against).
 *   - `nkey` raw 32-byte seed → ed25519 sign of the canonical claim bytes →
 *     base64 signature (the `signature` the registry verifies).
 *
 * Reproduced + pinned by a round-trip test against the registry route.
 *
 * ## Safety
 *
 *   - **Idempotent / refuse-to-clobber.** Rotating a stack identity is a
 *     security event (peers cache the old pubkey; a silent swap is rejected
 *     by the registry). `generateStackIdentity` REFUSES to overwrite an
 *     existing seed file unless `force: true` is passed. The caller (CLI)
 *     surfaces `--force` explicitly.
 *   - **Secrets never logged.** This module returns the seed bytes/string to
 *     its caller and writes them to disk; it NEVER writes the seed to a log
 *     sink. Callers log the pubkey/fingerprint only (see `fingerprint`).
 *   - **No live I/O here.** `buildRegistrationClaim` produces the signed body;
 *     it does NOT POST it. Posting against a live registry is an ops step,
 *     gated for the human — `registerStackIdentity` is the thin fetch wrapper
 *     a caller opts into explicitly.
 */

import { writeFileSync, existsSync, chmodSync } from "fs";
import { createUser, fromSeed, type KeyPair } from "nkeys.js";

import { canonicalJSON } from "../common/registry/signing";
import { nkeyToBase64Pubkey } from "./verify-signed-by-chain";

// =============================================================================
// Types
// =============================================================================

/**
 * A freshly generated (or loaded) stack signing identity. The seed material
 * is carried in-memory so the caller can write it AND derive the
 * registration signature from the same key — NEVER log `seed`.
 */
export interface StackIdentityMaterial {
  /** NATS NKey public key (`U…`, 56-char base32) for `stack.nkey_pub`. */
  readonly nkeyPub: string;
  /**
   * Base64 raw 32-byte ed25519 pubkey — the `principal_pubkey` the registry
   * stores and verifies the registration signature against. Equals
   * `nkeyToBase64Pubkey(nkeyPub)`.
   */
  readonly pubkeyB64: string;
  /**
   * The NKey seed string (`SU…`). SECRET — written to the seed file, never
   * logged. Present so the caller can sign the registration claim with the
   * SAME key (proof-of-possession) without a second on-disk read.
   */
  readonly seed: string;
  /**
   * Short, log-safe fingerprint of the public key (first 12 base64 chars of
   * `pubkeyB64`). Use this in log lines INSTEAD of any secret material.
   */
  readonly fingerprint: string;
}

/** A registration claim + detached signature, ready to POST to the registry. */
export interface SignedRegistrationBody {
  readonly claim: RegistrationClaimShape;
  /** Base64 ed25519 signature over `canonicalJSON(claim)`. */
  readonly signature: string;
}

/**
 * Mirror of the network-registry `RegistrationClaim` wire shape
 * (`src/services/network-registry/src/types.ts`). Reproduced rather than
 * imported because the registry is a separately-bundled CF Worker excluded
 * from the root tsconfig. MUST stay field-compatible — pinned by the
 * round-trip test against the live route.
 */
export interface RegistrationClaimShape {
  principal_id: string;
  principal_pubkey: string;
  stacks: {
    stack_id: string;
    /** C-787 — per-stack signing pubkey (base64 ed25519). */
    stack_pubkey?: string;
    display_name?: string;
    metadata?: Record<string, string>;
  }[];
  capabilities: { id: string; description?: string; networks?: string[] }[];
  issued_at: string;
  nonce: string;
}

// =============================================================================
// PKCS#8 bridge — NKey raw seed → WebCrypto Ed25519 signer
// =============================================================================

/**
 * RFC 8410 PKCS#8 prefix for an Ed25519 private key carrying a raw 32-byte
 * seed. WebCrypto's `importKey("pkcs8", …)` is the portable path (Workers /
 * Bun / Node) to sign with the same ed25519 key the NKey wraps. The 32 seed
 * bytes are appended after this fixed 16-byte header.
 */
const PKCS8_ED25519_PREFIX = Uint8Array.from([
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04,
  0x22, 0x04, 0x20,
]);

/**
 * Wrap a raw 32-byte ed25519 seed in PKCS#8 so WebCrypto can import it as an
 * Ed25519 signing key. The resulting signature is byte-identical (and
 * cross-verifiable) with the NKey's own `sign()` — confirmed by the bridge
 * test — so registry proof-of-possession and bus signing share one key.
 */
function rawSeedToPkcs8(rawSeed: Uint8Array): Uint8Array {
  if (rawSeed.length !== 32) {
    throw new Error(
      `stack-provisioning: expected 32-byte ed25519 seed, got ${rawSeed.length.toString()}`,
    );
  }
  const out = new Uint8Array(PKCS8_ED25519_PREFIX.length + 32);
  out.set(PKCS8_ED25519_PREFIX, 0);
  out.set(rawSeed, PKCS8_ED25519_PREFIX.length);
  return out;
}

/** Read the 32-byte raw ed25519 seed off an nkeys.js KeyPair. */
function rawSeedOf(kp: KeyPair): Uint8Array {
  return (kp as unknown as { getRawSeed(): Uint8Array }).getRawSeed();
}

/** Standard-base64 encode (NOT url-safe — matches the registry's alphabet). */
function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

/**
 * Sign `message` with the ed25519 key wrapped by `kp`, via WebCrypto. Returns
 * a base64 raw 64-byte signature — the shape the registry's `verifyEd25519`
 * consumes.
 */
async function signWithNKey(kp: KeyPair, message: Uint8Array): Promise<string> {
  const pkcs8 = rawSeedToPkcs8(rawSeedOf(kp));
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pkcs8 as BufferSource,
    { name: "Ed25519" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign({ name: "Ed25519" }, key, message as BufferSource);
  return bytesToBase64(new Uint8Array(sig));
}

// =============================================================================
// Identity generation + seed-file write
// =============================================================================

/** Derive the log-safe fingerprint (never the seed) from a base64 pubkey. */
export function fingerprintOf(pubkeyB64: string): string {
  return pubkeyB64.slice(0, 12);
}

/**
 * Build {@link StackIdentityMaterial} from an existing NKey KeyPair. Shared
 * by `generateStackIdentity` (fresh keypair) and `loadStackIdentityMaterial`
 * (re-derive from an on-disk seed for re-registration without rotation).
 *
 * @throws if the NKey pub cannot be decoded to a base64 ed25519 pubkey — a
 *   malformed keypair must fail loudly here, not silently produce a claim the
 *   registry would reject.
 */
function materialFromKeyPair(kp: KeyPair): StackIdentityMaterial {
  const nkeyPub = kp.getPublicKey();
  const pubkeyB64 = nkeyToBase64Pubkey(nkeyPub);
  if (pubkeyB64 === undefined) {
    throw new Error(
      `stack-provisioning: could not decode NKey public key ${nkeyPub.slice(0, 8)}… ` +
        `to a base64 ed25519 pubkey — keypair is malformed`,
    );
  }
  const seed = new TextDecoder().decode(kp.getSeed());
  return { nkeyPub, pubkeyB64, seed, fingerprint: fingerprintOf(pubkeyB64) };
}

export interface GenerateStackIdentityOptions {
  /**
   * Absolute (tilde already expanded) path the seed is written to. Should
   * match `cortex.yaml stack.nkey_seed_path`.
   */
  readonly seedPath: string;
  /**
   * Overwrite an existing seed file. Default `false` — rotating a stack
   * identity is a security event (peers cache the old key; the registry
   * rejects a silent swap), so the default REFUSES to clobber.
   */
  readonly force?: boolean;
  /**
   * Seam for tests — inject a fixed KeyPair instead of `createUser()`.
   * Production callers omit this.
   * @internal
   */
  readonly keyPair?: KeyPair;
}

/**
 * Generate a fresh stack signing identity and write its seed to `seedPath`
 * with mode `600`. Returns the public material (incl. the in-memory seed so
 * the caller can sign a registration claim with the same key).
 *
 * **Refuses to clobber** an existing seed unless `force: true` — see the
 * rotation rationale above. On `force`, the existing file is overwritten and
 * the OLD identity is silently superseded; the caller MUST treat this as a
 * rotation (re-register the new pubkey, update `stack.nkey_pub`).
 *
 * @throws if `seedPath` exists and `force` is not set.
 */
export function generateStackIdentity(
  opts: GenerateStackIdentityOptions,
): StackIdentityMaterial {
  const { seedPath, force = false } = opts;

  if (existsSync(seedPath) && !force) {
    throw new Error(
      `stack-provisioning: refusing to overwrite existing seed at ${seedPath} — ` +
        `rotating a stack identity is a security event (peers cache the old pubkey; ` +
        `the registry rejects a silent key swap). Pass force to rotate deliberately.`,
    );
  }

  const kp = opts.keyPair ?? createUser();
  const material = materialFromKeyPair(kp);

  // Write the seed, THEN chmod 600. We write with mode 0o600 up front so the
  // file is never momentarily group/world-readable, then assert via chmod for
  // platforms where the umask widened the create mode. The trailing newline
  // matches `nsc generate nkey` output; `loadStackSigningKey` trims it.
  //
  // Non-force create uses flag "wx" (O_EXCL|O_CREAT): the no-clobber guarantee
  // becomes KERNEL-enforced (closing the existsSync→write TOCTOU above) and a
  // symlink planted at `seedPath` is REFUSED rather than followed-and-written-
  // through. Force (deliberate rotation) overwrites in place ("w"); the chmod
  // re-assert below covers that path, where writeFileSync ignores `mode` on an
  // already-existing file.
  writeFileSync(seedPath, material.seed + "\n", {
    mode: 0o600,
    ...(force ? {} : { flag: "wx" }),
  });
  // Defensive: an inherited umask can clear bits from the create-mode on some
  // platforms, so re-assert 600 explicitly. No-op on POSIX where the create
  // mode already took; harmless on win32 (ACL-governed).
  if (process.platform !== "win32") {
    chmodSync(seedPath, 0o600);
  }

  return material;
}

/**
 * Re-derive {@link StackIdentityMaterial} from an existing on-disk seed,
 * WITHOUT rotating. Use this to (re-)register an already-provisioned stack's
 * pubkey — the common case after `arc upgrade` provisions a seed but the
 * registry entry is missing. Goes through `loadStackSigningKey`'s chmod-600
 * gate via `fromSeed` after the caller has validated the path.
 *
 * NOTE: this does NOT re-run `enforceChmod600` (the caller — typically the CLI
 * — does, sharing the `loadStackSigningKey` discipline). It only parses the
 * trimmed seed string into a KeyPair and derives the public material.
 *
 * @throws if the seed is not a valid `SU…` user-class NKey seed.
 */
export function materialFromSeedString(seed: string): StackIdentityMaterial {
  const trimmed = seed.trim();
  if (!trimmed.startsWith("SU")) {
    throw new Error(
      `stack-provisioning: expected a user-class NKey seed (SU…), got ${trimmed.slice(0, 2)}…`,
    );
  }
  let kp: KeyPair;
  try {
    kp = fromSeed(new TextEncoder().encode(trimmed));
  } catch (err) {
    throw new Error(
      `stack-provisioning: failed to parse seed: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }
  return materialFromKeyPair(kp);
}

// =============================================================================
// Registration claim (proof-of-possession)
// =============================================================================

export interface BuildRegistrationClaimOptions {
  /** The principal this stack belongs to (`{principal_id}`). */
  readonly principalId: string;
  /**
   * The stack identity material. Carries the stack's signing key.
   *
   * For a FIRST registration (no {@link rootMaterial}) this key is BOTH the
   * claim's `principal_pubkey` (root) AND the key that signs the claim —
   * proof-of-possession of the principal root, exactly as pre-C-787.
   *
   * For an ADD-STACK (with {@link rootMaterial}) this key is the NEW stack's
   * per-stack signing key — its base64 pubkey becomes the new stack's
   * `stack_pubkey`. It does NOT sign the claim; the root does.
   */
  readonly material: StackIdentityMaterial;
  /**
   * C-787 — the principal ROOT/authority material (the FIRST stack's seed),
   * present ONLY for an ADD-STACK against an already-registered principal.
   *
   * When supplied:
   *   - the claim's `principal_pubkey` is the ROOT pubkey (so the registry's
   *     rotation gate sees the same root already on record and admits it),
   *   - the claim is SIGNED by the root key (so signature verification against
   *     `principal_pubkey` succeeds — the add-stack authorization the registry
   *     requires), and
   *   - the joining stack in `stacks[]` carries `material`'s OWN pubkey as its
   *     `stack_pubkey` (the root ATTESTS that key by signing the claim).
   *
   * This is the impersonation defense at the client: only a holder of the
   * principal root seed can mint a claim the registry will accept for a new
   * stack. A holder of merely the new stack's key cannot (the registry rejects
   * a claim whose `principal_pubkey` ≠ the registered root).
   */
  readonly rootMaterial?: StackIdentityMaterial;
  /**
   * The stack ids to register. Each MUST be `{principalId}/{slug}` — the
   * registry rejects a prefix mismatch (forged-attribution guard).
   *
   * C-787 — a `stack_pubkey` may be set per stack. When omitted on the
   * add-stack path, the joining stack inherits `material.pubkeyB64`.
   */
  readonly stacks: { stack_id: string; display_name?: string; stack_pubkey?: string }[];
  /** Capabilities to advertise (optional). */
  readonly capabilities?: { id: string; description?: string; networks?: string[] }[];
  /**
   * Override the issued-at timestamp (tests / replay-window checks). Defaults
   * to `now`. The registry enforces a ±5-minute clock-skew window.
   * @internal
   */
  readonly issuedAt?: string;
  /**
   * Override the nonce (tests). Defaults to a fresh 16-byte random hex.
   * @internal
   */
  readonly nonce?: string;
}

/**
 * Build a signed registration body proving possession of the stack signing
 * key. The claim is signed with the SAME ed25519 key whose pubkey it
 * declares, so the registry's `verifyEd25519(claim.principal_pubkey, …)`
 * succeeds and a tampered claim (or a claim signed by a different key) is
 * rejected.
 *
 * Does NOT POST — returns the body for the caller to send (or print). Posting
 * against a live registry is a gated ops step.
 */
export async function buildRegistrationClaim(
  opts: BuildRegistrationClaimOptions,
): Promise<SignedRegistrationBody> {
  // C-787 — the AUTHORITY key is the root when adding a stack, else the stack's
  // own key (first-register / single-stack). The claim's `principal_pubkey` is
  // the authority pubkey, and the claim is SIGNED by the authority — so the
  // registry verifies the signature against `principal_pubkey` and admits the
  // claim only from a holder of that authority key.
  const authority = opts.rootMaterial ?? opts.material;

  // On the add-stack path, the joining stack carries its OWN pubkey (the stack
  // material's key) as `stack_pubkey` unless the caller set one explicitly. On
  // the first-register path with no per-stack key set, the stack inherits the
  // authority pubkey (the registry route also backfills this, but stamping it
  // here keeps the signed bytes explicit and the wire self-describing).
  const stacks = opts.stacks.map((s) => ({
    ...s,
    stack_pubkey: s.stack_pubkey ?? opts.material.pubkeyB64,
  }));

  const claim: RegistrationClaimShape = {
    principal_id: opts.principalId,
    principal_pubkey: authority.pubkeyB64,
    stacks,
    capabilities: opts.capabilities ?? [],
    issued_at: opts.issuedAt ?? new Date().toISOString(),
    nonce: opts.nonce ?? randomNonce(),
  };

  // Re-derive the AUTHORITY KeyPair from its in-memory seed to sign. We sign
  // over the SAME canonical-JSON the registry route reconstructs and verifies.
  const kp = fromSeed(new TextEncoder().encode(authority.seed.trim()));
  const message = new TextEncoder().encode(canonicalJSON(claim));
  const signature = await signWithNKey(kp, message);

  return { claim, signature };
}

// =============================================================================
// #747 — signed-admin network-create claim
// =============================================================================

/**
 * Mirror of the network-registry `NetworkCreateClaim` wire shape
 * (`src/services/network-registry/src/validate.ts`). Reproduced rather than
 * imported because the registry is a separately-bundled CF Worker excluded
 * from the root tsconfig. MUST stay field-compatible with the route validator.
 */
export interface NetworkCreateClaimShape {
  network_id: string;
  hub_url: string;
  leaf_port: number;
  admin_pubkey: string;
  issued_at: string;
  nonce: string;
}

/** A network-create claim + detached signature, ready to POST. */
export interface SignedNetworkCreateBody {
  readonly claim: NetworkCreateClaimShape;
  /** Base64 ed25519 signature over `canonicalJSON(claim)`. */
  readonly signature: string;
}

export interface BuildNetworkCreateClaimOptions {
  readonly networkId: string;
  readonly hubUrl: string;
  readonly leafPort: number;
  /** The admin identity material (carries the seed to sign with). */
  readonly material: StackIdentityMaterial;
  /** Override issued-at (tests / skew checks). Defaults to now. @internal */
  readonly issuedAt?: string;
  /** Override nonce (tests). Defaults to a fresh random hex. @internal */
  readonly nonce?: string;
}

/**
 * Build a signed network-create body (#747) proving possession of an admin
 * Ed25519 key. Reuses the EXACT key + signing path as
 * {@link buildRegistrationClaim} — the admin key is an nkey seed (`SU…`) and
 * `admin_pubkey` is its base64 form (`material.pubkeyB64`), so the registry's
 * `verifyEd25519(claim.admin_pubkey, …)` succeeds and a tampered/forged claim
 * is rejected. Does NOT POST — returns the body for the caller to send/print.
 */
export async function buildNetworkCreateClaim(
  opts: BuildNetworkCreateClaimOptions,
): Promise<SignedNetworkCreateBody> {
  const claim: NetworkCreateClaimShape = {
    network_id: opts.networkId,
    hub_url: opts.hubUrl,
    leaf_port: opts.leafPort,
    admin_pubkey: opts.material.pubkeyB64,
    issued_at: opts.issuedAt ?? new Date().toISOString(),
    nonce: opts.nonce ?? randomNonce(),
  };
  // Re-derive the KeyPair from the in-memory seed and sign over the SAME
  // canonical-JSON the registry route reconstructs and verifies.
  const kp = fromSeed(new TextEncoder().encode(opts.material.seed.trim()));
  const message = new TextEncoder().encode(canonicalJSON(claim));
  const signature = await signWithNKey(kp, message);
  return { claim, signature };
}

/** Fresh 16-byte random nonce, lowercase hex — matches the registry's window. */
export function randomNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

// =============================================================================
// Optional live registration (gated — caller opts in)
// =============================================================================

export interface RegisterStackIdentityOptions {
  /** Registry base URL (no trailing slash needed). */
  readonly registryUrl: string;
  /** The principal id (becomes the `:principal_id` path segment). */
  readonly principalId: string;
  /** The signed body from {@link buildRegistrationClaim}. */
  readonly body: SignedRegistrationBody;
  /** Injected fetch (tests). Defaults to global fetch. @internal */
  readonly fetchImpl?: typeof globalThis.fetch;
  /** Request timeout (ms). Default 10s. */
  readonly timeoutMs?: number;
}

export interface RegisterStackIdentityResult {
  readonly ok: boolean;
  readonly status: number;
  /** Parsed JSON response body (registry assertion on success; error on fail). */
  readonly response: unknown;
}

/**
 * POST the signed registration to `POST /principals/{principalId}/register`.
 *
 * This is the ONLY function in this module that performs network I/O, and it
 * is NEVER called at boot or from the generate path — a caller (CLI with an
 * explicit `--register` flag, or an ops script) opts into it deliberately, so
 * provisioning never silently mutates a live registry as a side effect of
 * key generation.
 */
export async function registerStackIdentity(
  opts: RegisterStackIdentityOptions,
): Promise<RegisterStackIdentityResult> {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const url = `${opts.registryUrl.replace(/\/+$/, "")}/principals/${encodeURIComponent(opts.principalId)}/register`;
  return postSigned(fetchImpl, url, opts.body, opts.timeoutMs);
}

export interface PostNetworkCreateOptions {
  /** Registry base URL (no trailing slash needed). */
  readonly registryUrl: string;
  /** The network id (becomes the `:network_id` path segment). */
  readonly networkId: string;
  /** The signed body from {@link buildNetworkCreateClaim}. */
  readonly body: SignedNetworkCreateBody;
  /** Injected fetch (tests). Defaults to global fetch. @internal */
  readonly fetchImpl?: typeof globalThis.fetch;
  /** Request timeout (ms). Default 10s. */
  readonly timeoutMs?: number;
}

/**
 * POST the signed-admin network-create body to `POST /networks/{networkId}`
 * (#747). Like {@link registerStackIdentity}, this is opt-in network I/O —
 * never called as a side effect of building the claim. Returns the same
 * `{ ok, status, response }` triple so a caller can surface the registry's
 * error JSON verbatim (admin_not_configured / admin_not_authorized / etc.).
 */
export async function postNetworkCreate(
  opts: PostNetworkCreateOptions,
): Promise<RegisterStackIdentityResult> {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const url = `${opts.registryUrl.replace(/\/+$/, "")}/networks/${encodeURIComponent(opts.networkId)}`;
  return postSigned(fetchImpl, url, opts.body, opts.timeoutMs);
}

// =============================================================================
// C-787 — fetch existing stacks (read side of the add-stack fetch+merge)
// =============================================================================

/** One element of a principal's registered `stacks[]`. */
export interface StackEntryShape {
  readonly stack_id: string;
  /** Per-stack signing pubkey (base64 ed25519). Always present post-C-787. */
  readonly stack_pubkey?: string;
  readonly display_name?: string;
  readonly metadata?: Record<string, string>;
}

export interface FetchExistingStacksOptions {
  /** Registry base URL (no trailing slash needed). */
  readonly registryUrl: string;
  /** The principal id (the `:principal_id` path segment). */
  readonly principalId: string;
  /** Injected fetch (tests). Defaults to global fetch. @internal */
  readonly fetchImpl?: typeof globalThis.fetch;
  /** Request timeout (ms). Default 10s. */
  readonly timeoutMs?: number;
}

/**
 * Outcome of {@link fetchExistingStacks}. Discriminated so the add-stack
 * caller can branch CORRECTLY rather than guess:
 *   - `present`  — the principal exists; `stacks` is its current registered set
 *                  (each entry carries its `stack_pubkey`). The caller MERGES
 *                  the new stack in and re-attests the COMPLETE set.
 *   - `absent`   — the registry returned 404 (first registration). The caller
 *                  proceeds with just the new stack, as pre-C-787.
 *   - `error`    — the registry was unreachable / returned a non-200/404 / a
 *                  malformed body. The caller MUST abort with a clear error
 *                  rather than send a partial set that would DROP existing
 *                  stacks (the data-loss the C-787 review flagged on #790).
 */
export type FetchExistingStacksResult =
  | { kind: "present"; stacks: StackEntryShape[] }
  | { kind: "absent" }
  | { kind: "error"; reason: string };

/**
 * C-787 — `GET /principals/{principalId}` and extract the registered
 * `stacks[]`. The READ half of the add-stack fetch+merge: the register route
 * does a FULL-OVERWRITE upsert of the `stacks` column, so an add-stack claim
 * MUST carry the complete intended set or it silently drops every stack it
 * omits. This read lets the caller rebuild that complete set (existing +
 * new) and have the root re-attest it.
 *
 * Distinguishes 404 (`absent` → first registration) from every other failure
 * (`error`) so the caller never sends a partial set on a transient outage.
 * The GET payload is a `SignedAssertion<PrincipalRecord>`; we read
 * `payload.stacks` WITHOUT verifying the registry signature here — this is a
 * convenience read to AVOID DATA LOSS, not a trust decision: the stacks we
 * merge are re-attested by the principal ROOT signature on the register POST,
 * and the registry re-verifies that. (A tampered GET could at worst cause the
 * root to re-attest a stack it did not intend; the principal running the root
 * reviews the merged set, and federated VERIFY still resolves per-stack keys from the
 * registry-signed record. Signature-verifying this read is a possible
 * hardening follow-up, not required to close the data-loss blocker.)
 */
export async function fetchExistingStacks(
  opts: FetchExistingStacksOptions,
): Promise<FetchExistingStacksResult> {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const url = `${opts.registryUrl.replace(/\/+$/, "")}/principals/${encodeURIComponent(opts.principalId)}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort();
  }, opts.timeoutMs ?? 10_000);
  let res: Response;
  try {
    res = await fetchImpl(url, { method: "GET", signal: controller.signal });
  } catch (err) {
    return {
      kind: "error",
      reason: `GET ${url} failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  } finally {
    clearTimeout(timeout);
  }

  if (res.status === 404) return { kind: "absent" };
  if (!res.ok) {
    return { kind: "error", reason: `GET ${url} returned HTTP ${res.status.toString()}` };
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch (err) {
    return {
      kind: "error",
      reason: `GET ${url} returned non-JSON body: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  // Shape: SignedAssertion<PrincipalRecord> → body.payload.stacks[].
  const payload = (body as { payload?: unknown } | null)?.payload;
  const stacksRaw = (payload as { stacks?: unknown } | null | undefined)?.stacks;
  if (!Array.isArray(stacksRaw)) {
    return {
      kind: "error",
      reason: `GET ${url} payload had no stacks[] array (malformed registry response)`,
    };
  }
  // Narrow each entry defensively — only keep well-formed stack records.
  const stacks: StackEntryShape[] = [];
  for (const s of stacksRaw) {
    if (typeof s === "object" && s !== null && typeof (s as { stack_id?: unknown }).stack_id === "string") {
      stacks.push(s as StackEntryShape);
    }
  }
  return { kind: "present", stacks };
}

/** Shared POST-JSON-with-timeout used by both register + network-create. */
async function postSigned(
  fetchImpl: typeof globalThis.fetch,
  url: string,
  body: unknown,
  timeoutMs?: number,
): Promise<RegisterStackIdentityResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort();
  }, timeoutMs ?? 10_000);
  try {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    let response: unknown;
    try {
      response = await res.json();
    } catch (err) {
      // Non-JSON body (e.g. a proxy error page). Surface the parse failure
      // as the response rather than throwing — the caller decides.
      response = {
        error: "non_json_response",
        detail: err instanceof Error ? err.message : String(err),
      };
    }
    return { ok: res.ok, status: res.status, response };
  } finally {
    clearTimeout(timeout);
  }
}
