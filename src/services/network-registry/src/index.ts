/**
 * IAW D.4 — Cortex network registry service (Cloudflare Worker).
 *
 * Hono REST API. Canonical pubkey directory for the IAW federation
 * (Q3 lock-in: centralised, NOT NATS-gossiped). Cortex consults the
 * registry at startup + on schedule to refresh peer pubkeys.
 *
 * Endpoints (D.4.2):
 *   POST /principals/{principal_id}/register
 *   GET  /principals/{principal_id}
 *   GET  /networks/{network_id}           — signed descriptor (S2.5, DD-12)
 *   GET  /networks/{network_id}/roster
 *   GET  /capabilities?query=<substring>
 *   GET  /registry/pubkey                 — pin this client-side
 *   GET  /api/health                      — liveness probe
 *
 * Trust model
 * ───────────
 * - POST /principals/.../register is open at the HTTP layer; authenticity
 *   is enforced by the signed assertion in the body (principal Ed25519
 *   signature over canonical-JSON of the claim, verified against the
 *   declared pubkey). First-sight is TOFU; subsequent registers MUST
 *   sign with the on-record pubkey. Rotation (transition claim co-signed
 *   by the previous key) is a v2 follow-up.
 * - GET responses are wrapped in a `SignedAssertion` carrying the
 *   registry's own Ed25519 signature over `{ payload, issued_at,
 *   registry }`. Cortex peers MUST pin the registry pubkey at config
 *   time and verify before mutating their local cache (D.4.4).
 *
 * No CF Access bypass policies. M2M traffic authenticates at the
 * application layer via Ed25519 — same defense-in-depth model as
 * grove-api S-058.
 */

import { Hono } from "hono";
import { cors } from "hono/cors";
import { createMiddleware } from "hono/factory";
import { principalRoutes } from "./routes/principals";
import { networkRoutes } from "./routes/networks";
import { capabilityRoutes } from "./routes/capabilities";
import { admissionRequestRoutes } from "./routes/admission-requests";
import { pubkeyFromPkcs8 } from "./signing";
import type { RateLimitEnv } from "./rate-limit";
import type { StoreEnv } from "./store";
import {
  checkRateLimit,
  clientKey,
  retryAfterSeconds,
  TOO_MANY_REQUESTS_BODY,
} from "./rate-limit";

export interface Env extends RateLimitEnv, StoreEnv {
  /**
   * Base64-encoded PKCS#8 Ed25519 private key used to sign GET
   * responses. Provisioned via `wrangler secret put` per the
   * wrangler.toml header. Absent in dev — see `signAssertion` for
   * the "unconfigured" fallback behaviour.
   */
  REGISTRY_SIGNING_KEY?: string;
  /**
   * Base64-encoded Ed25519 public key matching REGISTRY_SIGNING_KEY.
   * Computed at boot from the private key if unset — kept as a
   * separate env var so the lookup path through `signAssertion`
   * stays synchronous on the hot path.
   */
  REGISTRY_PUBLIC_KEY?: string;
  /**
   * #747 — comma-separated allowlist of base64 Ed25519 pubkeys authorised to
   * create/update network topology records via `POST /networks/{id}`. The
   * route FAILS CLOSED: when this is unset/empty the write is refused with
   * 503 `admin_not_configured` and NOTHING is persisted — there is never an
   * anonymous `hub_url` write (the descoped S2.5 vuln, #745 → #747).
   * Provisioned at deploy time via `wrangler secret put`; never a real key in
   * wrangler.toml. Whitespace around each entry is trimmed; empty entries are
   * ignored.
   */
  REGISTRY_ADMIN_PUBKEYS?: string;
  /**
   * ADR-0018 Q5 (PR5b) — comma-separated allowlist of base64 Ed25519 pubkeys
   * authorised to MINT/DELIVER per-member leaf secrets: the hub-admin authority
   * that writes the opaque sealed blob (`POST /admission-requests/{id}/
   * sealed-secret`) and revokes it (`/revoke`). DISTINCT from
   * `REGISTRY_ADMIN_PUBKEYS` (the registry-admin that signs the admit decision
   * and mints NOTHING) so a future network whose registry-admin ≠ hub-host keeps
   * the two authorities separable.
   *
   * COLLAPSE CASE: when this is unset/blank the gate FALLS BACK to
   * `REGISTRY_ADMIN_PUBKEYS` — for `metafactory` both authorities collapse into
   * Luna (FleetAdmit Tier-2 runs admit AND secret-delivery as one concierge
   * action), so one allowlist suffices. Set this separately only when the two
   * authorities must diverge.
   */
  REGISTRY_HUB_ADMIN_PUBKEYS?: string;
  /**
   * cortex#1996 D2 (RFC-0006 §8.1) — ERA FLAG for per-key `sealed_secrets[]`
   * delivery, DEFAULT OFF. When OFF (the default), the sealed-secret write route
   * behaves byte-identically to today: it only ever writes the SINGLE
   * `sealed_secret` slot, and a claim addressing any key other than the row's own
   * `peer_pubkey` is refused `409 identity_mismatch` (M17 unchanged). When ON, a
   * hub-admin write whose bound `peer_pubkey` is a COVERED live stack of the
   * row's principal (≠ the row's `peer_pubkey`) is accepted and appended to the
   * per-key array — the covered-2nd-stack transport path (#1748). The RECEIVE
   * side (reading + selecting an array entry) is ALWAYS on and is harmless while
   * the array is empty; this flag gates only the wire-observable EMIT-acceptance.
   * The D7 require-present flip is a SEPARATE, dated, gated step — NOT this flag.
   *
   * Accepted truthy values: `"true"`, `"1"`, `"on"` (case-insensitive). Anything
   * else — unset, blank, `"false"`, junk — is OFF (fail-closed default).
   */
  SEALED_SECRETS_ARRAY_EMIT?: string;
  ENVIRONMENT?: string;
}

/**
 * cortex#1996 D2 — is the per-key `sealed_secrets[]` array-EMIT era enabled?
 * Fail-closed: only an explicit truthy token flips it on; the default (unset /
 * blank / anything unrecognised) is OFF, so the single-slot path stays live.
 */
export function isSealedSecretsArrayEmitEnabled(env: Env): boolean {
  const raw = env.SEALED_SECRETS_ARRAY_EMIT;
  if (typeof raw !== "string") return false;
  const v = raw.trim().toLowerCase();
  return v === "true" || v === "1" || v === "on";
}

/**
 * #747 — parse `REGISTRY_ADMIN_PUBKEYS` into the set of authorised admin
 * pubkeys. Returns an EMPTY set when the var is unset/blank/whitespace-only,
 * which the network-create route treats as "admin not configured" → 503
 * fail-closed. Entries are trimmed; blank entries dropped.
 */
export function parseAdminPubkeys(env: Env): Set<string> {
  return parsePubkeySet(env.REGISTRY_ADMIN_PUBKEYS);
}

/**
 * ADR-0018 Q5 (PR5b) — parse the HUB-admin allowlist (`REGISTRY_HUB_ADMIN_PUBKEYS`)
 * for the sealed-secret-write + revoke routes. When that var is unset/blank the
 * two authorities collapse: we FALL BACK to `REGISTRY_ADMIN_PUBKEYS` (the
 * metafactory case where Luna is both authorities). Returns an EMPTY set only
 * when NEITHER var is configured → the hub-admin routes 503 fail-closed.
 */
export function parseHubAdminPubkeys(env: Env): Set<string> {
  const hub = parsePubkeySet(env.REGISTRY_HUB_ADMIN_PUBKEYS);
  return hub.size > 0 ? hub : parseAdminPubkeys(env);
}

/**
 * #1321 — parse a network's per-network `admin_pubkeys` field into a set. Same
 * comma-separated base64 grammar as the global allowlist; an unset/blank field
 * yields an EMPTY set (→ "this network defers to the global admins only").
 */
export function parseNetworkAdminPubkeys(raw: string | undefined): Set<string> {
  return parsePubkeySet(raw);
}

/** Shared parser: comma-separated base64 pubkeys → trimmed, non-empty set. */
function parsePubkeySet(raw: string | undefined): Set<string> {
  if (typeof raw !== "string" || raw.trim().length === 0) return new Set();
  return new Set(
    raw
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
  );
}

const app = new Hono<{ Bindings: Env }>();

// ---------------------------------------------------------------------------
// CORS — registry is read-public by design; lock origins as deployment grows.
// ---------------------------------------------------------------------------

app.use(
  "*",
  cors({
    origin: "*", // OK for v1 — responses are signed; reads are non-sensitive.
    allowMethods: ["GET", "POST", "OPTIONS"],
    allowHeaders: ["Content-Type"],
  }),
);

// ---------------------------------------------------------------------------
// On-boot: derive the registry pubkey from the signing key if not provided
// explicitly. We piggyback on a request-scoped initialiser to keep the
// global state simple — the derived key is cached at module scope and
// read by `signAssertion` without mutating `c.env`.
//
// Echo cortex#225 issue #4: previously we patched `c.env.REGISTRY_PUBLIC_KEY`
// per-request. Treating `env` as mutable works on Bun (plain object) but is
// a footgun on real Workers, where `env` is frozen-ish and the runtime may
// snapshot it. Module-scoped cache + explicit getter is the safer shape.
// ---------------------------------------------------------------------------

let derivedPublicKey: string | undefined;
let derivedFromKey: string | undefined;

async function ensurePublicKey(env: Env): Promise<void> {
  if (env.REGISTRY_PUBLIC_KEY) {
    // Caller-provided pubkey wins; mirror into the module cache so
    // `getRegistryPublicKey` short-circuits without re-checking env.
    if (derivedFromKey !== env.REGISTRY_SIGNING_KEY) {
      derivedPublicKey = env.REGISTRY_PUBLIC_KEY;
      derivedFromKey = env.REGISTRY_SIGNING_KEY ?? "explicit";
    }
    return;
  }
  if (!env.REGISTRY_SIGNING_KEY) return;
  if (derivedFromKey === env.REGISTRY_SIGNING_KEY && derivedPublicKey) return;
  try {
    const pub = await pubkeyFromPkcs8(env.REGISTRY_SIGNING_KEY);
    derivedPublicKey = pub;
    derivedFromKey = env.REGISTRY_SIGNING_KEY;
  } catch (err) {
    // Surface as a 500 once a request lands; do not throw at boot
    // because the Worker would crash-loop and lose the diagnostic.
    // The pubkey route emits the structured error.
    console.error(
      `[network-registry] failed to derive pubkey: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Read the registry public key without mutating `env`. Routes that need
 * the pubkey at request time call this; `signAssertion` resolves it via
 * the same path. Returns `undefined` if the Worker is unconfigured.
 */
export function getRegistryPublicKey(env: Env): string | undefined {
  return env.REGISTRY_PUBLIC_KEY ?? derivedPublicKey;
}

/** Test-only — reset module-scoped derivation cache between cases. */
export function _resetDerivedPublicKeyForTest(): void {
  derivedPublicKey = undefined;
  derivedFromKey = undefined;
}

app.use("*", async (c, next) => {
  await ensurePublicKey(c.env);
  await next();
});

// ---------------------------------------------------------------------------
// Health + pubkey
// ---------------------------------------------------------------------------

app.get("/api/health", (c) =>
  c.json({
    status: "ok",
    service: "cortex-network-registry",
    runtime: "cloudflare-workers",
    environment: c.env.ENVIRONMENT ?? "unknown",
    api_version: 1,
  }),
);

app.get("/registry/pubkey", (c) => {
  const pub = getRegistryPublicKey(c.env);
  if (!pub) {
    return c.json(
      {
        error: "registry_unconfigured",
        details:
          "REGISTRY_SIGNING_KEY not provisioned; this Worker is running in dev/no-key mode and cannot produce signed assertions",
      },
      503,
    );
  }
  return c.json({ algorithm: "Ed25519", public_key: pub });
});

// ---------------------------------------------------------------------------
// Read rate-limit (#680) — looser IP-keyed limit on the load-bearing GET
// surface. Applied to the resolve / roster / capabilities reads, NOT to
// /api/health or /registry/pubkey (liveness + pin probes must stay cheap and
// always-answerable; throttling a health check would be counterproductive).
//
// The register mutation has its OWN, stricter limit enforced inside the handler
// (rate-limit BEFORE signature verify — see routes/principals.ts) so the gate
// can fold principal_id into the key and shed bad-sig floods before the
// expensive Ed25519 path.
//
// Limits are byte-identical on dev and prod (code constants in rate-limit.ts).
// ---------------------------------------------------------------------------

const readLimited = createMiddleware<{ Bindings: Env }>(async (c, next) => {
  const allowed = await checkRateLimit(c.env, "read", clientKey(c.req.raw));
  if (!allowed) {
    return c.json(TOO_MANY_REQUESTS_BODY, 429, {
      "Retry-After": String(retryAfterSeconds("read")),
    });
  }
  await next();
});

app.use("/principals/:principal_id", readLimited);
// #747 — the network descriptor path now serves BOTH GET (read) and POST
// (signed-admin create/update). Scope the loose READ limit to GET only; the
// POST has its OWN, stricter `register`-bucket limit enforced inside the
// handler (rate-limit BEFORE signature verify), exactly like
// POST /principals/:id/register. Applying both to the POST would mean a single
// admin write is metered against two buckets — the strict one is the
// authoritative gate, so the read limit must not also fire on POST.
app.on("GET", "/networks/:network_id", readLimited);
app.use("/networks/:network_id/roster", readLimited);
app.use("/capabilities", readLimited);

// ---------------------------------------------------------------------------
// Mount route groups
// ---------------------------------------------------------------------------

app.route("/", principalRoutes());
app.route("/", networkRoutes());
app.route("/", capabilityRoutes());
// ADR-0015: admission gate routes (the canonical, only paths — the hub-minted-identity
// issuance-request routes were retired here; the registry is not yet deployed,
// so there are no consumers to keep a compat shim for).
app.route("/", admissionRequestRoutes());

// ---------------------------------------------------------------------------
// 404
// ---------------------------------------------------------------------------

app.notFound((c) => c.json({ error: "not_found" }, 404));

// ---------------------------------------------------------------------------
// Error handler — log and return a structured 500 so peers don't get HTML.
// ---------------------------------------------------------------------------

app.onError((err, c) => {
  console.error(`[network-registry] unhandled error: ${err.message}\n${err.stack ?? ""}`);
  return c.json({ error: "internal_error" }, 500);
});

export default app;
