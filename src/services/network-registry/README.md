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

## Storage (v1)

In-memory per-isolate. Acceptable for the initial endpoint surface +
test rig. **Persistence (D1 or KV) is a follow-up** before any
production traffic — see "Roadmap" below.

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
   implementation. The store interface in `store.ts` is the single
   seam; the SQL schema will land alongside the D1 implementation
   (intentionally NOT shipped as an empty stub in this PR).
2. **Durable nonce cache.** The per-isolate `InMemoryNonceCache`
   protects against delayed replays via the 5-minute skew check, but
   an in-flight replay against a different isolate within the skew
   window CAN succeed. Move nonce storage into D1 (or a dedicated KV
   namespace with strict consistency) at the same time as #1 so the
   replay window collapses to the route-layer skew bound.
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
