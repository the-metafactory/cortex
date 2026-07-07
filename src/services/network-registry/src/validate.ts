/**
 * IAW D.4 — Request validation for the registry service.
 *
 * Centralised because every route needs to reject malformed input before
 * touching the store or the crypto layer. We deliberately do NOT pull in
 * Zod here: this Worker is excluded from the root `tsconfig.json` along
 * with the other CF Workers, and shipping Zod with the Worker bundle
 * adds ~50KB to the cold-start binary without buying us anything the
 * hand-rolled validators here don't already enforce. The shapes are
 * narrow (5 fields on `RegistrationClaim`) so the maintenance cost is
 * a few dozen lines.
 *
 * Grammar choices mirror `src/common/types/cortex-config.ts` so that
 * a value rejected here would also be rejected by the cortex-side
 * `PolicyFederatedNetworkSchema` once PR #223 lands — register-then-
 * load loops can't smuggle in a value that the consumer would reject.
 */

import type {
  AdmissionDecisionClaim,
  AdmissionDepartClaim,
  AdmissionReadClaim,
  AdmissionRevokeClaim,
  Capability,
  HubAuthorizeClaim,
  RegistrationClaim,
  SealedSecretWriteClaim,
  SignedAdmissionDecision,
  SignedAdmissionMineRead,
  SignedAdmissionDepart,
  SignedAdmissionRead,
  SignedAdmissionRevoke,
  SignedHubAuthorize,
  SignedNetworkRosterMemberRead,
  SignedRegistration,
  SignedSealedSecretWrite,
  SignedStackRetire,
  StackIdentity,
  StackRetireClaim,
} from "./types";

// =============================================================================
// Grammar regexes
// =============================================================================

/** Same shape as `PrincipalConfigSchema.id` — letter-prefixed (cortex#141). */
const PRINCIPAL_ID_RE = /^[a-z][a-z0-9-]*$/;

/** `{principal_id}/{stack_slug}` — both parts follow principal grammar. */
const STACK_ID_RE = /^[a-z][a-z0-9-]*\/[a-z][a-z0-9-]*$/;

/** Phase A.6 capability grammar — `<domain>.<entity>`. */
const CAPABILITY_ID_RE = /^[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*$/;

/** Standard base64 alphabet + padding. We don't accept URL-safe here. */
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

/** Network id — same grammar as principal id. */
const NETWORK_ID_RE = /^[a-z][a-z0-9-]*$/;

/**
 * Issuance request id — 32 lowercase hex chars (16 random bytes from
 * generateRequestId in store.ts). Matching the exact format the store
 * generates ensures a malformed path param is rejected before it reaches
 * any query or error body (M2 — request_id path param validation).
 */
const REQUEST_ID_RE = /^[0-9a-f]{32}$/;

// =============================================================================
// Public validators
// =============================================================================

export function isValidPrincipalId(id: string): boolean {
  return typeof id === "string" && id.length > 0 && id.length <= 64 && PRINCIPAL_ID_RE.test(id);
}

export function isValidNetworkId(id: string): boolean {
  return typeof id === "string" && id.length > 0 && id.length <= 64 && NETWORK_ID_RE.test(id);
}

export function isValidStackId(id: string): boolean {
  return typeof id === "string" && id.length <= 128 && STACK_ID_RE.test(id);
}

export function isValidCapabilityId(id: string): boolean {
  return typeof id === "string" && id.length <= 64 && CAPABILITY_ID_RE.test(id);
}

/**
 * Validate an issuance request_id path parameter.
 * Must be exactly 32 lowercase hex chars — the format generateRequestId in
 * store.ts produces. Rejects slugs, UUIDs with dashes, and empty strings
 * before they can reach queries or error bodies (M2 guard).
 */
export function isValidRequestId(id: string): boolean {
  return typeof id === "string" && REQUEST_ID_RE.test(id);
}

/**
 * 32-byte Ed25519 pubkey, base64. We do a structural check here and
 * defer the cryptographic "is this a valid curve point" question to
 * `verifyEd25519` — WebCrypto rejects malformed keys at importKey
 * time. The pre-flight check is just to fail fast on shape errors.
 */
export function isValidPubkey(b64: string): boolean {
  if (typeof b64 !== "string") return false;
  if (!BASE64_RE.test(b64)) return false;
  // 32 raw bytes → 44 base64 chars (with `=` padding). 43 unpadded is
  // also accepted by atob() but standardise on padded form.
  return b64.length === 44;
}

// =============================================================================
// Composite claim validation
// =============================================================================

export interface ValidationError {
  field: string;
  message: string;
}

/**
 * Validate the full registration body before signature verification.
 * Returns the list of errors; an empty array means the claim is
 * structurally valid and ready for the crypto step.
 *
 * Cross-field rules enforced here (matching the schema in PR #223):
 *   - `claim.principal_id` MUST equal the URL path param (passed in
 *     `expectedPrincipalId`). Mismatch is a forged-attribution attempt.
 *   - Every `stack_id` MUST be prefixed by `{principal_id}/`. Same
 *     reason — prevents principal A claiming a stack id under principal B.
 *   - Stack ids unique within the claim.
 *   - Capability ids unique within the claim.
 *   - All declared networks in `capabilities[].networks[]` follow the
 *     network-id grammar (free declaration; no central network registry).
 */
export function validateRegistrationClaim(
  claim: unknown,
  expectedPrincipalId: string,
): { ok: true; claim: RegistrationClaim } | { ok: false; errors: ValidationError[] } {
  const errors: ValidationError[] = [];

  if (typeof claim !== "object" || claim === null || Array.isArray(claim)) {
    return { ok: false, errors: [{ field: "claim", message: "must be an object" }] };
  }
  const c = claim as Record<string, unknown>;

  // principal_id
  if (typeof c.principal_id !== "string" || !isValidPrincipalId(c.principal_id)) {
    errors.push({ field: "principal_id", message: "must be lowercase alphanumeric + hyphen, letter-prefixed" });
  } else if (c.principal_id !== expectedPrincipalId) {
    errors.push({
      field: "principal_id",
      message: `body principal_id "${c.principal_id}" does not match path "${expectedPrincipalId}"`,
    });
  }

  // principal_pubkey
  if (typeof c.principal_pubkey !== "string" || !isValidPubkey(c.principal_pubkey)) {
    errors.push({ field: "principal_pubkey", message: "must be a 32-byte Ed25519 pubkey, base64-encoded (44 chars)" });
  }

  // stacks
  const stacks: StackIdentity[] = [];
  if (!Array.isArray(c.stacks)) {
    errors.push({ field: "stacks", message: "must be an array (possibly empty)" });
  } else {
    const seenIds = new Set<string>();
    c.stacks.forEach((s, i) => {
      if (typeof s !== "object" || s === null || Array.isArray(s)) {
        errors.push({ field: `stacks[${i.toString()}]`, message: "must be an object" });
        return;
      }
      const sObj = s as Record<string, unknown>;
      if (typeof sObj.stack_id !== "string" || !isValidStackId(sObj.stack_id)) {
        errors.push({
          field: `stacks[${i.toString()}].stack_id`,
          message: "must be {principal_id}/{stack_slug}, both letter-prefixed",
        });
        return;
      }
      const principalPrefix = sObj.stack_id.split("/")[0] ?? "";
      if (typeof c.principal_id === "string" && principalPrefix !== c.principal_id) {
        errors.push({
          field: `stacks[${i.toString()}].stack_id`,
          message: `stack_id prefix "${principalPrefix}" must match principal_id "${c.principal_id.toString()}"`,
        });
        return;
      }
      if (seenIds.has(sObj.stack_id)) {
        errors.push({
          field: `stacks[${i.toString()}].stack_id`,
          message: `duplicate stack_id "${sObj.stack_id}"`,
        });
        return;
      }
      seenIds.add(sObj.stack_id);
      // C-787 — stack_pubkey is OPTIONAL on the wire (back-compat: a producer
      // predating per-stack keys omits it and the route backfills from the
      // root). When PRESENT it must be a well-formed base64 Ed25519 pubkey —
      // a malformed key would poison the verify path for that stack.
      if (
        sObj.stack_pubkey !== undefined &&
        (typeof sObj.stack_pubkey !== "string" || !isValidPubkey(sObj.stack_pubkey))
      ) {
        errors.push({
          field: `stacks[${i.toString()}].stack_pubkey`,
          message: "must be a 32-byte Ed25519 pubkey, base64-encoded (44 chars) if provided",
        });
        return;
      }
      // display_name + metadata are optional and free-form; we only
      // type-check them.
      if (sObj.display_name !== undefined && typeof sObj.display_name !== "string") {
        errors.push({
          field: `stacks[${i.toString()}].display_name`,
          message: "must be a string if provided",
        });
        return;
      }
      if (sObj.metadata !== undefined) {
        if (typeof sObj.metadata !== "object" || sObj.metadata === null || Array.isArray(sObj.metadata)) {
          errors.push({
            field: `stacks[${i.toString()}].metadata`,
            message: "must be an object map of strings if provided",
          });
          return;
        }
        for (const [k, v] of Object.entries(sObj.metadata)) {
          if (typeof v !== "string") {
            errors.push({
              field: `stacks[${i.toString()}].metadata.${k}`,
              message: "metadata values must be strings",
            });
            return;
          }
        }
      }
      // C-1351 — retired_at is OPTIONAL and free-form ISO-8601. It rides through
      // a re-register (add-stack merge) so a retired tombstone SURVIVES rather
      // than being resurrected: the client re-attests the full stacks[] including
      // the retired entry, and this reconstruction PRESERVES it into storage. A
      // register that omits it (the common live case) leaves the stack live.
      if (
        sObj.retired_at !== undefined &&
        (typeof sObj.retired_at !== "string" || Number.isNaN(Date.parse(sObj.retired_at)))
      ) {
        errors.push({
          field: `stacks[${i.toString()}].retired_at`,
          message: "must be an ISO-8601 timestamp if provided",
        });
        return;
      }
      // Build the canonical stack record. Only include optional keys
      // when they are actually defined — `canonicalJSON` is structural
      // and treats `metadata: undefined` as different from "no metadata".
      // The principal-side signing rig also omits these keys when unset
      // (the helper builds the claim from spread defaults), so the
      // canonical bytes must match here.
      const stackRecord: StackIdentity = { stack_id: sObj.stack_id };
      if (typeof sObj.stack_pubkey === "string") {
        stackRecord.stack_pubkey = sObj.stack_pubkey;
      }
      if (typeof sObj.display_name === "string") {
        stackRecord.display_name = sObj.display_name;
      }
      if (sObj.metadata !== undefined) {
        stackRecord.metadata = sObj.metadata as Record<string, string>;
      }
      // C-1351 — carry the tombstone through the whitelist reconstruction so a
      // re-register (full-overwrite upsert) PRESERVES a retired stack in storage
      // instead of silently resurrecting it (the merge-preserves-retired contract).
      if (typeof sObj.retired_at === "string") {
        stackRecord.retired_at = sObj.retired_at;
      }
      stacks.push(stackRecord);
    });
  }

  // capabilities
  const capabilities: Capability[] = [];
  if (!Array.isArray(c.capabilities)) {
    errors.push({ field: "capabilities", message: "must be an array (possibly empty)" });
  } else {
    const seenIds = new Set<string>();
    c.capabilities.forEach((cap, i) => {
      if (typeof cap !== "object" || cap === null || Array.isArray(cap)) {
        errors.push({ field: `capabilities[${i.toString()}]`, message: "must be an object" });
        return;
      }
      const capObj = cap as Record<string, unknown>;
      if (typeof capObj.id !== "string" || !isValidCapabilityId(capObj.id)) {
        errors.push({
          field: `capabilities[${i.toString()}].id`,
          message: "must be <domain>.<entity>, both letter-prefixed",
        });
        return;
      }
      if (seenIds.has(capObj.id)) {
        errors.push({
          field: `capabilities[${i.toString()}].id`,
          message: `duplicate capability id "${capObj.id}"`,
        });
        return;
      }
      seenIds.add(capObj.id);
      if (capObj.description !== undefined && typeof capObj.description !== "string") {
        errors.push({
          field: `capabilities[${i.toString()}].description`,
          message: "must be a string if provided",
        });
        return;
      }
      const networks: string[] = [];
      if (capObj.networks !== undefined) {
        if (!Array.isArray(capObj.networks)) {
          errors.push({
            field: `capabilities[${i.toString()}].networks`,
            message: "must be an array of network ids if provided",
          });
          return;
        }
        for (let j = 0; j < capObj.networks.length; j++) {
          const n = capObj.networks[j];
          if (typeof n !== "string" || !isValidNetworkId(n)) {
            errors.push({
              field: `capabilities[${i.toString()}].networks[${j.toString()}]`,
              message: "must be a valid network id (lowercase alphanumeric + hyphen, letter-prefixed)",
            });
            return;
          }
          networks.push(n);
        }
      }
      // Same canonical-form discipline as the stack record above.
      const capRecord: Capability = { id: capObj.id };
      if (typeof capObj.description === "string") {
        capRecord.description = capObj.description;
      }
      if (capObj.networks !== undefined) {
        capRecord.networks = networks;
      }
      capabilities.push(capRecord);
    });
  }

  // issued_at — ISO-8601 UTC. Parsing back through Date catches gross
  // garbage; the route layer also enforces a clock-skew window.
  if (typeof c.issued_at !== "string" || Number.isNaN(Date.parse(c.issued_at))) {
    errors.push({ field: "issued_at", message: "must be an ISO-8601 timestamp" });
  }

  // nonce
  if (typeof c.nonce !== "string" || c.nonce.length < 8 || c.nonce.length > 128) {
    errors.push({ field: "nonce", message: "must be a string between 8 and 128 chars" });
  }

  // #825 — optional optimistic-concurrency token. Must be a string when present.
  // CRITICAL: it is part of the SIGNED canonical claim, so it must be PRESERVED
  // into the reconstructed claim verbatim — silently dropping it would change the
  // canonical bytes the route verifies and reject every CAS-bearing claim (401).
  if (c.expected_updated_at !== undefined && typeof c.expected_updated_at !== "string") {
    errors.push({ field: "expected_updated_at", message: "must be a string when present" });
  }

  // ADR-0018 Gap-A — optional target network. Same SIGNED-bytes discipline as
  // expected_updated_at: it is part of the canonical claim, so it must be
  // PRESERVED verbatim into the reconstructed claim, or every network-bearing
  // register would fail signature verification (401). When present it must be a
  // valid network id (free declaration — the same grammar a network create uses).
  if (
    c.network_id !== undefined &&
    (typeof c.network_id !== "string" || !isValidNetworkId(c.network_id))
  ) {
    errors.push({
      field: "network_id",
      message: "must be a valid network id (lowercase alphanumeric + hyphen, letter-prefixed) when present",
    });
  }

  if (errors.length > 0) return { ok: false, errors };

  return {
    ok: true,
    claim: {
      principal_id: c.principal_id as string,
      principal_pubkey: c.principal_pubkey as string,
      stacks,
      capabilities,
      ...(typeof c.expected_updated_at === "string" && { expected_updated_at: c.expected_updated_at }),
      ...(typeof c.network_id === "string" && { network_id: c.network_id }),
      issued_at: c.issued_at as string,
      nonce: c.nonce as string,
    },
  };
}

// =============================================================================
// #747 — network-create/update (signed-admin) claim validation
// =============================================================================

/**
 * The admin-signed claim carried by `POST /networks/{network_id}` (#747).
 * An admin proves possession of an allowlisted key by signing
 * `canonicalJSON(claim)` with `admin_pubkey`; the route verifies the
 * signature AND checks the pubkey against `REGISTRY_ADMIN_PUBKEYS`. This
 * is the secure replacement for the descoped anonymous network write
 * (S2.5 #745 → #747): an unauthenticated write the registry then signs
 * would let an attacker seed a malicious `hub_url` (descriptor poisoning
 * → federation MITM), so the write is gated on a signed-admin assertion
 * and FAILS CLOSED when no admin key is configured.
 */
export interface NetworkCreateClaim {
  /** Must equal the URL path parameter. */
  network_id: string;
  /** The hub's leaf-node dial URL (e.g. `tls://hub.meta-factory.ai:7422`). */
  hub_url: string;
  /** The hub's leaf-node listen port (1..65535). */
  leaf_port: number;
  /** Base64 Ed25519 pubkey of the admin signing this claim. */
  admin_pubkey: string;
  /** ISO-8601 UTC timestamp at which the admin signed this claim. */
  issued_at: string;
  /** Random nonce to prevent replay. */
  nonce: string;
  /**
   * #1321 — OPTIONAL per-network admin allowlist to set on the network record:
   * comma-separated base64 Ed25519 pubkeys (same grammar as the global var).
   * Only a GLOBAL admin may set/change this (the route enforces that — a
   * per-network admin supplying it is rejected 403). Omitted on a plain
   * topology update.
   */
  admin_pubkeys?: string;
  /**
   * #1598 — OPTIONAL hub-mode attestation: how the network's hub authenticates
   * leaves. hub_mode `operator` (NSC/JWT — admit seals a per-member scoped-user
   * credential, v2 envelope) or `simple` (inline leaf authorization — admit
   * seals the shared-string secret, v1 envelope). Drives the admit-side
   * fail-fast guards BOTH ways (design §4 D2). Omitted = unattested (legacy
   * rows) — admit treats that as `simple` for back-compat but the creds path
   * refuses to run.
   */
  hub_mode?: "operator" | "simple";
  /**
   * #1598 / design §5.1 — OPTIONAL resolver-mode attestation for an
   * operator-mode hub: `nats` (push-capable full resolver — runtime revocation
   * works) or `memory` (preload — revocation needs a hub restart). The
   * rotate/revoke tooling (#1599) fail-fasts unless `nats`.
   */
  resolver_mode?: "nats" | "memory";
}

/** The on-wire envelope: an admin claim + detached Ed25519 signature. */
export interface SignedNetworkCreate {
  claim: NetworkCreateClaim;
  /** Base64 Ed25519 signature over canonical-JSON(claim). */
  signature: string;
}

/**
 * Validate the full network-create body before signature verification.
 * Mirrors `validateRegistrationClaim`: cross-field rules first (so a
 * forged-attribution path-vs-body mismatch is rejected pre-crypto), then
 * shape checks on every field. The route layer enforces clock-skew on
 * `issued_at`, signature verification against `admin_pubkey`, the admin
 * allowlist, and nonce-replay.
 */
export function validateNetworkCreateClaim(
  claim: unknown,
  expectedNetworkId: string,
): { ok: true; claim: NetworkCreateClaim } | { ok: false; errors: ValidationError[] } {
  const errors: ValidationError[] = [];

  if (typeof claim !== "object" || claim === null || Array.isArray(claim)) {
    return { ok: false, errors: [{ field: "claim", message: "must be an object" }] };
  }
  const c = claim as Record<string, unknown>;

  // network_id — grammar + path match (forged-attribution guard).
  if (typeof c.network_id !== "string" || !isValidNetworkId(c.network_id)) {
    errors.push({ field: "network_id", message: "must be lowercase alphanumeric + hyphen, letter-prefixed" });
  } else if (c.network_id !== expectedNetworkId) {
    errors.push({
      field: "network_id",
      message: `body network_id "${c.network_id}" does not match path "${expectedNetworkId}"`,
    });
  }

  // hub_url — non-empty string. We do NOT parse/validate the scheme here:
  // the leaf renderer + descriptor consumer own URL grammar (and the cortex
  // client's parseDescriptor only requires a non-empty string). Keeping the
  // check narrow avoids rejecting a legitimate hub URL the registry has no
  // business interpreting.
  if (typeof c.hub_url !== "string" || c.hub_url.length === 0) {
    errors.push({ field: "hub_url", message: "must be a non-empty string" });
  }

  // leaf_port — integer in 1..65535.
  if (
    typeof c.leaf_port !== "number" ||
    !Number.isInteger(c.leaf_port) ||
    c.leaf_port < 1 ||
    c.leaf_port > 65535
  ) {
    errors.push({ field: "leaf_port", message: "must be an integer in 1..65535" });
  }

  // admin_pubkey — base64 Ed25519 pubkey shape (same check as principal_pubkey).
  if (typeof c.admin_pubkey !== "string" || !isValidPubkey(c.admin_pubkey)) {
    errors.push({ field: "admin_pubkey", message: "must be a 32-byte Ed25519 pubkey, base64-encoded (44 chars)" });
  }

  // issued_at — ISO-8601 UTC; route enforces the skew window.
  if (typeof c.issued_at !== "string" || Number.isNaN(Date.parse(c.issued_at))) {
    errors.push({ field: "issued_at", message: "must be an ISO-8601 timestamp" });
  }

  // nonce — same bounds as the registration claim.
  if (typeof c.nonce !== "string" || c.nonce.length < 8 || c.nonce.length > 128) {
    errors.push({ field: "nonce", message: "must be a string between 8 and 128 chars" });
  }

  // admin_pubkeys (#1321) — OPTIONAL comma-separated base64 pubkeys; same shape
  // as the global allowlist. Validate every entry so a malformed set is rejected
  // pre-crypto rather than persisted. Authorization (only-global-may-set) is the
  // route's job, not the validator's.
  if (c.admin_pubkeys !== undefined) {
    if (typeof c.admin_pubkeys !== "string") {
      errors.push({ field: "admin_pubkeys", message: "must be a string (comma-separated base64 pubkeys) or omitted" });
    } else {
      const entries = c.admin_pubkeys
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      if (entries.length === 0) {
        errors.push({ field: "admin_pubkeys", message: "must contain at least one pubkey when present" });
      } else if (!entries.every((e) => isValidPubkey(e))) {
        errors.push({ field: "admin_pubkeys", message: "every entry must be a 32-byte Ed25519 pubkey, base64-encoded (44 chars)" });
      }
    }
  }

  // hub_mode / resolver_mode (#1598) — OPTIONAL closed enums. Reject anything
  // outside the enum pre-crypto so a typo'd attestation is never persisted (the
  // admit-side guards branch on these values).
  if (c.hub_mode !== undefined && c.hub_mode !== "operator" && c.hub_mode !== "simple") {
    errors.push({ field: "hub_mode", message: 'must be "operator" or "simple" when present' });
  }
  if (c.resolver_mode !== undefined && c.resolver_mode !== "nats" && c.resolver_mode !== "memory") {
    errors.push({ field: "resolver_mode", message: 'must be "nats" or "memory" when present' });
  }
  // resolver_mode only means something for an operator-mode hub — reject the
  // incoherent combination rather than persisting an attestation the consumers
  // would have to special-case.
  if (c.resolver_mode !== undefined && c.hub_mode !== "operator") {
    errors.push({ field: "resolver_mode", message: 'requires hub_mode "operator"' });
  }

  if (errors.length > 0) return { ok: false, errors };

  const result: NetworkCreateClaim = {
    network_id: c.network_id as string,
    hub_url: c.hub_url as string,
    leaf_port: c.leaf_port as number,
    admin_pubkey: c.admin_pubkey as string,
    issued_at: c.issued_at as string,
    nonce: c.nonce as string,
    ...(c.admin_pubkeys !== undefined && { admin_pubkeys: c.admin_pubkeys as string }),
    ...(c.hub_mode !== undefined && { hub_mode: c.hub_mode as "operator" | "simple" }),
    ...(c.resolver_mode !== undefined && { resolver_mode: c.resolver_mode as "nats" | "memory" }),
  };
  return { ok: true, claim: result };
}

/**
 * Validate the signed-network-create envelope ({ claim, signature }).
 * Mirrors `validateSignedRegistration`.
 */
export function validateSignedNetworkCreate(
  body: unknown,
): { ok: true; signed: SignedNetworkCreate } | { ok: false; errors: ValidationError[] } {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { ok: false, errors: [{ field: "body", message: "must be an object" }] };
  }
  const b = body as Record<string, unknown>;
  if (typeof b.signature !== "string" || b.signature.length === 0) {
    return { ok: false, errors: [{ field: "signature", message: "missing" }] };
  }
  if (!BASE64_RE.test(b.signature)) {
    return { ok: false, errors: [{ field: "signature", message: "must be base64" }] };
  }
  if (typeof b.claim !== "object" || b.claim === null) {
    return { ok: false, errors: [{ field: "claim", message: "missing" }] };
  }
  return {
    ok: true,
    signed: { claim: b.claim as NetworkCreateClaim, signature: b.signature },
  };
}

export function validateSignedRegistration(
  body: unknown,
): { ok: true; signed: SignedRegistration } | { ok: false; errors: ValidationError[] } {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { ok: false, errors: [{ field: "body", message: "must be an object" }] };
  }
  const b = body as Record<string, unknown>;
  if (typeof b.signature !== "string" || b.signature.length === 0) {
    return { ok: false, errors: [{ field: "signature", message: "missing" }] };
  }
  if (!BASE64_RE.test(b.signature)) {
    return { ok: false, errors: [{ field: "signature", message: "must be base64" }] };
  }
  if (typeof b.claim !== "object" || b.claim === null) {
    return { ok: false, errors: [{ field: "claim", message: "missing" }] };
  }
  return {
    ok: true,
    signed: { claim: b.claim as RegistrationClaim, signature: b.signature },
  };
}

// =============================================================================
// ADR-0015 — Network-admission decision + read claim validators
// =============================================================================

/**
 * Validate the body of `POST /admission-requests/{id}/admit` and `/reject`.
 * The envelope is { claim: AdmissionDecisionClaim, signature: string }.
 * Mirrors `validateSignedNetworkCreate` exactly in structure so the admin gate
 * can be applied identically (503 / 401 / 403 order).
 */
export function validateSignedAdmissionDecision(
  body: unknown,
): { ok: true; signed: SignedAdmissionDecision } | { ok: false; errors: ValidationError[] } {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { ok: false, errors: [{ field: "body", message: "must be an object" }] };
  }
  const b = body as Record<string, unknown>;
  if (typeof b.signature !== "string" || b.signature.length === 0) {
    return { ok: false, errors: [{ field: "signature", message: "missing" }] };
  }
  if (!BASE64_RE.test(b.signature)) {
    return { ok: false, errors: [{ field: "signature", message: "must be base64" }] };
  }
  if (typeof b.claim !== "object" || b.claim === null || Array.isArray(b.claim)) {
    return { ok: false, errors: [{ field: "claim", message: "must be a non-array object" }] };
  }
  return {
    ok: true,
    signed: { claim: b.claim as AdmissionDecisionClaim, signature: b.signature },
  };
}

/**
 * Validate the `AdmissionDecisionClaim` payload before crypto verification.
 * Cross-field rule: claim.request_id MUST match the URL path parameter.
 * claim.decision MUST be "admit" or "reject".
 */
export function validateAdmissionDecisionClaim(
  claim: unknown,
  expectedRequestId: string,
  expectedDecision: "admit" | "reject",
): { ok: true; claim: AdmissionDecisionClaim } | { ok: false; errors: ValidationError[] } {
  const errors: ValidationError[] = [];

  if (typeof claim !== "object" || claim === null || Array.isArray(claim)) {
    return { ok: false, errors: [{ field: "claim", message: "must be an object" }] };
  }
  const c = claim as Record<string, unknown>;

  if (typeof c.request_id !== "string" || c.request_id.length === 0) {
    errors.push({ field: "request_id", message: "must be a non-empty string" });
  } else if (c.request_id !== expectedRequestId) {
    errors.push({
      field: "request_id",
      message: `body request_id "${c.request_id}" does not match path "${expectedRequestId}"`,
    });
  }

  if (c.decision !== "admit" && c.decision !== "reject") {
    errors.push({ field: "decision", message: 'must be "admit" or "reject"' });
  } else if (c.decision !== expectedDecision) {
    errors.push({
      field: "decision",
      message: `body decision "${c.decision as string}" does not match route "${expectedDecision}"`,
    });
  }

  if (typeof c.admin_pubkey !== "string" || !isValidPubkey(c.admin_pubkey)) {
    errors.push({ field: "admin_pubkey", message: "must be a 32-byte Ed25519 pubkey, base64-encoded (44 chars)" });
  }

  if (typeof c.issued_at !== "string" || Number.isNaN(Date.parse(c.issued_at))) {
    errors.push({ field: "issued_at", message: "must be an ISO-8601 timestamp" });
  }

  if (typeof c.nonce !== "string" || c.nonce.length < 8 || c.nonce.length > 128) {
    errors.push({ field: "nonce", message: "must be a string between 8 and 128 chars" });
  }

  if (errors.length > 0) return { ok: false, errors };

  return {
    ok: true,
    claim: {
      request_id: c.request_id as string,
      decision: c.decision as "admit" | "reject",
      admin_pubkey: c.admin_pubkey as string,
      issued_at: c.issued_at as string,
      nonce: c.nonce as string,
    },
  };
}

/**
 * Validate the `x-admin-signed` header for admin read endpoints on
 * /admission-requests. The header value is JSON: { claim: AdmissionReadClaim,
 * signature: string }. No nonce (reads are idempotent). Clock-skew applies.
 */
export function validateSignedAdmissionRead(
  body: unknown,
): { ok: true; signed: SignedAdmissionRead } | { ok: false; errors: ValidationError[] } {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { ok: false, errors: [{ field: "body", message: "must be an object" }] };
  }
  const b = body as Record<string, unknown>;
  if (typeof b.signature !== "string" || b.signature.length === 0) {
    return { ok: false, errors: [{ field: "signature", message: "missing" }] };
  }
  if (!BASE64_RE.test(b.signature)) {
    return { ok: false, errors: [{ field: "signature", message: "must be base64" }] };
  }
  if (typeof b.claim !== "object" || b.claim === null || Array.isArray(b.claim)) {
    return { ok: false, errors: [{ field: "claim", message: "must be a non-array object" }] };
  }
  const bc = b.claim as Record<string, unknown>;
  if (typeof bc.admin_pubkey !== "string" || !isValidPubkey(bc.admin_pubkey)) {
    return {
      ok: false,
      errors: [{ field: "claim.admin_pubkey", message: "must be a 32-byte Ed25519 pubkey, base64-encoded (44 chars)" }],
    };
  }
  // FND-5 — OPTIONAL network scope. When present it must be a well-formed
  // network id; the read gate then FORCES a per-network admin's read to it.
  if (
    bc.network_id !== undefined &&
    (typeof bc.network_id !== "string" || !isValidNetworkId(bc.network_id))
  ) {
    return {
      ok: false,
      errors: [{ field: "claim.network_id", message: "must be a valid network id" }],
    };
  }
  if (typeof bc.issued_at !== "string" || Number.isNaN(Date.parse(bc.issued_at))) {
    return { ok: false, errors: [{ field: "claim.issued_at", message: "must be an ISO-8601 timestamp" }] };
  }
  return {
    ok: true,
    signed: {
      // Reconstruct the claim the caller signed. Include network_id ONLY when
      // supplied — so the signature verifies over the same canonicalJSON bytes
      // whether or not the caller scoped the read (backward compatible with the
      // pre-FND-5 two-field claim).
      claim: {
        admin_pubkey: bc.admin_pubkey,
        ...(typeof bc.network_id === "string" && { network_id: bc.network_id }),
        issued_at: bc.issued_at,
      },
      signature: b.signature,
    },
  };
}

/**
 * ADR-0018 Q4 (Gap-C) — validate the `x-pop-signed` header for the member
 * PoP-read endpoint `GET /admission-requests/mine`. The header value is JSON:
 * `{ claim: AdmissionMineReadClaim, signature: string }`. No nonce (reads are
 * idempotent). Clock-skew applies. The route verifies the signature against
 * `claim.peer_pubkey` — that signature is the authorization (no admin key).
 */
export function validateSignedAdmissionMineRead(
  body: unknown,
): { ok: true; signed: SignedAdmissionMineRead } | { ok: false; errors: ValidationError[] } {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { ok: false, errors: [{ field: "body", message: "must be an object" }] };
  }
  const b = body as Record<string, unknown>;
  if (typeof b.signature !== "string" || b.signature.length === 0) {
    return { ok: false, errors: [{ field: "signature", message: "missing" }] };
  }
  if (!BASE64_RE.test(b.signature)) {
    return { ok: false, errors: [{ field: "signature", message: "must be base64" }] };
  }
  if (typeof b.claim !== "object" || b.claim === null || Array.isArray(b.claim)) {
    return { ok: false, errors: [{ field: "claim", message: "must be a non-array object" }] };
  }
  const bc = b.claim as Record<string, unknown>;
  if (typeof bc.principal_id !== "string" || !isValidPrincipalId(bc.principal_id)) {
    return {
      ok: false,
      errors: [{ field: "claim.principal_id", message: "must be a valid principal id" }],
    };
  }
  if (typeof bc.peer_pubkey !== "string" || !isValidPubkey(bc.peer_pubkey)) {
    return {
      ok: false,
      errors: [{ field: "claim.peer_pubkey", message: "must be a 32-byte Ed25519 pubkey, base64-encoded (44 chars)" }],
    };
  }
  if (typeof bc.issued_at !== "string" || Number.isNaN(Date.parse(bc.issued_at))) {
    return { ok: false, errors: [{ field: "claim.issued_at", message: "must be an ISO-8601 timestamp" }] };
  }
  return {
    ok: true,
    signed: {
      claim: { principal_id: bc.principal_id, peer_pubkey: bc.peer_pubkey, issued_at: bc.issued_at },
      signature: b.signature,
    },
  };
}

/**
 * C-1282 (ADR-0018 Q4) — validate the `x-pop-signed` header for the member
 * network-roster read `GET /networks/{network_id}/roster/member`. The header
 * value is JSON: `{ claim: NetworkRosterMemberReadClaim, signature: string }`.
 *
 * Like the `/mine` PoP read: no nonce (reads are idempotent), clock-skew
 * applies, and the route verifies the signature against `claim.peer_pubkey`
 * (that signature is the authorization). Unlike `/mine`, the claim binds a
 * `network_id` so the signature is scoped to one network — the route additionally
 * checks `claim.network_id` matches the path and that the proven pubkey is an
 * ADMITTED member of it (the fail-closed gate lives in the route, not here).
 */
export function validateSignedNetworkRosterMemberRead(
  body: unknown,
): { ok: true; signed: SignedNetworkRosterMemberRead } | { ok: false; errors: ValidationError[] } {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { ok: false, errors: [{ field: "body", message: "must be an object" }] };
  }
  const b = body as Record<string, unknown>;
  if (typeof b.signature !== "string" || b.signature.length === 0) {
    return { ok: false, errors: [{ field: "signature", message: "missing" }] };
  }
  if (!BASE64_RE.test(b.signature)) {
    return { ok: false, errors: [{ field: "signature", message: "must be base64" }] };
  }
  if (typeof b.claim !== "object" || b.claim === null || Array.isArray(b.claim)) {
    return { ok: false, errors: [{ field: "claim", message: "must be a non-array object" }] };
  }
  const bc = b.claim as Record<string, unknown>;
  if (typeof bc.network_id !== "string" || !isValidNetworkId(bc.network_id)) {
    return {
      ok: false,
      errors: [{ field: "claim.network_id", message: "must be a valid network id" }],
    };
  }
  if (typeof bc.peer_pubkey !== "string" || !isValidPubkey(bc.peer_pubkey)) {
    return {
      ok: false,
      errors: [{ field: "claim.peer_pubkey", message: "must be a 32-byte Ed25519 pubkey, base64-encoded (44 chars)" }],
    };
  }
  if (typeof bc.issued_at !== "string" || Number.isNaN(Date.parse(bc.issued_at))) {
    return { ok: false, errors: [{ field: "claim.issued_at", message: "must be an ISO-8601 timestamp" }] };
  }
  return {
    ok: true,
    signed: {
      claim: { network_id: bc.network_id, peer_pubkey: bc.peer_pubkey, issued_at: bc.issued_at },
      signature: b.signature,
    },
  };
}

// =============================================================================
// ADR-0018 PR5b — hub-admin sealed-secret write + revoke claim validators
// =============================================================================

/**
 * Bound on the opaque sealed ciphertext the registry stores (ADR-0018 b′). It
 * must be base64 (the registry never decodes it, but a non-base64 value can
 * only be junk) and bounded so a hostile hub-admin cannot stuff the row with an
 * unbounded blob. A `crypto_box_seal` of a small secret is ~100 bytes base64;
 * 8 KiB leaves generous headroom for the future M3 payload-key envelope (#1246)
 * riding the SAME slot without a hard cliff.
 */
export function isValidSealedSecret(b64: string): boolean {
  return typeof b64 === "string" && b64.length >= 1 && b64.length <= 8192 && BASE64_RE.test(b64);
}

/**
 * Validate the `POST /admission-requests/{id}/sealed-secret` envelope
 * ({ claim: SealedSecretWriteClaim, signature }). Mirrors
 * `validateSignedAdmissionDecision` so the HUB-admin gate applies the identical
 * 503/401/403 order.
 */
export function validateSignedSealedSecretWrite(
  body: unknown,
): { ok: true; signed: SignedSealedSecretWrite } | { ok: false; errors: ValidationError[] } {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { ok: false, errors: [{ field: "body", message: "must be an object" }] };
  }
  const b = body as Record<string, unknown>;
  if (typeof b.signature !== "string" || b.signature.length === 0) {
    return { ok: false, errors: [{ field: "signature", message: "missing" }] };
  }
  if (!BASE64_RE.test(b.signature)) {
    return { ok: false, errors: [{ field: "signature", message: "must be base64" }] };
  }
  if (typeof b.claim !== "object" || b.claim === null || Array.isArray(b.claim)) {
    return { ok: false, errors: [{ field: "claim", message: "must be a non-array object" }] };
  }
  return {
    ok: true,
    signed: { claim: b.claim as SealedSecretWriteClaim, signature: b.signature },
  };
}

/**
 * Validate the `SealedSecretWriteClaim` payload before crypto verification.
 * Cross-field rule: claim.request_id MUST match the URL path parameter
 * (forged-attribution guard). The opaque `sealed_secret` is shape-checked only
 * (base64 + bounded) — the registry never reads it.
 */
export function validateSealedSecretClaim(
  claim: unknown,
  expectedRequestId: string,
): { ok: true; claim: SealedSecretWriteClaim } | { ok: false; errors: ValidationError[] } {
  const errors: ValidationError[] = [];

  if (typeof claim !== "object" || claim === null || Array.isArray(claim)) {
    return { ok: false, errors: [{ field: "claim", message: "must be an object" }] };
  }
  const c = claim as Record<string, unknown>;

  if (typeof c.request_id !== "string" || c.request_id.length === 0) {
    errors.push({ field: "request_id", message: "must be a non-empty string" });
  } else if (c.request_id !== expectedRequestId) {
    errors.push({
      field: "request_id",
      message: `body request_id "${c.request_id}" does not match path "${expectedRequestId}"`,
    });
  }

  if (typeof c.sealed_secret !== "string" || !isValidSealedSecret(c.sealed_secret)) {
    errors.push({ field: "sealed_secret", message: "must be base64, 1..8192 chars" });
  }

  if (typeof c.hub_admin_pubkey !== "string" || !isValidPubkey(c.hub_admin_pubkey)) {
    errors.push({ field: "hub_admin_pubkey", message: "must be a 32-byte Ed25519 pubkey, base64-encoded (44 chars)" });
  }

  if (typeof c.issued_at !== "string" || Number.isNaN(Date.parse(c.issued_at))) {
    errors.push({ field: "issued_at", message: "must be an ISO-8601 timestamp" });
  }

  if (typeof c.nonce !== "string" || c.nonce.length < 8 || c.nonce.length > 128) {
    errors.push({ field: "nonce", message: "must be a string between 8 and 128 chars" });
  }

  if (errors.length > 0) return { ok: false, errors };

  return {
    ok: true,
    claim: {
      request_id: c.request_id as string,
      sealed_secret: c.sealed_secret as string,
      hub_admin_pubkey: c.hub_admin_pubkey as string,
      issued_at: c.issued_at as string,
      nonce: c.nonce as string,
    },
  };
}

/**
 * Validate the `POST /admission-requests/{id}/revoke` envelope
 * ({ claim: AdmissionRevokeClaim, signature }).
 */
export function validateSignedAdmissionRevoke(
  body: unknown,
): { ok: true; signed: SignedAdmissionRevoke } | { ok: false; errors: ValidationError[] } {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { ok: false, errors: [{ field: "body", message: "must be an object" }] };
  }
  const b = body as Record<string, unknown>;
  if (typeof b.signature !== "string" || b.signature.length === 0) {
    return { ok: false, errors: [{ field: "signature", message: "missing" }] };
  }
  if (!BASE64_RE.test(b.signature)) {
    return { ok: false, errors: [{ field: "signature", message: "must be base64" }] };
  }
  if (typeof b.claim !== "object" || b.claim === null || Array.isArray(b.claim)) {
    return { ok: false, errors: [{ field: "claim", message: "must be a non-array object" }] };
  }
  return {
    ok: true,
    signed: { claim: b.claim as AdmissionRevokeClaim, signature: b.signature },
  };
}

/**
 * Validate the `AdmissionRevokeClaim` payload before crypto verification.
 * Cross-field rule: claim.request_id MUST match the URL path parameter.
 */
export function validateAdmissionRevokeClaim(
  claim: unknown,
  expectedRequestId: string,
): { ok: true; claim: AdmissionRevokeClaim } | { ok: false; errors: ValidationError[] } {
  const errors: ValidationError[] = [];

  if (typeof claim !== "object" || claim === null || Array.isArray(claim)) {
    return { ok: false, errors: [{ field: "claim", message: "must be an object" }] };
  }
  const c = claim as Record<string, unknown>;

  if (typeof c.request_id !== "string" || c.request_id.length === 0) {
    errors.push({ field: "request_id", message: "must be a non-empty string" });
  } else if (c.request_id !== expectedRequestId) {
    errors.push({
      field: "request_id",
      message: `body request_id "${c.request_id}" does not match path "${expectedRequestId}"`,
    });
  }

  if (typeof c.hub_admin_pubkey !== "string" || !isValidPubkey(c.hub_admin_pubkey)) {
    errors.push({ field: "hub_admin_pubkey", message: "must be a 32-byte Ed25519 pubkey, base64-encoded (44 chars)" });
  }

  if (typeof c.issued_at !== "string" || Number.isNaN(Date.parse(c.issued_at))) {
    errors.push({ field: "issued_at", message: "must be an ISO-8601 timestamp" });
  }

  if (typeof c.nonce !== "string" || c.nonce.length < 8 || c.nonce.length > 128) {
    errors.push({ field: "nonce", message: "must be a string between 8 and 128 chars" });
  }

  if (errors.length > 0) return { ok: false, errors };

  return {
    ok: true,
    claim: {
      request_id: c.request_id as string,
      hub_admin_pubkey: c.hub_admin_pubkey as string,
      issued_at: c.issued_at as string,
      nonce: c.nonce as string,
    },
  };
}

// =============================================================================
// cortex#1498 — hub-admin authorize claim validators
// =============================================================================

/**
 * Validate the `POST /admission-requests/{id}/authorize` envelope
 * ({ claim: HubAuthorizeClaim, signature }). Structurally identical to
 * {@link validateSignedAdmissionRevoke} (same hub-admin authority, same
 * fields) — kept as its own function so the two write verbs stay
 * independently evolvable (e.g. `authorize` growing a field revoke never
 * needs, or vice versa).
 */
export function validateSignedHubAuthorize(
  body: unknown,
): { ok: true; signed: SignedHubAuthorize } | { ok: false; errors: ValidationError[] } {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { ok: false, errors: [{ field: "body", message: "must be an object" }] };
  }
  const b = body as Record<string, unknown>;
  if (typeof b.signature !== "string" || b.signature.length === 0) {
    return { ok: false, errors: [{ field: "signature", message: "missing" }] };
  }
  if (!BASE64_RE.test(b.signature)) {
    return { ok: false, errors: [{ field: "signature", message: "must be base64" }] };
  }
  if (typeof b.claim !== "object" || b.claim === null || Array.isArray(b.claim)) {
    return { ok: false, errors: [{ field: "claim", message: "must be a non-array object" }] };
  }
  return {
    ok: true,
    signed: { claim: b.claim as HubAuthorizeClaim, signature: b.signature },
  };
}

/**
 * Validate the `HubAuthorizeClaim` payload before crypto verification.
 * Cross-field rule: claim.request_id MUST match the URL path parameter.
 *
 * Freshness/replay (Sage #1501): this validator only checks `issued_at` is a
 * well-formed ISO-8601 timestamp — the actual freshness WINDOW is enforced at
 * the ROUTE by `verifyHubAdminWrite` (the shared hub-admin write gate), which
 * rejects `Math.abs(now - issued) > CLOCK_SKEW_MS` (400) and burns the `nonce`
 * against the replay cache (409), exactly as the sealed-secret/revoke claims
 * do. So a signed authorize claim is NOT replayable indefinitely — the bound
 * lives one layer up, deliberately, not here.
 */
export function validateHubAuthorizeClaim(
  claim: unknown,
  expectedRequestId: string,
): { ok: true; claim: HubAuthorizeClaim } | { ok: false; errors: ValidationError[] } {
  const errors: ValidationError[] = [];

  if (typeof claim !== "object" || claim === null || Array.isArray(claim)) {
    return { ok: false, errors: [{ field: "claim", message: "must be an object" }] };
  }
  const c = claim as Record<string, unknown>;

  if (typeof c.request_id !== "string" || c.request_id.length === 0) {
    errors.push({ field: "request_id", message: "must be a non-empty string" });
  } else if (c.request_id !== expectedRequestId) {
    errors.push({
      field: "request_id",
      message: `body request_id "${c.request_id}" does not match path "${expectedRequestId}"`,
    });
  }

  if (typeof c.hub_admin_pubkey !== "string" || !isValidPubkey(c.hub_admin_pubkey)) {
    errors.push({ field: "hub_admin_pubkey", message: "must be a 32-byte Ed25519 pubkey, base64-encoded (44 chars)" });
  }

  if (typeof c.issued_at !== "string" || Number.isNaN(Date.parse(c.issued_at))) {
    errors.push({ field: "issued_at", message: "must be an ISO-8601 timestamp" });
  }

  if (typeof c.nonce !== "string" || c.nonce.length < 8 || c.nonce.length > 128) {
    errors.push({ field: "nonce", message: "must be a string between 8 and 128 chars" });
  }

  if (errors.length > 0) return { ok: false, errors };

  return {
    ok: true,
    claim: {
      request_id: c.request_id as string,
      hub_admin_pubkey: c.hub_admin_pubkey as string,
      issued_at: c.issued_at as string,
      nonce: c.nonce as string,
    },
  };
}

/**
 * C-1350 Slice 1 (#1350) — validate the `POST /admission-requests/{id}/depart`
 * envelope ({ claim: AdmissionDepartClaim, signature }). Structural only; the
 * route verifies the signature over the WIRE claim (`canonicalJSON(signed.claim)`,
 * the #1414 verify-over-wire norm) and enforces the own-row ownership gate.
 */
export function validateSignedAdmissionDepart(
  body: unknown,
): { ok: true; signed: SignedAdmissionDepart } | { ok: false; errors: ValidationError[] } {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { ok: false, errors: [{ field: "body", message: "must be an object" }] };
  }
  const b = body as Record<string, unknown>;
  if (typeof b.signature !== "string" || b.signature.length === 0) {
    return { ok: false, errors: [{ field: "signature", message: "missing" }] };
  }
  if (!BASE64_RE.test(b.signature)) {
    return { ok: false, errors: [{ field: "signature", message: "must be base64" }] };
  }
  if (typeof b.claim !== "object" || b.claim === null || Array.isArray(b.claim)) {
    return { ok: false, errors: [{ field: "claim", message: "must be a non-array object" }] };
  }
  return {
    ok: true,
    signed: { claim: b.claim as AdmissionDepartClaim, signature: b.signature },
  };
}

/**
 * C-1350 Slice 1 (#1350) — validate the `AdmissionDepartClaim` payload before
 * crypto verification. Cross-field rule: claim.request_id MUST match the URL
 * path parameter (a captured depart token for row A cannot be replayed against
 * row B's path). Mirrors {@link validateAdmissionRevokeClaim} but keyed on the
 * MEMBER `peer_pubkey` (the PoP authority) + `principal_id`, not a hub-admin key.
 */
export function validateAdmissionDepartClaim(
  claim: unknown,
  expectedRequestId: string,
): { ok: true; claim: AdmissionDepartClaim } | { ok: false; errors: ValidationError[] } {
  const errors: ValidationError[] = [];

  if (typeof claim !== "object" || claim === null || Array.isArray(claim)) {
    return { ok: false, errors: [{ field: "claim", message: "must be an object" }] };
  }
  const c = claim as Record<string, unknown>;

  if (typeof c.request_id !== "string" || c.request_id.length === 0) {
    errors.push({ field: "request_id", message: "must be a non-empty string" });
  } else if (c.request_id !== expectedRequestId) {
    errors.push({
      field: "request_id",
      message: `body request_id "${c.request_id}" does not match path "${expectedRequestId}"`,
    });
  }

  if (typeof c.principal_id !== "string" || !isValidPrincipalId(c.principal_id)) {
    errors.push({ field: "principal_id", message: "must be a valid principal id" });
  }

  if (typeof c.peer_pubkey !== "string" || !isValidPubkey(c.peer_pubkey)) {
    errors.push({ field: "peer_pubkey", message: "must be a 32-byte Ed25519 pubkey, base64-encoded (44 chars)" });
  }

  if (typeof c.issued_at !== "string" || Number.isNaN(Date.parse(c.issued_at))) {
    errors.push({ field: "issued_at", message: "must be an ISO-8601 timestamp" });
  }

  if (typeof c.nonce !== "string" || c.nonce.length < 8 || c.nonce.length > 128) {
    errors.push({ field: "nonce", message: "must be a string between 8 and 128 chars" });
  }

  if (errors.length > 0) return { ok: false, errors };

  return {
    ok: true,
    claim: {
      request_id: c.request_id as string,
      principal_id: c.principal_id as string,
      peer_pubkey: c.peer_pubkey as string,
      issued_at: c.issued_at as string,
      nonce: c.nonce as string,
    },
  };
}

// =============================================================================
// C-1351 Slice 2 (#1351) — stack-retire (root-signed deregistration) validators
// =============================================================================

/**
 * Validate the `POST /principals/:id/stacks/retire` envelope
 * ({ claim: StackRetireClaim, signature }). Structural only; the route verifies
 * the signature over the WIRE claim (`canonicalJSON(signed.claim)`, the #1414
 * verify-over-wire norm) against the STORED record's `principal_pubkey`
 * (root-key authz — the claim carries no pubkey to trust).
 */
export function validateSignedStackRetire(
  body: unknown,
): { ok: true; signed: SignedStackRetire } | { ok: false; errors: ValidationError[] } {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { ok: false, errors: [{ field: "body", message: "must be an object" }] };
  }
  const b = body as Record<string, unknown>;
  if (typeof b.signature !== "string" || b.signature.length === 0) {
    return { ok: false, errors: [{ field: "signature", message: "missing" }] };
  }
  if (!BASE64_RE.test(b.signature)) {
    return { ok: false, errors: [{ field: "signature", message: "must be base64" }] };
  }
  if (typeof b.claim !== "object" || b.claim === null || Array.isArray(b.claim)) {
    return { ok: false, errors: [{ field: "claim", message: "must be a non-array object" }] };
  }
  return {
    ok: true,
    signed: { claim: b.claim as StackRetireClaim, signature: b.signature },
  };
}

/**
 * Validate the `StackRetireClaim` payload before crypto verification.
 * Cross-field rules (forged-attribution guards, mirroring the register claim):
 *   - claim.principal_id MUST equal the URL path parameter.
 *   - claim.stack_id MUST be a well-formed `{principal_id}/{slug}` prefixed by
 *     the principal_id (a claim cannot retire a stack under another principal).
 *   - expected_updated_at (CAS token) is REQUIRED and non-empty.
 */
export function validateStackRetireClaim(
  claim: unknown,
  expectedPrincipalId: string,
): { ok: true; claim: StackRetireClaim } | { ok: false; errors: ValidationError[] } {
  const errors: ValidationError[] = [];

  if (typeof claim !== "object" || claim === null || Array.isArray(claim)) {
    return { ok: false, errors: [{ field: "claim", message: "must be an object" }] };
  }
  const c = claim as Record<string, unknown>;

  if (typeof c.principal_id !== "string" || !isValidPrincipalId(c.principal_id)) {
    errors.push({ field: "principal_id", message: "must be a valid principal id" });
  } else if (c.principal_id !== expectedPrincipalId) {
    errors.push({
      field: "principal_id",
      message: `body principal_id "${c.principal_id}" does not match path "${expectedPrincipalId}"`,
    });
  }

  if (typeof c.stack_id !== "string" || !isValidStackId(c.stack_id)) {
    errors.push({ field: "stack_id", message: "must be {principal_id}/{stack_slug}, both letter-prefixed" });
  } else {
    const prefix = c.stack_id.split("/")[0] ?? "";
    if (typeof c.principal_id === "string" && prefix !== c.principal_id) {
      errors.push({
        field: "stack_id",
        message: `stack_id prefix "${prefix}" must match principal_id "${c.principal_id}"`,
      });
    }
  }

  if (typeof c.expected_updated_at !== "string" || c.expected_updated_at.length === 0) {
    errors.push({ field: "expected_updated_at", message: "must be a non-empty string (CAS token)" });
  }

  if (typeof c.issued_at !== "string" || Number.isNaN(Date.parse(c.issued_at))) {
    errors.push({ field: "issued_at", message: "must be an ISO-8601 timestamp" });
  }

  if (typeof c.nonce !== "string" || c.nonce.length < 8 || c.nonce.length > 128) {
    errors.push({ field: "nonce", message: "must be a string between 8 and 128 chars" });
  }

  if (errors.length > 0) return { ok: false, errors };

  return {
    ok: true,
    claim: {
      principal_id: c.principal_id as string,
      stack_id: c.stack_id as string,
      expected_updated_at: c.expected_updated_at as string,
      issued_at: c.issued_at as string,
      nonce: c.nonce as string,
    },
  };
}
