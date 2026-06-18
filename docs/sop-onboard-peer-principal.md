# SOP — Onboard a peer principal (sovereign federation path, ADR-0013)

**Status:** active (G5 / cortex#1121 — supersedes the 6 fragmented SOPs below for the end-to-end path) · **Author:** Luna (for Andreas) · **Refs:** ADR-0013, cortex#1116 (audit epic), cortex#1121 (this doc)

**Supersedes (end-to-end path):** `sop-stack-onboarding.md` · `sop-network-join.md` · `sop-federation-onboarding.md` · `sop-network-registry.md` · `sop-stack-identity.md` · `runbook-federation-peering.md`

> **Retained detail.** Each of those six SOPs carries reference material not duplicated here (registry internals, stack-identity rotation, network join mechanics, the manual hand-pin fallback). They each carry a supersede banner pointing back to this runbook. Do not delete them.

---

## 1. The model in one paragraph

The federation model (ADR-0013, Model B) is **sovereign**: every principal runs their own NSC operator and a dedicated federation account under it. A leaf link is a **secret-authenticated transport pipe** — one side runs the hub, the other connects in as a remote, each binding the link to a **local NATS account in their own NSC operator**. No cross-operator JWT trust is involved; no hub mints accounts for joiners. What crosses `federated.>` is governed by an **export/import** that each principal runs in their own store — a single-store, single-operator operation on each side. One stack gets one federation account regardless of how many networks it joins; network isolation is by subject scope (`federated.{principal}.>` plus per-network `accept_subjects`), never by minting an account per network. **Model A (hub-minted guest accounts) is not supported** — if you have no NSC operator yet, standing one up is the first step, and the tooling is designed to make that trivial. See [ADR-0013](./adr/0013-sovereign-federation-model.md) for the full rationale.

---

## 2. The happy path, end to end

This is the ordered sequence for a **new peer principal** joining an existing network. Both principals go through the same steps on their own side; the two irreducible two-party moments are called out explicitly in section 3.

### Step 1 — Stand up your own stack

If you do not have a cortex stack yet, create one. The command scaffolds a born-aligned config-split skeleton (slug == `stack.id` trailing segment, no drift can form) and sets `stack.nkey_seed_path` to the conventional path:

```bash
cortex stack create <slug> --principal <principal> --apply
```

Then fill the `<REPLACE_ME>` secrets (Discord token/guild/channels). `arc upgrade Cortex` auto-provisions the NKey seed on first install.

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

Your stack's local NATS bus must be **operator-mode** (it must define your NSC operator, the system account, and the resolver preload including the federation account) before it can bind a leaf link to an operator-mode hub. A hard-isolated anonymous bus (no NSC operator, no accounts) cannot federate.

> **What operator-mode means here.** Your bus config must include the NSC operator JWT, `system_account`, `resolver: MEMORY`, and `resolver_preload` containing both your agents account and your system account. Mirror the four blocks from your existing operator-mode bus conf if you have one (e.g. `~/.config/nats/local.conf`). Keep your stack's own `server_name`, `listen` port, `jetstream.domain`, and `http` monitor port — do not copy the meta-factory leaf include, `cortex network join` renders its own leaf include for your stack.

If your stack is already on an operator-mode bus (most established stacks are), skip to step 4.

> **Converting a hard-isolated stack.** Edit `~/.config/nats/<slug>.conf` to add the operator-mode blocks, restart the bus, then continue. See [`sop-stack-onboarding.md §B0.1`](./sop-stack-onboarding.md#b01--the-bus-must-be-operator-mode-the-794-lesson) for the full procedure.

### Step 4a — Create your dedicated federation account

Your stack needs a **dedicated federation account** under your NSC operator — separate from your agents account so federation traffic is blast-radius-isolated from internal work. This is the last-mile provisioning step (G1d):

```bash
arc nats add-federation-export --account <federation-account-name> --stack <principal>/<slug>
```

> **Honest status (as of G5).** G1d (the dedicated-account provisioning primitive) emits a WARN no-op today — the `arc nats add-federation-export` command provisions the export/import wiring but the automated account-creation path is still the last-mile. If your NSC operator does not yet have a dedicated federation account, you create it once with `nsc add account <federation-account-name>` before running the arc command. This step becomes fully one-command when G1d ships.

Add the federation account's NKey (`A…`) to your stack config under `stack.nats_infra.account`.

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

### Step 5 — Obtain your leaf credentials (hub side issues them)

The hub-side network admin issues leaf credentials for your stack. This is one of the two irreducible two-party moments (see section 3):

**Hub side (the network admin):**

```bash
cortex creds issue leaf-<slug> --account community --pub 'federated.<slug>.>' --sub 'federated.<slug>.>'
```

This runs `arc nats add-bot` under the hood and adds a user to the federation account the hub trusts — **no hub restart required** for an existing account. The admin then assembles the leaf package and makes it available.

**Your side:**

Download the leaf `.creds` file and place it at `~/.config/nats/<network>.creds`. Note the federation account NKey (`A…`) it belongs to — it goes in `stack.nats_infra.account`.

If the network uses the O-4a issuance-request broker: submit `cortex provision-stack register …` with `--request-creds` and the admin runs `cortex creds grant <request-id>`.

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

---

## 3. The two irreducible two-party steps

Everything in section 2 can be done independently by each side — except two moments that are genuine two-party decisions an agent can orchestrate and prompt for, but not unilaterally perform:

### (a) The leaf secret exchange

The hub admin must **consciously admit a peer** — they issue leaf credentials for the joining stack and share the secret out-of-band. This is by design: no automation can bypass the human-grant decision that admits a new principal onto a hub. The `cortex creds grant <request-id>` command (G2) scripts the hub-side mechanics, but the decision to grant is the admin's.

**What crosses out-of-band:** the leaf `.creds` file (or the issuance-request ID for the O-4a broker flow), and the leaf endpoint URL.

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
