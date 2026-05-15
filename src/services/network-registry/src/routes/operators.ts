/**
 * IAW D.4.2 — Operator endpoints.
 *
 *   POST /operators/{operator_id}/register
 *     Operator publishes a signed assertion containing their pubkey,
 *     stack identities, and capability declaration. The registry
 *     verifies the signature, checks the nonce, applies clock-skew
 *     bounds, and upserts the record.
 *
 *   GET /operators/{operator_id}
 *     Peers query an operator's current pubkey + stack list. Response
 *     is wrapped in a `SignedAssertion` carrying the registry's
 *     signature so the caller can verify before caching.
 */

import { Hono } from "hono";
import { getRegistryPublicKey, type Env } from "../index";
import { signEd25519, verifyEd25519, canonicalJSON } from "../signing";
import { getNonceCache, getStore } from "../store";
import type { OperatorRecord, SignedAssertion } from "../types";
import {
  isValidOperatorId,
  validateRegistrationClaim,
  validateSignedRegistration,
} from "../validate";

/** Maximum clock skew accepted between operator's `issued_at` and registry now. */
const CLOCK_SKEW_MS = 5 * 60 * 1000; // 5 minutes

export function operatorRoutes(): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();

  app.post("/operators/:operator_id/register", async (c) => {
    // Echo cortex#225 issue #1: refuse to mutate state when we can't
    // produce a signed receipt. The GET surface already returns 503
    // for `/registry/pubkey` when unconfigured; without this guard
    // POST silently accepts registrations with an empty signature and
    // burns TOFU slots, blocking the next legitimate register with
    // HTTP 409. The unsigned-fallback path remains in `signAssertion`
    // only so that GET responses can degrade gracefully in dev — POST
    // is the mutation surface and gets stricter handling.
    if (!c.env.REGISTRY_SIGNING_KEY || !getRegistryPublicKey(c.env)) {
      return c.json(
        {
          error: "registry_unconfigured",
          details:
            "REGISTRY_SIGNING_KEY not provisioned; cannot accept registrations without producing a signed receipt",
        },
        503,
      );
    }
    const operatorId = c.req.param("operator_id");
    if (!isValidOperatorId(operatorId)) {
      return c.json({ error: "invalid operator_id in path" }, 400);
    }

    let body: unknown;
    try {
      body = await c.req.json();
    } catch (_err) {
      return c.json({ error: "body must be valid JSON" }, 400);
    }

    const envelopeCheck = validateSignedRegistration(body);
    if (!envelopeCheck.ok) {
      return c.json({ error: "validation_failed", details: envelopeCheck.errors }, 400);
    }
    const { signed } = envelopeCheck;

    const claimCheck = validateRegistrationClaim(signed.claim, operatorId);
    if (!claimCheck.ok) {
      return c.json({ error: "validation_failed", details: claimCheck.errors }, 400);
    }
    const { claim } = claimCheck;

    // Clock-skew check — reject claims dated too far in the past or future.
    // Past-bound is the replay window; future-bound stops an attacker
    // pre-signing claims for later replay against a known nonce-cache miss.
    const issued = Date.parse(claim.issued_at);
    const now = Date.now();
    if (Math.abs(now - issued) > CLOCK_SKEW_MS) {
      return c.json(
        {
          error: "issued_at out of skew window",
          details: { skew_ms: now - issued, max_ms: CLOCK_SKEW_MS },
        },
        400,
      );
    }

    // Replay check.
    const nonceCache = getNonceCache();
    const fresh = await nonceCache.recordIfFresh(claim.nonce, now);
    if (!fresh) {
      return c.json({ error: "nonce_replayed" }, 409);
    }

    // Signature verification. The operator signs canonical-JSON(claim)
    // with their declared pubkey. TOFU on first register (the claim
    // tells us which key to verify against); rotation requires the
    // previous key to sign a transition claim — out of scope for v1,
    // tracked as a follow-up.
    const message = new TextEncoder().encode(canonicalJSON(claim));
    const valid = await verifyEd25519(claim.operator_pubkey, signed.signature, message);
    if (!valid) {
      return c.json({ error: "signature_invalid" }, 401);
    }

    // Pubkey rotation policy for v1:
    //   - First register for an operator_id: accept any pubkey.
    //   - Subsequent registers MUST sign with the same pubkey already
    //     on record. We reject silent key swaps to protect the chain
    //     of trust peers have already cached. Rotation comes back in
    //     a follow-up that accepts a transition claim co-signed by
    //     the previous key.
    const store = getStore();
    const existing = await store.getOperator(operatorId);
    if (existing && existing.operator_pubkey !== claim.operator_pubkey) {
      return c.json(
        {
          error: "pubkey_rotation_not_supported",
          details: "rotation requires a transition claim co-signed by the previous key (v2 feature)",
        },
        409,
      );
    }

    const record = await store.putOperator(
      operatorId,
      claim.operator_pubkey,
      claim.stacks,
      claim.capabilities,
    );

    // Sign + return the canonical view so the operator gets the same
    // signed assertion shape peers will see.
    const assertion = await signAssertion(c.env, record);
    return c.json(assertion, 201);
  });

  app.get("/operators/:operator_id", async (c) => {
    const operatorId = c.req.param("operator_id");
    if (!isValidOperatorId(operatorId)) {
      return c.json({ error: "invalid operator_id in path" }, 400);
    }
    const store = getStore();
    const record = await store.getOperator(operatorId);
    if (!record) {
      return c.json({ error: "not_found" }, 404);
    }
    const assertion = await signAssertion(c.env, record);
    return c.json(assertion);
  });

  return app;
}

// =============================================================================
// Internal — signed-assertion helper
// =============================================================================

/**
 * Wrap any GET payload in a `SignedAssertion`. The signature covers
 * the canonical-JSON of `{ payload, issued_at, registry }`, so peers
 * cannot lift one signature onto a different payload without breaking
 * verification.
 *
 * Exported via the module-internal seam so `networks.ts` and
 * `capabilities.ts` reuse it without duplicating signing logic.
 */
export async function signAssertion<T>(
  env: Env,
  payload: T,
): Promise<SignedAssertion<T>> {
  const issued_at = new Date().toISOString();
  const registry = getRegistryPublicKey(env);
  if (!env.REGISTRY_SIGNING_KEY || !registry) {
    // No key configured — return an unsigned-but-structured response
    // ONLY for GET-path callers; POST `/operators/.../register` rejects
    // before reaching here (see the 503 guard in the register handler,
    // Echo cortex#225 issue #1). The registry pubkey field is required
    // by the type, so set it to a sentinel string clients can detect
    // ("unconfigured"). Cortex peers MUST refuse to trust a sentinel-
    // keyed assertion; the bot logs this loudly via the audit channel.
    // In dev/local this is the documented degradation; in production
    // wrangler secrets gate the deploy.
    return {
      payload,
      issued_at,
      registry: registry ?? "unconfigured",
      signature: "",
    };
  }
  const bound = canonicalJSON({ payload, issued_at, registry });
  const sig = await signEd25519(env.REGISTRY_SIGNING_KEY, new TextEncoder().encode(bound));
  return { payload, issued_at, registry, signature: sig };
}

export type { OperatorRecord };
