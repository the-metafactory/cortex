# Design — Wrap the raw `nsc` server-config generation in cortex tooling

**Status:** SIGNED OFF + IMPLEMENTED (2026-06-28) — Option A (provision) + A2 (make-live bootstrap) · **Author:** Luna (for Andreas) · **Refs:** cortex#1265 (from #1262), arc server-config-export · **Builds on:** [`design-onboarding-tooling-audit.md`](./design-onboarding-tooling-audit.md) (G1–G5), ADR-0013 (sovereign federation), ADR-0012 (account isolation)

> **Decision (§4) is signed off and built.** Andreas approved **Option A** (the server-config JWT-export bridge lives in `cortex network provision`) and the secondary **A2** (the local-only path bootstraps its initial `.conf` via `cortex network make-live`). Implementation: provision now exports operator + federation + (best-effort) SYS JWTs into `stack.nats_infra` (`network-provision-lib.ts` + `operator-mode-export.ts`, backed by new arc verbs `nats export-operator` / `export-system`); make-live bootstraps an initial operator-mode resolver via `renderOperatorModeBlocks` when none exists. **Note on SYS:** `nsc add operator` does not auto-create a SYS account, and the renderer treats `system_account` as optional, so provision exports it *best-effort* (a missing SYS is a clean skip, never a failure) rather than forcing a new account into the tree.

---

## 1. The question (cortex#1265)

Per the plug-and-play / "feel like TCP/IP" vision, onboarding a stack should be **cortex-commands-only** — no operator ever types a raw `nsc` / `nats-server` line. We are most of the way there. The audit ([`design-onboarding-tooling-audit.md`](./design-onboarding-tooling-audit.md)) and the consolidated runbook ([`sop-onboard-peer-principal.md`](./sop-onboard-peer-principal.md)) wrapped account-tree minting (`cortex network provision`), the daemon switch (`cortex network make-live`), and the join (`cortex network join`). **One raw edge remains:** generating the **initial operator-mode NATS server config** for a brand-new stack's bus — the `operator:` JWT + `system_account:` + `resolver: MEMORY` + `resolver_preload { … }` blocks that turn a hard-isolated/anonymous bus into one that can host an account tree. The SOP teaches this as a hand-edit (`sop-stack-onboarding.md §B0.1`), classically produced by raw `nsc generate config --mem-resolver --sys-account SYS --config-file <path>`.

This doc walks the onboarding flow end to end, isolates exactly where that raw edge is (and how narrow it actually is), and recommends a command-home.

---

## 2. Raw-command audit — every by-hand `nsc` / `arc` / `nats-server` step

Walking `sop-onboard-peer-principal.md` Steps 1–8 (the happy path), plus the `§B0.1` bus-conversion the SOP defers to, plus the local-only `provision → make-live` path. **Verdict legend:** ✅ already cortex-commands-only · ⚠️ tooled-but-doc-lag · ❌ genuine raw-`nsc` gap.

| # | Onboarding action | What the operator runs today | Tooling status |
|---|---|---|---|
| 1 | Stand up the stack | `cortex stack create <slug> --apply` | ✅ cortex. Scaffolds the config-split YAML. **Note:** it does **not** emit a NATS server `.conf` — `system.yaml` only points `nats.url` at a bus the operator is expected to already run. |
| 2 | Stack signing identity | `cortex provision-stack generate …` (or auto-provisioned by `arc upgrade`) | ✅ cortex |
| 3 | **Bus → operator-mode** (§B0.1) | **Hand-edit `<slug>.conf`**: paste `operator:` JWT, `system_account:`, `resolver: MEMORY`, `resolver_preload { <acct>: <jwt> }` — classically produced by raw **`nsc generate config --mem-resolver --sys-account SYS --config-file`** | ❌ **THE GAP (cortex#1265).** No cortex/arc verb renders the **initial** operator-mode server config for a fresh bus. Every downstream tool *assumes it already exists* (see §3). |
| 4a | Dedicated federation account | `cortex network provision <stack> --apply` (wraps `arc nats init-operator` + `add-account` ×2 + `add-federation-export`) | ⚠️ tooled. The SOP §4a "honest status" note still tells operators to run raw **`nsc add account <fed>`** by hand — that is **doc-lag**: `cortex network provision` (cortex#1139, `network-provision-lib.ts`) now mints the operator + federation + agents accounts via arc. Fix the SOP. |
| 4b | Register identity | `cortex provision-stack register …` | ✅ cortex |
| 5 | Roster admission (hub) | `cortex network admit …` | ✅ cortex |
| 5b | Leaf secret (hub) | `cortex network secret add-member …` | ✅ cortex |
| 6 | Join the network | `cortex network join <network> --apply` | ✅ cortex. O-3 (cortex#1053) **auto-renders** the §B0.1 operator-mode blocks via `renderOperatorModeBlocks` — *but only from JWTs supplied in config* (see §3, the linchpin). |
| 7 | Verify | `cortex network status` / `curl` | ✅ |
| 8 | Go private (encryption) | config edits only | ✅ config-only |
| — | New-network bring-up (admin) | `cortex network create …` | ✅ cortex (#747) |
| — | Registry admin bootstrap (one-time) | `wrangler secret put REGISTRY_ADMIN_PUBKEYS` + `wrangler deploy` | ✅ acceptable — one-time, not `nsc` |
| — | Local-only daemon switch | `cortex network make-live <stack> --apply` | ⚠️ tooled **but refuses a non-operator-mode bus** — it only *appends* an account to an **existing** `resolver_preload`; it cannot bootstrap one. Hits the same §B0.1 gap (see §3). |

**Conclusion of the audit:** there is exactly **one** genuine raw-`nsc` gap left in the cortex-commands-only vision — **row 3: generating the initial operator-mode server config for a brand-new bus.** Row 4a is doc-lag (already wrapped). Everything else is already cortex-only or acceptably one-time.

---

## 3. Where the gap actually lives — the linchpin (verified in code)

The gap is **narrower than it looks**, because the *renderer already exists*. Three facts, each verified against source:

1. **The blocks renderer exists.** `renderOperatorModeBlocks(currentConf, pkg)` (`src/common/nats/leaf-remote-renderer.ts:882`) takes an anonymous/empty `.conf` plus an `OperatorModeLeafPackage` `{ operatorJwt, account, accountJwt, systemAccount?, systemAccountJwt? }` and emits exactly the §B0.1 blocks (`operator:`, `system_account:`, `resolver: MEMORY`, `resolver_preload { … }`) while preserving the stack's own `server_name`/`listen`/`http`/`jetstream.domain`. It is idempotent (byte-stable on a converted bus) and is what `cortex network join`'s `convertToOperatorMode` already calls (`network-adapters.ts:563`).

2. **The renderer is starved of inputs.** `cortex network join` builds the package **purely from config** — `stack.nats_infra.{operator_jwt, account_jwt, system_account, system_account_jwt}` (`network-derive.ts:441-460`). If those fields are absent, *no package materialises* and join falls back to the #794 fail-fast. **Nothing populates those four JWT fields.** `cortex network provision` writes back `account`, `agents_account`, `creds_path`, `nkey_seed_path` (`network-provision-adapters.ts:77-83`) — but **not** the operator/account/system **JWTs** the renderer consumes. provision even says so explicitly: *"the operator-mode `.conf` render + bus restart are LEFT TO JOIN … render-only here"* (`network-provision-lib.ts:18-20`).

3. **`make-live` can only append, never bootstrap.** `makeLiveStack` refuses early if the bus has no `resolver_preload { }` block, pointing the operator at §B0.1 by hand (`network-make-live-lib.ts:271-282`). It *appends* an account JWT to an existing resolver (via `arc nats export-account`), it does not create the operator-mode skeleton.

**So the gap is a JWT-export-and-populate bridge, not a new renderer.** Concretely, two half-steps nobody owns:

- **(a) Export** the operator JWT + federation/agents account JWT + system-account JWT from the freshly-minted `nsc` store. `arc nats export-account` already exists (make-live uses it); **`arc nats export-operator` / `export-system` (operator JWT + SYS account JWT) may be an arc-side gap** — confirm / file an arc issue.
- **(b) Populate** them — either straight into the stack's `<slug>.conf` (render the initial operator-mode skeleton) *or* into `stack.nats_infra.{operator_jwt, account_jwt, system_account, system_account_jwt}` so the **existing** O-3 join / make-live path renders the conf with zero new rendering code.

The account-minting (`provision`) and the rendering (`renderOperatorModeBlocks`) both already exist. **The bridge between them is the whole of cortex#1265.**

---

## 4. The command-home decision — RECOMMENDATION + alternatives ⟵ SIGN-OFF NEEDED

This is the decision that needs Andreas's sign-off before implementation.

### Recommended — Option A: extend `cortex network provision` (export + populate)

Add a JWT-export + populate phase to the existing `provision` pipeline (`network-provision-lib.ts`), as steps 7–8 after the account mint and the `nats_infra` write-back it already does:

```
provision (today):  init-operator → add-account(fed) → add-account(agents)
                     → generate seed → wire federated.> → write nats_infra{account,agents,creds,seed}
provision (+1265):   … → export operator/account/system JWTs (via arc)
                        → write nats_infra{operator_jwt, account_jwt, system_account, system_account_jwt}
```

Provision **stays non-disruptive**: it writes only *config* (exactly as it does today), never the `.conf` and never restarts the bus. The existing O-3 join renderer (and, with a small extension, make-live) then has everything it needs — `cortex network join` converts the bus to operator-mode automatically, and the operator runs **zero `nsc`**.

**Why A:**
- Smallest diff that closes the gap. provision already holds the minted account pubkeys, the arc account-tree seam (`buildOperatorProvisioningAdapter`), and the config write-back adapter — adding JWT-export to the same fail-fast, ensure-shaped pipeline is a few steps, not a new command.
- Single source of truth: the account tree, its pubkeys, and its JWTs all resolve in one place, in one idempotent pass.
- Reuses `renderOperatorModeBlocks` wholesale — no new rendering code, no second place that knows the §B0.1 grammar.
- Preserves provision's documented non-disruption invariant (writes config, not the live bus).

**The one secondary sub-decision A forces (the local-only path):** a stack that **never federates** never runs `join`, and `make-live` today *refuses* a non-operator-mode bus. So for that path, either (A1) `provision` also renders the initial `.conf` directly (a `--render-conf` flag — provision crosses one step into touching the bus config, still no restart), or (A2) teach `make-live` to **bootstrap** (render-if-absent via `renderOperatorModeBlocks`) instead of only appending. **Sub-recommendation: A2** — it keeps provision config-only and makes "operator-mode bootstrap" a property of the daemon-switch step that already owns the resolver, with `renderOperatorModeBlocks` reused there too.

### Alternative — Option B: fold into `cortex stack create`

Reject. `stack create` is deliberately a **pure, offline, no-overwrite scaffold** that runs *before* the nsc tree exists (provision mints it later). It has no JWTs to render and no seed to shell to arc with. Folding account-minting + JWT-export into it would make a fast offline scaffold suddenly require arc/nsc and a seed, breaking its character and its idempotency guarantees.

### Alternative — Option C: a new verb `cortex network init-bus` / `cortex stack ensure-bus`

A dedicated verb that exports the JWTs and renders the operator-mode `.conf` (sibling to make-live's daemon-switch).

- **Pro:** cleanest single-responsibility ("make this stack's bus operator-mode"); most self-documenting; mirrors the make-live pattern.
- **Con:** adds a *fourth* verb to the `create → provision → make-live → join` sequence — directly against the audit's "fewer steps" thrust — and would re-export the same JWTs provision is already best placed to export. A new verb earns its keep only if we want the `.conf` render to be an explicit, separately-invocable act rather than a byproduct of provision. **Fallback if Andreas wants the render kept out of provision entirely.**

### The decision, stated for sign-off

> **PRIMARY:** Server-config (JWT-export + populate) lives in **`cortex network provision`** (Option A, recommended) — vs. a new **`cortex network init-bus`** verb (Option C). `cortex stack create` (Option B) is rejected.
>
> **SECONDARY (only under A):** the local-only / never-federates path renders its initial `.conf` via **make-live bootstrap (A2, recommended)** vs. a **`provision --render-conf` flag (A1)**.
>
> **DEPENDENCY to confirm:** `arc nats export-operator` / `export-system` (operator JWT + SYS account JWT). `export-account` exists; the other two may need an arc verb — confirm or file an arc issue before implementation.

---

## 5. Sketch of the wrapper interface (NOT to be built yet)

Illustrative only — to make the recommendation concrete. Under Option A the new seam is an **export port** alongside the existing `OperatorProvisioningPort`, shelling to arc (cortex never runs `nsc`):

```ts
/** Export operator-mode JWTs from the nsc store (cortex never runs nsc — arc owns it). */
export interface OperatorModeExportPort {
  /** `arc nats export-operator --json` → operator JWT (+ derived SYS account). */
  exportOperator(): Promise<{ ok: true; operatorJwt: string } | { ok: false; reason: string }>;
  /** `arc nats export-account <name> --json` → account pubkey + JWT (exists today). */
  exportAccount(name: string): Promise<{ ok: true; pubKey: string; jwt: string } | { ok: false; reason: string }>;
  /** `arc nats export-system --json` → SYS account pubkey + JWT (for system_account). */
  exportSystem(): Promise<{ ok: true; pubKey: string; jwt: string } | { ok: false; reason: string }>;
}
```

provision's config write-back (`ProvisionConfigWritePort.write`) gains four optional fields: `operatorJwt`, `accountJwt`, `systemAccount`, `systemAccountJwt`, persisted under `stack.nats_infra.*`. **Idempotency:** ensure-shaped like the rest of provision — present in config ⇒ no-op; absent ⇒ export + write. **No `--apply` mutation of the live bus** (config-only). The actual `.conf` render stays in `renderOperatorModeBlocks`, invoked by join (federated) or make-live-bootstrap (local-only).

**Cases to honor (call out at implementation time, not now):**
- **operator-mode** (the target): export the three JWTs, populate config, let join/make-live render.
- **MEMORY resolver** specifically (not a full NATS account-server resolver): the existing renderer emits `resolver: MEMORY` + `resolver_preload` — the same shape `make-live` appends to. Keep them grammar-compatible (one renderer).
- **already operator-mode** (established stack): export is a no-op if config already carries the JWTs — never clobber a hand-tuned `.conf`.

---

## 6. Layer-split check (CLAUDE.md / federation-wire-protocol SOP)

This stays inside the established split: **cortex (M7) orchestrates; arc owns the `nsc` boundary.** cortex shells to `arc nats export-*` and renders config text — it **never runs `nsc`** (ADR-0013 invariant, the same precedent as `cortex creds issue → arc nats add-bot` and provision's `init-operator`/`add-account`). No `federated.*` envelope is emitted, routed, or consumed by this tooling, so the wire-protocol 5-check is **not** triggered (consistent with the audit's G1–G5 scoping). No network id ever goes on the wire.

---

## 7. Cross-references

- [`design-onboarding-tooling-audit.md`](./design-onboarding-tooling-audit.md) — the G1–G5 audit this extends (server-config is the un-named residue of G1/G5)
- [`sop-onboard-peer-principal.md`](./sop-onboard-peer-principal.md) — the consolidated runbook whose §B0.1 deferral is the gap; **§4a doc-lag** to fix (provision already wraps account creation)
- [`sop-stack-onboarding.md §B0.1`](./sop-stack-onboarding.md) — the hand-edit this would replace
- [`design-make-live-daemon-switch.md`](./design-make-live-daemon-switch.md) — the sibling daemon-switch (the A2 bootstrap would extend it)
- [ADR-0013](./adr/0013-sovereign-federation-model.md) · [ADR-0012](./adr/0012-external-operator-account-isolation.md) — sovereign federation + account isolation
- **Code:** `network-provision-lib.ts` (extend) · `leaf-remote-renderer.ts:882` (`renderOperatorModeBlocks`, reuse) · `network-derive.ts:441` (the config fields to populate) · `network-make-live-lib.ts:271` (the bootstrap refusal A2 would relax)
- **Issues:** cortex#1265 (this) · cortex#1262 (parent) · cortex#1139 (provision/G1d) · cortex#1053 (O-3 join conversion)
