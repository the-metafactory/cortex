# cortex-network-registry

IAW Phase D.4 — cloud-side network registry service. Hono REST API on
Cloudflare Workers. Canonical pubkey directory for the IAW federation
per Q3 lock-in (centralised, NOT NATS-gossiped). Cortex consults the
registry at startup + on schedule to refresh peer pubkeys.

Refs cortex#116 (Phase D umbrella) → `docs/plan-internet-of-agentic-work.md` §D.4.

## Endpoints

| Method | Path                                | Purpose                                           |
|--------|-------------------------------------|---------------------------------------------------|
| POST   | `/operators/{operator_id}/register` | Operator publishes signed assertion (D.4.2)       |
| GET    | `/operators/{operator_id}`          | Peers query operator's current pubkey + stacks    |
| GET    | `/networks/{network_id}/roster`     | Who's in this network                             |
| GET    | `/capabilities?query=<substring>`   | Capability search across networks                 |
| GET    | `/registry/pubkey`                  | Returns the registry's Ed25519 pubkey (pin this)  |
| GET    | `/api/health`                       | Liveness probe                                    |

## Trust model

- **POST register**: open at the HTTP layer; authenticity enforced by
  the signed assertion in the body. Operator signs canonical-JSON of
  the `RegistrationClaim` with their operator Ed25519 NKey; the
  registry verifies against the declared pubkey. TOFU on first sight.
  Subsequent registers MUST sign with the on-record pubkey.
- **GET responses**: wrapped in `SignedAssertion<T>` with a registry
  Ed25519 signature over `{ payload, issued_at, registry }`. Cortex
  peers pin the registry pubkey at config time and verify before
  mutating their local cache (D.4.4).
- **No CF Access bypass policies.** M2M traffic authenticates at the
  application layer via Ed25519. Same defense-in-depth as grove-api S-058.

## Storage (v1)

In-memory per-isolate. Acceptable for the initial endpoint surface +
test rig. **Persistence (D1 or KV) is a follow-up** before any
production traffic — see "Roadmap" below.

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
# One-time per environment: provision the signing key.
bunx wrangler secret put REGISTRY_SIGNING_KEY --env production
# Paste a base64-encoded PKCS#8 Ed25519 private key.

# Deploy
bunx wrangler deploy --env production
```

DNS for `network.meta-factory.ai` is provisioned at first deploy time;
the placeholder route in `wrangler.toml` is commented out and finalised
then.

## Roadmap (follow-ups)

These are explicitly out of scope for D.4 v1 and tracked as separate
issues (see cortex#116):

1. **Durable persistence.** Swap `InMemoryRegistryStore` for a D1
   implementation. Schema lives in `schema.sql`. The store interface
   in `store.ts` is the single seam.
2. **Pubkey rotation.** Accept a transition claim co-signed by the
   previous key. Currently silent rotation is rejected with HTTP 409.
3. **Pagination on `/capabilities`.** Hard-capped at 500 hits for v1.
4. **Per-operator publish rate limiting.** Replay protection covers
   one axis; throughput limiting is the other.
5. **Cortex-side consumer.** A `RegistryClient` in `src/bus/registry/`
   that consults the registry at startup + on schedule and invalidates
   on `system.operator.published` events (D.4.3). Filed alongside the
   D.2 / D.3 work — this service is the producer half.
