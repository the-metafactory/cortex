/**
 * ADR-0018 PR5b (#1240) — the SEALED secret envelope (the M3 seam).
 *
 * The hub-admin seals a small JSON envelope (not a bare PSK) to the member's
 * pubkey, so the SAME sealed-delivery slot can carry MORE THAN the leaf PSK
 * without a wire/schema change. PR5b populates `leaf_psk` + `leaf_user`. The
 * per-network M3 payload key (#1246, ADR-0019) rides the SAME envelope later as
 * `payload_key` — `cortex network secret add-member` seals both, `rotate` /
 * `revoke-member` cover both, and the member-side decode already tolerates the
 * extra field. That is the "one extra sealed blob via the same path" seam the
 * issue asks PR5b to leave clean.
 *
 * The registry never sees this — it only carries the OPAQUE `crypto_box_seal`
 * ciphertext of the JSON below.
 */

/** Envelope schema version. Bumped only on a breaking shape change. */
export const LEAF_SECRET_ENVELOPE_VERSION = 1;

/**
 * v2 (#1596, epic #1595) — the credential-file payload. Where v1 carries a
 * shared-string `leaf_psk` (Model-B / conf-mode hub), v2 carries the verbatim
 * text of a per-member NSC user `.creds` file, so an operator-mode hub can seal
 * a real transport credential through the SAME sealed-delivery channel (the
 * #1526 design's core move). This is a DISCRIMINATED version, NOT a
 * "leaf_psk XOR creds" relaxation of v1 — a version-blind either-field decoder
 * would let a hostile courier silently downgrade the payload type (design §5.2,
 * red-team R9/R12), so the payload variant is pinned by `v`.
 */
export const LEAF_SECRET_ENVELOPE_VERSION_V2 = 2;

/**
 * The plaintext sealed to a member's pubkey. JSON, UTF-8, then
 * {@link sealToPrincipal}. Keep it small + flat — `crypto_box_seal` has no size
 * problem here, but the registry bounds the ciphertext (validate.isValidSealedSecret).
 */
export interface LeafSecretEnvelope {
  /** Envelope version (currently {@link LEAF_SECRET_ENVELOPE_VERSION}). */
  v: number;
  /** The per-member leaf PSK (base64url). The transport secret (ADR-0018 Q2). */
  leaf_psk: string;
  /**
   * The userinfo USER paired with `leaf_psk` — matches the hub's
   * `authorization { user, password }` entry. Defaults to the member's
   * principal id at mint time.
   */
  leaf_user: string;
  /**
   * M3 SEAM (#1246 / ADR-0019) — the per-network payload key `K`, sealed
   * alongside the leaf PSK. Populated by `cortex network secret add-member` /
   * `rotate` when the hub stack config carries a `payload_key` for the network
   * (C-1349 Slice 1). OPTIONAL + absent on encryption-off networks and on
   * pre-C-1349 blobs. Decoders MUST tolerate its presence AND its absence.
   */
  payload_key?: string;
  /**
   * C-1349 Slice 1 — the key id (rotation epoch) of {@link payload_key}, the
   * `<network>/k<n>` the runtime stamps into `extensions.enc.kid`
   * (`payload_key_id` in stack config, default `<network>/k1`). Rides beside
   * `payload_key` so the joiner installs BOTH; decoders MUST tolerate its
   * absence (old blobs, and a `payload_key` sealed before this field existed).
   */
  payload_key_kid?: string;
}

/**
 * v2 plaintext (#1596) — carries a per-member NSC user `.creds` file text
 * instead of a shared PSK. Sealed to the member's pubkey exactly like v1; the
 * registry still only ever holds the opaque ciphertext.
 */
export interface LeafSecretEnvelopeV2 {
  /** Always {@link LEAF_SECRET_ENVELOPE_VERSION_V2}. The payload-variant discriminant. */
  v: 2;
  /**
   * The verbatim `.creds` file text (user JWT + user nkey seed) the member
   * writes to disk and points its leaf remote at. The transport credential.
   */
  creds: string;
  /**
   * The subject this credential was minted FOR — the member's
   * `{principal}/{stack}` (or the leaf username). Carrying it here is what lets
   * the member install (#1597) refuse a credential minted for a DIFFERENT
   * subject (red-team R7: a courier sealing another member's real creds to this
   * member). NOTE: this module only validates the field is present — the
   * identity-binding CHECK itself lands in #1597, not here.
   */
  leaf_user: string;
  /**
   * ISO-8601 mint timestamp, set at seal time. Exists so the member install
   * (#1597) can reject a re-fetched, long-superseded credential. NOTE: this
   * module validates it is a PARSEABLE date; the staleness COMPARISON is #1597.
   */
  minted_at: string;
  /** M3 payload key `K` (ADR-0019) — rides v2 unchanged (see v1's `payload_key`). */
  payload_key?: string;
  /** Key id / rotation epoch of {@link payload_key} — rides v2 unchanged. */
  payload_key_kid?: string;
}

/** Either envelope shape, discriminated by `v`. */
export type AnyLeafSecretEnvelope = LeafSecretEnvelope | LeafSecretEnvelopeV2;

/** Narrow an {@link AnyLeafSecretEnvelope} to the v2 (creds) variant. */
export function isLeafSecretEnvelopeV2(
  env: AnyLeafSecretEnvelope,
): env is LeafSecretEnvelopeV2 {
  return env.v === LEAF_SECRET_ENVELOPE_VERSION_V2;
}

/** Encode a {@link LeafSecretEnvelope} to the UTF-8 JSON that gets sealed. */
export function encodeLeafSecretEnvelope(
  fields: Omit<LeafSecretEnvelope, "v"> & { v?: number },
): string {
  const env: LeafSecretEnvelope = {
    v: fields.v ?? LEAF_SECRET_ENVELOPE_VERSION,
    leaf_psk: fields.leaf_psk,
    leaf_user: fields.leaf_user,
    ...(fields.payload_key !== undefined && { payload_key: fields.payload_key }),
    ...(fields.payload_key_kid !== undefined && { payload_key_kid: fields.payload_key_kid }),
  };
  return JSON.stringify(env);
}

/**
 * Encode a {@link LeafSecretEnvelopeV2} (creds payload) to the UTF-8 JSON that
 * gets sealed. `v` is fixed at {@link LEAF_SECRET_ENVELOPE_VERSION_V2}.
 */
export function encodeLeafSecretEnvelopeV2(
  fields: Omit<LeafSecretEnvelopeV2, "v">,
): string {
  // Fail fast at the PRODUCER: never mint a blob our own decoder rejects.
  if (fields.creds.length === 0) {
    throw new Error("sealed-leaf-secret: cannot encode a v2 envelope with empty creds");
  }
  if (fields.leaf_user.length === 0) {
    throw new Error("sealed-leaf-secret: cannot encode a v2 envelope with empty leaf_user");
  }
  if (fields.minted_at.length === 0 || Number.isNaN(Date.parse(fields.minted_at))) {
    throw new Error("sealed-leaf-secret: cannot encode a v2 envelope with a non-ISO-8601 minted_at");
  }
  const env: LeafSecretEnvelopeV2 = {
    v: LEAF_SECRET_ENVELOPE_VERSION_V2,
    creds: fields.creds,
    leaf_user: fields.leaf_user,
    minted_at: fields.minted_at,
    ...(fields.payload_key !== undefined && { payload_key: fields.payload_key }),
    ...(fields.payload_key_kid !== undefined && { payload_key_kid: fields.payload_key_kid }),
  };
  return JSON.stringify(env);
}

/** Thrown when a decoder meets an envelope version it does not understand. */
export class UnsupportedEnvelopeVersionError extends Error {
  constructor(readonly version: number) {
    super(
      `sealed-leaf-secret: envelope version ${String(version)} is newer than this cortex understands — ` +
        `upgrade cortex on this stack to open it. (This is NOT a corrupt or mis-sealed blob.)`,
    );
    this.name = "UnsupportedEnvelopeVersionError";
  }
}

/**
 * Validate + extract the optional ADR-0019 payload-key rider (`payload_key` +
 * `payload_key_kid`) shared by both the v1 and v2 decoders. Fails closed on a
 * wrong-typed field; returns only the fields that are present. One site for a
 * future K change instead of four.
 */
function readPayloadKeyFields(
  p: Record<string, unknown>,
): { payload_key?: string; payload_key_kid?: string } {
  if (p.payload_key !== undefined && typeof p.payload_key !== "string") {
    throw new Error("sealed-leaf-secret: payload_key must be a string when present");
  }
  if (p.payload_key_kid !== undefined && typeof p.payload_key_kid !== "string") {
    throw new Error("sealed-leaf-secret: payload_key_kid must be a string when present");
  }
  return {
    ...(typeof p.payload_key === "string" && { payload_key: p.payload_key }),
    ...(typeof p.payload_key_kid === "string" && { payload_key_kid: p.payload_key_kid }),
  };
}

/** Parse the sealed plaintext to a JSON object, failing closed (never echoes it). */
function parseEnvelopeObject(plaintext: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(plaintext);
  } catch (err) {
    throw new Error("sealed-leaf-secret: unsealed payload is not valid JSON", { cause: err });
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("sealed-leaf-secret: unsealed payload must be a JSON object");
  }
  const obj = parsed as Record<string, unknown>;
  // `v`, when present, MUST be a number — else the numeric version guards below
  // (and the upgrade-vs-v1 routing) silently mis-route a `v: "2"` string blob to
  // the v1 "missing leaf_psk" path. Reject it here so every decoder is covered.
  if ("v" in obj && typeof obj.v !== "number") {
    throw new Error("sealed-leaf-secret: envelope version `v` must be a number when present");
  }
  return obj;
}

/**
 * Decode + validate the UNSEALED plaintext into a v1 {@link LeafSecretEnvelope}.
 * Fails closed on a malformed envelope (the member would otherwise render a leaf
 * with a junk secret). Tolerates the `payload_key` field.
 *
 * #1596 — a KNOWN-newer version (`v > 1`) is rejected with a distinct
 * {@link UnsupportedEnvelopeVersionError} that names the real remedy (upgrade
 * cortex), NOT the previous misleading "missing leaf_psk" → "corrupted / wrong
 * pubkey" path. v1-only callers should keep using this; new callers that speak
 * v2 use {@link decodeAnyLeafSecretEnvelope}. The error NEVER echoes the plaintext.
 */
export function decodeLeafSecretEnvelope(plaintext: string): LeafSecretEnvelope {
  const p = parseEnvelopeObject(plaintext);
  if (typeof p.v === "number" && p.v > LEAF_SECRET_ENVELOPE_VERSION) {
    throw new UnsupportedEnvelopeVersionError(p.v);
  }
  if (typeof p.leaf_psk !== "string" || p.leaf_psk.length === 0) {
    throw new Error("sealed-leaf-secret: unsealed payload missing leaf_psk");
  }
  if (typeof p.leaf_user !== "string" || p.leaf_user.length === 0) {
    throw new Error("sealed-leaf-secret: unsealed payload missing leaf_user");
  }
  return {
    v: typeof p.v === "number" ? p.v : LEAF_SECRET_ENVELOPE_VERSION,
    leaf_psk: p.leaf_psk,
    leaf_user: p.leaf_user,
    ...readPayloadKeyFields(p),
  };
}

/** Decode + validate a v2 {@link LeafSecretEnvelopeV2} (creds payload). Fails closed. */
function decodeLeafSecretEnvelopeV2(p: Record<string, unknown>): LeafSecretEnvelopeV2 {
  if (typeof p.creds !== "string" || p.creds.length === 0) {
    throw new Error("sealed-leaf-secret: v2 payload missing creds");
  }
  if (typeof p.leaf_user !== "string" || p.leaf_user.length === 0) {
    throw new Error("sealed-leaf-secret: v2 payload missing leaf_user");
  }
  if (typeof p.minted_at !== "string" || p.minted_at.length === 0) {
    throw new Error("sealed-leaf-secret: v2 payload missing minted_at");
  }
  if (Number.isNaN(Date.parse(p.minted_at))) {
    throw new Error("sealed-leaf-secret: v2 payload minted_at must be a parseable ISO-8601 date");
  }
  return {
    v: LEAF_SECRET_ENVELOPE_VERSION_V2,
    creds: p.creds,
    leaf_user: p.leaf_user,
    minted_at: p.minted_at,
    ...readPayloadKeyFields(p),
  };
}

/**
 * Version-aware decode of the UNSEALED plaintext into whichever envelope shape
 * `v` selects. This is the decoder new (v2-speaking) consumers use — the member
 * install path (#1597) branches on {@link isLeafSecretEnvelopeV2}.
 *
 * - `v` absent or `1` → v1 {@link LeafSecretEnvelope} (creds path never taken).
 * - `v === 2`         → v2 {@link LeafSecretEnvelopeV2} (creds payload).
 * - `v > 2`           → {@link UnsupportedEnvelopeVersionError} (upgrade cortex).
 *
 * Fails closed on any malformed shape; the error NEVER echoes the plaintext.
 */
export function decodeAnyLeafSecretEnvelope(plaintext: string): AnyLeafSecretEnvelope {
  const p = parseEnvelopeObject(plaintext);
  if (p.v === LEAF_SECRET_ENVELOPE_VERSION_V2) {
    return decodeLeafSecretEnvelopeV2(p);
  }
  if (typeof p.v === "number" && p.v > LEAF_SECRET_ENVELOPE_VERSION_V2) {
    throw new UnsupportedEnvelopeVersionError(p.v);
  }
  // v absent, v===1, or any v <= 1: the v1 decoder (which also guards v>1).
  return decodeLeafSecretEnvelope(plaintext);
}
