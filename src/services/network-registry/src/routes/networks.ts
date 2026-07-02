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
import { getRegistryPublicKey, parseAdminPubkeys, parseNetworkAdminPubkeys, type Env } from "../index";
import { signAssertion } from "./principals";
import {
  getIssuanceStore,
  getNonceCache,
  getStore,
  membersFromAdmissions,
  rosterFromAdmissions,
} from "../store";
import {
  isValidNetworkId,
  validateNetworkCreateClaim,
  validateSignedNetworkCreate,
  validateSignedNetworkRosterMemberRead,
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
    // #1414 — verify over the claim AS RECEIVED (canonicalJSON(signed.claim)),
    // NOT the whitelist reconstruction, converging on the #832 register pattern
    // so a future signed field (mirroring #1321's admin_pubkeys) can't silently
    // 401. The reconstruction (`claim`) still drives validation + the pubkey we
    // verify/authorise against (validation proved claim.admin_pubkey ===
    // signed.claim.admin_pubkey) + storage. Fail closed (401) if the shared
    // guarded canonicaliser throws on an over-deep/over-wide body (#832/#1418).
    let message: Uint8Array<ArrayBuffer>;
    try {
      message = new TextEncoder().encode(canonicalJSON(signed.claim)) as Uint8Array<ArrayBuffer>;
    } catch (_err) {
      return c.json({ error: "signature_invalid" }, 401);
    }
    const valid = await verifyEd25519(claim.admin_pubkey, signed.signature, message);
    if (!valid) {
      return c.json({ error: "signature_invalid" }, 401);
    }

    // Authorisation (#747 + #1321 per-network admin). The (cryptographically
    // proven) admin_pubkey must be authorised to write THIS network — either:
    //   (a) a GLOBAL admin (REGISTRY_ADMIN_PUBKEYS, the metafactory bootstrap), OR
    //   (b) a PER-NETWORK admin listed in the existing record's `admin_pubkeys`
    //       (the **Network posture (admin vs member)** authority — CONTEXT.md).
    // On CREATE (no existing record) there is no per-network set yet, so only a
    // global admin can create — network creation stays a hierarchical act
    // (RIR/IANA-style), per the federation-decentralisation research.
    const store = getStore(c.env);
    const existing = await store.getNetwork(networkId);
    const isGlobalAdmin = adminPubkeys.has(claim.admin_pubkey);
    const perNetworkAdmins = parseNetworkAdminPubkeys(existing?.admin_pubkeys);
    const isPerNetworkAdmin = perNetworkAdmins.has(claim.admin_pubkey);
    if (!isGlobalAdmin && !isPerNetworkAdmin) {
      return c.json({ error: "admin_not_authorized" }, 403);
    }

    // Anti-self-escalation (#1321): only a GLOBAL admin may set or change a
    // network's admin_pubkeys. A per-network admin governs the roster + topology
    // but cannot add co-admins or lock out the global admin. A per-network admin
    // who supplies admin_pubkeys is refused (403) rather than silently ignored,
    // so the attempt is visible.
    if (claim.admin_pubkeys !== undefined && !isGlobalAdmin) {
      return c.json({ error: "admin_pubkeys_requires_global_admin" }, 403);
    }

    // Replay check — only on the authentic+authorised path so a nonce row is
    // consumed exclusively by a genuine admin write. A legit replay (valid
    // signature, previously-seen nonce) still rejects 409.
    const nonceCache = getNonceCache(c.env);
    const fresh = await nonceCache.recordIfFresh(claim.nonce, now);
    if (!fresh) {
      return c.json({ error: "nonce_replayed" }, 409);
    }

    // Resolve the admin_pubkeys to persist: a global admin may set it from the
    // claim; otherwise PRESERVE the existing set (never clobber on a per-network
    // topology update). Always pass the resolved value so both store backends
    // write the same thing.
    const adminPubkeysToStore = isGlobalAdmin
      ? (claim.admin_pubkeys ?? existing?.admin_pubkeys)
      : existing?.admin_pubkeys;
    const record = await store.putNetwork(
      claim.network_id,
      claim.hub_url,
      claim.leaf_port,
      adminPubkeysToStore,
    );

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
    // ADR-0018 Q3/Gap-B — membership is sourced from ADMITTED admission rows
    // (the source of truth), NOT derived from announced capabilities. A
    // principal appears in `members[]` iff they hold an ADMITTED row for this
    // network; capabilities are joined on as an orthogonal facet (in /roster).
    const principals = await store.listPrincipals();
    const admitted = await getIssuanceStore(c.env).listIssuanceRequests("ADMITTED");
    const descriptor: NetworkDescriptor = {
      network_id: record.network_id,
      hub_url: record.hub_url,
      leaf_port: record.leaf_port,
      members: membersFromAdmissions(admitted, principals, networkId),
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
    // ADR-0018 Q3/Gap-B — roster sourced from ADMITTED admission rows, joining
    // each admitted principal's pubkey + this-network capabilities (the facet).
    const principals = await store.listPrincipals();
    const admitted = await getIssuanceStore(c.env).listIssuanceRequests("ADMITTED");
    const roster = rosterFromAdmissions(admitted, principals, networkId);
    const assertion = await signAssertion(c.env, roster);
    return c.json(assertion);
  });

  // ---------------------------------------------------------------------------
  // GET /networks/:network_id/roster/member — C-1282 (ADR-0018 Q4) member read
  //
  // The MEMBER-ACCESSIBLE read of a network's ADMITTED peer-roster. Released to
  // a caller who proves possession of an ADMITTED member key for THIS network —
  // the PoP signature IS the authorization (no admin key, no allowlist), mirror
  // of `/admission-requests/mine`. FAIL-CLOSED at the membership gate: the
  // proven pubkey MUST hold an ADMITTED row for `network_id`, else 403. A
  // non-member (never-registered, PENDING, REVOKED, or admitted to a DIFFERENT
  // network) learns nothing. The admitted-peer list is not sensitive to a
  // fellow admitted member (ADR-0018 Q4), so an admitted member sees the full
  // roster — the SAME payload the public `/roster` serves, minus no secrets
  // (the roster carries none; sealed blobs stay on the per-member `/mine`).
  //
  // This is a SEPARATE surface from the public `/networks/:id/roster` (which the
  // federation-transport resolve path consumes unauthenticated and is left
  // unchanged). It exists for the MC member posture (#1275/#1276) + hosted feed
  // (#1280), which authorize off the running stack's own registered key.
  // ---------------------------------------------------------------------------

  app.get("/networks/:network_id/roster/member", async (c) => {
    const networkId = c.req.param("network_id");
    if (!isValidNetworkId(networkId)) {
      return c.json({ error: "invalid network_id in path" }, 400);
    }

    // Rate-limit BEFORE the Ed25519 verify (read bucket — idempotent GET).
    // Key by IP ONLY — exactly as the `/admission-requests/mine` sibling does.
    // `network_id` is an attacker-controlled, format-only-validated path segment
    // (existence is not checked until the membership gate), so keying on it would
    // let one IP mint unbounded fresh read budgets by rotating the path, and the
    // "shed before the expensive verify + D1 read" guard this line exists for
    // would be bypassable. (The POST /networks mutation keys by (IP, network_id)
    // for per-network fairness, but that is a 5/60s admin-gated write — the wrong
    // precedent for a non-sensitive idempotent read whose gate sheds crypto.)
    const allowed = await checkRateLimit(c.env, "read", clientKey(c.req.raw));
    if (!allowed) {
      return c.json(TOO_MANY_REQUESTS_BODY, 429, {
        "Retry-After": String(retryAfterSeconds("read")),
      });
    }

    // Parse + validate the x-pop-signed header (signed-read so an
    // unauthenticated caller leaks NO roster metadata).
    const headerVal = c.req.header("x-pop-signed");
    if (!headerVal) {
      return c.json({ error: "x-pop-signed header required" }, 400);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(headerVal);
    } catch (_err) {
      return c.json({ error: "x-pop-signed must be valid JSON" }, 400);
    }
    const readCheck = validateSignedNetworkRosterMemberRead(parsed);
    if (!readCheck.ok) {
      return c.json({ error: "x-pop-signed validation_failed", details: readCheck.errors }, 400);
    }
    const { signed } = readCheck;

    // The signed claim binds the network — reject a token minted for a DIFFERENT
    // network than the path (a captured network-A token can't read network B).
    if (signed.claim.network_id !== networkId) {
      return c.json({ error: "network_id_mismatch" }, 400);
    }

    // Clock-skew — bound a captured read token's replay lifetime.
    const issued = Date.parse(signed.claim.issued_at);
    const now = Date.now();
    if (Math.abs(now - issued) > CLOCK_SKEW_MS) {
      return c.json({ error: "issued_at out of skew window" }, 400);
    }

    // Proof-of-possession — the signature over canonicalJSON(claim) MUST verify
    // against the claimed peer_pubkey. This signature IS the authorization: a
    // caller who cannot sign for the key gets nothing (401).
    const message = new TextEncoder().encode(canonicalJSON(signed.claim)) as Uint8Array<ArrayBuffer>;
    const valid = await verifyEd25519(signed.claim.peer_pubkey, signed.signature, message);
    if (!valid) {
      return c.json({ error: "signature_invalid" }, 401);
    }

    // FAIL-CLOSED membership gate — the proven pubkey MUST hold an ADMITTED row
    // for THIS network. A registered-but-PENDING key, a REVOKED key, or a key
    // admitted only to another network is NOT a member and gets 403 (no roster).
    const issuanceStore = getIssuanceStore(c.env);
    const myRows = await issuanceStore.listIssuanceRequestsByPeer(signed.claim.peer_pubkey);
    const isMember = myRows.some(
      (r) => r.status === "ADMITTED" && r.network_id === networkId,
    );
    if (!isMember) {
      return c.json({ error: "not_a_member" }, 403);
    }

    // Authorised — serve the network's ADMITTED roster (the same admission-sourced
    // shape the public `/roster` returns), wrapped in a registry-signed assertion
    // the member pins + verifies (DD-9).
    const store = getStore(c.env);
    const principals = await store.listPrincipals();
    const admitted = await issuanceStore.listIssuanceRequests("ADMITTED");
    const roster = rosterFromAdmissions(admitted, principals, networkId);
    const assertion = await signAssertion(c.env, roster);
    return c.json(assertion);
  });

  return app;
}
