# SOP — Network join (one command)

**Status:** active (S6 / Network Join Control Plane epic #733)
**Owner:** principal
**Audience:** a **principal** joining one of their **stacks** to a **network** (a federation of peer principals whose stacks interconnect at the NATS leaf-node layer), and the mirror-image join on the peer side.
**Authoritative detail:** [`CONTEXT.md`](../CONTEXT.md) §Scope/§Network · [`docs/adr/0003-network-join-control-plane.md`](./adr/0003-network-join-control-plane.md) (binding DDs) · [`docs/design-network-join-control-plane.md`](./design-network-join-control-plane.md) (the spec) · [`compass/sops/federation-wire-protocol.md`](https://github.com/the-metafactory/compass/blob/main/sops/federation-wire-protocol.md) (the wire grammar this rides on, unchanged).
**Supersedes:** the manual, cloudflared-led [`docs/runbook-federation-peering.md`](./runbook-federation-peering.md) (#728) for the steady-state case. That runbook is retained only as the offline / hand-pin fallback.

> **What changed.** Joining a network used to be ~10 manual steps across four Myelin layers, two config files, and an out-of-band key swap (the design spec §1 friction table). It is **now one command**. The registry is the source of truth; the command absorbs every step in that table.

---

## Pre-flight

After reading this SOP, output:

```
SOP: network-join | network: {name} | mode: {dry-run|apply} | step: {register?→join→status}
```

Verify before proceeding:

- You know the **network id** to join (lowercase, letter-prefixed — e.g. `metafactory`).
- You have the **registry URL** and the **pinned registry pubkey** (DD-9 — the trust anchor; without the pin the join is trust-on-first-use).
- Your stack has a **signing seed** (`--seed-path`), a **NATS leaf `.creds`** file, and the local **nats-server config** + **launchd plist** the daemon loads.
- `join`/`leave` **default to dry-run** — they print the intended actions and touch nothing. Add `--apply` only when you mean to mutate the live deployment.

---

## The flow (≤3 steps — the "feel like TCP/IP" test)

The success test for this control plane (spec §9): joining a network feels like a machine joining the internet — plug in and it works. If the flow below grows past these three steps, that is a **bug in the design**, not the principal's problem — flag it.

### Step 1 — Register the stack identity (once per stack)

Skip if this stack is already registered with the network's registry. Registration is idempotent.

```bash
cortex provision-stack register <principal-id> \
  --seed-path ~/.config/nats/cortex.nk \
  --registry-url https://network.meta-factory.ai \
  --stack-id <principal-id>/<stack>
```

This proves possession of the stack's signing key and publishes the stack's pubkey + capabilities to the registry, so peers resolve you (DD-2/DD-5). `--stack-id` defaults to `<principal-id>/default`.

### Step 2 — Join the network

```bash
cortex network join <network> \
  --principal <principal-id> \
  --registry-url https://network.meta-factory.ai \
  --registry-pubkey <base64-registry-pubkey> \
  --seed-path ~/.config/nats/cortex.nk \
  --creds ~/.config/nats/leaf.creds \
  --account <A…-nkey-U> \
  --nats-config ~/.config/nats/<conf>.conf \
  --plist ~/Library/LaunchAgents/ai.meta-factory.cortex.<stack>.plist \
  --apply
```

`join` performs the whole §1 sequence, idempotently (DD-4): register (if needed) → pull the **signature-verified** network descriptor (`hub_url`/`leaf_port` from the registry, DD-12; cached fallback on a registry outage, DD-10) → render the nats-server leaf remote + ensure the plist loads it (DD-6) → write `policy.federated.networks[]` with **registry-resolved** peers (DD-5) plus the stack's own accept-subject → restart.

**Run it without `--apply` first.** The default dry-run prints every action with no disk or daemon mutation, so you see exactly what the live run will do. `--apply` and `--dry-run` are mutually exclusive.

Optional flags: `--stack <principal>/<slug>` (defaults to `<principal>/default`), `--leaf-node <name>` (leaf connection name; defaults to the network id), `--max-hop <n>` (hop budget; defaults to 1), `--json` (machine-readable `{ status, items, data, error }` envelope).

### Step 3 — Verify

```bash
cortex network status --principal <principal-id> [--stack <principal>/<slug>] [--monitor-url <nats-monitor-url>]
```

Shows each joined network with its leaf link state, resolved peers, accept-subjects, max-hop, and in/out counters. A healthy join shows the leaf `link:` established and the expected peers listed.

---

## Leaving a network

```bash
cortex network leave <network> \
  --principal <principal-id> \
  --nats-config ~/.config/nats/<conf>.conf \
  --plist ~/Library/LaunchAgents/ai.meta-factory.cortex.<stack>.plist \
  --apply
```

`leave` reverses a join cleanly and idempotently: removes the network entry + its leaf include, drops the plist `-c` config arg if no networks remain, and restarts. Like `join`, it defaults to dry-run; pass `--apply` to execute. Re-running on a network you are not joined to is a no-op.

---

## Security posture (what protects the join)

The join control plane is additive over the unchanged wire grammar (DD-1). The control-plane trust properties:

- **Registry-resolved peers** (DD-5) — `peers[]` carry `principal_id`; cortex resolves the pubkey + stack from the registry roster at config-load. No hand-maintained pubkey lists in steady state.
- **Pin + verify the registry** (DD-9) — cortex verifies **every** registry response (descriptor, roster, principal) against the pinned registry pubkey before trusting a resolved peer key. An unverified response is rejected. Pass `--registry-pubkey` to pin; omitting it is trust-on-first-use.
- **Fail-closed on mismatch** (DD-11) — if a peer has both a hand-pinned pubkey and a *different* registry-resolved key, that peer is refused and an alert is raised. A divergence is a drift/attack signal, never a merge.
- **Cached-roster degradation** (DD-10) — a transient registry outage uses the last-known-good cached roster and warns loudly; federation stays up, it is not silently torn down.
- **Dry-run by default** — `join`/`leave` never mutate the live deployment without `--apply`.

**Security ramp is orthogonal to join** (DD-7). Joining works at any signing posture (`off → permissive → enforce`); ramping signing changes the crypto verification on the *data plane*, never who you are joined to. Confidentiality (mTLS on the leaf, payload encryption) is a separate axis — see [`docs/runbook-federation-peering.md`](./runbook-federation-peering.md) §"After the test works".

---

## Scopes — local / federated / public

This SOP covers the **federated** scope (joining a named network of peer principals). The other two onboarding tiers (CONTEXT.md §Scope, spec §3):

- **local** — a stack's own bus (loopback nats-server); the home broadcast domain. **Zero-config** — it is home, the runtime's primary link. Nothing to join.
- **federated** — a named network of peer principals. **This SOP** — registry-mediated `cortex network join <network>`.
- **public** — the open square (the Internet of Agentic Work); unrestricted, carries no principal/stack segment. Opt-in publish/discover of capabilities openly. See **S5 / #739** for the public-scope opt-in.

---

## When the one command is not enough

Reach for the manual fallback in [`docs/runbook-federation-peering.md`](./runbook-federation-peering.md) (#728) only when:

- there is **no reachable registry** for the network, or
- you need an **offline hand-pin** of a peer (DD-5's fallback: a `principal_pubkey` pasted out-of-band).

Bringing up a **brand-new network** before its descriptor exists is **not** a fallback case — it is its own one command: a network admin runs `cortex network create <network> --hub <tls-url> --leaf-port <port> --admin-seed <seed> --apply` to write the topology row, then principals `join` it as below. See [`sop-stack-onboarding.md` §B1](./sop-stack-onboarding.md) for the full create flow + the one-time `REGISTRY_ADMIN_PUBKEYS` prerequisite (#747).

Otherwise, the one command above is the path. If a join step still demands NATS/PKI expertise, that is a design bug (spec §9) — file it against #733.
