# Runbook — Issue a leaf credential for a community operator (admin / admin-agent executable)

**Status:** active
**Audience:** a **network/hub admin** (human or an admin agent with repo + `nsc` access) onboarding a peer operator onto `metafactory-community`
**Decision basis:** [ADR-0012](./adr/0012-external-operator-account-isolation.md) — each external operator gets their own account
**Related:** `docs/sop-stack-onboarding.md` §B0–B5, `docs/sop-federation-onboarding.md`, `docs/sop-network-join.md`, `docs/runbook-federation-peering.md`

This is the **hub side** of community-operator onboarding: minting the one secret artifact —
a leaf `.creds` — that lets an operator's cortex bind a NATS leaf to a hub. It is
copy-paste and agent-executable. The operator-facing steps (what *they* run) are in
`#assistant-fleet-onboarding` / `docs/sop-network-join.md`.

---

## Issuing admin — run under YOUR operator, not someone else's

`metafactory-community` can be served by a hub on **either admin's** side (the federation SOP's
"whose side hosts the leaf hub" choice). **Each admin issues creds under their OWN operator on
their OWN hub** — operator signing keys are never shared. So this runbook is parameterised by
the *issuing admin*; substitute your own operator + hub:

| Issuing admin | Operator | Hub config | Hub endpoint |
|---|---|---|---|
| **Andreas** (worked example below) | `OP_ANDREAS` (pubkey in `~/.config/nats/local.conf` — not reproduced here) | `~/.config/nats/local.conf` | `tls://nats.meta-factory.dev:7422` |
| **JC** | **his own operator** (e.g. `OP_JCFISCHER`) | his hub's nats config | his hub endpoint |

The **procedure is identical** for either admin — only the operator identity, the
`resolver_preload` file you edit, and the hub you restart differ. An operator onboarded by
Andreas gets an account under `OP_ANDREAS`; one onboarded by JC gets an account under JC's
operator. Whichever admin runs this, **select your operator first** and use **your** hub's
endpoint in the hand-off (step 4).

## Facts (Andreas's hub — the worked example)

| | Value |
|---|---|
| Operator | `OP_ANDREAS` |
| Internal agents' account | `ANDREAS_AGENTS` — **never** issue an external operator into this |
| System account | `SYS` |
| Hub config (resolver) | `~/.config/nats/local.conf` — `resolver: MEMORY` + `resolver_preload` |
| Network | `metafactory-community` — hub `tls://nats.meta-factory.dev:7422`, leaf_port `7422` |
| Resolver implication | a **new account** ⇒ add its JWT to `resolver_preload` + **restart the hub**; a new **user** in an existing account ⇒ no restart |

**Pre-req:** `nsc env` shows YOUR operator selected (Andreas: `nsc env -o OP_ANDREAS`; JC selects his own). Every `nsc` command below issues under whatever operator is selected — so this single check is what makes the runbook correct for either admin.

---

## Inputs

- `OPERATOR_SLUG` — short, lowercase, the operator's handle (e.g. `northwoods`). Becomes the
  account name (UPPER) + user name. Verify it's not already taken: `nsc list accounts`.

(Nothing is needed *from the operator* to mint the cred — it is a bearer credential minted
entirely on our side. They configure their side independently; see §"Hand-off".)

---

## Steps

### 1. Create the operator's own account (ADR-0012)

```bash
ACCT=$(echo "$OPERATOR_SLUG" | tr '[:lower:]' '[:upper:]')          # e.g. NORTHWOODS
nsc add account --name "$ACCT"
nsc edit account --name "$ACCT" --sk generate                       # account signing key (good hygiene)
# capture the account public key (A…) — the operator's `--account` value:
ACCT_PUB=$(nsc describe account --name "$ACCT" --field sub --raw 2>/dev/null || nsc list accounts | awk -v a="$ACCT" '$0~a{print $4}')
echo "account pubkey: $ACCT_PUB"
```

### 2. Create the leaf user + generate its creds

```bash
USER="leaf-$OPERATOR_SLUG"
nsc add user --account "$ACCT" --name "$USER"
# OPTIONAL least-privilege: confine the user to this operator's federated scope only
nsc edit user --account "$ACCT" --name "$USER" \
  --allow-pub  "federated.$OPERATOR_SLUG.>" \
  --allow-sub  "federated.$OPERATOR_SLUG.>" \
  --allow-pub  "_INBOX.>" --allow-sub "_INBOX.>"
nsc generate creds --account "$ACCT" --name "$USER" > "/tmp/$OPERATOR_SLUG.leaf.creds"
chmod 600 "/tmp/$OPERATOR_SLUG.leaf.creds"
```

### 3. Teach the hub the new account, then restart (MEMORY resolver)

```bash
ACCT_JWT=$(nsc describe account --name "$ACCT" --raw)               # the account JWT
# Add to ~/.config/nats/local.conf resolver_preload:
#   // Account "<ACCT>"
#   <ACCT_PUB>: <ACCT_JWT>
# then reload the hub (brief blip — andreas/jc leafs reconnect automatically):
#   launchctl kickstart -k gui/$(id -u)/ai.meta-factory.nats.<hub-label>     # or your hub restart cmd
```
> ⚠️ This is the one step that touches the live community hub. The `resolver_preload` edit +
> restart is required only for a **new account** (ADR-0012). Confirm the hub comes back up
> (`curl -s http://127.0.0.1:8222/healthz`) and andreas/jc leafs re-link before handing off.

### 4. Hand-off package (out of band — see security note)

Give the operator **four** things:
1. `/tmp/<slug>.leaf.creds` — the leaf credential (**secret — bearer key**).
2. `account pubkey` (`$ACCT_PUB`, an `A…`) — their `cortex network join --account` value.
3. `account JWT` (`$ACCT_JWT`) — for **their** local nats `resolver_preload` (operator-mode bus, §B0.1).
4. Endpoint: `tls://nats.meta-factory.dev:7422` (already in the `metafactory-community` registry descriptor).

The operator then runs the three commands in `#assistant-fleet-onboarding` (register → join → status).

---

## Security (Security-first)

- The `.creds` is a **private bearer key**. Prefer an **encrypted / one-time** hand-off
  (age/gpg, a self-destructing secret link, Signal) over a plain Discord paste.
- If a private channel paste is used for convenience: **delete the message** once the operator
  has pulled it, keep the channel's membership tight, and **rotate after first connect**
  (delete the user, re-`nsc add user` + `generate creds`) so the pasted copy is dead.
- The cred is **scoped + revocable** per ADR-0012 — confined to `federated.<slug>.>` (step 2)
  and independently revocable without touching any other operator.
- v1 `federated.` payloads are cleartext-over-TLS, signing off. For external operators keep
  `accept_subjects` least-privilege and prioritise the signing → mTLS ramp.

## Revoke (offboard / rotate)

```bash
nsc revoke add-user  --account "$ACCT" --name "leaf-$OPERATOR_SLUG"   # or delete the user
# to fully offboard: remove the account block from resolver_preload + restart the hub
```
