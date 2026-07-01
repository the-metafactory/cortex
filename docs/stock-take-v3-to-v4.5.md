# Stock-take — cortex v3.0.0 → v4.5.1

**As of:** 2026-06-05 · **Deployed:** v4.5.1 (whole fleet, config-split layout) · **Posture:** all confidentiality controls OFF by default (IoAW-first).

This is a synthesis of what cortex has become since the v3 vocabulary migration, the live deployment topology, and the remaining IoAW (Internet-of-Agentic-Work) backlog — especially the signing/encryption ramp that stays disabled until the surface is hardened.

---

## 1. Release arc (v3.0.0 → v4.5.1)

| Version | Date | Theme |
|---|---|---|
| v3.0.0 | 05-21 | Vocabulary migration (BREAKING) |
| v3.0.1–v3.0.3 | 05-26 | Sage review-bus fixes (verdict exit-code, `--post`, ack_wait dedup) |
| v3.1.0 | 05-29 | Bot-to-bot review reply loop + Discord stability |
| v4.0.0 | 06-01 | principal-identity vocabulary migration (BREAKING) |
| v4.1.0 | 06-03 | Unified surface gateway (inbound demux + outbound reply round-trip) |
| v4.2.0 | 06-04 | **Trust track**, network registry & Discord multi-server |
| v4.3.0 | 06-04 | Cross-stack guild isolation, stack-aware upgrades, nonce-before-verify |
| v4.4.0 | 06-04 | Session settings isolation (C-701 Part A) |
| v4.4.1 | 06-04 | Mission Control dashboard dist-path fix |
| v4.5.0 | 06-04 | Per-skill grants + Discord multi-stack hardening |
| v4.5.1 | 06-05 | Config-split-aware upgrade lifecycle |

### What was built, by theme
- **Vocabulary / identity (v3.0.0, v4.0.0):** the whole stack moved to the `principal` / `stack` / `assistant` ubiquitous language (the principal-identity cut was the breaking change). This is the identity grammar everything else keys on.
- **Surface gateway (v4.1.0):** one assistant can front many stacks — inbound demux + outbound reply round-trip through a single gateway seam.
- **Trust track + network registry (v4.2.0):** Ed25519 stack signing primitives (TC-1/TC-2), the cross-principal verify seam (TC-2d), and the deployed **network-registry** (`network.meta-factory.ai`, D1-durable, registry-signed assertions, proof-of-possession registration). This is the trust anchor for federation: pin the registry, resolve peers on demand — no per-assistant config.
- **Federated subject grammar (v4.x, ADR-0001 / #691):** federated subjects carry `federated.{principal}.{stack}.…`; the **network is never on the wire** — it's resolved from topology (`peers[].principal_id`). Supersedes the earlier `{network_id}` grammar.
- **Multi-stack / multi-network runtime:** one runtime hosts N stacks; each stack binds one NATS link per network. Stacks are a first-class, enumerable list (not three hardcoded names) — see §2.
- **Hardening sweep (v4.3–v4.5):** cross-stack guild isolation (#704), DM stack-ownership (#709), per-session Discord progress (#708), stack-aware upgrade lifecycle (#700/#717), session **settings isolation** (#701 Part A — bot sessions no longer inherit the principal's global `~/.claude` hooks/skills), and **per-skill capability grants** via a PreToolUse hook (#710, default-deny).
- **CI reliability (#699):** full-suite flakes (a real keypair-test correctness bug + subprocess/fs-watch races) fixed at the root.
- **Config-split (migration 0003):** monolithic `cortex.{stack}.yaml` → multi-file layout (`system/` + `network/` + `surfaces/` + `stacks/` per dir), one dir = one composed stack. See §2.

---

## 2. Live deployment topology

Two principals' worth of separation, multiple stacks, **two networks**:

```
metafactory network — NATS :4222
  ├── andreas/meta-factory   (Grove)  — Luna + Echo + Forge; owns Andreas's DMs
  └── andreas/work           (headless, no Discord)

halden network — NATS :4223 (HARD-ISOLATED, no leaf bridge)
  └── andreas/halden                  — Luna + Echo; guild-only (dmOwner: false)
```

- **Config-split is live + durable.** Every stack runs from `~/.config/cortex/<stack>/` (per-stack `system/system.yaml` + `stacks/<stack>.yaml` + a per-stack sentinel `<stack>.yaml`). The retained root monoliths are rollback anchors only.
- **The PID-collision lesson (migration 0003):** the `--config` sentinel **must** be named per-stack (`<stack>.yaml`) — the single-instance PID file derives from the `--config` basename, so a uniform `cortex.yaml` would collide on `cortex-cortex.pid`. Now `cortex-<slug>.pid`, all unique.
- **`arc upgrade cortex` is config-split-aware (#717):** it discovers per-stack dirs, renders `--config` at the sentinels, and ignores the monoliths — upgrades preserve the split. Verified live on the v4.5.1 deploy (the held #700 smoke-test).

### Config-migration pathway (for a new/existing stack)
Per `docs/migrations/0003-config-split-layout.md`:
1. Back up the monolith.
2. Split into `<stack>/{system/system.yaml, stacks/<stack>.yaml}` + a per-stack sentinel `<stack>/<stack>.yaml` (`nats.subjects` in exactly one place).
3. Validate byte-identical `LoadedConfig` (`composeRawConfig`).
4. Repoint the plist `--config` → the sentinel; reload that daemon; verify (unique `cortex-<slug>.pid`, Discord reconnect, sinks).
5. Rollback = repoint `--config` back at the monolith.

---

## 3. IoAW backlog — Trust & Confidentiality (#627 umbrella)

**Current posture: everything OFF.** No `security:` block in any live config → signing, mTLS, payload-encryption all default off. The live stacks run **unsigned + cleartext-over-TLS**. This is deliberate: get the Internet-of-Agentic-Work path working end-to-end first, *then* ramp the posture.

### The intended ramp (off → permissive → enforce, layer by layer)
The controls exist as toggles; the work is to **harden each, then enable it, then make it default**:

1. **Signing (TC-1 / TC-2 — code merged, OFF).** Ed25519 stack signing + `signed_by[]` chain + the cross-principal verify seam (TC-2d, registry-resolved peer pubkeys). Engages only under `security.signing: enforce`; under `off`/`permissive` there is zero registry I/O and federated envelopes verify local-only. **Next step to enable:** exercise signing in `permissive` on a real cross-stack flow, confirm the verify seam + registry resolution, then flip to `enforce` and make it the default.
2. **mTLS (TC-4d/4e — `future`).** #639 (NATS mTLS: tls surface on `NatsLink` + cortex.yaml/relay plumbing), #640 (cloud-publisher mTLS + non-TLS-leaf warning), #685 (wire `transport.mtls` env into the relay plist). The Bun-client-cert concern (#683) was resolved. **Enable after signing is enforced.**
3. **Payload encryption (TC-3 — designed, NOT implemented, DEFERRED).** `docs/design-envelope-encryption.md` exists; no implementation in `src/bus`. `federated.` payloads currently cross cleartext-over-TLS. **The biggest remaining confidentiality gap** — implement after mTLS.
4. **At-rest field encryption (TC-4c, #638 — `future`).** High-sensitivity columns (local SQLite + D1). Last in the ramp.

### Federated path (the IoAW loop — not yet closed)
- **#686 — federated review consumer (HELD, lockstep with pilot#149).** Built (#715) but found broken on independent review: verdict misrouted to self (requester parsed from the receiver's own subject segment, not `envelope.source`), a latent leak-shape (verdict routing not cross-checked vs source), and the `peers[]` gate isn't wired into the consumer path. Correct fix needs the pilot#149 wire contract (cross-repo). **This is the single piece between here and a working cross-principal review loop.**
- **#631 — F-3 multi-link/multi-network runtime** (one NATS leaf per network) — `next`.
- **#681 — registry enumeration/membership-exposure policy** for list endpoints (dev=prod) — `next`.
- **#417 — adapter payload sanitisation** (code-fence injection, Stage-4 trust model); **#413** channel-topology federation-by-default; **#404** federated CAS for attachment payloads — `future`.

---

## 4. Mission Control — UNTESTED

Mission Control (the v3 dashboard tree lifted from grove-v2, ~149 files: API, state, D1, dashboard-v2 React, CF worker, WebSocket) **has not been exercised at all** since the migration. v4.4.1 was only a dist-path fix. Before relying on it: a validation pass (the CF worker REST API + WebSocket round-trip, the dashboard build/deploy to CF Pages, the event pipeline end-to-end). **Treat MC as unverified** — it is the most likely place for migration rot to hide.

## 5. Signal — integrate post-hardening

Signal (telemetry/observability) hooks exist as backlog (#596 — emit gateway observability via signal/`system.*` bus events; #501 — adapter connection-health for signal: reconnect cadence, degraded durations, OTLP/JSONL export). **Deferred by design** until cortex's surface is hardened — wiring observability before the trust/MC surface is solid would instrument a moving target.

---

## 6. Recommended sequencing

1. **Validate Mission Control** (highest unknown — it's untested and load-bearing for the principal-facing surface).
2. **Close the IoAW loop:** pilot#149 ↔ #686 (federated consumer rework on the correct wire contract).
3. **Harden → enable the trust ramp, in order:** signing (`permissive` → `enforce` → default) → mTLS (#639/#640/#685) → payload encryption (TC-3) → at-rest (#638).
4. **Then integrate Signal** (#596/#501) once the surface is stable.
5. **Registry hardening** (#681 enumeration policy) alongside the signing-enforce flip.

The through-line: the multi-stack/multi-network surface and the trust *primitives* are built and deployed; what remains is (a) verifying the principal-facing surface (MC), (b) closing the federated loop (cross-repo), and (c) the deliberate, staged ramp of the confidentiality controls from off to default once each is hardened.
