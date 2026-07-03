/**
 * cortex#1482 (epic #1479, join-3) — shared pubkey-normalize util.
 *
 * Three surfaces across the federation join path accept a pubkey in TWO
 * legitimate encodings — the NATS NKey base32 form (`A…`/`U…`, 56 chars) and
 * the registry's base64 raw-ed25519 form (44 chars) — and today each surface
 * only accepts ONE of the two, so pasting the "wrong" (but equally valid)
 * encoding fails with a grammar error instead of just working. This module is
 * the single place that:
 *
 *   - DETECTS which encoding (and, for an nkey, which ROLE — account or
 *     user) a string is in ({@link detectPubkey});
 *   - CONVERTS between the two encodings ({@link toBase64Pubkey},
 *     {@link toNkeyPubkey});
 *   - compares two pubkeys for identity REGARDLESS of encoding/role
 *     ({@link samePubkey}).
 *
 * Crypto is NOT hand-rolled: nkey decode/encode goes through the SAME
 * `@nats-io/nkeys` `Codec` the bus-side verifier and the DD-8 registry bridge
 * (`registry/encoding.ts`) already trust. This module adds the role
 * DETECTION + role-aware conversion `encoding.ts` doesn't need — DD-8 is
 * hardcoded to the User role because config/peers pubkeys there are always
 * User; this module also covers the Account role for the FED-account surface
 * (ADR-0018's "seal-target ≠ leaf-account": the registered/PoP identity
 * pubkey is a User-role nkey, the hub's federation account is an
 * Account-role nkey — two DIFFERENT keys, not two encodings of one key).
 *
 * Scope: account + user nkeys only (`A…`/`U…`) — the two roles that appear at
 * cortex's pubkey boundaries today. The other NKey roles (operator NKeys,
 * cluster, server, curve) are out of scope.
 */

import { Prefix } from "@nats-io/nkeys";
// Deep import of the internal `Codec` (base32 + CRC16 + prefix-byte codec):
// the package's PUBLIC API (`@nats-io/nkeys` mod) exposes keypair factories
// (`createUser`, `fromPublic`, …) but NOT a raw pubkey→bytes decode / bytes→
// pubkey encode, which this module needs for role-aware conversion + raw-byte
// equality. This is a CONSCIOUS choice, not an accident, and it matches the
// established repo pattern — `registry/encoding.ts` (the DD-8 bridge) and
// `nats/leaf-remote-renderer.ts` already import `Codec` from the same subpath.
// If a future @nats-io/nkeys promotes a public decode/encode, migrate all
// three call sites together.
import { Codec } from "@nats-io/nkeys/lib/codec";

/**
 * The two NKey roles this module resolves. Mirrors the two things
 * cortex#1482's Pair 1 reconciles: `user` = the registered/PoP identity
 * pubkey (the admission-row seal target); `account` = a FED account nkey
 * (the leaf bind target). The two are DIFFERENT keys, not two encodings of
 * one key — {@link toNkeyPubkey} refuses to silently re-role one into the
 * other.
 */
export type PubkeyRole = "account" | "user";

const ROLE_PREFIX: Record<PubkeyRole, Prefix> = {
  account: Prefix.Account,
  user: Prefix.User,
};

/** The single letter each role's nkey encoding starts with. */
const ROLE_LETTER: Record<PubkeyRole, string> = { account: "A", user: "U" };

/** Per-role grammar-only shape regex, hoisted to module scope so
 *  {@link looksLikeNkeyRole} never recompiles it per call. */
const ROLE_NKEY_SHAPE: Record<PubkeyRole, RegExp> = {
  account: /^A[A-Z2-7]{55}$/,
  user: /^U[A-Z2-7]{55}$/,
};

/**
 * Union NKey-public GRAMMAR for the two roles this module covers: a single
 * role letter + 55 base32-alphabet chars = 56 total. Mirrors the existing
 * per-role regexes (`NKEY_PUBKEY_REGEX` in `common/types/nkey.ts` for `U…`,
 * the module-private `NKEY_ACCOUNT` in `leaf-remote-renderer.ts` for `A…`) —
 * this is only the shape gate; {@link decodeNkeyPublic} checksum-verifies on
 * top of it via `Codec.decode`.
 */
const NKEY_SHAPE = /^[AU][A-Z2-7]{55}$/;

/** Base64 Ed25519 grammar — SAME shape `registry/encoding.ts` validates
 *  against (43 standard-alphabet chars + one `=` of padding). */
const BASE64_ED25519 = /^[A-Za-z0-9+/]{43}=$/;

/** The result of {@link detectPubkey}. */
export interface DetectedPubkey {
  encoding: "nkey" | "base64";
  /** Only set for `encoding: "nkey"` — base64 carries no role annotation. */
  role?: PubkeyRole;
  /** The decoded 32 raw ed25519 bytes. */
  raw: Uint8Array;
}

/**
 * Checksum-verified nkey decode: `trimmed` must match {@link NKEY_SHAPE} AND
 * decode through `Codec.decode` (crockford-base32 + CRC16 + prefix-byte,
 * matching the ROLE the leading letter declares). Returns `undefined` for
 * anything that isn't a genuinely valid nkey of one of the two covered
 * roles — a shape-only match with a bad checksum is NOT a valid key.
 */
function decodeNkeyPublic(trimmed: string): DetectedPubkey | undefined {
  if (!NKEY_SHAPE.test(trimmed)) return undefined;
  const role: PubkeyRole = trimmed.startsWith(ROLE_LETTER.account) ? "account" : "user";
  try {
    const raw = Codec.decode(ROLE_PREFIX[role], new TextEncoder().encode(trimmed));
    return { encoding: "nkey", role, raw };
  } catch {
    // Shape-matched but failed the CRC16 checksum — not a valid nkey. Fall
    // through to "not recognized" rather than throwing; a poison/malformed
    // value must fail loudly at the CALLER's boundary, not crash here.
    return undefined;
  }
}

/** Decode a standard-base64 raw ed25519 pubkey (44 chars w/ padding) to its
 *  32 raw bytes. `undefined` when `trimmed` isn't valid base64 shaped for a
 *  32-byte payload. */
function decodeBase64Public(trimmed: string): DetectedPubkey | undefined {
  if (!BASE64_ED25519.test(trimmed)) return undefined;
  let bin: string;
  try {
    bin = atob(trimmed);
  } catch {
    // The regex above should have caught any non-base64-alphabet input —
    // defensive only.
    return undefined;
  }
  if (bin.length !== 32) return undefined;
  const raw = new Uint8Array(32);
  for (let i = 0; i < 32; i++) raw[i] = bin.charCodeAt(i);
  return { encoding: "base64", raw };
}

/**
 * Detect which of the two accepted encodings (and, for an nkey, which role)
 * `value` is in. Returns `undefined` when `value` matches NEITHER grammar —
 * the caller's "not a recognizable pubkey at all" case. Never throws.
 */
export function detectPubkey(value: string): DetectedPubkey | undefined {
  const trimmed = value.trim();
  return decodeNkeyPublic(trimmed) ?? decodeBase64Public(trimmed);
}

/**
 * Normalize ANY accepted representation (nkey-account, nkey-user, or base64)
 * to base64 — the registry / admission-row / seal-target surface. Base64 has
 * no role annotation, so an nkey of EITHER role converts freely. Round-trips
 * an already-base64 input byte-for-byte (canonical padding). `undefined`
 * when `value` isn't a recognizable pubkey in either encoding.
 */
export function toBase64Pubkey(value: string): string | undefined {
  const detected = detectPubkey(value);
  if (detected === undefined) return undefined;
  return Buffer.from(detected.raw).toString("base64");
}

/**
 * Normalize `value` to the nkey form for `role`. Two cases:
 *
 *   - `value` is ALREADY nkey-shaped for `role` (`A…`/`U…`, 56 chars) —
 *     passed through VERBATIM. Grammar-only (checksum not re-derived): this
 *     mirrors the legacy per-role shape gates (`isNkeyAccountPubkey`, the
 *     account role; `NKEY_PUBKEY_REGEX`, the user role) this module
 *     supersedes, so a caller that already has the value in the right form
 *     gets it back byte-identical — some callers embed it verbatim into a
 *     printed config snippet a human later pastes, and round-tripping it
 *     through decode+re-encode would be needless extra risk for no benefit.
 *   - Otherwise, `value` is decoded (base64, or an nkey of a DIFFERENT
 *     role — checksum-verified) and RE-ENCODED with the requested role. An
 *     nkey of a role OTHER than `role` is REFUSED (`undefined`) — role is a
 *     semantic fact about a key (which keypair it is), not a free encoding
 *     choice, and silently re-badging a user key as an account key (or vice
 *     versa) would hide exactly the seal-target ≠ leaf-account confusion
 *     ADR-0018 warns about. A caller that wants to explain WHY a value was
 *     refused should call {@link detectPubkey} or {@link looksLikeNkeyRole}
 *     on the same input directly.
 */
export function toNkeyPubkey(value: string, role: PubkeyRole): string | undefined {
  const trimmed = value.trim();
  if (looksLikeNkeyRole(trimmed, role)) return trimmed;

  const detected = detectPubkey(trimmed);
  if (detected === undefined || detected.encoding === "nkey") {
    // Either not recognizable at all, or an nkey of the OTHER role — refuse
    // rather than re-role it.
    return undefined;
  }
  try {
    const encoded = Codec.encode(ROLE_PREFIX[role], detected.raw);
    return new TextDecoder().decode(encoded);
  } catch {
    return undefined;
  }
}

/**
 * Representation-agnostic equality: true iff `a` and `b` decode (any
 * accepted encoding, either role) to the IDENTICAL 32 raw ed25519 bytes.
 * Deliberately role-blind (an nkey's role prefix is a label on top of the
 * key material, not part of it) — this answers "is this literally the same
 * key", a different question from {@link toNkeyPubkey}'s role-aware
 * refusal. `false` (never throws) when either side isn't a recognizable
 * pubkey.
 */
export function samePubkey(a: string, b: string): boolean {
  const da = detectPubkey(a);
  const db = detectPubkey(b);
  if (da === undefined || db === undefined) return false;
  if (da.raw.length !== db.raw.length) return false;
  for (let i = 0; i < da.raw.length; i++) {
    if (da.raw[i] !== db.raw[i]) return false;
  }
  return true;
}

/**
 * Grammar-only (NO checksum) shape gate: does `value` look like an nkey of
 * `role` — right leading letter + length? For HINTS/explanations where
 * cryptographic certainty isn't the point (e.g. "this looks like a FED
 * account nkey, did you mean to pass the registered pubkey instead" — ADR-
 * 0018) — a typo'd checksum shouldn't suppress the hint that would otherwise
 * help the user spot their mistake. For a certainty-required check (actually
 * USING the decoded bytes), use {@link detectPubkey} instead.
 */
export function looksLikeNkeyRole(value: string, role: PubkeyRole): boolean {
  return ROLE_NKEY_SHAPE[role].test(value.trim());
}
