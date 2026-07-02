/**
 * IAW D.4.2 — Principal endpoints.
 *
 *   POST /principals/{principal_id}/register
 *     Principal publishes a signed assertion containing their pubkey,
 *     stack identities, and capability declaration. The registry
 *     verifies the signature, checks the nonce, applies clock-skew
 *     bounds, and upserts the record.
 *
 *   GET /principals/{principal_id}
 *     Peers query a principal's current pubkey + stack list. Response
 *     is wrapped in a `SignedAssertion` carrying the registry's
 *     signature so the caller can verify before caching.
 */

import { Hono } from "hono";
import { getRegistryPublicKey, type Env } from "../index";
import { signEd25519, verifyEd25519, canonicalJSON } from "../signing";
import { getNonceCache, getStore, getIssuanceStore, StaleRecordError } from "../store";
import {
  checkRateLimit,
  clientKey,
  retryAfterSeconds,
  TOO_MANY_REQUESTS_BODY,
} from "../rate-limit";
import type { PrincipalRecord, SignedAssertion } from "../types";
import {
  isValidPrincipalId,
  validateRegistrationClaim,
  validateSignedRegistration,
} from "../validate";

/** Maximum clock skew accepted between principal's `issued_at` and registry now. */
const CLOCK_SKEW_MS = 5 * 60 * 1000; // 5 minutes

export function principalRoutes(): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();

  app.post("/principals/:principal_id/register", async (c) => {
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
    const principalId = c.req.param("principal_id");
    if (!isValidPrincipalId(principalId)) {
      return c.json({ error: "invalid principal_id in path" }, 400);
    }

    // #680 — rate-limit BEFORE the expensive signature verify. Register is the
    // strictest limit (mutation + Ed25519 compute). We key by (IP, principal_id)
    // so one principal hammering register can't hide behind a shared/NAT egress
    // IP, and one IP can't exhaust the limit across many principals. Placing
    // this here — after the cheap path validation, before JSON parse + verify —
    // means a flood of bad-signature registers is shed early rather than burning
    // verify compute. The limit value is a code constant identical on dev+prod
    // (see rate-limit.ts RATE_LIMITS.register).
    const allowed = await checkRateLimit(
      c.env,
      "register",
      clientKey(c.req.raw, principalId),
    );
    if (!allowed) {
      return c.json(TOO_MANY_REQUESTS_BODY, 429, {
        "Retry-After": String(retryAfterSeconds("register")),
      });
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

    const claimCheck = validateRegistrationClaim(signed.claim, principalId);
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

    // Signature verification. The principal signs canonical-JSON(claim)
    // with their declared pubkey. TOFU on first register (the claim
    // tells us which key to verify against); rotation requires the
    // previous key to sign a transition claim — out of scope for v1,
    // tracked as a follow-up.
    //
    // #832 — verify the signature over the claim AS RECEIVED ON THE WIRE
    // (`signed.claim`), NOT over the server's validated *reconstruction*
    // (`claim`). The reconstruction (validate.ts) rebuilds the claim from a
    // fixed whitelist of known fields; verifying against it means ANY
    // validly-signed field the reconstruction does not (yet) echo silently
    // changes the canonical bytes and 401s a legitimate register. That is
    // exactly the #825→#832 regression: the client began signing
    // `expected_updated_at` into the CAS-bearing add-stack claim, and a
    // registry whose reconstruction dropped that field rejected every such
    // register with `signature_invalid` — a canonicalization drift between
    // what the client SIGNED and what the server VERIFIED. The signed
    // contract is "the principal signs canonicalJSON(claim); the registry
    // verifies the SAME bytes", so the one canonical form is the received
    // claim. Structural validation already ran above (malformed → 400), and
    // STORAGE still uses the whitelisted `claim` — so an unknown/forward
    // field is signed-but-ignored, never persisted. Tamper resistance is
    // unchanged: mutating any field after signing changes these very bytes,
    // so the signature (over the original) still fails closed (401).
    //
    // #695 — verify the signature BEFORE recording the nonce. The nonce
    // cache is durable (D1, #694), so an unsigned/bad-signature POST that
    // recorded its nonce first would permanently burn that nonce row
    // without ever proving authenticity. A replay is only meaningful for
    // an authentic (validly-signed) claim, so we shed bad-sig POSTs with
    // 401 here and only consume a nonce on the authentic path below.
    let canonical: string;
    try {
      canonical = canonicalJSON(signed.claim);
    } catch (_err) {
      // #832 — canonicalJSON throws CanonicalDepthError on a pathologically
      // deep (hostile) claim. Fail closed: an over-depth payload can never
      // match a legitimate signature, so treat it as a bad signature (401)
      // rather than surfacing a 500.
      return c.json({ error: "signature_invalid" }, 401);
    }
    const message = new TextEncoder().encode(canonical);
    const valid = await verifyEd25519(claim.principal_pubkey, signed.signature, message);
    if (!valid) {
      return c.json({ error: "signature_invalid" }, 401);
    }

    // Replay check — only reached once the signature is proven valid, so
    // a nonce row is consumed exclusively on the authentic path. A legit
    // replay (valid signature, previously-seen nonce) still rejects 409.
    const nonceCache = getNonceCache(c.env);
    const fresh = await nonceCache.recordIfFresh(claim.nonce, now);
    if (!fresh) {
      return c.json({ error: "nonce_replayed" }, 409);
    }

    // Pubkey rotation policy for v1:
    //   - First register for a principal_id: accept any pubkey.
    //   - Subsequent registers MUST sign with the same pubkey already
    //     on record. We reject silent key swaps to protect the chain
    //     of trust peers have already cached. Rotation comes back in
    //     a follow-up that accepts a transition claim co-signed by
    //     the previous key.
    const store = getStore(c.env);
    const existing = await store.getPrincipal(principalId);
    if (existing && existing.principal_pubkey !== claim.principal_pubkey) {
      return c.json(
        {
          error: "pubkey_rotation_not_supported",
          details: "rotation requires a transition claim co-signed by the previous key (v2 feature)",
        },
        409,
      );
    }

    // C-787 — per-stack pubkey backfill. The signature has been verified
    // against `claim.principal_pubkey` (the ROOT/authority key), so by signing
    // this claim the principal root ATTESTS every stack_pubkey it carries.
    // A stack that omits `stack_pubkey` (a producer predating per-stack keys,
    // or the single-stack first-register case) inherits the root pubkey — so
    // an existing single-stack principal keeps verifying with no producer
    // change. A stack that carries its OWN stack_pubkey is taken as-is (the
    // root signed it, so it is authorized). This is the authorization model:
    // adding/updating any stack pubkey is gated entirely by the root signature
    // verified above — a claim signed by a non-root key never reaches here
    // (it is rejected 409 at the rotation gate or 401 at signature_invalid).
    const stacksWithPubkeys = claim.stacks.map((s) => ({
      ...s,
      stack_pubkey: s.stack_pubkey ?? claim.principal_pubkey,
    }));

    // #825 — optimistic concurrency. The client read-merged from a record at
    // `claim.expected_updated_at`; CAS the write so a concurrent host that
    // mutated the row in between is rejected (409) rather than silently
    // clobbered. Absent on a first register → unconditional upsert (unchanged).
    let record: PrincipalRecord;
    try {
      record = await store.putPrincipal(
        principalId,
        claim.principal_pubkey,
        stacksWithPubkeys,
        claim.capabilities,
        claim.expected_updated_at,
      );
    } catch (err) {
      if (err instanceof StaleRecordError) {
        return c.json(
          {
            error: "stale_record",
            details:
              "the principal record changed since your read; re-read, re-merge, and retry",
            current_updated_at: err.current?.updated_at ?? null,
          },
          409,
        );
      }
      throw err;
    }

    // O-4a.1 — issuance-request hook. AFTER successful registration, upsert a
    // PENDING issuance request for the peer's principal pubkey. This is additive:
    // it does not change the response body or the principal record. Idempotent:
    // re-registration of the same peer_pubkey returns the existing request row
    // without creating a duplicate.
    //
    // We use the first stack's stack_pubkey (or the root principal_pubkey when
    // the claim carries no stacks) as the peer_pubkey on the issuance request.
    // This is the key that federated envelopes FROM this peer will be verified
    // against (per C-787). The requested_scope is derived from the principal_id.
    //
    // Errors here do NOT reject the registration — a failure to create the
    // issuance request must not reject a valid registration: the principal
    // record is already committed, and a retry of the issuance upsert is always
    // safe (idempotent). But the failure MUST NOT be silent (cortex#1263): a
    // swallowed upsert leaves a principal in `principals` with NO PENDING
    // admission row, so the admin sees nothing to admit and the registrant
    // believes they are queued. We therefore (a) emit a loud, structured
    // `system.error` log carrying enough context for a monitor / on-call to act,
    // and (b) surface a non-fatal warning on the register RESPONSE so the
    // registering cortex can tell its principal "registered, but your admission
    // request didn't land — re-register to retry."
    const peerPubkey =
      stacksWithPubkeys[0]?.stack_pubkey ?? claim.principal_pubkey;
    const requestedScope = `federated.${principalId}.>`;
    let admissionRequestFailed = false;
    try {
      const issuanceStore = getIssuanceStore(c.env);
      // ADR-0018 Gap-A — stamp the target network the joiner named (signed into
      // the claim) onto the PENDING admission row. This makes the idempotency
      // key `(principal_id, peer_pubkey, network_id)`, so the same stack can
      // request admission to two networks. A network-less register (no
      // `network_id` in the claim) creates a network-less PENDING row.
      await issuanceStore.upsertPending(
        principalId,
        peerPubkey,
        requestedScope,
        claim.network_id,
      );
    } catch (err) {
      admissionRequestFailed = true;
      // Loud, structured system.error signal — mirrors the registry's other
      // non-fatal error surfacing (`console.error` with the `[network-registry]`
      // prefix, picked up by the platform log drain / monitor). The token
      // `system.error admission_request_upsert_failed` is greppable; the context
      // (principal_id, peer_pubkey, network_id, scope, error) is everything a
      // monitor / on-call needs to diagnose and re-raise the PENDING row.
      console.error(
        `[network-registry] system.error admission_request_upsert_failed ` +
          `principal_id=${principalId} ` +
          `peer_pubkey=${peerPubkey} ` +
          `network_id=${claim.network_id ?? "(none)"} ` +
          `requested_scope=${requestedScope} ` +
          `error=${err instanceof Error ? err.message : String(err)}`,
      );
      // Intentionally non-fatal: the principal record is committed. The caller
      // is told via the response warning below.
    }

    // Sign + return the canonical view so the principal gets the same
    // signed assertion shape peers will see.
    const assertion = await signAssertion(c.env, record);
    if (admissionRequestFailed) {
      // Additive, back-compat: the signed `payload`/`issued_at`/`registry`/
      // `signature` fields are unchanged (clients that ignore extra fields keep
      // working). The `admission_request: "failed"` flag + human-readable
      // `warning` tell the registering cortex that registration succeeded but
      // the admission request did NOT land — re-registering self-heals because
      // `upsertPending` is idempotent.
      return c.json(
        {
          ...assertion,
          admission_request: "failed" as const,
          warning:
            "registered, but the PENDING admission request could not be created; re-register to retry (the upsert is idempotent)",
        },
        201,
      );
    }
    return c.json(assertion, 201);
  });

  app.get("/principals/:principal_id", async (c) => {
    const principalId = c.req.param("principal_id");
    if (!isValidPrincipalId(principalId)) {
      return c.json({ error: "invalid principal_id in path" }, 400);
    }
    const store = getStore(c.env);
    const record = await store.getPrincipal(principalId);
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
    // ONLY for GET-path callers; POST `/principals/.../register` rejects
    // before reaching here (see the 503 guard in the register handler,
    // Echo cortex#225 issue #1). The registry pubkey field is required
    // by the type, so set it to a sentinel string clients can detect
    // ("unconfigured"). Cortex peers MUST refuse to trust a sentinel-
    // keyed assertion; the agent logs this loudly via the audit channel.
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

export type { PrincipalRecord };
