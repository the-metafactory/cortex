# SOP — Onboard a peer principal (sovereign federation path, ADR-0013)

**Status:** active (G5 / cortex#1121 — supersedes the 6 fragmented SOPs below for the end-to-end path) · **Author:** Luna (for Andreas) · **Refs:** ADR-0013, cortex#1116 (audit epic), cortex#1121 (this doc)

**Supersedes (end-to-end path):** `sop-stack-onboarding.md` · `sop-network-join.md` · `sop-federation-onboarding.md` · `sop-network-registry.md` · `sop-stack-identity.md` · `runbook-federation-peering.md`

> **Retained detail.** Each of those six SOPs carries reference material not duplicated here (registry internals, stack-identity rotation, network join mechanics, the manual hand-pin fallback). They each carry a supersede banner pointing back to this runbook. Do not delete them.

---

## 1. The model in one paragraph

The federation model (ADR-0013) is **sovereign**: every principal runs their own NSC operator and signs the wire with their **own `SU` key** — nobody mints your identity. A leaf link is a **secret-authenticated transport pipe**: one side runs the hub, the other connects in as a remote. The **local** bind is to a **local NATS account in your own NSC operator** (operator-mode, the standard) or `$G` (the fallback). The **transport credential** that authenticates the pipe to the hub is a **hub-minted, sealed scoped `.creds`** the hub-admin mints under the hub's FED account ([ADR-0023](./adr/0023-federation-leaf-credential-model.md), which superseded the ADR-0018 PSK). What crosses `federated.>` is governed by an **export/import** each principal runs in their own store. Network isolation is by subject scope (`federated.{principal}.{stack}.>` plus per-network `accept_subjects`). **Model A — a hub minting your *identity* account (authenticating *as who you are* inside the hub's operator) — is not supported** ([ADR-0013](./adr/0013-sovereign-federation-model.md)); the hub minting your *transport* `.creds` is a different layer and **is** the delivered model (ADR-0023). If you have no NSC operator yet, standing one up is the first step, and the tooling makes it trivial.

---

## Core concepts: App vs principal vs slug

**Three different kinds of thing.** A Discord **App**, a **principal**, and a **slug** are not variants of one idea — they are a *Discord object*, a *human identity*, and a *stack label* respectively. Conflating them is the most common onboarding stumble, so get them straight before the steps below.

- **Discord App** — the bot identity in Discord; its token is what the stack authenticates with. **Scope:** one per stack instance, reused across guilds (the C-704 `guildId` filter isolates each stack). **How to choose:** name it after the assistant / stack, *not* after a server.
- **principal** — the human the assistant answers to; the root of the trust and policy model. **Scope:** one human, one or more stacks. **How to choose:** a GitHub username is fine — stable, unique, something you won't want to rename.
- **slug** — the label for *this* stack / deployment. It's the second subject segment (`local.{principal}.{slug}.…`) and the config dir name. **Scope:** one per stack. **How to choose:** name it for the scope it serves. `community`, `work`, `halden` are *examples, not reserved words* — `halden` is just a location handle (a Norwegian city). Don't reuse a CONTEXT.md scope term such as `public` for a closed stack.

**Rule of thumb:**
- **App name** — the assistant's public face: one, reused across servers.
- **principal** — *you*: a GitHub handle is fine.
- **slug** — *this stack's* private label: descriptive of THIS deployment.

One bot identity (the App) can serve **N guilds** — you do **not** create a new App per Discord server. You create a second App only when you run a genuinely separate stack: different brain, different principal. See [`CONTEXT.md`](../CONTEXT.md#principals-stacks-networks) for the canonical glossary entries.

---

## 2. The happy path, end to end

This is the ordered sequence for a **new peer principal** joining an existing network. Both principals go through the same steps on their own side; the two irreducible two-party moments are called out explicitly in section 3.

### Prerequisites

Before Step 1, confirm your machine has:

- **Bun** — the only supported runtime (`bun --version`). Never use npm / yarn / node.
- **NATS server with JetStream** — one isolated bus per stack (`nats-server --version`). A federating stack's bus must also be operator-mode (NSC operator + the account the leaf binds to); see Step 3.
- **Claude Code, authenticated** — the default execution substrate for dispatched work (`claude --version`).
- **`arc`** *(recommended)* — the metafactory package manager (`arc --version`). It manages install, the launchd lifecycle, and signing-seed provisioning; `arc upgrade cortex` auto-provisions your stack's NKey seed on first install. Cortex runs without it, but you then provision the seed and lifecycle by hand.

**`soma` is not required** to run cortex — it is a separate, optional layer.

Canonical prereq source: [`README-AGENTS.md` §1](../README-AGENTS.md#1-prerequisites).

### Step 1 — Stand up your own stack

If you do not have a cortex stack yet, create one. The command scaffolds a born-aligned config-split skeleton (slug == `stack.id` trailing segment, no drift can form) and sets `stack.nkey_seed_path` to the conventional path:

```bash
cortex stack create <slug> --principal <principal> --apply
```

Then fill the `<REPLACE_ME>` secrets (Discord token/guild/channels). `arc upgrade cortex` auto-provisions the NKey seed on first install.

If you already have a stack, skip to step 2.

Reference: [`sop-stack-onboarding.md`](./sop-stack-onboarding.md) for the full stack bring-up SOP (bus config, plist, verify).

### Step 2 — Generate the stack signing identity

Mint (or confirm you already have) your stack's Ed25519 signing NKey — the key that signs every envelope your stack publishes:

```bash
cortex provision-stack generate <principal> \
  --seed-path ~/.config/nats/cortex-<slug>.nk \
  --stack-id <principal>/<slug>
```

This prints your `nkey_pub` (`U…`, 56 chars). Keep the seed chmod 600 — it is the root of secret material for this stack. If the seed already exists (provisioned by `arc upgrade`), run `register` instead of `generate` (step 4b).

### Step 3 — Ensure your bus is operator-mode

Your stack's local NATS bus must be **operator-mode** (it must define your NSC operator, the system (SYS) account — **required** whenever JetStream is enabled, which is the default; `cortex network provision` mints and wires it for you (cortex#1333), so no raw `nsc add account SYS` is needed — and the resolver preload including the federation account) before it can bind a leaf link to an operator-mode hub. A hard-isolated anonymous bus (no NSC operator, no accounts) cannot federate.

> **What operator-mode means here.** Your bus config must include the NSC operator JWT, `system_account` (required whenever JetStream is enabled — the default; `cortex network provision` wires it for you, cortex#1333), `resolver: MEMORY`, and `resolver_preload` containing your federation account (and, once landed, your agents account). Keep your stack's own `server_name`, `listen` port, `jetstream.domain`, and `http` monitor port — `cortex network join` renders its own leaf include for your stack.

**You no longer hand-edit this (cortex#1265).** `cortex network provision` (step 4a) now **exports the operator-mode JWTs** — operator + federation account (+ SYS account, when present) — into `stack.nats_infra.{operator_jwt, account_jwt, system_account, system_account_jwt}`. From there the conversion is automatic and command-only:

- **Federating stack →** `cortex network join` (step 6) reads those fields and **renders the operator-mode `.conf` for you** (O-3 conversion). You run **zero `nsc generate config`**.
- **Local-only stack (never federates) →** `cortex network make-live <slug> --apply` **bootstraps** the initial operator-mode resolver from the same JWTs (and lands the daemon on its agents account). Again, no raw `nsc`.

If your stack is already on an operator-mode bus (most established stacks are), nothing to do — both paths are idempotent and never clobber a hand-tuned `.conf`.

> **Manual fallback only.** The hand-edit in [`sop-stack-onboarding.md §B0.1`](./sop-stack-onboarding.md#b01--the-bus-must-be-operator-mode-the-794-lesson) is now a last-resort fallback, not the happy path — prefer `cortex network provision` + `join`/`make-live`.

### Step 4a — Mint your account tree (one command)

Stand up your sovereign account tree — your NSC operator, a **dedicated federation account** (separate from your agents account so federation traffic is blast-radius-isolated from internal work), the per-stack agents account, the `federated.>` export/import wiring, and the **operator-mode JWT export** (cortex#1265) — in a single command:

```bash
cortex network provision <principal>/<slug> --apply
```

> **Status (G1d + cortex#1265).** This wraps `arc nats init-operator` + `add-account` (federation + agents) + `add-federation-export` + `export-{operator,account,system}`. It is **non-disruptive** — it writes only config (the account pubkeys AND the operator-mode JWTs into `stack.nats_infra`), never the `.conf` and never restarts the bus. The raw `nsc add account` / `nsc generate config` steps this SOP used to teach are gone; provision now covers account creation and the JWT export wholesale. Dry-run by default; pass `--apply` to mint.

`cortex network provision` writes the federation account's NKey (`A…`) to `stack.nats_infra.account` and the operator-mode JWTs alongside it — no manual edit required.

### Step 4b — Register your stack identity with the network registry

Publish your stack's public key to the registry so peer principals can resolve it:

```bash
cortex provision-stack register <principal> \
  --seed-path ~/.config/nats/cortex-<slug>.nk \
  --registry-url https://network.meta-factory.ai \
  --stack-id <principal>/<slug>
```

This is proof-of-possession: the claim is signed by the very key it declares. The registry verifies clock skew, nonce replay, and the Ed25519 signature before storing.

> **Adding a second or later stack.** If you already have a registered principal record, pass `--principal-seed <root-seed>` (your first stack's seed) so the registry can root-authorize the add-stack claim and fetch-merge your existing stacks.

Pin the registry in your stack config (`stacks/<slug>.yaml`):

```yaml
policy:
  federated:
    registry:
      url: https://network.meta-factory.ai
      pubkey: ErrjFoLzi4jw7TuTqjPMg5OnQCH0oKUClWgr8VyYHmk=  # PIN — 44 chars incl. '='
```

The pinned pubkey is the trust anchor. Without pinning, the client uses TOFU at first boot (a network-path attacker could substitute their own anchor). Obtain the pubkey out-of-band or from `GET https://network.meta-factory.ai/registry/pubkey`.

### Step 5 — Get admitted to the network roster (two-party gate)

The network admin must **consciously admit your stack** to the network roster. This is the ADR-0015 admission gate: it controls who is recognised as a peer, and **mints nothing** — the credential exchange is step 5b below.

**Your side (submit an admission request):**

```bash
# Register your stack with the network registry — creates a PENDING admission request.
cortex provision-stack register <principal> \
  --registry-url https://network.meta-factory.ai \
  --seed-path ~/.config/nats/cortex-<slug>.nk \
  --stack-id <principal>/<slug> \
  --network <network>
```

**Hub side (the network admin admits the request):**

```bash
# List pending requests (C-1314) — admin-signs the query, prints the queue
# (request-id · principal · network · peer · status · created) so you can copy
# the request-id. --status defaults to PENDING; --network filters client-side.
cortex network admit --list-pending \
  --registry-url https://network.meta-factory.ai \
  --admin-seed ~/.config/nats/admin.nk

# Admit (approves roster membership; mints nothing). The network_id is read from
# the stored request (set at register time) — there is no --network flag here.
cortex network admit <request-id> \
  --registry-url https://network.meta-factory.ai \
  --admin-seed ~/.config/nats/admin.nk \
  --apply

# ...OR deny it (C-1348). The mirror of admit — signs a decision:"reject" claim,
# moves the PENDING row to REJECTED. Grants + seals nothing (no roster row, no
# leaf PSK). Same admin gate as admit; dry-run by default, --apply to execute.
cortex network reject <request-id> \
  --registry-url https://network.meta-factory.ai \
  --admin-seed ~/.config/nats/admin.nk \
  --apply
```

Saying **no** is as easy as saying **yes**: `reject` is the deliberate denial of a
PENDING request. An already-decided (non-PENDING) request surfaces a clear
"already ADMITTED/REJECTED/REVOKED" error rather than silently no-op'ing.

> **Read-scoping caveat (ADR-0020 fast-follow):** admin *reads* — including
> `--list-pending` — are **global-admin-only** today; a per-network admin gets a
> readable `403 admin_not_authorized` even for their own network. Use a global-
> admin seed (or the MC admission queue / Pier) until per-network read-scoping
> lands.

**Step 5b — Receive the leaf shared secret (sealed, automatic)**

Once you are admitted, the admin runs the leaf-secret tooling on the hub. The default delivery is **sealed** — the admin seals a per-member leaf PSK to your already-registered pubkey, so you never handle a raw secret:

```bash
# Hub side (admin) — mint + seal a per-member leaf PSK to the member's registered pubkey:
cortex network secret add-member <network> <your-stack-pubkey> \
  --admin-seed ~/.config/nats/admin.nk \
  --apply
```

The sealed blob lands in the registry (**ciphertext only** — the registry never sees the PSK). Your `cortex network join` (Step 6) **auto-fetches and unseals it with your own seed** — there is no `.creds` file to place and no secret to copy. (Bootstrap / air-gapped fallback: `--deliver oob` surfaces the PSK on the admin's terminal for a manual handoff; you then pass `--leaf-secret` / `--leaf-user` to `join`.)

This is the same sealed channel that later carries the network **payload key** `K` (Step 8) — one primitive, one pipe ([ADR-0018](./adr/0018-admission-gate-and-leaf-secret-distribution.md) / [ADR-0019](./adr/0019-federated-payload-encryption.md)). Note the federation account NKey (`A…`) — it goes in `stack.nats_infra.account`.

### Step 6 — Join the network (one command)

```bash
# Dry-run first — inspect what will be written before touching the live deployment:
cortex network join <network> --config ~/.config/cortex/<slug>/<slug>.yaml

# Then apply:
cortex network join <network> --config ~/.config/cortex/<slug>/<slug>.yaml --apply
```

The join command performs the full sequence idempotently:
- Pulls the **signature-verified** network descriptor (`hub_url`/`leaf_port`) from the registry
- Runs the **local-side export/import** (`arc nats add-federation-export`) that wires your federation account to your agents account so `federated.>` can physically flow across account boundaries — a single-store operation on your own NSC operator, no peer account needed
- Renders the `leafnodes` include into your NATS config and ensures the plist loads it
- Writes `policy.federated.networks[]` with registry-resolved peers and your `accept_subjects`
- Restarts the daemon

> **Second or later stack.** Add `--principal-seed ~/.config/nats/cortex.nk` (your first stack's seed, #791) so the add-stack claim is root-signed and your existing stacks survive the full-overwrite.

### Step 7 — Verify

```bash
cortex network status --principal <principal> --stack <principal>/<slug>
```

A healthy join shows `link: established` and the expected peers listed with their capabilities.

Also verify the registry side:

```bash
curl https://network.meta-factory.ai/api/health              # → { "status": "ok" }
curl https://network.meta-factory.ai/principals/<principal>  # → SignedAssertion with your pubkey
```

### Step 8 — Go private (enable confidentiality)

Steps 1–7 give you a working federated link, but payloads still cross `federated.>` **cleartext-over-TLS** until you turn on encryption. A network is a **trust group** ([ADR-0019](./adr/0019-federated-payload-encryption.md)): all federated payloads — **Direct, Delegate, AND Offer** — are sealed with **one per-network symmetric key `K`**, readable only by admitted members and protected from any outsider on the transport (another network, the public, a non-member relay/hub).

**1. Get the network key `K`.** Every admitted member of the network holds the same `K`. It is delivered sealed-to-your-pubkey over the **same admission/seal channel** that carried your leaf secret (no new ceremony).

- **Default — sealed auto-delivery (C-1349 Slice 1).** When the network admin's hub config carries a `payload_key` for the network, `cortex network secret add-member <network> <member-pubkey> --admin-seed <seed> --apply` (and per-member `rotate`) seals `K` **into the same envelope** as your leaf PSK. Your `cortex network join <network> --apply` then auto-fetches, unseals, and **writes `encryption: enabled` + `payload_key` (+ kid) into your `stacks/<slug>.yaml` for you** — zero manual key handling, and the file is clamped to `0600`. `K` is never printed to a terminal, log, or dry-run output (only the kid + a SHA-256 fingerprint are shown). This is the path to prefer.
- **Fallback — manual handoff.** If the hub config has no `payload_key` for the network yet (encryption not staged hub-side), `add-member` seals the PSK only and prints an info line pointing here. In that case the admin hands you `K` (base64, decoding to exactly 32 bytes) over a secure channel and you stage it in config as in step 2 below.

**2. (Fallback only) Enable encryption in your stack config** (`stacks/<slug>.yaml`) — the sealed-delivery default writes this block for you:

```yaml
policy:
  federated:
    networks:
      - id: <network>
        encryption: enabled            # transition: SEAL outbound, ACCEPT both inbound
        payload_key: <K-base64-32-bytes>
        # payload_key_id: <network>/k1  # optional; defaults to <network>/k1
```

Restart the daemon. Your outbound `federated.>` payloads are now sealed with `K`, and you accept **both** sealed and cleartext-but-signed inbound (the transition window — it never breaks an in-flight peer).

**3. Flip to `required`** once every member confirms they are sealing. `encryption: required` **rejects** inbound cleartext federated payloads — the network is fully private.

> **Secret at rest — `chmod 600`.** The config layer holding `payload_key` (and any seed) MUST be `0600`. `payload_key` is a 256-bit AEAD key; a group-readable config leaks the whole network's confidentiality.
>
> **Posture semantics:** `off` (default) never seals · `enabled` seals outbound + accepts both inbound (the migration window) · `required` seals outbound + rejects cleartext inbound. If `encryption` is `enabled`/`required` but `payload_key` is **absent**, the runtime publishes **cleartext** and emits a loud "federating in the clear" warning — it cannot seal without `K`.
>
> **Encrypt-then-sign; metadata stays cleartext.** Only `payload` is sealed; `subject`/`sovereignty`/`signed_by[]`/routing fields stay cleartext-and-signed, so the bus routes + verifies the chain before any decrypt. Signing stays per-author (authenticity); `K` attests membership (confidentiality) — two independent properties.
>
> **Revoke / rotate (C-1349 Slice 2):** dropping a member's leaf PSK (`cortex network secret revoke-member <network> <member-pubkey> --admin-seed <seed> --apply`) cuts *transport* immediately, but the evictee may **retain `K`** and still decrypt any captured traffic — so on an encryption-enabled network `revoke-member` prints a rotate-now recommendation. Revoking their *read* access requires a network-wide key **rotation**: `cortex network secret rotate-key <network> --admin-seed <seed> --apply` mints `K'`, re-seals it to **every ADMITTED member** (leaf PSK unchanged, kid bumped `<network>/k<n>` → `k<n+1>`), and advances the hub-side `payload_key` + `payload_key_id`. It is **network-wide** — it takes **no** member pubkey (that is the per-member `rotate`, which rotates a member's leaf PSK). Dry-run by default; `--apply` mutates. Members then **re-run `cortex network join <network> --apply`** to pick up `K'` (join re-fetches the sealed blob) — the output states how many must re-join. There is no daemon auto-refresh: `K'` is authoritative only after the hub store is advanced, and a mid-rotation re-seal failure leaves the OLD `K` authoritative and the whole command re-runnable.

---

## 3. The two irreducible two-party steps

Everything in section 2 can be done independently by each side — except two moments that are genuine two-party decisions an agent can orchestrate and prompt for, but not unilaterally perform:

### (a) The admission + leaf-secret (and network-key) seal

The network admin must **consciously admit a peer** (via `cortex network admit <request-id> --apply`) and then deliver the leaf secret. These are two distinct steps (ADR-0015 / ADR-0018):

1. **Roster admission** — `cortex network admit` approves the peer onto the network roster. It is admin-signed, mints nothing, and records **ADMITTED** status in the registry (`register → PENDING → ADMITTED`). Existing members are grandfathered — migration 0009 backfills them ADMITTED.
2. **Leaf-secret seal** — the admin runs `cortex network secret add-member <network> <pubkey> --apply` to mint a per-member leaf PSK and **seal it to the peer's registered pubkey** (default `--deliver sealed`). The joiner's `cortex network join` auto-fetches and unseals it — the peer never handles a raw secret, and the registry stores only ciphertext. (`--deliver oob` is the bootstrap fallback: the PSK is surfaced on the admin's terminal for a manual handoff.)

The **network payload key `K`** (the confidentiality key, Step 8 / ADR-0019) rides the **same seal-to-pubkey primitive on the same channel** — one pipe carries both the leaf secret and `K`.

**What crosses out-of-band:** the leaf endpoint URL (the hub `tls://…`) and — until cortex#1246 automates `K` delivery through `join` — the network key `K` itself, handed over a secure channel.

### (b) The hub topology agreement

Both principals must agree on:
- **Who hosts the leaf hub** — one side runs the leaf hub listener, the other connects in as a remote. Either side can host.
- **How the hub is reachable across the internet** — a machine behind NAT needs to expose the leaf port. Options: cloudflared TCP tunnel, a neutral cloud NATS host (VPS or Synadia NGS), or Tailscale/WireGuard. Both sides must agree on the approach.

The network descriptor (`hub_url`/`leaf_port`) in the registry records this once the hub exists; the registry resolves it for all future joiners. For a brand-new network, the admin runs:

```bash
cortex network create <network> \
  --hub tls://<hub-host>:<port> \
  --leaf-port <port> \
  --admin-seed ~/.config/nats/network-admin.nk \
  --apply
```

After that, subsequent principals join with `cortex network join` and the registry resolves the topology automatically.

---

## 4. What each side does (mutual vs asymmetric)

The federation onboarding has three independent layers. Understanding which is mutual helps avoid confusion:

| Layer | What it establishes | Who does it | Mutual? |
|---|---|---|---|
| **(a) Network — leaf link** | Physical NATS leaf-node connection between the two buses | Both sides configure their NATS server (hub listener or remote); the topology agreement is two-party | Yes — one side hosts the hub, both wire their NATS conf |
| **(b) Identity — registry pin** | Cross-principal pubkey resolution | Each principal registers once; everyone else pins only the registry URL + pubkey | Each side registers independently; pinning the registry is per-stack config |
| **(c) Dispatch — subject scope** | What inbound federated traffic each side accepts; what capabilities each offers | Each side sets `accept_subjects` and `announce_capabilities` in their own config | Each side configures its own policy independently |

**Key insight from ADR-0013.** Layers (a) and (b) are decoupled. The registry resolves *identity* (pubkeys + capabilities); it does not create the bus link. The leaf link resolves *reachability*; it does not establish trust. A stack with a leaf link but no registry registration is reachable but unverifiable. A registered stack with no leaf link is identifiable but unreachable. Both must exist for a live dispatch.

**What never crosses the principal boundary:**
- Your NSC operator's accounts or JWTs — each principal's account tree stays in their own store
- Your internal agents account — the federation account is the only one bridged to the leaf
- Session interiors — `local.` scope never crosses the principal boundary; only `federated.` lifecycle metadata is visible to peers (ADR-0005)

---

## 4b. Community onboarding — the two-channel airgap (Process B)

When the joining principal is a **newcomer in the metafactory-community server** (not a peer you are already coordinating with directly), admission runs across a deliberate **two-channel airgap** ([ADR-0015](./adr/0015-two-tier-onboarding-and-admission-gate.md) two tiers · [ADR-0017](./adr/0017-surface-tooling-arc-bundles.md) surface tooling · the cortex#1250 airgap):

**PUBLIC channel → Pier (zero-authority concierge).** `#onboard-your-fleet` is the public entry anyone can reach before holding any role. **Pier** ([`personas/pier.md`](../personas/pier.md) — `allowedTools: [Read]`, `issues_nothing: true`) greets the newcomer, explains the two tiers, walks them through sovereign setup (Steps 1–7 above), and — once they have registered and raised a PENDING request — **surfaces** the request-id + pubkey to the private back-office. Pier **cannot admit, issues nothing, holds no admin seed, and touches no key.** A prompt-injected Pier still cannot mint an admission.

**PRIVATE channel → admin + privileged assistants.** `#assistant-fleet-onboarding` is where the principal (Andreas) and privileged assistants (Ivy, Luna) act on Pier's surfaced request. These are the Tier-2 `fleet-admit` privileged acts, run with the admin seed that never leaves the private side:

```bash
# 1. Admit to the roster (mints nothing):
cortex network admit <request-id> --network <network> \
  --admin-seed ~/.config/nats/admin.nk --apply

# 2. Seal the leaf PSK (and, per ADR-0019, the network key K) to their pubkey:
cortex network secret add-member <network> <their-pubkey> \
  --admin-seed ~/.config/nats/admin.nk --apply
```

**The newcomer's cortex runs `cortex network join <network> --apply`** → auto-fetches + unseals → leaf connects. They then go private (Step 8).

The airgap **is** the security property: the **public** surface can only *surface*; the **private** surface holds the only authority that admits or seals. See [`personas/pier.md`](../personas/pier.md) for Pier's exact surfacing protocol.

> **Tier 1 (chat-only)** is the lighter path: the newcomer brings their own Discord bot, Pier surfaces a `community-fleet` role request, and the principal grants the role — no bus, no NATS, no keys. See [`sop-community-fleet-admission.md`](./sop-community-fleet-admission.md). Tier 2 (above) is the sovereign bus path.

---

## 5. Migration note — the six superseded SOPs

The six documents below preceded this runbook. Each holds reference detail not repeated here. **This runbook is the canonical entry point for end-to-end peer onboarding; the six below are retained for their reference depth.**

Each carries a supersede banner at the top pointing here. The banner text is:

> `> Superseded by docs/sop-onboard-peer-principal.md for the end-to-end peer-onboarding path. Retained for [specific reference detail].`

| SOP | Reference detail it uniquely holds |
|---|---|
| `sop-stack-onboarding.md` | Full stack bring-up (bus config, plist, Discord binding, verify); bus-conversion to operator-mode; network-create flow (§B1) |
| `sop-network-join.md` | Network join mechanics (all four subcommands: join, leave, status, create); multi-stack join (`--principal-seed`); security ramp |
| `sop-federation-onboarding.md` | Three-layer model detail; manual fallback (`peers[]` hand-pin); dispatch anatomy (Offer vs Direct); current status of the federated dispatch path |
| `sop-network-registry.md` | Registry internals (keypair generation, deployment, threat model); TOFU vs pin; what-breaks-if-skipped; operational notes (crash-loop fail-safe, rotation) |
| `sop-stack-identity.md` | Stack NKey rotation procedure; `arc upgrade` provisioning; threat model |
| `runbook-federation-peering.md` | Manual cloudflared-led peering (already marked superseded by `sop-network-join.md`); offline hand-pin steps; reachability options |

---

## 6. Model A is not supported

Guest-account onboarding (hub-minted accounts, Model A) is not supported. The cost — a newcomer without an NSC operator cannot federate until they stand one up — is intentionally paid down by making "stand up your own NSC operator" trivial via tooling (`arc` + `cortex stack create`), not by hosting their identity in someone else's operator. See ADR-0013 §Alternatives considered for the full rejection rationale.

A newcomer's first action is always step 1 of this runbook: stand up their own stack with their own NSC operator. That is the only path.

---

## Cross-references

- [ADR-0013](./adr/0013-sovereign-federation-model.md) — the sovereign federation model (binding decision)
- [ADR-0003](./adr/0003-network-join-control-plane.md) — network-join control plane design decisions
- [ADR-0001](./adr/0001-federated-subject-grammar.md) — federated subject grammar (the wire grammar federation rides on)
- [`docs/design-onboarding-tooling-audit.md`](./design-onboarding-tooling-audit.md) — the audit + G1–G5 plan that drives this consolidation
- [`docs/design-g1-account-topology.md`](./design-g1-account-topology.md) — G1 account-topology tooling spec (the NSC operator export/import primitive)
- [`CONTEXT.md §NSC operator`](../CONTEXT.md) — the NSC operator carve-out in the principal→network vocabulary migration
- [`CONTEXT.md §Federation account`](../CONTEXT.md) — the canonical definition of the dedicated federation account
- **Issues:** cortex#1116 (audit epic) · cortex#1117 (G1) · cortex#1121 (this runbook)
