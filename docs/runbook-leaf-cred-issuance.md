# Runbook — Issue a leaf credential for a community principal (admin / admin-agent executable)

**Status:** active
**Audience:** a **network/hub admin** (human or an admin agent with repo + arc/`nsc` access) onboarding a peer operator onto `metafactory-community`
**Decision basis:** [ADR-0012](./adr/0012-external-operator-account-isolation.md) — **default: shared `community` account + per-operator scoped bot**; dedicated account is an opt-in for hard isolation
**Related:** `docs/design-automated-operator-onboarding.md`, `docs/sop-stack-onboarding.md` §B0–B5, `docs/sop-federation-onboarding.md`, `docs/sop-network-join.md`, `docs/runbook-federation-peering.md`, the `cortex creds` ↔ `arc nats` contract (`the-metafactory/arc:docs/integrations/cortex-creds.md`)

This is the **hub side** of community-principal onboarding: minting the one secret artifact —
a leaf `.creds` — that lets a principal's cortex bind a NATS leaf to a hub. It is
copy-paste and agent-executable. The principal-facing steps (what *they* run) are in
`#assistant-fleet-onboarding` / `docs/sop-network-join.md`.

> **Restart framing (read first).** Issuing a leaf cred for a **bot/user in an account the
> hub already trusts is restart-free** — a user JWT is self-contained, signed by that
> account; the hub needs no reload to accept it. A **hub restart is required only** when
> you (a) add a **brand-new account** to a `resolver: MEMORY` hub (it must go into
> `resolver_preload`), or (b) **revoke** under MEMORY (the revocation list is part of the
> account JWT the hub holds in memory). The happy path below adds a *user* to the existing
> shared `community` account → **no restart**.

---

## Happy path — `cortex creds issue` (one command, restart-free)

Per [ADR-0012](./adr/0012-external-operator-account-isolation.md), the **default** is a
per-principal **bot in the shared `community` account**, scoped to that principal's federated
namespace. Mint it in one command:

```bash
OP=northwoods                                   # the principal's handle (lowercase)
cortex creds issue "leaf-$OP" \
  -a community \
  --pub "federated.$OP.>" \
  --sub "federated.$OP.>"
```

This shells out to **`arc nats add-bot leaf-$OP -a community --pub federated.$OP.> --sub
federated.$OP.> --json`** (contract: `arc:docs/integrations/cortex-creds.md`, schema
`arc.nats.v1`). arc owns `nsc` + the `$SYS` account; cortex is a thin delegator. It:

- mints the leaf user under the existing `community` account and signs its JWT,
- writes the `.creds` file (mode `600`, under a `700` dir) and returns its absolute
  `credsPath` + the durable `pubKey` (a `U…`) in the JSON envelope,
- confines the user to `federated.$OP.>` (the least-privilege subject scope that **is** the
  isolation boundary in shared-account mode — ADR-0012),
- needs **no hub restart** — it adds a *user* to an account the hub already trusts.

**Issuing admin (`nsc`-account-parameterized).** Pass `-a` for the `nsc` account you issue
under — each admin issues under their **own** `nsc` account tree on their **own** hub; signing
keys are never shared. arc resolves the active `nsc` account via `nsc env` when `-a` is omitted.

| Issuing admin | Issue under | Hub endpoint |
|---|---|---|
| **Andreas** (worked example) | `-a community` (a `community` account under `OP_ANDREAS`) | `tls://nats.meta-factory.dev:7422` |
| **JC** | a `community` account under **his own** operator (e.g. `OP_JCFISCHER`) | his hub endpoint |

**Rotate / revoke** are the same one-command shape, restart-free in shared-account mode:

```bash
cortex creds rotate "leaf-$OP" -a community      # → arc nats reissue-bot (revokes old pubkey, mints new)
cortex creds revoke "leaf-$OP" -a community      # → arc nats remove-bot --delete-creds (server-side revoke + push)
```

Then proceed to **Hand-off** below.

---

## Fallback — one-time `community` account bootstrap (only when a dedicated account is needed)

> ⚠️ **You only run this section in two cases:** (1) **once**, to bootstrap the shared
> `community` account itself the very first time, before any principal can be issued into it;
> or (2) when a principal takes the **dedicated-account opt-in** (ADR-0012) for hard,
> namespace-level isolation. For every ordinary principal after the shared account exists,
> **skip this — use the happy path above.** This is the raw-`nsc` path; it creates an
> **account**, which under the MEMORY resolver is the one thing that **does** need a hub
> restart.

### Facts (Andreas's hub — the worked example)

| | Value |
|---|---|
| Operator | `OP_ANDREAS` |
| Shared external account | `community` — the default home for external-principal bots (ADR-0012) |
| Internal agents' account | `ANDREAS_AGENTS` — **never** issue an external principal into this |
| System account | `SYS` |
| Hub config (resolver) | `~/.config/nats/local.conf` — `resolver: MEMORY` + `resolver_preload` |
| Network | `metafactory-community` — hub `tls://nats.meta-factory.dev:7422`, leaf_port `7422` |
| Resolver implication | a **new account** ⇒ add its JWT to `resolver_preload` + **restart the hub**; a new **user** in an existing account ⇒ **no restart** |

**Pre-req:** `nsc env` shows YOUR operator selected (Andreas: `nsc env -o OP_ANDREAS`; JC selects his own). Every `nsc` command below issues under whatever operator is selected — so this single check is what makes the runbook correct for either admin.

### Inputs

- `ACCT_NAME` — the account to bootstrap. For the shared default this is `community`
  (done once). For a dedicated-account opt-in, the principal's handle UPPER (e.g.
  `NORTHWOODS`). Verify it's not already taken: `nsc list accounts`.

### Steps

#### 1. Create the account

```bash
ACCT=community                                                      # or e.g. NORTHWOODS for the dedicated opt-in
nsc add account --name "$ACCT"
nsc edit account --name "$ACCT" --sk generate                       # account signing key (good hygiene)
# capture the account public key (A…) — the principal's `--account` value:
ACCT_PUB=$(nsc describe account --name "$ACCT" --field sub --raw 2>/dev/null || nsc list accounts | awk -v a="$ACCT" '$0~a{print $4}')
echo "account pubkey: $ACCT_PUB"
```

#### 2. Teach the hub the new account, then restart (MEMORY resolver — new ACCOUNT only)

```bash
ACCT_JWT=$(nsc describe account --name "$ACCT" --raw)               # the account JWT
# Add to ~/.config/nats/local.conf resolver_preload:
#   // Account "<ACCT>"
#   <ACCT_PUB>: <ACCT_JWT>
# then reload the hub (brief blip — andreas/jc leafs reconnect automatically):
#   launchctl kickstart -k gui/$(id -u)/ai.meta-factory.nats.<hub-label>     # or your hub restart cmd
```
> ⚠️ This restart is **only** because step 1 created a **new account**. Confirm the hub
> comes back up (`curl -s http://127.0.0.1:8222/healthz`) and andreas/jc leafs re-link
> before issuing into it. Once the account exists, every per-principal bot issued into it
> (happy path above) is **restart-free**.

#### 3. Issue the principal's bot into the now-existing account

For the shared `community` account, this is just the **happy path** above
(`cortex creds issue leaf-$OP -a community --pub/--sub federated.$OP.>`) — restart-free.

For a **dedicated-account opt-in**, issue the bot into that account the same way:

```bash
cortex creds issue "leaf-$OP" -a "$ACCT" --pub "federated.$OP.>" --sub "federated.$OP.>"
```

(Raw equivalent if `cortex creds` is unavailable on the hub box:
`nsc add user --account "$ACCT" --name "leaf-$OP"`, scope it with
`nsc edit user … --allow-pub/--allow-sub "federated.$OP.>"` + `_INBOX.>`, then
`nsc generate creds --account "$ACCT" --name "leaf-$OP" > /tmp/$OP.leaf.creds; chmod 600`.)

---

## Admit to Discord (grant-and-admit — run immediately after issuing the cred)

After the leaf cred is issued, grant the principal presence in the community Discord by assigning the `community-fleet` role. This is the O-5 admission step: one command, same act as the cred grant.

**Prerequisite (the bot must meet these; the command fails with a clear 403 if not):**
- The bot token must have **Manage Roles** permission in the `metafactory-community` guild.
- The bot's highest role must sit **above** `community-fleet` in the guild role hierarchy.

**Command:**

```bash
OP_DISCORD_ID=<the-principal's-Discord-user-snowflake>

# Assign community-fleet role — admits the principal to the community Discord
discord role add --server community --role community-fleet --member "$OP_DISCORD_ID"
```

The `community-fleet` name is passed as-is; `discord role add` resolves it to its snowflake id via `GET /guilds/{guild}/roles`. If the name resolves ambiguously (duplicate role names), pass the snowflake id directly via `--role <id>`.

**Revoke** (on offboarding, after `cortex creds revoke`):

```bash
discord role remove --server community --role community-fleet --member "$OP_DISCORD_ID"
```

> This step is human-executed (or admin-agent-executed). It is the "O-5 single act": issuing the cred and admitting to Discord happen in the same admin session, folded together — no separate watcher or daemon needed.

---

## Hand-off package (out of band — see security note)

Give the principal **four** things:
1. the leaf `.creds` (path from `credsPath` in the issue output) — the leaf credential (**secret — bearer key**).
2. `account pubkey` (the `A…`) — their `cortex network join --account` value.
3. `account JWT` — for **their** local nats `resolver_preload` (operator-mode bus, §B0.1).
4. Endpoint: `tls://nats.meta-factory.dev:7422` (already in the `metafactory-community` registry descriptor).

The principal then runs the three commands in `#assistant-fleet-onboarding` (register → join → status).

> Once the `register → issue → join` handshake lands (design spec O-4), the leaf package
> rides the signed registration response and this manual hand-off goes away — see
> `docs/design-automated-operator-onboarding.md` §3.

---

## Security (Security-first)

- The `.creds` is a **private bearer key**. Prefer an **encrypted / one-time** hand-off
  (age/gpg, a self-destructing secret link, Signal) over a plain Discord paste.
- If a private channel paste is used for convenience: **delete the message** once the principal
  has pulled it, keep the channel's membership tight, and **rotate after first connect**
  (`cortex creds rotate leaf-$OP -a community` — restart-free) so the pasted copy is dead.
- The cred is **scoped + revocable** per ADR-0012 — confined to `federated.<slug>.>` at
  issuance (the `--pub/--sub` scope, which is the isolation boundary in shared-account mode)
  and independently revocable without touching any other principal.
- In **shared-account (default) mode** there is no account wall behind the subject scope —
  so keep `--pub/--sub` and `accept_subjects` strictly least-privilege, and prioritise the
  signing → mTLS ramp for external principals. A principal needing a hard wall takes the
  dedicated-account opt-in (ADR-0012).
- v1 `federated.` payloads are cleartext-over-TLS, signing off.

## Revoke (offboard / rotate)

**Default (shared-account) — restart-free, one command:**

```bash
cortex creds revoke "leaf-$OP" -a community      # → arc nats remove-bot --delete-creds: server-side revoke + push + delete local creds
```

`arc` adds the bot's pubkey to the account revocation map and `nsc push`-es it; the bus
rejects that cred going forward. If arc returns `PUSH_FAILED`, the **old creds remain VALID
on the bus** — fix connectivity and retry the same command before considering it revoked.

**Dedicated-account opt-in — fully offboarding the account needs a restart (MEMORY):**

```bash
cortex creds revoke "leaf-$OP" -a "$ACCT"        # revoke the user (server-side)
# to drop the whole account: remove its block from resolver_preload + restart the hub
```
