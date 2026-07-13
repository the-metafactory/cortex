> **Superseded by [`docs/sop-onboard-peer-principal.md`](./sop-onboard-peer-principal.md) for the end-to-end peer-onboarding path.** Retained for: full stack bring-up mechanics (bus config, plist, Discord binding, verify), bus-conversion to operator-mode (§B0.1), and network-create flow (§B1).

# SOP — Stack onboarding (a new Discord-facing cortex stack)

**Status:** active
**Owner:** principal
**Audience:** a **principal** standing up a NEW cortex **stack** bound to a Discord guild — on its own **hard-isolated local bus** (the `halden` / `community` pattern), optionally **federated** onto a network afterward (Part 2).
**Authoritative detail:** [`CONTEXT.md`](../CONTEXT.md) §Principals/stacks/networks · [`sop-stack-identity.md`](./sop-stack-identity.md) (the signing key) · [`sop-network-join.md`](./sop-network-join.md) (federation, Part 2) · [`sop-discord-channel-routing.md`](./sop-discord-channel-routing.md).

> **What this is.** Standing up a Discord-facing stack used to be an undocumented manual recipe (identity → isolated bus → cortex config + Discord binding → plist → load). This SOP captures it so the next one is a checklist. The config-write half (Step 3) is now automated by **`cortex stack create`** (#808) — Part 1 leads with it; the manual recipe remains as the fallback + the explanation of what each generated file is.

---

## Pre-flight

After reading this SOP, output:

```
SOP: stack-onboarding | stack: {principal}/{slug} | guild: {guildId} | bus: :{port} | step: {identity→bus→config→load→verify}
```

A **stack** is one cortex deployment under a **principal** — its own signing identity, bus, subject sub-namespace (`local.{principal}.{slug}.…`), and launchd plist. Part 1 stands it up **local-only** (own loopback bus, no federation). Part 2 federates it.

---

## Prerequisites (the parts only the principal can do)

| Need | Why | How |
|---|---|---|
| **Bot is a member of the target guild** | the daemon can't join a guild for you | invite the assistant's Discord bot to the guild (Developer Portal OAuth URL, `scope=bot`, least-privilege perms). One bot can serve N guilds — the **C-704 guild filter** isolates each stack by `guildId`. |
| **Message Content intent ON** | the bot must read message content | Developer Portal → the bot's application → enable. (Already on if the bot reads any other guild.) |
| **guildId + a channel id** | binding + the nominal agent/log channel | from the Discord client (Developer Mode → copy id) or `GET /guilds/{id}/channels` with the bot token. |
| **A free local NATS port** | the isolated bus | meta-factory `:4222`, halden `:4223`, community `:4224` → use the next free pair (data + monitor `:82xx`). |

---

## Part 1 — Stand up the local stack

### The fast path — `cortex stack create` (#808)

Most of Part 1 is now one command. `cortex stack create <slug>` scaffolds the
whole config-split skeleton **born aligned** (dir basename == slug == `stack.id`
trailing segment, so the slug↔`stack.id` drift [ADR-0004](./adr/0004-stack-slug-authority.md)
catches can never form) and **unique within the principal** (it refuses a dir
collision or a duplicate `stack.id`):

```bash
# Dry-run first (DEFAULT — prints the file set, touches nothing):
cortex stack create <slug> --principal <principal>

# Write it:
cortex stack create <slug> --principal <principal> --apply
```

It writes `system/system.yaml`, `surfaces/surfaces.yaml`, `stacks/<slug>.yaml`,
the `<slug>.yaml` pointer, and a `personas/<agent>.md` stub — filling your real
slug / principal / agent and keeping `<REPLACE_ME>` only for true secrets
(Discord token/guild/channels + the post-first-boot `nkey_pub`). It sets
`stack.nkey_seed_path` to the conventional `~/.config/nats/cortex-<slug>.nk` and
does **not** generate the seed — `arc upgrade cortex` auto-provisions it on first
install (Step 1 below).

After it writes, the remaining work is: pick a free bus port (Step 2), fill the
`<REPLACE_ME>` secrets in `stacks/<slug>.yaml` + `surfaces/surfaces.yaml`
(Steps 2–3), write the plist (Step 4), and verify (Step 5). When the stack
should join a network afterward, continue to **Part 2** (`cortex network join`).

The remaining Steps 0–5 below are the **manual recipe** — read them to
understand each generated file, or to stand a stack up without the command.

### Step 0 — Choose a semantic slug

> **New to App vs principal vs slug?** They're three different *kinds* of thing — a Discord object, a human identity, a stack label — and the most common onboarding stumble. Read the [Core concepts primer](sop-onboard-peer-principal.md#core-concepts-app-vs-principal-vs-slug) first.

The slug is the second subject segment (`local.{principal}.{slug}.…`) and the config dir name. **Pick it for the scope it serves**, per `CONTEXT.md` §Scope — do **not** call a closed/federated stack `public` (the `public.` scope is the open IoAW square; a closed collaborator set is **federated**). e.g. `community`, `work`, `halden`.

### Step 1 — Generate the stack signing identity

```bash
cortex provision-stack generate <principal> \
  --seed-path ~/.config/nats/cortex-<slug>.nk \
  --stack-id <principal>/<slug>
```

Records the seed chmod 600 and prints `nkey_pub` (`U…`). **Local-only stacks do NOT need `--register`** — own-stack implicit trust (`verify-signed-by-chain`) admits the stack's own self-signed envelopes, and `security.signing` may stay `off`. Registration is only for federated `signing: enforce` (Part 2 / `sop-stack-identity.md`).

### Step 2 — Stand up the hard-isolated bus

The isolation wall is the **absence** of any `leafnodes{}` / `gateway{}` / `cluster{}` block (cortex#692). Write `~/.config/nats/<slug>.conf`:

```hocon
server_name: <slug>-<principal>
listen: 127.0.0.1:<port>
http: 127.0.0.1:<monitor-port>          # e.g. 82xx — must not collide
jetstream {
  store_dir: ~/.config/nats/<slug>-jetstream
  max_mem: 64mb
  max_file: 1gb
  domain: <slug>-<principal>
}
# NO leafnodes{} / cluster{} / gateway{} — that absence IS the isolation wall.
# Anonymous auth: process + port + store separation is the boundary.
```

> 📄 **Reference template:** [`docs/config-layout/nats-server.conf.example`](./config-layout/nats-server.conf.example) is the annotated, copy-and-fill version of this file (it also shows the operator-mode blocks added in §B0.1). For a federating stack you usually don't write this by hand at all — `cortex network provision` + `cortex network make-live` generate it (see §B0.1).

Write `~/Library/LaunchAgents/ai.meta-factory.nats.<slug>.plist` (`nats-server -c ~/.config/nats/<slug>.conf`, `RunAtLoad`/`KeepAlive`), then:

```bash
launchctl load ~/Library/LaunchAgents/ai.meta-factory.nats.<slug>.plist
lsof -nP -iTCP:<port> -sTCP:LISTEN | grep nats   # verify up
```

### Step 3 — Write the cortex config (`~/.config/cortex/<slug>/`)

**Start from the canonical template.** [`docs/config-layout/`](config-layout/) is
the self-documenting config-split template — copy it and fill the `<REPLACE_ME>`
markers rather than hand-rolling the directory:

```bash
cp -R docs/config-layout ~/.config/cortex/<slug>
# rename the pointer file after your slug, then fill the <REPLACE_ME> markers
mv ~/.config/cortex/<slug>/research.yaml ~/.config/cortex/<slug>/<slug>.yaml
```

Multi-file layout (`composer` reads `system/` + `stacks/`):

- **`<slug>.yaml`** — pointer (contents ignored; the dirname selects the layout).
- **`system/system.yaml`** — `claude.*` (timeouts, **least-privilege `bashAllowlist`** — read-only rule set; restrict `gh` to allowed repos via `bashAllowlist.repos`), `allowedDirs` (a sandbox dir), `paths` (publishedEventsDir, logDir), and the **`nats`** block:
  ```yaml
  nats:
    url: nats://127.0.0.1:<port>
    name: <slug>
    identity: { seedPath: ~/.config/nats/cortex-<slug>.nk, publicKey: <nkey_pub> }
    accountSigningKeyPath: <same account signing key as the principal's other stacks>
  ```
- **`stacks/<slug>.yaml`** — `principal` (id + `discordId`), `stack` (id `<principal>/<slug>`, `nkey_seed_path`, `nkey_pub`), `capabilities` (`chat`), `policy`, `agents`, `github.repos`. **chmod 600** (carries the bot token).
- **`personas/<assistant>.md`** — copy the assistant's persona and **append a repo-scope note** so the assistant knows its allowed repo slugs without being told (avoids the "what's the repo slug?" round-trip).

**Principal-only (CRITICAL for a guild that others can join):** list **only** the principal in `policy.principals[]` with their Discord id, e.g.

```yaml
policy:
  principals:
    - id: <assistant>            # the stack's own signing identity
      home_principal: <principal>
      home_stack: <principal>/<slug>
      nkey_pub: <nkey_pub>
      role: [principal-role]
    - id: <principal>            # the human — the ONLY human principal
      home_principal: <principal>
      home_stack: <principal>/<slug>
      role: [principal-role]
      platform_ids: { discord: ["<principal-discord-id>"] }
  roles:
    - id: principal-role
      capabilities: [dispatch.<assistant>, keyword.chat, tool.bash, tool.read, tool.glob, tool.grep]
```

A non-principal's @mention resolves to `authorIsPrincipal=false` (non-spoofable, cortex#729) → **hard-blocked silently** (a `system.access.denied` audit envelope on the bus, **no channel post**). The assistant answers the principal and no one else.

The agent's `presence.discord` binds the guild:

```yaml
presence:
  discord:
    enabled: true
    dmOwner: false               # the primary stack owns the principal's DMs; this one is guild-only
    token: <assistant bot token>
    guildId: "<guildId>"
    agentChannelId: "<channel id>"   # nominal default; the assistant answers @mentions guild-wide
    logChannelId: "<channel id>"
    surfaceSubjects: []          # no proactive bus-event rendering — replies only
```

### Step 4 — Write + load the cortex plist

`~/Library/LaunchAgents/ai.meta-factory.cortex.<slug>.plist` → `/Users/<you>/.local/bin/cortex start --config ~/.config/cortex/<slug>/<slug>.yaml`, `WorkingDirectory` = the installed pkg, `CORTEX_CHANNEL=<slug>`, logs to `~/.config/cortex/logs/cortex-<slug>.{log,error.log}`. Then `launchctl load …`.

### Step 5 — Verify

```bash
grep -E "Stack:|connected to nats|policy-engine active|connected as|Guild:" ~/.config/cortex/logs/cortex-<slug>.log | tail
```

A healthy boot shows `Stack: <principal>/<slug>`, `connected to nats://…:<port>`, `policy-engine active — principals=N`, `discord adapter started (… guild: <guildId>)`, and `connected as <Bot>#NNNN`. Then:

1. **@mention the assistant as the principal** → it replies. ✅
2. **(Recommended) @mention from a non-principal account** → **silence** (no reply, no refusal post). ✅ — this is the principal-only gate proving itself.

---

## Gotchas

- **One bot, many guilds (C-704):** reuse the assistant's bot token bound to a *different* `guildId` per stack; the guild filter makes each daemon act only on its bound guild. Running the same token in N processes = N gateway sessions (fine at low volume).
- **gh auto-approve:** `claude.bashAllowlist` propagates to dispatched sessions (`cortex.ts` → `CORTEX_BASH_GUARD`); the bash-guard **auto-approves** matching commands (cortex#778) so async dispatch never stalls on an unanswerable prompt. Restrict reach with `bashAllowlist.repos` (a `gh` command targeting any other repo is denied; repo-less `gh` passes).
- **Guild = restricted profile:** a guild @mention resolves to the DEFAULT (non-DM) profile **even for the principal** — so `bashAllowlist` gates *every* command. Size the allowlist for the work the stack must do.
- **Slug naming:** see Step 0 — don't overload CONTEXT.md scope terms.
- **Surface adapters are bundles now (ADR-0024):** cortex core ships **zero in-tree platform adapters**. `web`, `discord`, `slack`, and `mattermost` are each a first-party **adapter bundle** (`metafactory-cortex-adapter-<platform>`); `pagerduty` is a **renderer bundle**. They are declared as first-party deps in cortex's own `arc-manifest.yaml`, so `arc upgrade cortex` auto-installs them and they load **even with `system.plugins.external: false`** (the default-off external-plugin flag in `system/system.yaml`) — the *first-party bundle exemption*. So your `presence.discord` / `surfaces.discord` binding works out of the box with **no flag flip**. Only a genuinely **third-party / out-of-tree** platform needs `system.plugins.external: true`, and that platform's binding shape is defined by its own bundle, not cortex. Boot **hard-fails** if renderer coverage drops below two distinct classes with ≥1 effective sink (`dashboard` is inert) — the error names the missing bundle + the `arc install` remedy.

---

## Part 2 — Federate the stack onto a network (Layer B)

Federating turns the stack's hard-isolated local bus into a **leaf** of a shared network, so peer principals' stacks interconnect at the bus level. The join itself is one command (`cortex network join`, see [`sop-network-join.md`](./sop-network-join.md)); the gap THIS SOP closes is the **new-network bring-up** (hub + registry seed + leaf cert) that precedes the first join.

> A Discord guild ≠ a network. The guild is an **L7 surface**; the network is an **L1–L3 NATS federation**. A stack can be in a guild (Part 1) without being federated, and federate (Part 2) without sharing a guild.

### B0 — Prerequisites (hub admin)

- **A reachable NATS leaf hub** (`host:port` + TLS). Reuse an existing endpoint under a NEW network id (e.g. `tls://nats.meta-factory.dev:7422`), or stand one up.
- **A leaf `.creds` for THIS stack on that hub** — the gating artifact (like a VPN cert). Default issuance is **one restart-free command** by the hub admin: `cortex creds issue leaf-<slug> -a community --pub federated.<slug>.> --sub federated.<slug>.>` (→ `arc nats add-bot`) — it adds a *user* to an account the hub already trusts, so **no hub restart** is needed. Drop the resulting `.creds` at `~/.config/nats/<network>.creds`. Note the **account** NKey (`A…`) it belongs to — it goes in `stack.nats_infra.account`. See [`runbook-leaf-cred-issuance.md`](./runbook-leaf-cred-issuance.md) for the full hub side (happy path + the one-time account-bootstrap fallback), and [ADR-0012](./adr/0012-external-operator-account-isolation.md) for the shared-account-vs-dedicated isolation choice. Raw-`nsc` is the bootstrap fallback in `runbook-federation-peering.md`.

### B0.1 — The bus MUST be operator-mode (the #794 lesson)

> **Authority:** [`docs/adr/0013-sovereign-federation-model.md`](./adr/0013-sovereign-federation-model.md) (the sovereign model, accepted). Hub-minted identity (hub-issued guest accounts / creds) is **retired** — see [`docs/adr/0015-two-tier-onboarding-and-admission-gate.md`](./adr/0015-two-tier-onboarding-and-admission-gate.md).

> ⚠️ **READ THIS BEFORE JOINING.** Part 1 stands the stack up on a **hard-isolated, anonymous** bus (the `halden` / `community` pattern — Step 2: *no* `leafnodes{}` / `cluster{}` / `gateway{}`, no operator-mode account tree at all; the isolation is the absence of all of those). **An anonymous bus cannot federate.**

Under the **sovereign model** ([ADR-0013](./adr/0013-sovereign-federation-model.md)) `cortex network join` renders a leaf remote that binds a **local NATS account in your OWN NSC operator** — *not* an account minted by the hub. For the `nats-server` to name that local account, it must itself be operator-mode and **define the account** — an anonymous bus has no operator and no account tree, so it can't resolve the account the leaf remote names, and on (re)start it crashes:

```
nats-server: cannot find local account "AADPQ7…" specified in leafnode remote
```

→ the daemon fails to start and the stack's bus goes **down**. The fix (cortex#794) makes `cortex network join` **detect an anonymous bus and refuse, fail-fast** — rather than rendering a leaf that crashes the server — so a join never silently takes a bus offline. (Surfaced joining `andreas/community` on `:4224` to `metafactory-community`; recovered with `cortex network leave`. The fail-fast lands with #794; until it does, the guard below — convert the bus to operator-mode first — is the principal's responsibility.)

> ✅ **This is now automated (cortex#1265) — you should NOT hand-run `nsc` for this.** The two-command flow stands the operator-mode bus up for you:
>
> ```bash
> cortex network provision <slug> --apply     # mints your OWN nsc operator + accounts;
>                                             # records stack.nats_infra.config_path
>                                             # (~/.config/nats/<slug>.conf) + the operator JWT +
>                                             # account JWT into the stack config
> cortex network make-live <slug> --apply     # BOOTSTRAPS the operator-mode blocks below
>                                             # (operator JWT + system_account + resolver: MEMORY
>                                             # + resolver_preload) onto the bus — zero raw nsc
> ```
>
> `provision` writes the per-stack `config_path` that `make-live` (and `cortex network join`) derive `--nats-config` from, so the loop closes without a manual `nsc generate config --mem-resolver`. **Manual fallback:** copy [`docs/config-layout/nats-server.conf.example`](./config-layout/nats-server.conf.example), fill in your own JWTs/pubkeys, and point the daemon at it with `--nats-config <path>`. The hand-edited shape below is exactly what the template documents and what `make-live` emits.

**To federate a hard-isolated stack, stand up your OWN NSC operator first — do not copy the hub's.** Each principal roots their federation identity in their **own** operator (ADR-0013 §Decision-1); nobody's identity lives in anybody else's operator. The automated flow above does this for you; the hand-edit below is the manual fallback. Edit the stack's `~/.config/nats/<slug>.conf` to add **your own** NSC operator / system-account / resolver blocks plus **one dedicated federation account** (distinct from the agents account, per ADR-0013 §Decision-3 / [ADR-0012](./adr/0012-external-operator-account-isolation.md)):

```hocon
server_name: <slug>-<principal>          # KEEP the stack's own identity/ports/JS domain
listen: 127.0.0.1:<port>
http: 127.0.0.1:<monitor-port>
jetstream { store_dir: …; domain: <slug>-<principal>; max_mem: 64mb; max_file: 1gb }

# --- YOUR OWN operator-mode blocks (generated by YOUR nsc, never copied from a hub) ---
operator: <YOUR OP_… JWT>                     # your own NSC operator JWT
system_account: <your SYS account A…>
resolver: MEMORY
resolver_preload: {
  <your FEDERATION account A…>: <account JWT>  # the local account the leaf binds to (ADR-0013 §3)
  <your AGENTS account A…>:     <account JWT>  # internal agents — separate blast radius
  <your SYS account A…>:        <account JWT>
}
# -------------------------------------------------------------------------------------
# DROP any hub leaf include — `cortex network join` adds its OWN
# `include "leafnodes-<network>.conf"` for THIS network.
```

Generate these blocks with **your own** `nsc` (do not copy any other principal's operator JWT, account, or creds — that would re-introduce the retired hub-minted-identity pattern); **keep** the stack's own `server_name` / `listen` port / `jetstream.domain` / `http` monitor port (do not collide with another local bus); and **do not** add a hub `include "leafnodes-<network>.conf"` line by hand (the join renders this network's leaf include itself). The leaf link itself is a **secret-authenticated transport pipe**, not a cross-operator JWT handshake (ADR-0013 §Decision-1): the hub authenticates the remote with `authorization { user, password: <leaf-secret> }`, and **each side binds the link to a local account in its own operator**. The `federated.>` export/import that bridges that federation account to your agents account is **purely local — single-store, single-operator** (`cortex network join` runs your side; the peer runs theirs — ADR-0013 §Decision-2). Restart the bus, confirm it comes up, then run `cortex network join`.

> **Restart framing — this is a one-time *bus-conversion* restart.** The restart here is converting *this stack's local bus* to operator-mode (a one-time posture change, done once when the stack first federates). Under the sovereign model nobody mints your **identity**: your `SU` signing key is always your own — the cross-party artifact is the sealed **leaf credential** (the transport `.creds`; ADR-0013 §Consequences, updated by [ADR-0023](./adr/0023-federation-leaf-credential-model.md)), and adding or rotating it touches only the `leafnodes{}` authorization, not the account tree. Account-tree changes that *do* cost a restart (a brand-new account under `resolver: MEMORY`) are ones **you** make in **your own** store — see [ADR-0012](./adr/0012-external-operator-account-isolation.md) (now superseded by [ADR-0015](./adr/0015-two-tier-onboarding-and-admission-gate.md)).

> **Principal's call (the open design question, #794):** whether a deliberately hard-isolated, public-facing stack like `andreas/community` *should* be converted to operator-mode to federate, or stay isolated, is a posture decision — operator-mode opens the bus to the network. The fail-fast only guarantees the join never crashes the bus; it does not decide the posture for you.

### B1 — Create the network in the registry (network admin)

Standing up a network is now **one command** (#747, v5.2.0) — no raw SQL, no `CLOUDFLARE_API_TOKEN`. `cortex network create` POSTs a **signed-admin claim** to the registry's fail-closed `POST /networks/<network>`; the registry verifies the Ed25519 signature and checks the signing pubkey against its `REGISTRY_ADMIN_PUBKEYS` allowlist before writing the topology row.

**One-time prerequisite (per registry, done once).** The registry must trust a network-admin key before it will accept any create:

1. Generate the network-admin signing key — the same `SU…` seed shape every stack identity uses. Keep the seed chmod 600; note the base64 pubkey it prints:
   ```bash
   cortex provision-stack generate <network-admin-id> \
     --seed-path ~/.config/nats/network-admin.nk \
     --stack-id <network-admin-id>/registry-admin
   ```
2. Allowlist that pubkey on the registry and redeploy (a one-time `wrangler secret put` — the value is the **base64 admin pubkey**, comma-separated if more than one admin):
   ```bash
   cd <pkg>/src/services/network-registry
   wrangler secret put REGISTRY_ADMIN_PUBKEYS --env production   # paste the base64 pubkey(s)
   wrangler deploy --env production
   ```
   Until `REGISTRY_ADMIN_PUBKEYS` is set the route **fails closed** — `POST /networks/<network>` returns `503 admin_not_configured` and nothing is persisted (there is never an anonymous `hub_url` write). A claim signed by a key NOT in the allowlist gets `403 admin_not_authorized`.

**Create the network** (dry-run is the default — it prints the signed claim it *would* POST and touches no registry; add `--apply` to write):

```bash
# dry-run first — inspect the claim + the derived admin_pubkey
cortex network create <network> \
  --hub tls://<hub>:<port> \
  --leaf-port <port> \
  --admin-seed ~/.config/nats/network-admin.nk \
  --registry-url https://network.meta-factory.ai

# then write it
cortex network create <network> \
  --hub tls://<hub>:<port> \
  --leaf-port <port> \
  --admin-seed ~/.config/nats/network-admin.nk \
  --registry-url https://network.meta-factory.ai \
  --apply
```

`--registry-url` defaults to the production registry, so it can be omitted in the common case. The command derives `admin_pubkey` from the seed (the same key shape `provision-stack` uses), so the pubkey you allowlisted in the prerequisite is exactly the one the registry checks.

Verify: `curl https://network.meta-factory.ai/networks/<network>` returns the signed descriptor (`hub_url` / `leaf_port` matching what you created).

### B2 — Federated config on the stack

Add to `stacks/<slug>.yaml` (the registry pin alone — empty `networks[]` — leaves the registry client **dormant**; boot logs "policy.federated.registry configured … but no peers declared"):

```yaml
stack:
  nats_infra:
    config_path: ~/.config/nats/<slug>.conf
    plist_path: ~/Library/LaunchAgents/ai.meta-factory.nats.<slug>.plist   # or unit_path on systemd
    account: <A…-nkey>                  # the leaf creds' account (from B0)
    creds_path: ~/.config/nats/<network>.creds
policy:
  federated:
    registry:
      url: https://network.meta-factory.ai
      pubkey: <base64 — GET /registry/pubkey>
    networks: []                        # the join writes registry-resolved peers here
```

### B3 — Register + join (the one command)

```bash
cortex provision-stack register <principal> --seed-path <seed> \
  --registry-url https://network.meta-factory.ai --stack-id <principal>/<slug>
cortex network join <network> --config ~/.config/cortex/<slug>/<slug>.yaml --apply
```

Dry-run first (omit `--apply`). The join pulls the signature-verified descriptor → renders a `leafnodes` include into the stack's nats config → writes `policy.federated.networks[]` with registry-resolved peers → restarts. If the B2 config blocks are absent, pass `--registry-pubkey / --creds / --account / --nats-config / --plist` overrides instead.

**If this is the principal's 2nd+ stack** (e.g. you already federated `andreas/meta-factory` and are now adding `andreas/community`), the register step needs the principal **root** seed to authorize the add-stack — pass `--principal-seed <root-seed>` (#791):

```bash
cortex network join <network> --config ~/.config/cortex/<slug>/<slug>.yaml \
  --principal-seed ~/.config/nats/cortex.nk --apply
```

It root-signs the add-stack claim and fetch-merges the principal's existing stacks (so the other stacks survive). Idempotent. See [`sop-network-join.md` § Multi-stack join](./sop-network-join.md#multi-stack-join-a-principals-2nd-stack-791).

> ⚠️ **Operator-mode bus is a hard prerequisite** for B3 — if you stood this stack up anonymous in Part 1, convert its bus first ([§B0.1](#b01--the-bus-must-be-operator-mode-the-794-lesson)), or `cortex network join` fails fast (#794).

### B4 — Peer side (mutual)

Each peer principal (e.g. JC) does their own B0 (a leaf cert on the hub) + B3 on their stack against the same `<network>`. Membership is implicit — a principal is "in" the network iff a capability tags it (`capability.networks: [<network>]`). B1 is done once per network.

### B5 — Verify

`cortex network status --principal <principal> --stack <principal>/<slug>` → leaf `link:` established + the expected peers listed.

### Confidentiality note

Payload encryption **ships as of v5.27.0** ([ADR-0019](./adr/0019-federated-payload-encryption.md)): a network is a trust group, and all `federated.>` payloads (Direct/Delegate/Offer) are sealed with one per-network key `K`. It is **opt-in per network** — until you set `policy.federated.networks[].encryption: enabled` + `payload_key` (and the config file is `chmod 600`), payloads still cross `federated.` cleartext-over-TLS. For a public-facing community stack, **go private** (see [`sop-onboard-peer-principal.md` §Step 8 — Go private](./sop-onboard-peer-principal.md)) **and** keep the dispatch scope tight (principal-only, least-privilege allowlist from Part 1).

## Part 3 — Decommission a stack (retire the death story)

Standing a stack up has a birth story (`cortex stack create`); tearing one down has a **two-step death story**: LOCAL teardown, then REGISTRY deregistration. Do them in that order.

### Step 1 — Local teardown (`cortex stack delete`, Slice 1 #1351)

```bash
# Dry-run first (DEFAULT — prints the full teardown plan, touches nothing):
cortex stack delete <slug>

# Execute (requires the literal slug after --confirm — never a glob):
cortex stack delete <slug> --apply --confirm <slug>
```

`stack delete` refuses while the stack is still **joined to any network** (`policy.federated.networks[]` non-empty) — run `cortex network leave <net> --apply` first, so a live roster membership is never orphaned. On `--apply` it stops + unloads the daemon/nats units, removes the config-split dir + pointer + this stack's rendered nats conf, and **retires** the signing seed to `<seed>.retired-<timestamp>` (it is NOT deleted — key destruction is a separate conscious act; add `--purge-seeds` for the full wipe). Its completion output points you at Step 2.

### Step 2 — Registry deregistration (`cortex provision-stack retire`, Slice 2 #1351)

Local teardown removes the stack's *presence*; the registry still lists it in the principal's `stacks[]`. Retire it — a **tombstone** (the entry stays for history but is excluded from active resolution and its key stops verifying):

```bash
# Dry-run first (DEFAULT — prints the plan + surviving active stacks, touches nothing):
cortex provision-stack retire <principal> --stack-id <principal>/<slug> \
  --principal-seed ~/.config/nats/cortex.nk \
  --registry-url <registry-url> --registry-pubkey <pinned-b64>

# Execute:
cortex provision-stack retire <principal> --stack-id <principal>/<slug> \
  --principal-seed ~/.config/nats/cortex.nk \
  --registry-url <registry-url> --registry-pubkey <pinned-b64> --apply
```

Rules (all fail-closed):

- **Root-signed, not stack-signed.** The retire is authorized by the principal **root** seed (`--principal-seed`) — the same root-only authority adding a stack uses (#791). There is **no `--seed-path`**: the retiring stack's own key signs nothing. The registry verifies the claim against the **stored** record's `principal_pubkey`; a wrong seed is a 401.
- **Pinned verified read.** `--registry-pubkey` is REQUIRED — the CAS-token read of the current record is signature-verified against it before the retire is signed (never retire off an unverifiable read).
- **Live-membership refusal.** A stack with a live **ADMITTED** network membership is refused (`409`) — **revoke** it (admin: `cortex network secret revoke-member`) or **depart** it (member: `cortex network leave --apply`) first. `DEPARTED`/`REVOKED`/`REJECTED`/`PENDING` do not block.
- **Idempotent + last-stack-safe.** Re-retiring an already-retired stack is a `200` no-op. Retiring the last stack is allowed — a dormant, all-retired principal is a valid state (the record is preserved; full record deletion stays a global-admin manual op).

The stack stays on record as a tombstone: `GET /principals/:id` still returns it (with `retired_at`), but every consumer that treats `stacks[]` as the live set filters it out, and its `stack_pubkey` is no longer served as a verification key.
