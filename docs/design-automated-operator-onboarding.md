# Design: Automated operator onboarding (bot-driven, one-command)

**Status:** spec
**Author:** Andreas + Luna
**Date:** 2026-06-16
**Refs:** `docs/sop-federation-onboarding.md`, `docs/sop-stack-onboarding.md` §B, `docs/runbook-leaf-cred-issuance.md` (cortex#1012), `docs/adr/0012-external-operator-account-isolation.md`, the `cortex creds` ↔ `arc nats` contract (`the-metafactory/arc:docs/integrations/cortex-creds.md`, arc#134). Companion to the `#assistant-fleet` / `#assistant-fleet-onboarding` Discord onboarding.

---

## 1. Goal

Onboard a new operator (peer principal + their agent fleet) onto the
`metafactory-community` bus **frequently** and **mostly bot-driven** — an
onboarding agent in `#assistant-fleet-onboarding` does the work; the operator
runs **one command**; a human only makes the trust grant.

The current path (federation SOP + the leaf-cred runbook) is a ~9-step,
two-sided manual dance with hand-edited NATS config and an out-of-band secret
hand-off. This spec collapses it.

## 2. Current state — what already exists (verified on main)

The bus side is **further along than the SOP prose implies**:

- **`cortex creds issue <id>` → `arc nats add-bot <id> -a <account> --pub … --sub …`** already mints a bot's leaf creds in one command, with **least-privilege subject scoping built in**, plus `rotate` (`reissue-bot`) and `revoke` (`remove-bot --delete-creds`). arc owns `nsc` + `$SYS`; cortex is a thin delegator. The contract is **operator-parameterized** (`-a OP_JC` / `OP_ANDREAS`), so each admin already issues under their own operator.
- **Issuing a bot (user) needs NO hub restart** — user JWTs are self-contained, signed by an account the hub already trusts. (The restart cost attaches to *new accounts* and *revocations* under a MEMORY resolver — see §4.)
- `cortex network join` already renders the leaf remote + writes `policy.federated.networks[]`, and the leaf-renderer already detects operator-mode-vs-default bus (#794/#799).

**So the raw-`nsc` steps in `docs/runbook-leaf-cred-issuance.md` are the low-level fallback — the automated happy path is `cortex creds issue`.** That runbook + ADR-0012 need correcting (O-2).

## 3. Target flow

Operator runs ONE command:

```
cortex network join metafactory-community        # implies register
```

The onboarding bot (holding a scoped issuing key) then, server-side:

1. **Verifies** the operator's proof-of-possession registration (they signed with their own principal seed — `provision-stack register` already does this).
2. **Issues** their leaf creds: `cortex creds issue <operator-bot> -a community --pub federated.<op>.> --sub federated.<op>.>` — restart-free.
3. **Returns** the creds in the signed registration/descriptor response (no out-of-band paste).
4. `cortex network join` **auto-converts** the operator's bus to operator-mode (renders the operator JWT + account + resolver blocks itself), wires the leaf, writes policy, restarts — no hand-edited `<slug>.conf`, no #794 crash class.
5. The bot **assigns the `community-fleet` Discord role** (the role-based model) so presence + bus admission are one act.

Human's only step: **approve the trust grant** (admit this operator to the federated bus).

## 4. Decisions

- **D1 — Shared `community` account + per-operator *scoped bot*, by default** (revises ADR-0012). add-bot adds *users*, not accounts; a new *account* is what forces a `resolver_preload` edit + hub restart under MEMORY. So default external operators to **one shared `community` account with a per-operator bot scoped via `--pub/--sub federated.<op>.>`** — pure `arc nats add-bot`, restart-free, one command. Subject-permission scoping is the isolation boundary instead of the account boundary. **Dedicated-account (ADR-0012) stays an opt-in** for operators who need hard, namespace-level isolation. Document the weaker (namespace-shared) isolation honestly; pair it with tight `accept_subjects`.
- **D2 — `cortex network join` owns the operator-mode conversion.** It must render the operator-mode blocks from the network descriptor + issued creds rather than fail-fast and tell a human to hand-edit. Fail-fast stays only as the last resort when it genuinely can't (e.g. missing creds).
- **D3 — Issuance rides the register handshake**, not an out-of-band hand-off. The signed registration response carries the leaf package.
- **D4 — Scoped issuing key, never the root operator seed.** The onboarding bot mints via a dedicated operator *signing key* (`OP_*` already carries `signing_keys`), revocable + audited. It may only issue community-account bots — never create accounts, never sign other accounts.
- **D5 — The trust grant stays human.** Bus admission is a deliberate principal act; the bot prepares + executes, a human approves.

## 5. Work breakdown

| Slice | Scope | Repo(s) | Restart-free? |
|---|---|---|---|
| **O-1** | ADR revisit — shared-account + scoped-bot default (D1); supersede/amend ADR-0012 | cortex (docs) | — |
| **O-2** | Correct `runbook-leaf-cred-issuance.md` + stale SOP — `cortex creds issue` happy path; fix MEMORY/restart framing | cortex (docs) | — |
| **O-3** | `cortex network join` auto-converts an anonymous bus to operator-mode (D2) — render operator/account/resolver blocks + leaf + policy + restart from the descriptor; fail-fast only when creds absent | cortex | yes |
| **O-4** | `register → issue → join` handshake (D3) — verified register triggers `cortex creds issue` for the community account + returns the leaf package in the signed response; join consumes it | cortex + arc + registry | yes |
| **O-5** | Discord role-based admission (the onboarding bot assigns `community-fleet`; tender holds scoped Manage-Roles) | cortex/ops | — |

**Dependency order:** O-1/O-2 (decision + docs, no code) → O-3 (independent code) → O-4 (the handshake, depends on O-3 + D1's shared account) → O-5 (parallel, ops-ish).

## 6. Acceptance

- A new operator joins with a single `cortex network join metafactory-community` after `provision-stack register` — no hand-edited NATS config, no manual cred paste, no hub restart.
- Issuing/rotating/revoking a community operator's bot is one `cortex creds`/`arc nats` call each; revoke propagates (push or restart-free per the resolver in use).
- The onboarding bot can run the whole flow with a scoped key it never escalates beyond `community`-account bot issuance.
- A human approves the bus-admission trust grant; nothing else needs a human.

## 7. Security gates (stay human / one-time)
- Provisioning the bot's scoped issuing signing key (one-time).
- The per-operator bus-admission approval (D5).
- The shared-vs-dedicated isolation choice when an operator needs hard isolation (D1 opt-in).
- v1 `federated.` payloads cross cleartext-over-TLS, signing off — keep `accept_subjects` least-privilege; ramp signing → mTLS sooner for external parties.
