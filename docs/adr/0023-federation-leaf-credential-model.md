# ADR-0023 — Federation leaf credential: operator-mode scoped-user `.creds` (supersedes the ADR-0018 PSK)

**Status:** accepted (ratified with Andreas 2026-07-09) · **Supersedes:** [ADR-0018](0018-admission-gate-and-leaf-secret-distribution.md)'s transport-auth mechanism (per-member PSK → scoped-user `.creds`) · **Refines/reconciles:** [ADR-0013](0013-sovereign-federation-model.md) (sovereign federation — the identity/transport split below) · **Refs:** epic #1595 (payload swap), #1724 (`--leaf-user` drives the mint), #1626/#1599 (hub resolver MEMORY→nats prerequisite), arc#269 (`add-federated-user`), #1748 (2nd-stack admission keying gap), the course-correction commit `5db0fb5a`, `CONTEXT.md` §"Leaf credential", `docs/sop-network-join.md`, `docs/sop-onboard-peer-principal.md`

## Context

The federation model shipped a change (epic #1595, v6.3.0 — the "payload swap") that the surrounding docs did not absorb, producing a genuinely confusing spread where five documents told three different stories:

| Dimension | Stale docs said | Delivered code does |
|---|---|---|
| Transport credential | sealed **PSK** written as a hub `authorization` user (ADR-0018, CONTEXT §183, both SOPs) | a **scoped-user `.creds`** minted via `arc add-federated-user` under the hub's FED account and sealed to the member (`network-secret-lib.ts:698`) |
| Who mints it | "the hub issues **no** credential" (CONTEXT §216); "**your own** FED account" (`sop-onboard-peer-principal.md:13`) | the **hub-admin** mints it under the **hub's** FED account (`hubFedAccount`, `network-secret-lib.ts:679–698`) |
| Bind requirement | 2nd stack "**MUST** be operator-mode" (`sop-network-join.md:124`) | operator-mode account-bound **or** creds-only on `$G` — chosen by `resolveLeafBindMode` (`leaf-remote-renderer.ts`) |

The confusion was structural: the credential *form* changed, the *minting authority* changed, and a `$G`/creds-only bind became mechanically possible — but the docs still described the ADR-0018 PSK world, and `sop-network-join.md:30` even labels the newly-possible creds-only path a "rejected Model A." This ADR records the delivered model as the single anchor the docs align to.

The grounding is the code, read directly: the verbs (`network.ts` dispatch), the mint (`network-secret-lib.ts`), the bind (`leaf-remote-renderer.ts` / `resolveLeafBindMode`), and the signing identity (`stack-signing-key.ts`). Docs that disagree with these are stale.

## Decision

**1. Two layers, and only the transport layer changed.** Federation auth is two composed layers, not two competing models:

- **Identity / signing layer — sovereign, UNCHANGED (ADR-0013 holds).** Every stack signs every wire envelope with its **own `SU` nkey** (`stack.nkey_seed_path`), pinned as `stack.nkey_pub`, verified by peers through the `signed_by[]` chain. Nobody mints your identity. A hub minting your *signing/identity account* remains the **rejected Model A**.
- **Transport-auth layer — changed (this ADR, supersedes ADR-0018).** The leaf pipe authenticates with a **scoped-user `.creds`** the **hub-admin mints under the hub's FED account** (`arc add-federated-user`, scope `federated.{principal}.{stack}.>`) and **seals to the member's registered pubkey** (v2 seal, over the admission channel). This **replaced** the per-member PSK/`authorization` user. Verb: `cortex network secret add-member <net> <member-pubkey> --leaf-user <u> --apply`. The member's `cortex network join` unseals it; the member never handles a raw secret.

**2. The hub mints your *transport* credential, never your *identity*.** This is the precise reconciliation with ADR-0013. ADR-0013 rejected hub-minted **identity** (authenticating *as* an account inside someone else's NSC operator for who-you-are). The payload swap hub-mints only a **transport user** (a narrowly-scoped user in the hub's FED account, for pipe auth) — the member's signing key and their own local account stay theirs. **Transport-credential issuance ≠ identity issuance.** ADR-0013's "no hub-minted credentials" is hereby narrowed to "no hub-minted **identity**"; hub-minted transport creds are the delivered, accepted mechanism.

**3. Both binds are supported; operator-mode account-bound is RECOMMENDED, creds-only on `$G` is supported-but-not-recommended (for simplicity).** The code (`resolveLeafBindMode`, `leaf-remote-renderer.ts`) is **neutral** — it renders the leaf from the same sealed `.creds` two ways, chosen purely by the member's **local** bus type, with no enforced preference. The *recommendation* is a decision, not a code constraint:

- **operator-mode local bus — RECOMMENDED:** the leaf remote carries an `account:` line binding imported subjects to the member's **own** local FED account (in the member's own operator). This is what `jc/default`, `andreas`, and `jc/clawbox` (on AC25) run; `cortex network provision` + `make-live` stand the bus up.
- **`$G`/default local bus — SUPPORTED, not recommended:** no `account:` line — subjects land in `$G`, the binding rides in the `.creds` JWT. Mechanically valid and non-destructive. It is not recommended purely **for simplicity**: a single consistent bind model across all members is easier to document, support, and reason about than a two-mode fleet — not because creds-only is broken or less secure.

The scoped `.creds` (hub-account transport user) authenticates the pipe in **both** modes; the bind mode only decides the local `account:` line. The recommendation is the operator's choice, reversible per member; the code supports either indefinitely.

**4. Operator-mode hub + push-capable resolver are prerequisites.** The scoped mint edits the hub FED account JWT and (on rotate) revoke+pushes the old key; a preloaded MEMORY resolver cannot learn either without a hub restart. `secret add-member` refuses unless the network attests `resolver_mode: nats` (`network-secret-lib.ts:669`; #1626/#1599).

**5. Revoke/rotate are operator-mode nsc operations, not the conf-mode PSK path.** `secret revoke-member` / `rotate` = `arc reissue-federated-user` (revoke+push+re-mint) under the hub FED account. The old conf-mode `remove-user + SIGHUP` path is retired. The M3 payload key `K` (ADR-0019) rides the same v2 seal, unchanged.

## Consequences

- **ADR-0018's transport mechanism (per-member PSK) is superseded.** ADR-0018's admission gate (roster `register → PENDING → admit`, mints nothing) stands; only its leaf-secret-distribution mechanism changes (PSK → scoped `.creds`). ADR-0018 gets a supersede-note pointing here.
- **CONTEXT.md and both SOPs are corrected** to the scoped-`.creds` transport, the hub-mints-transport-not-identity reconciliation, and operator-mode-standard / creds-only-fallback. `sop-network-join.md:30`'s "creds-only = rejected Model A" framing is corrected: creds-only is a *fallback bind mode*, not Model A (Model A is hub-minted *identity*).
- **Stale code comments are flagged** (`network-secret-lib.ts:6/450`, `network.ts:367/434` still say "PSK") — comment-only cleanup, non-behavioural, filed as follow-up.
- **The 2nd-stack admission gap (#1748) is a known blocker of this model.** `secret add-member` and `network join` both classify a stack's admission by the stack's own pubkey, but the registry keys the covering admission on `stacks[0]`. A principal's 2nd stack therefore reads `no-row` and the join gate refuses (`joinBlockerMessage`, `network.ts:672`) even though the principal is admitted. Until #1748 lands, a 2nd stack is joined by hand-rendering its leaf remote (`credentials:` → the stack's own sealed `.creds`) — exactly what JC did for `jc/clawbox`.

## Alternatives considered

- **Creds-only on `$G` as THE standard (operator-mode as legacy) — REJECTED (2026-07-09).** Proposed mid-investigation as the simpler model (members stay `$G`, only the hub is operator-mode). Rejected because it does not match what shipped or what runs: `jc/default`, `andreas`, and `jc/clawbox` are all operator-mode on the hub, and the SOPs already guide members onto operator-mode with their own FED account. Creds-only is retained as the documented **fallback** bind, not the standard.
- **Keep the ADR-0018 PSK — REJECTED (shipped out by #1595).** The PSK's conf-mode `authorization` + SIGHUP delivery could not do runtime revoke/rotate on an operator-mode hub, and did not compose with the payload-key `K` delivery. The scoped `.creds` unifies the seal channel (leaf cred + `K`, one v2 seal) and gives runtime revoke via nsc + resolver push.
- **Hub-minted identity account (true Model A) — REJECTED (ADR-0013, unchanged).** The hub minting *who you are* collapses sovereignty. The delivered model deliberately mints only a scoped *transport* user; identity stays the member's own `SU` key.
