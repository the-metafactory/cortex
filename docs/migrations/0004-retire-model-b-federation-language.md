# Migration 0004 — Retire "Model A / Model B" federation language

**Status:** in progress · **Decided:** 2026-07-09 (Andreas) · **Anchor:** [ADR-0023](../adr/0023-federation-leaf-credential-model.md) — which already retired the language in CONTEXT.md + the four core docs (#1760/#1773). This migration finishes the sweep across the rest of the tree, deterministically.

## Why

The "Model A / Model B" dichotomy (ADR-0013) is design-time jargon that stopped mapping cleanly once the delivered model added hub-minted **transport** creds. Describe the layers directly instead.

## Replacement rules

| Old | New |
|---|---|
| "Model B" / "sovereign Model-B federation" (the positive frame) | **sovereign federation** (drop the label; keep "sovereign") |
| "Model A" (the rejected pattern) | **hub-minted identity** ("a hub minting your identity account") |

**Invariant preserved:** identity = your own `SU` signing key (never hub-minted); transport = hub-issued leaf credential. Model-A rejection was about hub-minting **identity**, not transport. Rename vocabulary only — never change a technical assertion. Keep the vocab gate green (no bare "operator").

## Scope

- **163** total occurrences. **104** actionable (below) + the historical records left as-is (§E) + the diagram (§D).
- Tick each box as its edit lands. Trust-path files (leaf-remote-renderer, network-secret) get an extra read: confirm the rename didn't alter a security assertion.

## A. Living docs — SWEEP

- [x] `docs/sop-federation-onboarding.md:10` — > **Authority:** [`docs/adr/0013-sovereign-federation-model.md`](./adr/0013-sovereign-federation-mod
- [x] `docs/sop-federation-onboarding.md:123` — This is the one mutual topology step. Both principals **agree on which side hosts the leaf hub** and
- [x] `docs/sop-federation-onboarding.md:206` — In cortex.yaml the link is named by `policy.federated.networks[].leaf_node` and (optionally, per F-3
- [x] `docs/sop-federation-onboarding.md:210` — > **The leaf hub is operator-mode, so the leaf side must be too (#794).** The `halden` / `community`
- [x] `docs/sop-federation-onboarding.md:229` — 1. **Leaf-account binding (code, mechanical) — [#1261](https://github.com/the-metafactory/cortex/iss
- [x] `docs/sop-stack-onboarding.md:215` — > **Authority:** [`docs/adr/0013-sovereign-federation-model.md`](./adr/0013-sovereign-federation-mod
- [x] `docs/sop-stack-onboarding.md:219` — Under **Model B** ([ADR-0013](./adr/0013-sovereign-federation-model.md)) `cortex network join` rende
- [x] `docs/sop-stack-onboarding.md:263` — Generate these blocks with **your own** `nsc` (do not copy any other principal's operator JWT, accou
- [x] `docs/sop-stack-onboarding.md:265` — > **Restart framing — this is a one-time *bus-conversion* restart.** The restart here is converting 
- [x] `docs/sop-community-fleet-admission.md:1` — > **Scope correction (ADR-0015).** This SOP covers **Tier-1 (chat) admission only** — the `community
- [x] `docs/design-own-operator-onboarding.md:4` — **Refs:** [ADR-0013](./adr/0013-sovereign-federation-model.md) (sovereign federation / Model B), [AD
- [x] `docs/design-own-operator-onboarding.md:12` — ADR-0013 drops the hub-minted guest account (Model A) entirely: **a principal MUST run their own NSC
- [x] `docs/design-own-operator-onboarding.md:66` — 7. **Ensure the bus is operator-mode under THIS principal's own operator.** Render the SOP §B0.1 ope
- [x] `docs/design-internet-of-agentic-work.md:246` — Model A is the minimum-viable today. Model B is what the Operator vision calls for (one principal, n
- [x] `docs/design-internet-of-agentic-work.md:248` — **Decision resolved by Q7** (see §5) — Andreas locked `local.{principal}.{stack}.>` as protocol stat
- [x] `docs/design-make-live-daemon-switch.md:3` — **Feature:** C-1257 (PR7 / #1225, EPIC #1142, ADR-0013 Model B)
- [x] `docs/design-wrap-server-config-tooling.md:3` — **Status:** SIGNED OFF + IMPLEMENTED (2026-06-28) — Option A (provision) + A2 (make-live bootstrap) 
- [x] `docs/design-wrap-server-config-tooling.md:143` — - [ADR-0013](./adr/0013-sovereign-federation-model.md) · [ADR-0012](./adr/0012-external-operator-acc
- [x] `docs/design-myelin-osi-scenarios.md:367` — Model A (Discord-as-federation) is the safe v0 — zero new infrastructure. But it contradicts Directi
- [x] `docs/design-myelin-osi-scenarios.md:371` — Model B is the only model that delivers what Direction A claims. Model A is the fallback for princip
- [x] `docs/design-myelin-osi-scenarios.md:521` — - **NATS leaf-node federation preconditions — owned by IoAW Phase D/E (cortex#110, cortex#117).** Mo
- [x] `docs/design-admission-gate-leaf-secret.md:7` — approval, mints nothing) · [ADR-0013](adr/0013-sovereign-federation-model.md) (sovereign Model-B; le
- [x] `docs/design-admission-gate-leaf-secret.md:37` — R1 repurposes the Model-A `register → PENDING → grant` machinery as an **identity-level admission ga
- [x] `docs/design-admission-gate-leaf-secret.md:54` — R1 is **not**: minting accounts, issuing `.creds`, or any Model-A machinery (retired under R2). It i
- [x] `docs/design-admission-gate-leaf-secret.md:84` — All on this branch's base (lifted from the Model-A O-4a machinery, transformed by migration `0007`):
- [x] `docs/design-admission-gate-leaf-secret.md:94` — | CLI | `src/cli/cortex/commands/network.ts` — `cortex network admit` (signs an admit decision claim
- [x] `docs/design-federation-hub-mode-and-join.md:24` — The ADR record itself carries the fork: ADR-0012 and the join-control-plane design doc assumed opera
- [x] `docs/plan-mc-future-state.md:309` — 17. **Sovereign by default — admission mints nothing:** admitting/authorizing a member creates no cr

## B. Source code (strings + comments)

- [x] `src/cli/cortex/commands/network-adapters.ts:582` — // C-1224 (ADR-0013 Model B): for a secret-auth leaf the secret bytes live
- [x] `src/cli/cortex/commands/network-adapters.ts:1488` — // G1c (#1117, ADR-0013 Model B) — wire the local-side `federated.>`
- [x] `src/cli/cortex/commands/network-derive.ts:46` — // network-leaf-package import removed — ADR-0015 retired O-4b / Model-A.
- [x] `src/cli/cortex/commands/network-derive.ts:143` — * C-1224 (ADR-0013 Model B) — the **leaf shared secret** for a secret-
- [x] `src/cli/cortex/commands/network-derive.ts:221` — /** C-1224 (ADR-0013 Model B) — `--leaf-secret` (the secret-auth pipe secret). */
- [x] `src/cli/cortex/commands/network-derive.ts:240` — // leafPackage removed — ADR-0015 retired O-4b / --from-package / Model-A.
- [x] `src/cli/cortex/commands/network-derive.ts:503` — // (--from-package / pkg?.credsPath removed — ADR-0015 retired O-4b / Model-A)
- [x] `src/cli/cortex/commands/network-derive.ts:507` — // C-1224 (ADR-0013 Model B) — the leaf shared secret (secret-auth pipe). Flag
- [x] `src/cli/cortex/commands/network-federation-wiring.ts:10` — * cortex NEVER calls nsc directly (ADR-0013 Model B invariant).
- [x] `src/cli/cortex/commands/network-lib.ts:91` — * C-1224 (ADR-0013 Model B, §Decision-1) — the **leaf shared secret** for a
- [x] `src/cli/cortex/commands/network-lib.ts:146` — * G1c (#1117, ADR-0013 Model B) — the agents NSC account (nkey-A) where the
- [x] `src/cli/cortex/commands/network-lib.ts:351` — // C-1224 (ADR-0013 Model B) — a leaf SECRET is an auth method on par with a
- [x] `src/cli/cortex/commands/network-lib.ts:397` — // `hasCreds`) so a secret-only Model-B leaf (C-1224) that triggered the
- [x] `src/cli/cortex/commands/network-lib.ts:491` — // (b.4) G1c (#1117, ADR-0013 Model B) — WIRE the local-side `federated.>`
- [x] `src/cli/cortex/commands/network-lib.ts:499` — // ADR-0013 Model B invariant: LOCAL accounts only — `federationAccount` is
- [x] `src/cli/cortex/commands/network-lib.ts:539` — `(G1c ADR-0013 Model B)`,
- [x] `src/cli/cortex/commands/network-lib.ts:547` — "(G1c ADR-0013 Model B)",
- [x] `src/cli/cortex/commands/network-lib.ts:559` — // C-1224 (ADR-0013 Model B) — SKIP this for a secret-auth leaf: it carries no
- [x] `src/cli/cortex/commands/network-lib.ts:585` — // C-1224 (ADR-0013 Model B) — render the SECRET-AUTH leaf when a leaf
- [x] `src/cli/cortex/commands/network-make-live-adapters.ts:9` — * tree + JWT come from arc (ADR-0013 Model B invariant).
- [x] `src/cli/cortex/commands/network-make-live-lib.ts:2` — * C-1257 (PR7/#1225, ADR-0013 Model B) — the pure orchestration behind
- [x] `src/cli/cortex/commands/network-ports.ts:505` — * G1c (#1117, ADR-0013 Model B) — the federation-wiring seam.
- [x] `src/cli/cortex/commands/network-ports.ts:513` — * cortex NEVER calls nsc directly (ADR-0013 Model B invariant).
- [x] `src/cli/cortex/commands/network-ports.ts:576` — * G1c (#1117, ADR-0013 Model B) — federation-wiring seam. Optional for
- [x] `src/cli/cortex/commands/network-provision-adapters.ts:10` — * runs nsc itself (ADR-0013 Model B invariant).
- [x] `src/cli/cortex/commands/network-provision-lib.ts:2` — * G1d / T1 (cortex#1139, ADR-0013 Model B) — the pure orchestration behind
- [x] `src/cli/cortex/commands/network-secret-adapters.ts:427` — // Modeled 1:1 on `network-federation-wiring.ts` (the ADR-0013 Model B arc-shell
- [x] `src/cli/cortex/commands/network-secret-ports.ts:110` — * calls nsc (the ADR-0013 Model B boundary; cortex NEVER calls nsc directly).
- [x] `src/cli/cortex/commands/network.ts:79` — // network-leaf-package import removed — ADR-0015 retired O-4b / Model-A.
- [x] `src/cli/cortex/commands/network.ts:274` — // C-1224 (ADR-0013 Model B) — the secret-authenticated leaf pipe. When
- [x] `src/cli/cortex/commands/network.ts:520` — // C-1257 (PR7/#1225, ADR-0013 Model B) — the daemon-switch step. Lands a
- [x] `src/cli/cortex/commands/network.ts:672` — // readLeafPackageFlag removed — ADR-0015 retired O-4b / --from-package / Model-A.
- [x] `src/cli/cortex/commands/network.ts:807` — * derive convention path may carry a hand-placed Model-A file we must never
- [x] `src/cli/cortex/commands/network.ts:880` — *   - `secret-auth` (v1) — the Model-B shared-string pipe; join renders the
- [x] `src/cli/cortex/commands/network.ts:984` — * Model-B joiner needs, REPLACING the misleading legacy `.creds not found (#821)`
- [x] `src/cli/cortex/commands/network.ts:995` — `then have an admin admit + seal. (This is a Model-B secret-auth join; a legacy .creds file is NOT t
- [x] `src/cli/cortex/commands/network.ts:1034` — * REPLACED with the actionable Model-B admission-state message. Pure + exported
- [x] `src/cli/cortex/commands/network.ts:1035` — * so the invariant is unit-testable. The rewrite is confined to the Model-B
- [x] `src/cli/cortex/commands/network.ts:1041` — *     into creds-file (Model-A) auth, so a missing/typo'd creds path is a genuine
- [x] `src/cli/cortex/commands/network.ts:1042` — *     "creds not found" error, NOT a Model-B admission gap; keep it verbatim
- [x] `src/cli/cortex/commands/network.ts:1062` — * C-1315 — when a join fails the Model-B creds preflight (#821) with no resolved
- [x] `src/cli/cortex/commands/network.ts:1156` — // C-1224 (ADR-0013 Model B) — secret-auth leaf overrides.
- [x] `src/cli/cortex/commands/network.ts:1164` — // (--from-package removed — ADR-0015 retired O-4b / Model-A)
- [x] `src/cli/cortex/commands/network.ts:1275` — // C-1224 (ADR-0013 Model B) — pass the secret-auth leaf material (when
- [x] `src/cli/cortex/commands/network.ts:1332` — // C-1315 — when the join fails the Model-B creds preflight (#821) and no leaf
- [x] `src/cli/cortex/commands/network.ts:1337` — // on the secret-auth (Model-B) no-secret path; an explicit --creds / --leaf-
- [x] `src/cli/cortex/commands/network.ts:4480` — make-live (C-1257, ADR-0013 Model B) The daemon-switch — lands a PROVISIONED
- [x] `src/cli/cortex/commands/network.ts:4509` — Mints nothing (no arc nats add-bot call — Model-A retired). Optionally
- [x] `src/cli/cortex/commands/operator-provisioning.ts:2` — * G1d (cortex#1139, ADR-0013 Model B) — the arc-shell driver for the
- [x] `src/common/nats/leaf-remote-renderer.ts:81` — * OPTIONAL since C-1224 (ADR-0013 Model B): a secret-authenticated leaf
- [x] `src/common/nats/leaf-remote-renderer.ts:89` — * C-1224 (ADR-0013 Model B, §Decision-1) — the **leaf shared secret** for a
- [x] `src/common/nats/leaf-remote-renderer.ts:171` — * For a secret-authenticated leaf (C-1224, Model B) this is the principal's
- [x] `src/common/nats/leaf-remote-renderer.ts:177` — * C-1224 (ADR-0013 Model B) — secret-auth material for a transport-pipe leaf.
- [x] `src/common/nats/leaf-remote-renderer.ts:288` — // C-1224 (ADR-0013 Model B) — SECRET-AUTH path. When the binding carries a
- [x] `src/common/nats/leaf-remote-renderer.ts:292` — // Model-B join carries no creds).
- [x] `src/common/nats/leaf-remote-renderer.ts:1630` — * C-1224 (ADR-0013 Model B) — splice `user:secret` into a clean dial URL's
- [x] `src/common/nats/leaf-remote-renderer.ts:1671` — // remote (account present) carries the line. A Model-B secret-auth leaf on an
- [x] `src/common/types/stack.ts:134` — * C-1224 (ADR-0013 Model B, §Decision-1) — the **leaf shared secret** for a
- [x] `src/common/types/stack.ts:194` — * Grammar (IAW design §3.2 Model B, Q7 lock-in):

## C. Source tests

- [x] `src/cli/cortex/commands/__tests__/network-adapters.test.ts:1177` — // still land 0600 (the secret lives inside the file for Model B).
- [x] `src/cli/cortex/commands/__tests__/network-derive.test.ts:790` — // C-1224 (ADR-0013 Model B) — leaf shared secret resolution.
- [x] `src/cli/cortex/commands/__tests__/network-federation-wiring.test.ts:9` — * Model B (ADR-0013): each principal wires their OWN half, in their OWN store.
- [x] `src/cli/cortex/commands/__tests__/network-federation-wiring.test.ts:209` — describe("G1c — federation-wiring step in joinNetwork (ADR-0013 Model B)", () => {
- [x] `src/cli/cortex/commands/__tests__/network-lib.test.ts:2573` — // C-1224 (ADR-0013 Model B) — secret-authenticated leaf join.
- [x] `src/cli/cortex/commands/__tests__/network-lib.test.ts:2575` — // A Model-B join carries a leaf SHARED SECRET (not a `.creds` file): the leaf
- [x] `src/cli/cortex/commands/__tests__/network-lib.test.ts:2586` — // Model B — NO creds file; the credential is the leaf secret (URL userinfo).
- [x] `src/cli/cortex/commands/__tests__/network-lib.test.ts:2592` — describe("C-1224 — secret-auth leaf join (Model B)", () => {
- [x] `src/cli/cortex/commands/__tests__/network-lib.test.ts:2642` — test("operator-mode auto-convert path is untouched by the secret delta (Model-B survivor)", async ()
- [x] `src/cli/cortex/commands/__tests__/network-lib.test.ts:2655` — // a secret-only Model-B leaf (hasCreds === false, hasSecret === true) on an
- [x] `src/cli/cortex/commands/__tests__/network-lib.test.ts:2663` — // Model B — NO creds file; the leaf secret is the only auth method.
- [x] `src/common/nats/__tests__/leaf-remote-renderer.test.ts:703` — // C-1224 (ADR-0013 Model B) — SECRET-AUTHENTICATED leaf rendering.
- [x] `src/common/nats/__tests__/leaf-remote-renderer.test.ts:705` — // The Model-B leaf is a secret-authenticated transport pipe: it binds the
- [x] `src/common/nats/__tests__/leaf-remote-renderer.test.ts:715` — // Model B: NO creds file — the credential is the URL userinfo secret.
- [x] `src/common/nats/__tests__/leaf-remote-renderer.test.ts:722` — describe("renderLeafRemote — C-1224 Model B secret-auth", () => {
- [x] `src/common/nats/__tests__/leaf-remote-renderer.test.ts:777` — describe("renderLeafIncludeFile — C-1224 Model B secret-auth serialization", () => {
- [x] `src/common/nats/__tests__/leaf-remote-renderer.test.ts:784` — // No `.creds` file on a Model-B leaf.

## D. Diagram — regenerate (not a text edit)

- [x] `docs/diagrams/cortex-network-join.svg` — "Model B" is rendered into the SVG text; regenerate from source (or edit the `<text>` nodes) so the alt-text already fixed in CONTEXT.md matches the image.

## E. LEAVE — historical records (do NOT edit; listed so they are not missed)

These record *when* the language was used; rewriting them falsifies history. Left intentionally:

- docs/adr/0012-external-operator-account-isolation.md
- docs/adr/0013-sovereign-federation-model.md
- docs/adr/0015-two-tier-onboarding-and-admission-gate.md
- docs/adr/0020-per-network-admin-authority.md
- docs/adr/0023-federation-leaf-credential-model.md
- docs/federation-1598-admit-mint-worklog.md
- docs/research-federation-decentralization.md
- docs/runbook-leaf-cred-issuance.md
- src/services/network-registry/migrations/0006_drop_hub_account.sql
- src/services/network-registry/migrations/0007_admission_requests.sql

- ADR-0013 keeps its original "Model A/B" wording as the origin of the (now-retired) terms; ADR-0023 §"Note on retired language" records the deprecation.

## Completion (2026-07-09)

**All credential-model "Model A/B" occurrences retired.**
- Living docs (9): sop-stack-onboarding, sop-federation-onboarding, sop-community-fleet-admission, design-own-operator-onboarding, design-make-live-daemon-switch, design-wrap-server-config-tooling, design-federation-hub-mode-and-join, design-admission-gate-leaf-secret, plan-mc-future-state.
- Source (25 files, 82 occurrences): comments + user-facing strings; test display labels. No behavioral assertion changed. `tsc` clean.
- Code symbol: `classifyModelBJoinBlocker` → `classifyJoinBlocker` (def + call).
- Diagram: SVG `<text>` nodes + regenerated PNG (rsvg-convert).

**LEFT — a DIFFERENT "Model A/B" taxonomy (not the credential model), intentionally untouched:**
- `design-internet-of-agentic-work.md` — Model A/B/C = stack-as-subject-segment routing.
- `design-myelin-osi-scenarios.md` — Model A = Discord-as-federation vs bus-federation.

**LEFT — historical records (the account of when the language was used):** ADR-0012/0013/0015/0020/0023, runbook-leaf-cred-issuance, research-federation-decentralization, federation-1598 worklog, network-registry migrations SQL.
