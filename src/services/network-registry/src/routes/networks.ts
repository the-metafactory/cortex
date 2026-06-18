/**
 * IAW D.4.2 — Network endpoints.
 *
 *   GET /networks/{network_id}
 *     S2.5 (#745, spec DD-12) — the network DESCRIPTOR: the registry-served
 *     `hub_url` + `leaf_port` (admin-seeded topology) plus the lightweight
 *     `members[]` view (derived from the roster). Returns a registry-signed
 *     assertion so a joining stack can pin the registry pubkey and verify the
 *     chain before deriving its nats-server leaf remote. 404 (`not_found`) when
 *     the network has never been seeded.
 *
 *   POST /networks/{network_id}            — signed-admin create/update (#747)
 *     The SECURE network-topology write. Replaces the descoped anonymous write
 *     (S2.5 #745 → #747): an admin signs canonicalJSON(claim) with an Ed25519
 *     key whose pubkey is in the `REGISTRY_ADMIN_PUBKEYS` allowlist. The route
 *     verifies the signature, checks the allowlist, applies clock-skew +
 *     nonce-replay, then UPSERTs. FAILS CLOSED when no admin key is configured
 *     (503, no write) so there is never an anonymous `hub_url` write — the
 *     descriptor-poisoning / federation-MITM vector DD-9 guards against.
 *     Mirrors the self-authenticating pattern of POST /principals/:id/register.
 *
 *   GET /networks/{network_id}/roster
 *     Query who's in this network. Membership is implicit: a principal is
 *     "in" a network if any of their announced capabilities lists that network.
 *     Returns a registry-signed assertion.
 */

import { Hono } from "hono";
import { getRegistryPublicKey, parseAdminPubkeys, type Env } from "../index";
import { signAssertion } from "./principals";
import { getNonceCache, getStore, membersFromPrincipals, rosterFromPrincipals } from "../store";
import {
  isValidNetworkId,
  validateNetworkCreateClaim,
  validateSignedNetworkCreate,
} from "../validate";
import { canonicalJSON, verifyEd25519 } from "../signing";
import {
  checkRateLimit,
  clientKey,
  retryAfterSeconds,
  TOO_MANY_REQUESTS_BODY,
} from "../rate-limit";
import type { NetworkDescriptor } from "../types";

/** Maximum clock skew accepted between the admin's `issued_at` and registry now. */
const CLOCK_SKEW_MS = 5 * 60 * 1000; // 5 minutes — mirrors the principal-register window.

export function networkRoutes(): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();

  // #747 — signed-admin network create/update. The SECURE replacement for the
  // descoped anonymous network write (S2.5 #745 → #747). An admin proves
  // possession of an allowlisted Ed25519 key by signing canonicalJSON(claim);
  // the route verifies the signature against `claim.admin_pubkey`, checks that
  // pubkey against `REGISTRY_ADMIN_PUBKEYS`, applies clock-skew + nonce-replay,
  // then UPSERTs the topology record. FAILS CLOSED: with no admin key
  // configured the write is refused and NOTHING is persisted — there is never
  // an anonymous hub_url write (the descriptor-poisoning / federation-MITM
  // vuln this issue closes).
  app.post("/networks/:network_id", async (c) => {
    const networkId = c.req.param("network_id");

    // FAIL-CLOSED, FIRST. Before path validation, rate-limit, JSON parse, or
    // any crypto: if no admin allowlist is configured the registry cannot
    // authorise ANY network write, so refuse with 503 and write NOTHING.
    // Doing this first means an unconfigured registry never even parses an
    // attacker's body, and the behaviour is unambiguous (no anonymous write
    // can slip through a later branch).
    const adminPubkeys = parseAdminPubkeys(c.env);
    if (adminPubkeys.size === 0) {
      return c.json(
        {
          error: "admin_not_configured",
          details:
            "REGISTRY_ADMIN_PUBKEYS not provisioned; network create/update is disabled (fail-closed). " +
            "Set the admin pubkey allowlist via `wrangler secret put` to enable signed-admin writes.",
        },
        503,
      );
    }

    // We must also be able to produce a signed receipt for the stored record
    // (GET /networks/:id serves a SignedAssertion). Refuse to mutate when the
    // registry's own signing key is absent — same guard the principal-register
    // route applies (Echo cortex#225 issue #1).
    if (!c.env.REGISTRY_SIGNING_KEY || !getRegistryPublicKey(c.env)) {
      return c.json(
        {
          error: "registry_unconfigured",
          details:
            "REGISTRY_SIGNING_KEY not provisioned; cannot accept network writes without producing a signed receipt",
        },
        503,
      );
    }

    if (!isValidNetworkId(networkId)) {
      return c.json({ error: "invalid network_id in path" }, 400);
    }

    // Rate-limit BEFORE the expensive signature verify (same ordering +
    // limit bucket as principal-register: mutation + Ed25519 compute). Key by
    // (IP, network_id) so a flood against one network can't hide behind a
    // shared egress IP, and one IP can't exhaust the limit across networks.
    const allowed = await checkRateLimit(c.env, "register", clientKey(c.req.raw, networkId));
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

    const envelopeCheck = validateSignedNetworkCreate(body);
    if (!envelopeCheck.ok) {
      return c.json({ error: "validation_failed", details: envelopeCheck.errors }, 400);
    }
    const { signed } = envelopeCheck;

    const claimCheck = validateNetworkCreateClaim(signed.claim, networkId);
    if (!claimCheck.ok) {
      return c.json({ error: "validation_failed", details: claimCheck.errors }, 400);
    }
    const { claim } = claimCheck;

    // Clock-skew check — reject claims dated too far past/future (replay
    // window + pre-signing guard), mirroring the principal-register route.
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

    // Signature verification FIRST (before recording the nonce — #695 rationale:
    // a bad-sig POST must not burn a durable nonce row). The admin signs
    // canonicalJSON(claim) with the key whose pubkey the claim declares.
    const message = new TextEncoder().encode(canonicalJSON(claim));
    const valid = await verifyEd25519(claim.admin_pubkey, signed.signature, message);
    if (!valid) {
      return c.json({ error: "signature_invalid" }, 401);
    }

    // Authorisation: the (cryptographically proven) admin_pubkey MUST be in the
    // configured allowlist. A valid signature from a NON-allowlisted key is a
    // 403 — possession is proven, but the key is not authorised to write
    // network topology. This is the core admin gate of #747.
    if (!adminPubkeys.has(claim.admin_pubkey)) {
      return c.json({ error: "admin_not_authorized" }, 403);
    }

    // Replay check — only on the authentic+authorised path so a nonce row is
    // consumed exclusively by a genuine admin write. A legit replay (valid
    // signature, previously-seen nonce) still rejects 409.
    const nonceCache = getNonceCache(c.env);
    const fresh = await nonceCache.recordIfFresh(claim.nonce, now);
    if (!fresh) {
      return c.json({ error: "nonce_replayed" }, 409);
    }

    const store = getStore(c.env);
    const record = await store.putNetwork(claim.network_id, claim.hub_url, claim.leaf_port);

    // Return the stored record wrapped in a registry-signed assertion — the
    // same shape GET /networks/:id serves, so the admin gets a verifiable
    // receipt of exactly what was persisted.
    const assertion = await signAssertion(c.env, record);
    return c.json(assertion, 201);
  });

  // S2.5 (DD-12) — the network descriptor. 404 when the topology was never
  // seeded; otherwise a signed descriptor the S1 client parses.
  app.get("/networks/:network_id", async (c) => {
    const networkId = c.req.param("network_id");
    if (!isValidNetworkId(networkId)) {
      return c.json({ error: "invalid network_id in path" }, 400);
    }
    const store = getStore(c.env);
    const record = await store.getNetwork(networkId);
    if (!record) {
      return c.json({ error: "not_found" }, 404);
    }
    const principals = await store.listPrincipals();
    const descriptor: NetworkDescriptor = {
      network_id: record.network_id,
      hub_url: record.hub_url,
      leaf_port: record.leaf_port,
      members: membersFromPrincipals(principals, networkId),
    };
    const assertion = await signAssertion(c.env, descriptor);
    return c.json(assertion);
  });

  app.get("/networks/:network_id/roster", async (c) => {
    const networkId = c.req.param("network_id");
    if (!isValidNetworkId(networkId)) {
      return c.json({ error: "invalid network_id in path" }, 400);
    }
    const store = getStore(c.env);
    const principals = await store.listPrincipals();
    const roster = rosterFromPrincipals(principals, networkId);
    const assertion = await signAssertion(c.env, roster);
    return c.json(assertion);
  });

  return app;
}
