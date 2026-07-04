# Design: Hub Mode & the Simplest Secure Federation Join

**Status:** Proposed — answers Andreas's 2026-07-04 question ("Can you change the mode of the hub to work with the model we've designed around? What does it mean to change mode — user journey, admin, security?")
**Anchors:** #1511 (leaf-auth fork), epic #1508 (federated dispatch data plane), #1507 (account boundary), ADR-0012/0013/0015/0018/0019/0020
**Method:** 11-agent analysis over the code, the ADR set, the SOPs, the 2026-06-26 join-issues log, the 2026-07-04 self-test findings, and nats-server source/docs; three independent design lenses (journey, security, admin-ops) adversarially red-teamed (3 attackers, 21 findings). Every load-bearing claim below carries a `file:line` or upstream-source citation.

## TL;DR

**Don't change the hub's mode. Change what `admit` seals.** The production metafactory hub already runs the correct end-state (operator-mode NSC/JWT, per-member `.creds` leaf users). The thing that doesn't fit is the sealed-**PSK** artifact the guided-join tooling delivers — inline leafnode users are structurally illegal on an operator-mode hub (the F4 crash). The fix is a payload swap through the *same* sealed channel: `admit` mints a subject-scoped NSC user `.creds` under the hub's federation account and seals **that** to the member's registered pubkey. The hub-side apply becomes a no-op — **zero hub config change, zero restart, zero resolver push per new member** (nats-server validates user JWTs against the account JWT it already trusts). The conf-mode alternative is disqualified on source-level grounds: hub leafnode authorization is **not reloadable** — every admit/rotate/revoke is a full hub restart dropping every member's leaf, and the revoke cortex ships today (remove user + SIGHUP) **silently fails to cut transport**. One hard prerequisite before the swap ships: the hub must run a push-capable (nats-based) account resolver, or revocation inherits the same restart tax.

---

## 1. Context: the two worlds we discovered

Everything here is downstream of one fact the self-test surfaced (`docs/federation-selftest-findings-2026-07-04.md`, F4): **two leaf-auth models coexist in this project, and they are mutually exclusive on one hub.**

| | World A — "the designed model" (ADR-0013/0015/0018) | World B — "the lived production hub" (ADR-0012 mechanics) |
|---|---|---|
| Hub server auth | **conf-mode**: inline `leafnodes { authorization { users = [{user, password}] } }` | **operator-mode**: NSC operator JWT + account resolver; no inline users |
| Member leaf auth | per-member PSK in the dial URL userinfo (`leaf-remote-renderer.ts:96-107`) | per-member user `.creds` file (`leaf-remote-renderer.ts:309-322`) |
| Where membership lives | the hub's **config file** (text surgery per member, `src/common/nats/hub-leaf-authorization.ts:83-93`) | **user JWTs** minted off-hub; hub config never changes |
| Status | what `admit --and-seal` ships today | what the metafactory hub actually runs (jc's live leaf is this shape; ADR-0012:22-24) |

The ADR record itself carries the fork: ADR-0012 and the join-control-plane design doc assumed operator-mode ("Flip server to operator-mode auth", `docs/design-network-join-control-plane.md:18`); ADR-0013 (point 1) and ADR-0018 (Q2/Q5/Q6) quietly assumed conf-mode — every mechanism in 0018 is "write a hub `authorization` user + reload". Nobody decided the fork; it accreted. **That un-decided fork is the root cause of the oscillating failure modes**: SOP contradictions C1–C3 (e.g. `sop-stack-onboarding.md` §B0 still instructs Model-A `cortex creds issue` two paragraphs from its own retirement notice), the stale-PSK Authorization-Violation storms, and the F4 crash are all children of two undocumented coexisting mechanisms plus one piece of mutable, restart-gated shared state (the hub conf).

nats-server ground truth that decides everything below (source-confirmed; the docs pages don't state either rule):

- **Operator mode forbids inline leafnode users, fatally**: `validateLeafNode` errors at startup — "operator mode does not allow specifying users in leafnode config" (`nats-server server/leafnode.go:263-266`). This is the F4 crash.
- **Leafnode authorization is not reloadable**: `getLeafNodeOptionsChanges` hard-rejects any change to leaf-auth `Users` on config reload (`server/reload.go:921-941`). SIGHUP keeps the old auth. Every conf-mode membership change is a **full hub restart**. Corroborated in-repo: the self-test harness restarts the hub rather than SIGHUPing (`scripts/federation-selftest.sh:229`), and the live June incident recorded "SIGHUP can't reload leaf auth".
- **A new user under an existing account costs the hub nothing**: "User JWTs only depend on the issuing Account NKEY" (docs.nats.io in-depth JWT guide) — no config change, no reload, no resolver push. Revocation is `nsc revocations add-user` + `nsc push` — a runtime operation (with a resolver caveat, §5.1).

## 2. What "changing the mode of the hub" would actually mean

There are two directions the fork can be closed. They are radically asymmetric.

### Direction 1 — downgrade the hub to conf-mode (make the shipped PSK artifact legal)

What the admin does, concretely: rewrite the hub conf removing the operator/resolver trust stanza; full restart (trust config isn't reloadable either); every existing `.creds`-authenticated leaf — jc's included — breaks mid-flight; all member leaves then land pooled in the `$G` account (`scripts/federation-selftest.sh:97-101`). Rollback is another full restart, stranding any interim PSK members. And then, forever after:

- **Every admit, rotate, and revoke is a full hub restart** (reload.go:921-941). Admitting member #12 drops members #1–11. Hub availability degrades linearly with community growth.
- **The revoke cortex ships is silently broken.** The apply path does remove-user + targeted SIGHUP (`network-secret-adapters.ts:205-238`), and the hub-owner artifact instructs "reload (SIGHUP)" (`network-secret-lib.ts:321-325`) — but the server rejects the change and keeps the old auth. The revoked member stays connected; the admin believes they're gone. ADR-0018 Q6 ("revoke MUST cut transport") is unimplementable as designed.
- **The hub conf becomes a plaintext credential dump**: every member's PSK inline (`hub-leaf-authorization.ts:83-93`); one conf read = network-wide transport-credential compromise. Plus a standing automated write-primitive into the live hub's config (the #1481 problem class).
- **Zero least privilege at the hub**: the managed users carry no permission fields; all members pool unscoped in `$G` — member A can `sub federated.B.>` and `pub` as anyone. ADR-0012's load-bearing scoping (0012:93-96) doesn't exist on this path.
- **No cryptographic identity**: a bearer password in URL userinfo (which also leaks into logs/ps output), vs a JWT + nonce-signature proof of key possession.

Verdict: **operationally and security-wise indefensible for a production, growing network.** It optimizes the demo and taxes every future membership event.

### Direction 2 — keep the hub operator-mode; make the tooling match it (the payload swap)

The hub is not touched at all. Four contained code seams change (each verified against source):

1. **Envelope** (`src/common/registry/sealed-leaf-secret.ts`): a `v: 2` envelope carrying `creds` (the verbatim `.creds` text) instead of `leaf_psk`. The extension seam is documented in the file itself ("the M3 seam", :2-14) and precedented — `payload_key` rode the same slot. The registry blob bound (8192 base64 chars, `src/services/network-registry/src/validate.ts:834-836`) fits a ~1.6 KB sealed `.creds` with ~5× headroom. **v2, not a "leaf_psk XOR creds" relaxation** — red-team showed the relaxation is a silent payload-downgrade vector and a version-skew trap (§5.2, R9/R12).
2. **Admin-side mint** (`network-secret-lib.ts` `addOrRotate` + the `SecretCrypto` port): instead of `mintPsk()` + hub-conf surgery, `admit` mints an NSC user under the hub's federation account (scoping mechanics in §5.3), exports the `.creds`, seals it. `decideHubLocality`/`renderHubOwnerArtifact` become unnecessary on this path — there is nothing to write on the hub.
3. **Member-side install** (`network.ts:790-830` `maybeAutoFetchLeafSecret`): when the unsealed envelope carries `creds`, write it to `~/.config/nats/<network>-leaf.creds` chmod 600 (the existing `enforceChmod600` hygiene, `network.ts:803`) and take the **already-shipped** creds branch of the leaf renderer (`leaf-remote-renderer.ts:309-322`; `network-lib.ts:565-568`) — the exact remote shape production runs today.
4. **Rotate/revoke** re-target nsc: rotate = re-mint + re-seal (no hub-conf round-trip); revoke = `nsc revocations add-user` + `nsc push` wired into `revoke-member` (the registry-side revoke POST is already payload-blind, `network-secret-adapters.ts:368-384`).

Everything else — sealing crypto (`seal-to-principal.ts:151-162`), registry transport/storage, PoP fetch (`fetch-sealed-secret.ts:63-104`), the admission state machine, `authorize`, the guided-join gate (`network-handoff-lib.ts:244-274`) — is payload-blind and survives untouched. The control plane the self-test proved green is kept; only the secret inside the sealed box changes.

**Answer to the literal question:** the fastest way to make the hub and the designed model agree is not to change the hub's mode — it's to change the model's payload. The hub already runs the end-state; the tooling catches up.

## 3. The three perspectives

### 3.1 User journey (the joining operator)

*Today (documented across 5 SOPs, of which 4 carry supersede banners):* stand up stack → generate identity → operator-mode bus prereq → provision account tree → register + pin registry → request admission → wait → **hub owner hand-applies a config snippet and restarts the hub** → authorize stamped → 2-pass guided join → hope dispatch works (issue-log §12: it didn't, and nothing said why). ~7 manual actions plus a wait, two of them on the admin/hub side, one of which (the paste+restart) is the leg that crashed the self-test hub and inspired the whole 3-leg handoff state machine (#1485).

*After the payload swap (greenfield operator "Priya", principal `priya`, stack `lab`):*

1. `cortex stack create lab --principal priya --apply` + `arc upgrade cortex` — born-aligned stack, seed auto-provisioned.
2. `cortex network join metafactory --apply` — derives identity/provision from config, registers PoP with the pinned registry, files admission, prints `PENDING — waiting for network admin (re-run or --wait to resume)`. **The wait is the trust boundary — the one irreducible human moment.**
3. Andreas runs one command (§3.2). No hub touch.
4. Priya re-runs `join` (or `--wait` resumes): PoP-fetch → **verify the hub-admin signature on the sealed row against the pinned admin pubkey** (§5.2, R1) → unseal → write creds 0600 → render the creds remote bound to her federation account → restart bus + daemon → **staged readiness trace**, each leg probed, not assumed: `identity ✓ · admitted ✓ · secret ✓ (signed by network admin) · leaf handshake ✓ (hub /leafz) · interest ✓ · federated echo ✓ (round-trip, 43ms)`.

Honest accounting (red-team R11): on a bare machine the count is still ~4–5 actions plus one wait — `<REPLACE_ME>` secrets, a running nats-server with JetStream, the registry pin, service management. The claim is not "one command"; the claim is **two commands + one wait for everything derivable, and a trace that names the failing leg when something breaks** — the anti-pattern of issue-log §12 ("everything green, ping dead, nowhere to look"). The echo probe needs a counterparty, so `network create` should stand up a hub-side always-on echo responder; the trace must distinguish "leaf+interest OK, no peer online" from failure (R5).

### 3.2 Admin perspective (Andreas running the hub)

Per-member marginal cost:

| | conf-mode PSK hub | operator-mode + creds payload |
|---|---|---|
| Admit | write hub conf (or hand-paste artifact) + **full hub restart**; all leaves drop | `cortex network admit <req> --apply` → mint scoped user + seal + stamp. **Hub untouched.** |
| Rotate | conf round-trip (reads old PSK back out of the conf, `network-secret-lib.ts:815-819`) + restart | re-mint + re-seal; hub untouched |
| Revoke | remove user + SIGHUP — **silently fails** (reload.go:921-941); real revoke = restart = all-member disruption | `nsc revocations add-user` + `nsc push` — runtime, cuts the live session, nobody else disturbed (prereq §5.1) |
| Blast radius of membership churn | every existing member, every time | zero for existing members |
| Per-member audit surface | a line in a config file everyone shares | `/leafz` entry with named account+user, registry admission row, `nsc describe account` revocations — a queryable ledger |
| Hub secrets at rest | every member's plaintext PSK | none |

The `authorize` leg exists today because a human hub owner had to paste config out-of-band. With a JWT payload, hub authorization is intrinsic to the mint — **but red-team R4/R7 stops us from blindly auto-stamping it**: `hub_authorized_at` should be stamped only after a positive hub-side probe (the account JWT actually visible on the hub's resolver), otherwise the guided gate turns back into an honor-system flag and reproduces the "every light green, dispatch dead" class at the auth layer. For split-authority networks (registry admin ≠ hub owner, the case `decideHubLocality` exists for), `authorize` and a hub-owner-side `mint-and-seal` command stay — raw creds must never transit a human channel (R4-journey).

Migration for the production hub: **none.** It already runs the target shape. The migration burden lands entirely on tooling + docs (and on member stacks via #1507's account unification, §6).

### 3.3 Security perspective

| Property | Operator-mode + sealed `.creds` | Conf-mode + sealed PSK |
|---|---|---|
| Identity binding | JWT chain operator→account→user + nonce-signature possession proof at connect | none — bearer string; holder IS the member; leaks via URL userinfo in logs |
| Secret at rest, hub | zero member secrets in hub conf | all member PSKs plaintext in hub conf |
| Secret in transit | identical for both: `crypto_box_seal` to the member's registered ed25519 key; registry sees ciphertext only | same (the one property the PSK path got right — fully inherited) |
| Revocation | runtime push, per-member, kills live session; timestamp-based (re-issue after revoke is valid — re-admit must be a conscious decision) | broken as shipped; correct form = network-wide restart |
| Least privilege | per-user JWT pub/sub permissions, enforced server-side (§5.3 makes this code, not discipline) | none at the hub; all members pool in `$G` |
| Member-key compromise | attacker gets one subject-scoped, attributable, runtime-revocable user | attacker joins `$G` unscoped: read all federation traffic, spoof any principal, until a hub restart |
| Registry compromise | see R1 below — must be fixed for **both** paths | same exposure |
| Hub compromise | hub is transport root either way; ADR-0019 payload key `K` is the mitigation (rides the same envelope unchanged) | same, plus the credential dump |

**The red-team's anchor finding (R1) applies to today's shipped path, not just the proposal:** `crypto_box_seal` is sender-anonymous, the registry holds the member's public key, and the member-side fetch verifies no authorship (`fetch-sealed-secret.ts:78-92`; the `/mine` row carries no admin signature). A malicious/compromised registry — or a first-boot MITM where the registry pubkey is unpinned (it's schema-optional today) — can seal its own envelope to the member, including a `payload_key` it knows, silently breaking the ADR-0019 confidentiality layer. Two mandatory hardenings, independent of the payload swap: **(a)** surface the hub-admin `{claim, signature}` (already posted with the sealed secret, `network-secret-adapters.ts:350-366`) on the member-facing row and verify it against the pinned network-admin pubkey before unsealing/installing; **(b)** make the registry pubkey pin mandatory, fail-closed. Filed as its own issue — this is a hardening of the live PSK+K path.

## 4. The decision

**D1. The hub keeps operator mode.** Conf-mode is retained *only* for hermetic self-tests and genuinely standalone simple hubs.
**D2. `admit --and-seal` becomes hub-mode-aware:** operator-mode network descriptor → mint+seal a subject-scoped NSC user `.creds` (v2 envelope); conf-mode → today's PSK path. **Fail-fast guard both ways** (the #794 pattern): the PSK artifact must be structurally unable to touch an operator hub (kills F4 permanently, and the C3 SOP trap of running `secret add-member --hub-config <real hub>` against production), and the emitted PSK-path instruction changes from "reload (SIGHUP)" to "restart" (it is currently wrong).
**D3. Member-side, the join consumes the creds through the existing creds-remote branch** — no new transport mechanism.
**D4. #1507's account unification lands on the FED account, never AGENTS** (§6).

## 5. Red-team-hardened requirements (what "secure" concretely means here)

The three attackers produced 21 findings; the design absorbs them as requirements. The five structural ones:

### 5.1 Resolver prerequisite (R1-ops, R2-journey — would have falsified the headline)
Everything cortex's own tooling renders is a **MEMORY/preload resolver** (`network-make-live-lib.ts:13,:106,:131`; its header says a SIGHUP doesn't pick up preload changes — hard restart). `nsc push` has no target against that: revocation would silently regress to preload-edit + restart, the exact tax this design kills. **Requirement:** creds-mode `admit` fail-fasts unless the network descriptor attests a push-capable (nats-based full) resolver on the hub, verified once by an actual push probe; the resolver mode is recorded in the registry network row. **Open question for Andreas: what resolver does the production hub run today?** (This was also the self-test's recommendation 2 — still the one unanswered question that gates the real join.)

### 5.2 Envelope v2 + payload-type pinning (R9-sec, R5-ops, R12-journey)
A creds-only v1-shaped envelope makes every pre-swap cortex member fail with an actively *misleading* shipped error ("sealed to a different pubkey or corrupted — ask them to re-seal", `network.ts:859-864`) — an admin/member re-seal loop debugging a phantom key mismatch. And an either-field decoder lets a hostile courier downgrade the payload type undetected. **Requirement:** `v: 2` discriminated envelope; the v1 decoder's error names the real remedy ("member must upgrade cortex"); the member's network policy pins the expected payload type and install refuses a mismatch; `minted_at` + user pubkey ride the envelope so staleness and subject-identity are checkable (a substituted-creds attack otherwise breaks attribution — R7-sec).

### 5.3 Least privilege is code, not SOP discipline (R6-sec, R6-ops, R3-journey)
The panel designs said "signed by a scoped signing key with per-member subjects" — **NATS can't express that as written**: a scoped signing key carries ONE role-wide permission set; a user signed by it must carry no own permissions. The realizable choices are (a) per-user permissions signed by the account/identity key, or (b) a subject-**templated** scope (`federated.{{name()}}.>` with username = `principal-stack` convention) — (b) is the design choice, verified in the self-test harness before shipping. **Requirement:** `admit` constructs the permission set itself and refuses to seal an unscoped export; member-side, `join` decodes its own user JWT after unseal and fails if the sub scope exceeds `federated.<me>.<stack>.>`. A typo'd hand-typed `nsc` flag must be structurally impossible, or the design's "least privilege" row is false.

### 5.4 Two-substrate admit must be idempotent (R7-ops)
Admit becomes nsc-mint + registry-seal. Mid-flow death (the historical norm: issues §8/§10/§15) leaves an orphaned live credential or a permanently colliding user name. **Requirement:** mint idempotently (`nsc describe user` first; re-export + continue if present); `hub_authorized_at` stamped only post-probe (§3.2).

### 5.5 Fix the dry-run lie first (R1-journey — CRITICAL, shipped today)
`joinNetwork` calls `ports.registry.registerStack()` unconditionally; the adapter never checks the `mutate` flag (`network-adapters.ts:386-423`) — while `departFromNetwork` IS dry-run gated (:476-481), proving the pattern was simply omitted. A "dry-run" join performs a live registration and raises a PENDING admission row an admin can act on. This is issue-log §8, still alive. One-line class of fix at the adapter; filed as its own bug. Dry-run safety is the trust foundation every journey claim stands on.

## 6. Interplay with #1507 (the account model)

The self-test's F1 conclusion stands: split FED/AGENTS member stacks can't complete outbound federated dispatch — export/import bridges messages, not subscription interest. The unification direction (publisher, responder, leaf on ONE account) composes cleanly with this design, with two constraints the lenses converged on:

- **The one account is FED, never AGENTS.** Folding onto AGENTS is ADR-0012's Option C, "rejected outright" (0012:34) — it would hand every federation peer a path toward internal agent traffic. ADR-0012's hub-side rule survives untouched; the member-side FED/AGENTS split was intra-principal hygiene, and it is empirically what breaks dispatch (attempts 1–4, findings doc).
- **Fix F3 inside the same PR** (explicit `make-live --creds` never propagates into the daemon's `nats.credsPath` — the mint-site re-plumb lands on exactly that bug's site, R8-ops), or the responder-silently-dormant failure doubles its diagnosis space.

Also flagged honestly (R6-ops): a single member-side account means the member's internal bus interest propagates hub-ward; the hub-side subject scoping in §5.3 is what contains it, which is another reason scoping must be code. Queue-group collisions across members in the shared hub account are a real misrouting hazard to test in the harness.

## 7. ADR bookkeeping

| ADR | Action |
|---|---|
| 0018 (leaf secret distribution) | **Amend.** Skeleton survives (sealed-to-pubkey, registry-opaque, PoP fetch, per-member scope, two authorities, revoke-cuts-transport). Q1's "no identity credential transits" is falsified — re-justify as a *transport-scoped, hub-account-issued, revocable* credential, not a hosted federation identity. Q6's mechanism becomes nsc revoke+push. |
| 0013 (sovereign federation) | **Amend point 1** (the `authorization { user, password }` sentence → hub-operator-issued transport-only user creds). Points 2–4 stand; member sovereignty (own operator, own keys, own bus) untouched. Explicitly NOT the rejected cross-operator JWT-trust alternative — no resolver preloads a foreign operator. |
| 0015 (two-tier onboarding) | **Amend one sentence** ("hub issues no account or credential" → "no identity account; a transport-only, subject-scoped leaf user credential is issued at admit"). |
| 0012 | No action — it is the *precedent*: this is 0012's shared-account + scoped-per-member-users design, delivered through 0018's sealed channel. It was retired for hand-delivery, not for its crypto; sealed delivery cures exactly that. |
| 0019 / 0020 / 0003 | Unchanged. (0003 arguably strengthened: DD-12's "no out-of-band creds wrangling" finally literal.) |

One new ADR should record D1–D4 (hub-mode ↔ leaf-auth matrix + the payload swap) — it closes #1511.

## 8. Failure-mode kill table

From the 28 catalogued failures (issues log 2026-06-26, SOP-documented modes, self-test findings):

| Failure | Fate under this design |
|---|---|
| F4 / crash: admit artifact vs operator hub | **Killed structurally** — hub-side apply is a no-op; mode-detect fail-fast guard |
| #17 stale-PSK Authorization-Violation storm | **Killed** — no hub-conf secret state to drift; rotate = re-mint (residual: registry-blob ↔ nsc drift, mitigated by `minted_at` + revoked-row blocking preflight, R2-ops) |
| Silent SIGHUP no-op revoke (new finding) | **Killed** on creds path (no reload needed); PSK-path docs corrected to "restart" |
| §12 undebuggable post-join timeout | **Killed** by the staged echo trace (with the "no peer online" distinction, R5) |
| §9 borrowed/missing creds | **Killed** — join writes the member's own sealed-delivered creds itself |
| §13/C1–C3 two documented models | **Killed only if** the payload-swap PR ships the single-SOP rewrite in the same PR (R10) — otherwise *worse* (three mechanisms documented) |
| §8 dry-run registry write | **Killed by the §5.5 bug fix** — independent, ships first |
| §19 TOFU registry pin | **Killed** — pin becomes mandatory (R2-sec) |
| F1/#1507 dispatch | separate epic-#1508 critical path; this design constrains it (FED, never AGENTS) |
| F2 `{principal}/default` peer resolution | **Not killed here** — needs the roster to carry the admission row's `stack_id` (data already exists end-to-end in the registry types); epic #1508 sub-issue |
| F3 daemon creds path | **Not killed here** — fix folded into the #1507 PR (§6) |
| §15 second-stack 409 | **Not killed** — cheapest fix is the 409 response naming `--principal-seed`; keep as its own issue |
| #794 operator-mode bus prereq | **Survives by design** (sovereignty is irreducible); auto-convert covers greenfield; refuse-messages point at SOP §B0.1 |

## 9. What Andreas decides

1. **The direction (D1–D4)** — hub keeps operator mode; admit swaps payload. (This doc's recommendation, all three lenses + red-team concurring.)
2. **Production hub resolver type** (§5.1) — memory-preload or nats-resolver? Decides whether revocation is truly zero-restart today or needs a one-time hub upgrade first. The single gating unknown for the real jc↔andreas join.
3. **Signing-key custody** (R5-sec, R4-ops) — the FED account signing key on one Mac is both the minting and revocation single point of failure, and a stolen key mints hub-valid creds invisible to the registry. Proposal: scoped signing key distinct from the account identity key, offline backup (or sealed to a second admin's registered pubkey through the existing channel), and periodic reconciliation of resolver users ↔ registry admission rows.
4. **Sequencing** — proposed: (1) §5.5 dry-run fix + R1 courier signature verification (both are hardenings of the live path, no redesign dependency); (2) #1507 single-FED-account + F3 (epic #1508 critical path — unblocks dispatch at all); (3) the payload swap + SOP single-rewrite; (4) the jc↔andreas live join, validated by the self-test-style staged trace.

## Sources

`docs/federation-selftest-findings-2026-07-04.md` · `docs/federation-join-issues-2026-06-26.md` · ADRs 0003/0012/0013/0015/0018/0019/0020 · `docs/design-network-join-control-plane.md` · `docs/sop-onboard-peer-principal.md` + the four superseded SOPs · `compass/sops/federation-wire-protocol.md` · cortex source as cited inline · nats-server source (`server/leafnode.go`, `server/reload.go`, `server/auth.go`) + docs.nats.io (JWT guide, leafnode config, nsc signing keys). Analysis: 11 agents (5 readers, 3 design lenses, 3 adversarial reviewers), 2026-07-05.
