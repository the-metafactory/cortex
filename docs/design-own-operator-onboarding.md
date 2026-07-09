# Design — own-operator onboarding: one-command sovereign setup (T1 / G1d)

**Status:** design (2026-06-27) · **Author:** Luna (for Andreas) · **Issue:** cortex#1139 (G1d) · **EPIC:** cortex#1142 T1
**Refs:** [ADR-0013](./adr/0013-sovereign-federation-model.md) (sovereign federation), [ADR-0012](./adr/0012-external-operator-account-isolation.md) (account isolation), [ADR-0015](#) (two-tier onboarding + admission gate), [`docs/design-onboarding-tooling-audit.md`](./design-onboarding-tooling-audit.md) (G1 linchpin), [`docs/sop-stack-onboarding.md`](./sop-stack-onboarding.md) §B0.1 (manual operator-mode conversion). `CONTEXT.md` §Identity & trust → **NSC operator**, **Federation account**, **Network-admission gate**.

> **Scope.** This is a DESIGN-FIRST scoping note. It defines the one-command UX, the compose-vs-net-new split, the idempotency/dry-run contract, and a TDD plan. No feature code, no PR.

---

## 1. The problem this closes

ADR-0013 drops the hub-minted guest account (hub-minted identity) entirely: **a principal MUST run their own NSC operator to federate.** The cost ADR-0013 §Decision-4 names explicitly — *"a newcomer with no NSC operator yet cannot federate until they stand one up"* — is paid down **"by investing in making 'stand up your own NSC operator' trivial (arc tooling)."** This doc designs that investment.

Today, standing up the sovereign federation substrate is the **least-tooled edge in the whole lifecycle** — ranked #1 ("Federated account-topology — zero tooling (the linchpin)") in [`design-onboarding-tooling-audit.md`](./design-onboarding-tooling-audit.md). The manual recipe (SOP §B0.1) is: hand-author an operator-mode `nats-server` `.conf`, copy four operator blocks verbatim from `~/.config/nats/local.conf`, hand-`nsc` an account, and hope the leaf binds. The pieces that ARE tooled are scattered across three verbs:

- `cortex provision-stack generate` — the **envelope signing** identity (`src/cli/cortex/commands/provision-stack.ts`)
- `cortex creds issue` → `arc nats add-bot` — per-agent **bus connection** creds (`src/cli/cortex/commands/creds.ts`)
- `cortex network join` — leaf render + O-3 bus operator-mode conversion + G1c local export/import (`src/cli/cortex/commands/network.ts`, `network-ports.ts`, `network-federation-wiring.ts`)

**G1d** (cortex#1139) is the missing seam: the dedicated **federation account** + the **agents account** config concept, *provisioned* (minted under the principal's own operator), so G1c's same-account no-op fallback (`network-lib.ts:91-99`, `agentsAccount?`) becomes a real cross-account export/import. T1 (cortex#1142) is the wrapper that makes the whole substrate **one command**.

### The three keys — DO NOT conflate (the accuracy correction)

A stack ends up holding three distinct cryptographic artifacts, at three different layers. The recent review correction: **the signing key does NOT authenticate the bus.**

| Artifact | Layer | Role | Provisioned by today |
|---|---|---|---|
| **Envelope signing seed** (`SU…`) | M3–M6 | signs envelopes; pubkey registered for verify | `cortex provision-stack generate` → `stack.nkey_seed_path` |
| **Local bus connection creds** (`.creds`, an `A→U` JWT chain) | M1 (local) | authenticates the daemon's connection to its **own** nats-server | `cortex creds issue` → `arc nats add-bot` |
| **Leaf shared secret** | M1 (federation) | authenticates the leaf transport pipe to a hub | out-of-band, two-party (ADR-0013 §Consequences) |

The **unifying idea** is NOT "one key does all three." It is **one ROOT the principal holds — the NSC operator seed** — from which the NATS account tree (the federation account, the agents account) and the local connection `.creds` all descend via JWT signing chains. The envelope signing seed is a separate ed25519 keypair generated *by the same command* and stored beside the operator seed (see Open Question 1 on whether to literally derive it). The leaf shared secret is the one artifact that is **never derived** — it is the mutual two-party handshake, exchanged out-of-band.

> **Layer discipline (the audit's hard rule, `design-onboarding-tooling-audit.md` §Separation of concerns):** cortex (M7) **orchestrates**; it **never runs `nsc` itself.** Every account-tree mutation goes *through arc* (`arc nats …`), the established precedent being `cortex creds issue → arc nats add-bot`. This design honors that: the new cortex verb shells to arc for every operator/account/creds mint and runs zero `nsc`.

---

## 2. One-command UX

### Headline verb

```
cortex stack ensure-own-operator <stack> [--apply]
```

A new subcommand under the existing `cortex stack` family (sibling of `create` / `list`, `src/cli/cortex/commands/stack.ts`). It sits between `create` and `network join` in the stack lifecycle:

```
cortex stack create <slug>            # scaffold config-split skeleton (#808)
cortex stack ensure-own-operator <s>  # ← THIS: mint the sovereign federation substrate
cortex network join <network>         # leaf link + local export/import (already tooled)
```

`<stack>` resolves the same way `cortex stack list` already resolves a stack (config-split dir → `stack.id`), so `principal` and `stack.id` are read from config, never re-typed.

### What it does (the pipeline, idempotent end-to-end)

Each step is **ensure-shaped**: present-and-correct ⇒ no-op; absent ⇒ mint; present-but-conflicting ⇒ refuse (never clobber). Order matters — operator before accounts before export/import before config.

1. **Ensure the NSC operator** (per-principal, one). If the principal has no operator seed at the conventional path, mint one via arc; write the seed `chmod 600`; refuse to clobber an existing seed (rotation is a deliberate, separate security event — mirrors `provision-stack generate`'s `--force` gate, `provision-stack.ts:202-218`).
2. **Ensure the federation account** (per-stack, one — ADR-0013 §Decision-3). Mint a dedicated NSC account under the principal's operator via arc; this is the `A…` the leaf binds to → writes `stack.nats_infra.account` (`src/common/types/stack.ts:102`).
3. **Ensure the agents account** (the G1d config concept). Mint/locate the account the dispatch-listener subscribes `federated.>` in; writes the new `stack.nats_infra.agents_account` field (net-new schema field, §3).
4. **Ensure the local connection creds.** Mint the daemon's bus `.creds` under the agents account via arc (`arc nats add-bot`, the existing `cortex creds issue` path) → writes `stack.nats_infra.creds_path`.
5. **Ensure the envelope signing identity.** Compose `provision-stack generate` (local-only, no `--register`) if `stack.nkey_seed_path` has no seed yet.
6. **Pre-stage the local `federated.>` export/import** between federation-account ↔ agents-account (the G1c wiring, `arc nats add-federation-export`). This is *also* run by `cortex network join`; running it here makes the stack "ready to join" and turns G1c's same-account no-op into the real cross-account wire. Idempotent (the arc primitive is a no-op when already wired).
7. **Ensure the bus is operator-mode under THIS principal's own operator.** Render the SOP §B0.1 operator-mode blocks (operator JWT + system_account + `resolver: MEMORY` + `resolver_preload`) into the stack's `nats-server` `.conf`, KEEPING the stack's own `server_name`/ports/JS domain. This reuses the O-3 `convertToOperatorMode` renderer (`network-ports.ts:194-215`) — but sourced from the principal's **own** freshly-minted operator material, not a hub-supplied package (the sovereign-model correction to O-3's input).

**Terminal state:** the stack stands on an operator-mode bus rooted in the principal's own NSC operator, with a dedicated federation account, an agents account, the `federated.>` export/import pre-wired, valid local creds, and a registered-able signing identity. The only things left before `cortex network join` succeeds are the **two irreducible two-party steps** (audit §The two irreducible steps): the **leaf shared secret** and **hub topology agreement**. The command's closing output names exactly those two as the remaining manual moments.

### Flags

| Flag | Meaning |
|---|---|
| `<stack>` (positional) | config-split stack dir or `stack.id`; principal + stack.id read from config |
| `--apply` | perform the mints/writes. **Default is dry-run** (prints the plan, touches nothing) — matches `stack create` (`stack.ts:120-132`) and `network join` (`network.ts:451-462`) |
| `--dry-run` | explicit dry-run; `--apply` + `--dry-run` together is a usage error (mirror `resolveApply`, `stack.ts:126-132`) |
| `--operator-seed <path>` | override the conventional operator-seed path (default: convention under `~/.config/nats/`) |
| `--force` | allow re-minting over an EXISTING operator/account/signing seed (deliberate rotation; off by default — no-clobber is the default) |
| `--json` | `{ status, items, data, error }` envelope (universal, per `_shared/envelope`) |

### Output (dry-run, the default)

```
cortex stack ensure-own-operator andreas/research: dry-run (no mutation; pass --apply)
  principal: andreas   stack: andreas/research
  PLAN:
    [mint ] NSC operator      OP_ANDREAS              (seed → ~/.config/nats/andreas.operator.seed, chmod 600)
    [mint ] federation account AC_ANDREAS_RESEARCH_FED → stack.nats_infra.account
    [ok   ] agents account     ANDREAS_AGENTS          (exists) → stack.nats_infra.agents_account
    [mint ] local creds        andreas-research-bot    → stack.nats_infra.creds_path
    [ok   ] signing identity    UA…                     (exists) → stack.nkey_seed_path
    [wire ] export/import       federated.> : fed-acct → agents-acct
    [conv ] bus → operator-mode  ~/.config/nats/research.conf (own operator OP_ANDREAS)
  Re-run with --apply to execute.
  AFTER this: exchange the leaf shared secret + agree hub topology with your peer, then `cortex network join <network>`.
```

---

## 3. Compose vs net-new

### Composes (reuse — do NOT reinvent)

| Need | Existing primitive | File |
|---|---|---|
| dry-run/`--apply` boundary, mutual-exclusion | `resolveApply` pattern | `src/cli/cortex/commands/stack.ts:126-132`, `network.ts:451-462` |
| subcommand parsing / `--json` envelope / exit codes | `parseSubcommandArgs`, `_shared/envelope`, `_shared/exit-result` | `src/cli/cortex/commands/_shared/` |
| chmod-600 seed write + no-clobber-without-`--force` | `generateStackIdentity` / `enforceChmod600` | `provision-stack.ts:202-218`, `src/common/config/file-permissions.ts` |
| signing identity (step 5) | `cortex provision-stack generate` | `provision-stack.ts` (`runGenerate`) |
| local creds mint (step 4) | `cortex creds issue` → `arc nats add-bot` | `creds.ts` (`arcVerbFor`, `creds.ts:528`) |
| local `federated.>` export/import (step 6) | `arc nats add-federation-export` via `FederationWiringPort` | `network-federation-wiring.ts`, `network-ports.ts:379-413` |
| operator-mode `.conf` rendering (step 7) | `convertToOperatorMode` / `renderOperatorModeBlocks` (O-3) | `network-ports.ts:194-215` |
| `stack.nats_infra` schema (account/creds_path/operator blocks) | `StackNatsInfraSchema` | `src/common/types/stack.ts:69-134` |

### Net-new (the genuinely new code)

1. **`cortex stack ensure-own-operator` orchestrator** — a new handler in `src/cli/cortex/commands/stack.ts` (+ a `stack-ensure-operator-lib.ts` for the pure plan-builder, mirroring `stack-lib.ts`). Wires the ports above into the 7-step ensure pipeline; live vs dry-run port selection like `network.ts:558`.

2. **arc verbs for operator + account minting (the linchpin — lives in arc, cortex#1139 names this explicitly: "may need `arc nats add-account` if absent").** cortex shells to them; it never runs `nsc`:
   - `arc nats init-operator <name> --json` — mint a principal's NSC operator (likely **net-new in arc**; verify against the arc contract). Idempotent / no-clobber.
   - `arc nats add-account <name> --json` — mint a dedicated account under the operator (cortex#1139: "may need `arc nats add-account` if absent" — **verify whether arc already ships it**; if not, it's an arc dependency this work declares).
   - A thin cortex driver mirroring `creds.ts`'s arc-subprocess pattern (`creds.ts:345` "arc nats subprocess driver", `arcVerbFor`, the `arc.nats.v1` schema pin `creds.ts:112`). New driver module `src/cli/cortex/commands/operator-provisioning.ts` (sibling of `network-federation-wiring.ts`).

3. **The `agents_account` schema field (the G1d config concept).** Add `agents_account: z.string().regex(/^A[A-Z0-9]{55}$/).optional()` to `StackNatsInfraSchema` (`src/common/types/stack.ts:134`). This is the field `network-lib.ts:91-99` already reads as `agentsAccount?` and `network-ports.ts:401-402` flags as "tracked as G1d" — adding it splits the federation account from the agents account so the export/import is a real cross-account wire instead of the same-account no-op.

4. **Config write-back helper** — write the six resolved fields (`account`, `agents_account`, `creds_path`, plus operator-mode `.conf` and `nkey_seed_path`) back into the config-split `stacks/<stack>.yaml`, reusing the same write path `network join` uses (`ConfigStorePort.writeNetworks` analogue, `network-ports.ts:289-294`). Addresses the audit's #4 finding (post-boot write-back trap) for the account fields.

---

## 4. Idempotency, no-clobber, dry-run boundary

- **Ensure-shaped, not create-shaped.** Re-running on an already-set-up stack is a clean no-op that re-prints the plan with every line `[ok]`. This is the property the verb name (`ensure-`) promises and the audit's onboarding-agent capstone needs (an agent must be able to re-run safely).
- **No-clobber seeds, `chmod 600`.** Every seed (operator, signing) is written `0600` and refuses to overwrite an existing seed without `--force` — reusing `enforceChmod600` + the `generateStackIdentity` clobber-refusal (`provision-stack.ts:172-218`). Rotation (`--force`) is a deliberate, loud, separate act, exactly as `provision-stack` treats it.
- **Dry-run by default, `--apply` to mutate.** Matches `stack create` and `network join` precisely (the `resolveApply` contract). A dry-run reaches into **read-only** arc calls only where they exist (or pure plan computation) and renders the plan; it writes nothing, mints nothing, restarts nothing. `--apply` + `--dry-run` together → usage error (exit 2).
- **Fail-fast before any mutation.** Resolve the full plan (what exists, what must be minted) and validate it BEFORE the first `--apply` write — so a half-provisioned stack is never left behind. Mirrors `network join`'s "READ all pre-flight checks before any mutation" discipline (`network-ports.ts:168-193`, `canBindAccount`/`resolveBindMode`).
- **arc is the only account-tree mutator.** cortex emits zero `nsc`; every mint is an `arc nats …` subprocess with the `arc.nats.v1` schema check and the `MIN_ARC_VERSION` guard from `creds.ts`.

---

## 5. Test plan (TDD targets)

Write tests first, against injected ports (the codebase's established seam style — `network-federation-wiring.test.ts` records port calls). No real `nsc`/arc in unit tests.

**Pure plan-builder (`stack-ensure-operator-lib.test.ts`):**
- Empty stack (nothing provisioned) → plan mints operator + fed-acct + agents-acct + creds + signing + wire + convert (7 actions).
- Fully-provisioned stack → plan is all `[ok]`, zero mutations (idempotency proof).
- Partial state: operator exists, accounts absent → mints only the accounts (each step independently ensure-shaped).
- `agents_account` present + distinct from `account` → wire step is cross-account; absent → same-account no-op is flagged (the G1c→G1d transition assertion).

**Orchestrator (`stack-ensure-operator.test.ts`, injected arc/file/plist ports):**
- Dry-run (default): records ZERO mutating port calls; prints the plan; exit 0.
- `--apply`: records the expected mint/write calls in order (operator → accounts → creds → wire → convert).
- No-clobber: existing operator seed without `--force` → refuses, exit 1, seed untouched.
- `--force`: re-mints (records the clobber), loud in output.
- `--apply` + `--dry-run` → usage error, exit 2.
- arc absent / below `MIN_ARC_VERSION` → clear, arc-naming error (reuse `creds.ts` error-surface assertions).
- arc mint failure mid-pipeline → fail-fast, no partial config write-back (transactional-ish: validate-then-write).

**Schema (`stack.test.ts` extension):**
- `agents_account` accepts a valid `A…` NKey, rejects a `U…`/malformed key, stays optional.

**Contract probe (integration, gated):**
- Assert the exact arc verbs + `--json` shape the driver depends on (`init-operator`, `add-account`) exist at the pinned arc version — or fail with a precise "arc dependency unmet (cortex#1139 / G1d)" message. This is where the arc-side gap (Open Question 3) surfaces concretely.

---

## 6. Open questions (need an Andreas decision)

1. **Derive the signing seed from the operator seed, or co-generate?** The unifying vision is "one root the principal holds = the operator seed." Cryptographically the envelope signing NKey (`provision-stack` `SU…`) is today an *independent* ed25519 keypair, not derived from the operator key. Two honest options: **(a)** one command generates BOTH seeds and stores the operator seed as "the seed you protect" (pragmatic, ships now, two files); **(b)** deterministically derive the signing seed from the operator seed via HKDF so there is literally one root secret (cleaner story, more crypto surface, harder rotation story). Recommend (a) for G1d; flag (b) as a follow-up if "one seed, period" is a hard requirement.

2. **Verb home: `cortex stack ensure-own-operator` vs `cortex network ensure-operator` vs a top-level `cortex federation init`?** The operator is per-*principal*; the federation account is per-*stack*; the command spans both. I propose `cortex stack …` because it's a stack-lifecycle step (create → ensure-own-operator → join) and `<stack>` carries the principal. Confirm the home, or pick a name.

3. **What does arc already ship?** cortex#1139 hedges: "may need `arc nats add-account` if absent." Need to confirm against the arc contract (`the-metafactory/arc:docs/integrations/cortex-creds.md`) which of `init-operator` / `add-account` exist. If absent, this work **declares an arc dependency** (an arc issue) and is blocked on it — `add-federation-export` (arc#243 / G1b) is the precedent for "cortex needs a new arc nats verb."

4. **Agents account: per-stack or per-principal-shared?** ADR-0012 isolation argues per-stack; the live meta-factory bus shares one `ANDREAS_AGENTS` across stacks. Does `ensure-own-operator` mint a fresh agents account per stack, or reuse a principal-shared one? Affects whether step 3 is a mint or a locate.

5. **Should ensure-own-operator also register the signing pubkey** (compose `provision-stack register`, network I/O), or stop at local-only and leave registration to the explicit `network join` / admission-gate flow? Registration is the network-admission-gate concern (ADR-0015) — I lean local-only here (keep the verb offline + idempotent), but confirm.

6. **Bus restart on operator-mode conversion (step 7).** Converting an anonymous bus to operator-mode is a one-time restart (SOP §B0.1 "one-time bus-conversion restart"). Does `ensure-own-operator` perform the restart (like `network join` does via `NatsServerPort.restart`, with the #821 health-probe + rollback), or render the `.conf` and leave the restart to the subsequent `join`? Leaning: render-only here, restart at `join` (keeps this verb non-disruptive), but it means the bus isn't *live* operator-mode until join.

---

## 7. Sequencing

G1d (the `agents_account` field + account provisioning) is the prerequisite that turns G1c's same-account no-op into a real cross-account wire. This verb (T1) is the wrapper. Per cortex#1142: **T1 feeds P1 (Pier)** — the onboarding concierge guides sovereign setup by driving exactly this command. So the deliverables, in order: (1) confirm/declare the arc verbs (Open Q3); (2) add the `agents_account` schema field; (3) the pure plan-builder + orchestrator behind the new `cortex stack ensure-own-operator`; (4) SOP §B0.1 rewrite to point at the one command instead of the manual recipe.
