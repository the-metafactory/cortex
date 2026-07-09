> **Superseded by [`docs/sop-onboard-peer-principal.md`](./sop-onboard-peer-principal.md) for the end-to-end peer-onboarding path.** Retained for: network join mechanics (all four subcommands: join, leave, status, create), multi-stack join (`--principal-seed`), and the security ramp (`off → permissive → enforce`).

# SOP — Network join (one command)

**Status:** active (S6 / Network Join Control Plane epic #733)
**Owner:** principal
**Audience:** a **principal** joining one of their **stacks** to a **network** (a federation of peer principals whose stacks interconnect at the NATS leaf-node layer), and the mirror-image join on the peer side.
**Authoritative detail:** [`CONTEXT.md`](../CONTEXT.md) §Scope/§Network · [`docs/adr/0003-network-join-control-plane.md`](./adr/0003-network-join-control-plane.md) (binding DDs) · [`docs/design-network-join-control-plane.md`](./design-network-join-control-plane.md) (the spec) · [`compass/sops/federation-wire-protocol.md`](https://github.com/the-metafactory/compass/blob/main/sops/federation-wire-protocol.md) (the wire grammar this rides on, unchanged).
**Supersedes:** the manual, cloudflared-led [`docs/runbook-federation-peering.md`](./runbook-federation-peering.md) (#728) for the steady-state case. That runbook is retained only as the offline / hand-pin fallback.

> **What changed.** Joining a network used to be ~10 manual steps across four Myelin layers, two config files, and an out-of-band key swap (the design spec §1 friction table). It is **now one command**. The registry is the source of truth; the command absorbs every step in that table.

---

## Managing networks (the whole command surface)

`cortex network` is the control plane for a stack's network lifecycle. Four subcommands, one mental model — joining a network should feel like a machine joining the internet (spec §9):

| Command | What it does | Notes |
|---|---|---|
| **`cortex network create <id>`** | Network admin stands up a NEW network's topology row in the registry — a **signed-admin** claim, **no raw SQL / no D1 write** (#747). Required flags: `--hub <tls-url>`, `--leaf-port <port>`, `--admin-seed <path>` (an `SU…` nkey seed — the same key shape `provision-stack` uses). Optional `--network-admins <csv>` sets the network's **per-network admin set** — a comma-separated list of base64 Ed25519 pubkeys (44 chars each), shipped #1326 / [ADR-0020](./adr/0020-per-network-admin-authority.md). `--registry-url` defaults to `https://network.meta-factory.ai`. **Dry-run by default**; pass `--apply` to POST. | One-time per registry: the admin pubkey must be on the registry's `REGISTRY_ADMIN_PUBKEYS` allowlist or the route fails closed (`503 admin_not_configured` / `403 admin_not_authorized`). **`--network-admins` is global-admin-only** (ADR-0020): a per-network admin who supplies it is refused `403 admin_pubkeys_requires_global_admin`. The value **overwrites** the stored admin set (it is not appended); **omitting** it on an update **preserves** the existing admins. See [`sop-stack-onboarding.md` §B1](./sop-stack-onboarding.md). |
| **`cortex network join <id>`** | A principal joins one of their **stacks** to an existing network: register → pull the signature-verified descriptor → render the leaf + load the daemon → write `policy.federated.networks[]` → restart. Idempotent. Derives everything from `cortex.yaml` (#753). | **Single-stack** (first stack): just `cortex network join <id>`. **Multi-stack** (a principal's 2nd+ stack): add `--principal-seed <root-seed>` (#791 — see [§ Multi-stack join](#multi-stack-join-a-principals-2nd-stack-791)). **Dry-run by default**; pass `--apply`. |
| **`cortex network status`** | Read-only: joined networks, leaf link state, resolved peers, accept-subjects, max-hop, in/out counters. | `--principal <id>` required; `--stack`, `--monitor-url`, `--json` optional. |
| **`cortex network leave <id>`** | Reverse a join cleanly + idempotently: drop the network entry + leaf include, remove the daemon's `-c` config arg if no networks remain, restart. | **Dry-run by default**; pass `--apply`. |
| **`cortex network admit <request-id>`** | (Admin) Approve a PENDING peer onto the network roster (`register → PENDING → ADMITTED`). Admin-signed; **mints nothing** (ADR-0015). Existing members are grandfathered (migration 0009 ADMITTED backfill). | `--admin-seed <path>` required; `--network`, `--apply` (dry-run by default). |
| **`cortex network secret add-member \| revoke-member \| rotate <id> <pubkey>`** | (Admin) Leaf-secret + network-key lifecycle (ADR-0018/0019). `add-member` mints a per-member leaf PSK and **seals it to the member's pubkey** (default `--deliver sealed`; `join` auto-fetches); `rotate` re-seals a fresh key to remaining members; `revoke-member` drops a member's PSK. | `--admin-seed <hub-admin-seed>` required; `--deliver sealed\|oob`, `--apply` (dry-run by default). |

**The one rule that bites:** a stack's nats bus must be **operator-mode** (it must define the `account` the leaf binds to) to federate onto an operator-mode hub. An **anonymous / hard-isolated** bus (the `halden` / `community` pattern — no NSC operator, no accounts) **cannot federate** as-is: the rendered leaf remote references an account the server doesn't know and `nats-server` crashes (`cannot find local account`). Convert the bus to operator-mode first — this is now automated: `cortex network provision <slug> --apply` (mints your operator + accounts, records `stack.nats_infra.config_path`) then `cortex network make-live <slug> --apply` (bootstraps the operator-mode config — no raw `nsc generate config`). See [`sop-stack-onboarding.md` §B0.1 — Operator-mode bus prerequisite](./sop-stack-onboarding.md#b01--the-bus-must-be-operator-mode-the-794-lesson) (#794, cortex#1265). Manual fallback: copy [`docs/config-layout/nats-server.conf.example`](./config-layout/nats-server.conf.example), fill your JWTs, and pass `--nats-config <path>`.

**The second thing that bites — a stale leaf credential (clear + reissue).** The transport credential is now a **hub-minted, sealed scoped `.creds`** (the operator-mode scoped-user model — [ADR-0023](./adr/0023-federation-leaf-credential-model.md), which superseded the ADR-0018 PSK). A **stale/mismatched sealed `.creds` on the registry row** makes every `cortex network join --apply` re-fetch + re-render a leaf the hub rejects — an **Authorization-Violation storm on each attempt** (recovering forces a restart back onto the safe config). Fix: (1) confirm the member's stack is registered with the right pubkey/stack_id; (2) you **re-run `cortex network secret add-member <net> <member-pubkey> --admin-seed <hub-admin-seed> --hub-config <the real hub> --leaf-user <principal>/<stack> --apply`** — it re-mints a fresh scoped `.creds` (`arc reissue-federated-user`: revoke+push old key, re-mint) and **re-seals over the stale row** (needs `resolver_mode: nats`); (3) the member re-runs `join`. The scoped `.creds` **is** hub-minted **transport** — that is the model, not a sidestep. What stays the **rejected Model A** ([ADR-0013](./adr/0013-sovereign-federation-model.md)) is a hub-minted **identity** account (authenticating *as who you are* inside the hub's operator); your `SU` signing key is always your own. When the hub is another principal's server, the mint+seal is theirs (two-party, [ADR-0023](./adr/0023-federation-leaf-credential-model.md) / [ADR-0018](./adr/0018-admission-gate-and-leaf-secret-distribution.md)).

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

## Multi-stack join: a principal's 2nd+ stack (#791)

A **principal** may run more than one stack (e.g. `andreas/meta-factory` and `andreas/community`). The registry stores **one** record per principal carrying **all** their stacks, and the registry's `POST /principals/{id}/register` is a **full-overwrite** of the `stacks` column authorized by the principal's **root** key (the first stack's seed). So a naive second-stack register signed by the *new* stack's own key is unauthorized — historically it `409`-ed.

To join a **second or later** stack, pass `--principal-seed <root-seed>` — the FIRST stack's seed:

```bash
cortex network join <network> \
  --config ~/.config/cortex/<slug>/<slug>.yaml \
  --principal-seed ~/.config/nats/cortex.nk \
  --apply
```

What `--principal-seed` does on the register step (mirrors `cortex provision-stack register --principal-seed`, #791):

- The add-stack claim is **signed by the root** (the authorization the registry requires), while the stack's own `--seed-path` key (derived from config) becomes the new stack's `stack_pubkey`.
- cortex **fetch-merges** the principal's existing stacks from the registry and re-attests the full set, so the principal's **other stacks survive** the full-overwrite (they are not dropped).
- It is **idempotent**: re-running, or running `join` after a separate `provision-stack register`, no-ops when the stack is already on record. `--principal-seed` is therefore only needed to register a genuinely NEW 2nd+ stack — not to re-run a converged one.

**Boundaries:**

- **Omit `--principal-seed` for a first-stack join** — then `--seed-path` is itself the root (the original behavior).
- On the standalone `provision-stack register --principal-seed` path, the **pinned `--registry-pubkey` is required** (C-791 security): the merge-read of existing stacks is signature-verified against the pin before it drives the destructive full-overwrite, so a compromised registry can't silently omit (drop) a stack. The `network join` path threads the pin from config (`policy.federated.registry.pubkey`).
- `--principal-seed` is **flag-only** — there is no `cortex.yaml` field for the principal root seed (no natural home), so it must be passed explicitly when adding a stack.

> **Prerequisite, same as any join:** the second stack's bus must be **operator-mode** (see [Managing networks](#managing-networks-the-whole-command-surface) + [`sop-stack-onboarding.md` §B0.1](./sop-stack-onboarding.md#b01--the-bus-must-be-operator-mode-the-794-lesson)). `andreas/community` is the worked example that surfaced #794: its registration succeeded with `--principal-seed`, but its leaf link was blocked until the bus was made operator-mode.

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

**Security ramp is orthogonal to join** (DD-7). Joining works at any signing posture (`off → permissive → enforce`); ramping signing changes the crypto verification on the *data plane*, never who you are joined to. Confidentiality (payload encryption) is a separate axis and **ships as of v5.27.0**: a network is a trust group and all federated payloads (Direct/Delegate/Offer) are sealed with one per-network key `K`. Enable it per-network with `policy.federated.networks[].encryption: enabled` + `payload_key: <K>` once the link is up — see [`sop-onboard-peer-principal.md` §Step 8 — Go private](./sop-onboard-peer-principal.md) and [ADR-0019](./adr/0019-federated-payload-encryption.md).

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
