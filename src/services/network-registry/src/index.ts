/**
 * IAW D.4 — Cortex network registry service (Cloudflare Worker).
 *
 * Hono REST API. Canonical pubkey directory for the IAW federation
 * (Q3 lock-in: centralised, NOT NATS-gossiped). Cortex consults the
 * registry at startup + on schedule to refresh peer pubkeys.
 *
 * Endpoints (D.4.2):
 *   POST /operators/{operator_id}/register
 *   GET  /operators/{operator_id}
 *   GET  /networks/{network_id}/roster
 *   GET  /capabilities?query=<substring>
 *   GET  /registry/pubkey                 — pin this client-side
 *   GET  /api/health                      — liveness probe
 *
 * Trust model
 * ───────────
 * - POST /operators/.../register is open at the HTTP layer; authenticity
 *   is enforced by the signed assertion in the body (operator Ed25519
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
import { operatorRoutes } from "./routes/operators";
import { networkRoutes } from "./routes/networks";
import { capabilityRoutes } from "./routes/capabilities";
import { pubkeyFromPkcs8 } from "./signing";

export interface Env {
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
  ENVIRONMENT?: string;
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
// global state simple — the derived key is cached at module scope.
// ---------------------------------------------------------------------------

let derivedPublicKey: string | undefined;
let derivedFromKey: string | undefined;

async function ensurePublicKey(env: Env): Promise<void> {
  if (env.REGISTRY_PUBLIC_KEY) return;
  if (!env.REGISTRY_SIGNING_KEY) return;
  if (derivedFromKey === env.REGISTRY_SIGNING_KEY && derivedPublicKey) {
    // Already derived for this signing key — patch env (per-request) and exit.
    env.REGISTRY_PUBLIC_KEY = derivedPublicKey;
    return;
  }
  try {
    const pub = await pubkeyFromPkcs8(env.REGISTRY_SIGNING_KEY);
    derivedPublicKey = pub;
    derivedFromKey = env.REGISTRY_SIGNING_KEY;
    env.REGISTRY_PUBLIC_KEY = pub;
  } catch (err) {
    // Surface as a 500 once a request lands; do not throw at boot
    // because the Worker would crash-loop and lose the diagnostic.
    // The pubkey route emits the structured error.
    process.stderr.write(
      `[network-registry] failed to derive pubkey: ${err instanceof Error ? err.message : String(err)}\n`,
    );
  }
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
  if (!c.env.REGISTRY_PUBLIC_KEY) {
    return c.json(
      {
        error: "registry_unconfigured",
        details:
          "REGISTRY_SIGNING_KEY not provisioned; this Worker is running in dev/no-key mode and cannot produce signed assertions",
      },
      503,
    );
  }
  return c.json({ algorithm: "Ed25519", public_key: c.env.REGISTRY_PUBLIC_KEY });
});

// ---------------------------------------------------------------------------
// Mount route groups
// ---------------------------------------------------------------------------

app.route("/", operatorRoutes());
app.route("/", networkRoutes());
app.route("/", capabilityRoutes());

// ---------------------------------------------------------------------------
// 404
// ---------------------------------------------------------------------------

app.notFound((c) => c.json({ error: "not_found" }, 404));

// ---------------------------------------------------------------------------
// Error handler — log and return a structured 500 so peers don't get HTML.
// ---------------------------------------------------------------------------

app.onError((err, c) => {
  process.stderr.write(`[network-registry] unhandled error: ${err.message}\n${err.stack ?? ""}\n`);
  return c.json({ error: "internal_error" }, 500);
});

export default app;
