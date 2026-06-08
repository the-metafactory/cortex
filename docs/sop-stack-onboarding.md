# SOP — Stack onboarding (a new Discord-facing cortex stack)

**Status:** active
**Owner:** principal
**Audience:** a **principal** standing up a NEW cortex **stack** bound to a Discord guild — on its own **hard-isolated local bus** (the `halden` / `community` pattern), optionally **federated** onto a network afterward (Part 2).
**Authoritative detail:** [`CONTEXT.md`](../CONTEXT.md) §Principals/stacks/networks · [`sop-stack-identity.md`](./sop-stack-identity.md) (the signing key) · [`sop-network-join.md`](./sop-network-join.md) (federation, Part 2) · [`sop-discord-channel-routing.md`](./sop-discord-channel-routing.md).

> **What this is.** Standing up a Discord-facing stack used to be an undocumented manual recipe (identity → isolated bus → cortex config + Discord binding → plist → load). This SOP captures it so the next one is a checklist — and flags the steps that are candidates for a future one-command `cortex stack add`.

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

### Step 0 — Choose a semantic slug

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

Write `~/Library/LaunchAgents/ai.meta-factory.nats.<slug>.plist` (`nats-server -c ~/.config/nats/<slug>.conf`, `RunAtLoad`/`KeepAlive`), then:

```bash
launchctl load ~/Library/LaunchAgents/ai.meta-factory.nats.<slug>.plist
lsof -nP -iTCP:<port> -sTCP:LISTEN | grep nats   # verify up
```

### Step 3 — Write the cortex config (`~/.config/cortex/<slug>/`)

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

`~/Library/LaunchAgents/ai.meta-factory.cortex.<slug>.plist` → `/Users/<you>/bin/cortex start --config ~/.config/cortex/<slug>/<slug>.yaml`, `WorkingDirectory` = the installed pkg, `CORTEX_CHANNEL=<slug>`, logs to `~/.config/cortex/logs/cortex-<slug>.{log,error.log}`. Then `launchctl load …`.

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

---

## Part 2 — Federate the stack onto a network (Layer B)

Federating turns the stack's hard-isolated local bus into a **leaf** of a shared network, so peer principals' stacks interconnect at the bus level. The join itself is one command (`cortex network join`, see [`sop-network-join.md`](./sop-network-join.md)); the gap THIS SOP closes is the **new-network bring-up** (hub + registry seed + leaf cert) that precedes the first join.

> A Discord guild ≠ a network. The guild is an **L7 surface**; the network is an **L1–L3 NATS federation**. A stack can be in a guild (Part 1) without being federated, and federate (Part 2) without sharing a guild.

### B0 — Prerequisites (hub admin)

- **A reachable NATS leaf hub** (`host:port` + TLS). Reuse an existing endpoint under a NEW network id (e.g. `tls://nats.meta-factory.dev:7422`), or stand one up.
- **A leaf `.creds` for THIS stack on that hub** — the gating manual artifact (like a VPN cert). Issued by the hub admin (`nsc`: a user under the hub's leaf account → `nsc generate creds`). Drop at `~/.config/nats/<network>.creds`. Note the **account** NKey (`A…`) it belongs to — it goes in `stack.nats_infra.account`. See [`runbook-federation-peering.md`](./runbook-federation-peering.md) for the manual hub side.

### B0.1 — The bus MUST be operator-mode (the #794 lesson)

> ⚠️ **READ THIS BEFORE JOINING.** Part 1 stands the stack up on a **hard-isolated, anonymous** bus (the `halden` / `community` pattern — Step 2: *no* `leafnodes{}` / `cluster{}` / `gateway{}`, no operator-mode account tree at all; the isolation is the absence of all of those). **An anonymous bus cannot federate.**

`cortex network join` renders a leaf remote that binds the creds' **account** (the `A…` nkey from B0). To bind a leaf to an **operator-mode hub** (the metafactory hub is operator-mode + account-bound), the local `nats-server` must itself be operator-mode and **define that account** — otherwise it doesn't know the account the leaf remote names, and on (re)start it crashes:

```
nats-server: cannot find local account "AADPQ7…" specified in leafnode remote
```

→ the daemon fails to start and the stack's bus goes **down**. The fix (cortex#794) makes `cortex network join` **detect an anonymous bus and refuse, fail-fast** — rather than rendering a leaf that crashes the server — so a join never silently takes a bus offline. (Surfaced joining `andreas/community` on `:4224` to `metafactory-community`; recovered with `cortex network leave`. The fail-fast lands with #794; until it does, the guard below — convert the bus to operator-mode first — is the principal's responsibility.)

**To federate a hard-isolated stack, convert its bus to operator-mode first.** Edit the stack's `~/.config/nats/<slug>.conf` to add the NSC operator / system-account / resolver blocks — mirroring the meta-factory bus's `~/.config/nats/local.conf` (`OP_ANDREAS` operator + `ANDREAS_AGENTS` account + `resolver: MEMORY` + `resolver_preload`):

```hocon
server_name: <slug>-<principal>          # KEEP the stack's own identity/ports/JS domain
listen: 127.0.0.1:<port>
http: 127.0.0.1:<monitor-port>
jetstream { store_dir: …; domain: <slug>-<principal>; max_mem: 64mb; max_file: 1gb }

# --- copied from ~/.config/nats/local.conf (the operator-mode blocks) ---
operator: <OP_… JWT>                     # the NSC operator JWT
system_account: <SYS account A…>
resolver: MEMORY
resolver_preload: {
  <ANDREAS_AGENTS account A…>: <account JWT>   # the account the leaf creds bind to
  <SYS account A…>:           <account JWT>
}
# ------------------------------------------------------------------------
# DROP the meta-factory leaf include — `cortex network join` adds its OWN
# `include "leafnodes-<network>.conf"` for THIS network.
```

Copy verbatim the four operator-mode blocks from `~/.config/nats/local.conf` — the `operator:` JWT, the `system_account`, the `resolver`, and the `resolver_preload` account map; **keep** the stack's own `server_name` / `listen` port / `jetstream.domain` / `http` monitor port (do not collide with the meta-factory bus); and **do not** copy meta-factory's `include "leafnodes-metafactory.conf"` line (the join renders this network's leaf include itself). Restart the bus, confirm it comes up, then run `cortex network join`.

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

Payloads cross `federated.` **cleartext-over-TLS** in v1 (CONTEXT.md §Federation confidentiality) — envelope/payload encryption is designed but deferred. For a public-facing community stack, keep the dispatch scope tight (principal-only, least-privilege allowlist from Part 1) until that lands.
