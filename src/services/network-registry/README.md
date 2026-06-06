# cortex-network-registry

IAW Phase D.4 — cloud-side network registry service. Hono REST API on
Cloudflare Workers. Canonical pubkey directory for the IAW federation
per Q3 lock-in (centralised, NOT NATS-gossiped). Cortex consults the
registry at startup + on schedule to refresh peer pubkeys.

Refs cortex#116 (Phase D umbrella) → `docs/plan-internet-of-agentic-work.md` §D.4.

## Endpoints

| Method | Path                                  | Purpose                                           |
|--------|---------------------------------------|---------------------------------------------------|
| POST   | `/principals/{principal_id}/register` | Principal publishes signed assertion (D.4.2)      |
| GET    | `/principals/{principal_id}`          | Peers query principal's current pubkey + stacks   |
| GET    | `/networks/{network_id}`              | Signed network descriptor (`hub_url`/`leaf_port`/`members[]`, S2.5 DD-12) |
| GET    | `/networks/{network_id}/roster`       | Who's in this network                             |
| GET    | `/capabilities?query=<substring>`     | Capability search across networks                 |
| GET    | `/registry/pubkey`                    | Returns the registry's Ed25519 pubkey (pin this)  |
| GET    | `/api/health`                         | Liveness probe                                    |

## Trust model

- **POST register**: open at the HTTP layer; authenticity enforced by
  the signed assertion in the body. Principal signs canonical-JSON of
  the `RegistrationClaim` with their principal Ed25519 NKey; the
  registry verifies against the declared pubkey. TOFU on first sight.
  Subsequent registers MUST sign with the on-record pubkey.
- **GET responses**: wrapped in `SignedAssertion<T>` with a registry
  Ed25519 signature over `{ payload, issued_at, registry }`. Cortex
  peers pin the registry pubkey at config time and verify before
  mutating their local cache (D.4.4).
- **No CF Access bypass policies.** M2M traffic authenticates at the
  application layer via Ed25519. Same defense-in-depth as grove-api S-058.

## Storage

**D1-backed durable storage (cortex#682).** Both the principal directory
AND the nonce-replay cache are persisted in Cloudflare D1, so
registrations and replay protection survive Worker-isolate recycling.
This is the durability gate before the PROD deploy.

- `D1RegistryStore` — `principals` table (one row per principal;
  `stacks` / `capabilities` stored as JSON text columns). `putPrincipal`
  is a single atomic UPSERT; re-register replaces the row in place.
- `D1NonceCache` — `nonces` table keyed on the nonce. `recordIfFresh`
  is an atomic `INSERT ... ON CONFLICT DO NOTHING`; the nonce is fresh
  iff the insert created a row. Because D1 is a single logical database
  shared by every isolate/colo, **a replay against a different isolate
  within the skew window is now caught** — closing the cross-isolate
  replay gap the in-memory cache documented. Expired nonces are pruned
  opportunistically (`seen_at < now − NONCE_WINDOW_MS`).
- **SQLi-safe.** Every query is parameterised via `.bind(...)`; no value
  is ever string-interpolated into SQL.

The binding is `DB` in every environment (see `wrangler.toml`); only the
database id differs per env. Schema lives in `migrations/0001_init.sql`.

**In-memory fallback.** When no `DB` binding is present (`wrangler dev`
without a local D1, and `bun test`), `getStore(env)` / `getNonceCache(env)`
fall back to `InMemoryRegistryStore` / `InMemoryNonceCache`. The
in-memory backends are per-isolate and NOT durable — fine for the test
rig, not for production (which always binds D1).

### Applying migrations at deploy

```bash
# Dev
bunx wrangler d1 migrations apply cortex-network-registry-dev --env dev --remote
# Production
bunx wrangler d1 migrations apply cortex-network-registry --env production --remote
```

The POST `/principals/.../register` handler returns **503** when the
Worker is unconfigured (no `REGISTRY_SIGNING_KEY`) so mutation cannot
happen without a producible signed receipt. GET endpoints degrade to
an unsigned-but-structured response in the same condition; cortex
peers refuse to trust assertions with `registry: "unconfigured"`.

## Discovery vs. traffic gating

Principals announce themselves into networks by listing the network in
`capability.networks[]`. Anyone can announce into any network id —
the registry treats `network_id` as a public namespace label, and
attribution (principal A learns principal B exists in `secret-research`)
is visible without a join handshake. **This is intentional for v1**:
runtime gating (`accept_subjects` / `deny_subjects` from PR #223)
protects the *traffic* path; the discovery surface is open by design
to keep the registry an indexable directory rather than a sealed
membership registry. A join handshake is filed as a follow-up if a
deployment needs sealed namespaces.

## Local dev

```bash
cd src/services/network-registry
bun install
bunx wrangler dev
```

## Tests

```bash
bun test
```

Test suite uses `app.fetch(...)` against an in-process Worker — no
network. Generates fresh Ed25519 keypairs per test (WebCrypto) so
real-world signature paths are exercised.

## Deploy

```bash
# One-time per environment: generate the registry's signing keypair.
# Prints the base64 PKCS#8 private key (REGISTRY_SIGNING_KEY) + the raw
# base64 public key to pin client-side. Verified to round-trip through
# the Worker's own pubkeyFromPkcs8() before it emits.
bun run gen-key

# Provision the signing key (paste the printed REGISTRY_SIGNING_KEY value).
bunx wrangler secret put REGISTRY_SIGNING_KEY --env production
# The secret is a base64-encoded PKCS#8 Ed25519 private key (#677).

# Deploy
bunx wrangler deploy --env production
```

The `wrangler.toml` route points `network.meta-factory.ai` (prod) /
`network-dev.meta-factory.ai` (dev) at this Worker. The principal creates
the matching proxied DNS record in the `meta-factory.ai` zone, then runs
`wrangler deploy --env <env>`.

## Roadmap (follow-ups)

These are explicitly out of scope for D.4 v1 and tracked as separate
issues (see cortex#116):

1. ~~**Durable persistence.**~~ ✅ **Done (cortex#682).** `D1RegistryStore`
   backs the principal directory; schema in `migrations/0001_init.sql`.
   See §Storage.
2. ~~**Durable nonce cache.**~~ ✅ **Done (cortex#682).** `D1NonceCache`
   moves nonce storage into the same D1 layer as principals. An in-flight
   replay against a different isolate within the skew window is now
   caught durably — the cross-isolate gap is closed. See §Storage.
3. **Pubkey rotation.** Accept a transition claim co-signed by the
   previous key. Currently silent rotation is rejected with HTTP 409.
4. **Pagination on `/capabilities`.** Hard-capped at 500 hits for v1.
5. **Per-principal publish rate limiting + CORS origin allowlist on
   POST.** Replay protection covers one axis; throughput limiting +
   tightening from `origin: "*"` to a known principal-tooling origin
   list is the other. Bundled because both are about hardening the
   mutation surface before public DNS goes live.
6. **Cortex-side consumer.** A `RegistryClient` in `src/bus/registry/`
   that consults the registry at startup + on schedule and invalidates
   on `system.principal.published` events (D.4.3). Filed alongside the
   D.2 / D.3 work — this service is the producer half.
7. **Sealed-network join handshake.** If a deployment needs network
   membership to require explicit consent from existing members
   (rather than open-announce), add a per-network join protocol with
   an admission signature from a network admin's key.
