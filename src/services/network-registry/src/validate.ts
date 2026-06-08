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
  Capability,
  RegistrationClaim,
  SignedRegistration,
  StackIdentity,
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
      // Build the canonical stack record. Only include optional keys
      // when they are actually defined — `canonicalJSON` is structural
      // and treats `metadata: undefined` as different from "no metadata".
      // The principal-side signing rig also omits these keys when unset
      // (the helper builds the claim from spread defaults), so the
      // canonical bytes must match here.
      const stackRecord: StackIdentity = { stack_id: sObj.stack_id };
      if (typeof sObj.display_name === "string") {
        stackRecord.display_name = sObj.display_name;
      }
      if (sObj.metadata !== undefined) {
        stackRecord.metadata = sObj.metadata as Record<string, string>;
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

  if (errors.length > 0) return { ok: false, errors };

  return {
    ok: true,
    claim: {
      principal_id: c.principal_id as string,
      principal_pubkey: c.principal_pubkey as string,
      stacks,
      capabilities,
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

  if (errors.length > 0) return { ok: false, errors };

  return {
    ok: true,
    claim: {
      network_id: c.network_id as string,
      hub_url: c.hub_url as string,
      leaf_port: c.leaf_port as number,
      admin_pubkey: c.admin_pubkey as string,
      issued_at: c.issued_at as string,
      nonce: c.nonce as string,
    },
  };
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
