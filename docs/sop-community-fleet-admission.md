# SOP — Community-fleet admission (O-5: Discord role-based admission)

**Status:** ready-to-execute (needs Discord admin + the assistant-fleet onboarding bot)
**Owner:** principal (Discord admin) + the onboarding bot (#assistant-fleet-onboarding)
**Part of:** EPIC [cortex#1050](https://github.com/the-metafactory/cortex/issues/1050) → O-5 ([#1055](https://github.com/the-metafactory/cortex/issues/1055)) · design `docs/design-automated-operator-onboarding.md` §3 step 5 + §4 D5
**Companions:** [`sop-federation-onboarding.md`](sop-federation-onboarding.md), [`sop-network-join.md`](sop-network-join.md), [`runbook-leaf-cred-issuance.md`](runbook-leaf-cred-issuance.md)

> **Scope.** O-5 is the LAST step of the automated-operator-onboarding handshake (O-4):
> after `register → issue → join` admits a principal to the federated bus and a human
> approves the trust grant (D5), the onboarding bot **assigns one Discord role** —
> `community-fleet` — so **presence + Discord access land in a single, bulk-revocable act**.
> This is **cortex/ops**, not cortex daemon code: the actor is the onboarding bot
> (scoped Manage-Roles), and the artifacts are a Discord role + the bot's assign/revoke
> procedure. No change to the cortex runtime.

---

## The one idea

> **The `community-fleet` role IS the admission.** Holding it = "this principal is an
> admitted member of the federated community." Granting it (presence + channel access)
> and revoking it (bulk de-admission) are each **one role-membership change**, not a
> sweep of per-channel/per-bot edits.

This keeps two things cleanly separated (the design's central decision, D1 + D5):

- **Bus admission** is subject-scoped at the NATS layer — each principal's stack bot is minted with
  `--pub/--sub federated.<principal>.>` (per-principal least-privilege; `cortex creds issue`, O-2.5).
  The Discord role does **not** widen bus permissions.
- **Discord presence/access** is the role. The role carries the channel overrides; the
  principal's bots stay minimally-scoped on the bus regardless of the role.

So the role is a **surface-side** convenience (visibility + channel access + a single
revoke handle), never a bus-authority grant. Losing the role removes Discord access; it
does not by itself revoke bus creds (that is `cortex creds revoke` / `arc nats remove-bot`).

---

## Step 1 — create the `community-fleet` role (Discord admin, one-time)

On the **metafactory-community** guild, create a role:

| Property | Value |
|---|---|
| name | `community-fleet` |
| hoist / mentionable | optional (principal preference) |
| base guild permissions | **none beyond `@everyone`** — the role grants access via per-channel **overrides**, not guild-wide perms |
| position | **below** the onboarding bot's own top role (a bot can only manage roles ranked below its highest — see Step 2) |

**Channel overrides** the role carries (`ALLOW` View Channel + Send Messages on each; deny elsewhere by default) — `<REPLACE_ME>`, confirm the set with the principal:

- the per-repo community channels the fleet collaborates in (e.g. `#cortex`, `#myelin`, `#signal`, …)
- the shared `#assistant-fleet` / onboarding channel
- NOT principal-private or admin channels

> Channel overrides on the role (not per-member) are why admission is bulk-revocable:
> change the role's overrides once → every holder updates.

---

## Step 2 — scope the onboarding bot's Manage-Roles (Discord admin, one-time)

The onboarding bot (the assistant-fleet tender) needs the **minimum** to assign/remove
`community-fleet` and nothing more:

- Grant the bot the guild permission **Manage Roles** (`MANAGE_ROLES`).
- Place the bot's **own role ABOVE `community-fleet`** in the role list. Discord enforces
  that a bot may only add/remove roles **ranked lower than its own highest role** — this is
  the structural cap that stops the bot escalating: it can manage `community-fleet`, never
  admin/principal roles, because those rank above it.
- Do **not** grant Administrator. Manage-Roles + correct role-ordering is the whole grant.

**Security invariant:** the bot's Discord power is bounded by role-rank, exactly as its bus
power is bounded by the scoped issuing key (D4 — may only issue `community`-account bots).
Two independent least-privilege boundaries, neither escalatable from the other.

---

## Step 3 — assign on admission (onboarding bot, per principal)

Triggered as **step 5 of the O-4 handshake**, AFTER the human approves the trust grant (D5):

```
register → issue (cortex creds issue <principal-bot> -a community --pub/--sub federated.<principal>.>) → join
   → [human approves the bus-admission trust grant — D5]
   → bot: assign `community-fleet` to the principal's Discord member(s)
```

The assign is idempotent (already-holding → no-op) and is the **only** Discord act —
presence + channel access both follow from the single role. The bot logs the grant
(principal id, Discord member id, timestamp) for audit.

**The role grant must not precede the human trust-grant** — admission to Discord is the
visible signal of bus admission; gating it on D5 keeps "a human approves admission, nothing
else needs a human" true (acceptance §6).

---

## Step 4 — revoke (bulk or single)

- **Single principal:** remove `community-fleet` from their member(s). Independently revoke
  their bus creds (`cortex creds revoke <principal-bot>` / `arc nats remove-bot --delete-creds`) —
  the two are deliberately separate handles.
- **Bulk:** remove the role from all holders (or delete/replace the role) — one act
  de-admits the whole fleet from Discord. (Bus de-admission is still per-bot cred revoke.)

---

## Acceptance (O-5)

- [ ] `community-fleet` role exists with channel overrides only (no guild-wide perms).
- [ ] Onboarding bot holds Manage-Roles, its role ranked above `community-fleet`, no Administrator.
- [ ] On a real onboarding, the bot assigns the role **after** the human trust-grant — presence + channel access appear in one act.
- [ ] Removing the role removes Discord access for that principal; bus creds revoke is a separate, still-working act.
- [ ] The bot cannot assign any role ranked at/above its own (verified by role-ordering).

---

## What this SOP does NOT cover (deliberately)

- **The onboarding bot itself** — it is the assistant-fleet tender ([cortex#108 effort / #assistant-fleet-onboarding]); this SOP specifies the role + procedure it executes, not the bot's implementation.
- **Bus cred issuance/revoke** — `cortex creds` (O-2.5, #1061) + the `register→issue→join` handshake (O-4, #1054/#1064/#1090). The role is the surface half; the cred is the bus half.
- **Per-principal subject scoping** — `federated.<principal>.>` least-privilege (O-2.5), the actual bus-authority boundary.
