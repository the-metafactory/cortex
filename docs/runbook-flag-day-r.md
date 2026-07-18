# Runbook — Flag-day R (the coordinated DID hard cut)

> **⚠️ This is a destructive, `[principal-hands]` cutover.** The cut is fired by the two
> principals together, following this checklist. It is **not** autonomous work — no executor,
> agent, or automation fires R. Pre-cut signed envelopes **stop verifying** at the cut and
> **cannot be rewritten** (the DID sits inside the signed bytes). Pre-cut signed history is
> **discarded, not migrated**. There is **no clean rollback** — the go/no-go gate *is* the
> control. Read [§9 Rollback posture](#9-rollback-posture) before scheduling.

**Goal:** in one coordinated flag-day release **R**, flip both principals' cortex stacks from the
deployed flat `did:mf` form to the class-explicit dot-form — envelope-field DID, subject
`@`-segment, and signature format together, atomically, per stack — so live federation runs on the
specified wire and a signed envelope emitted by one principal verifies on the other under the
class-explicit grammar.

**Worked example:** **Andreas** (NZ, principal `andreas`, stack `andreas/meta-factory`) ↔ **JC**
(Switzerland, principal `jcfischer`, stack `jcfischer/sage-host`). Substitute your own
`{principal}/{stack}` and pubkeys throughout; every `U…` is a placeholder for a real stack pubkey
exchanged out of band.

**Contract (read before firing):**
- myelin `specs/rfc/rfc-0001-identifiers.md` **§9** — the hard-cut decision (§9.1 release R, §9.2 the
  destructive consequence, **§9.3 the scoped persisted-state purge checklist**).
- myelin `specs/rfc/rfc-0002-subject-namespace.md` **§5** — the subject `@`-segment carries the whole
  class-explicit agent DID; it is atomically coupled to the envelope DID (one source,
  `src/subjects.ts:124`).
- myelin `specs/rfc/rfc-0004-envelope-signing.md` — the signature-format leg (field-ids +
  CONTEXT_TAG + canonical-88 + `spec_version`); the cortex-side crypto findings land here
  ([cortex#1973](https://github.com/the-metafactory/cortex/issues/1973)).
- myelin `specs/rfc/rfc-bcp-0001-wire-change-control-and-versioning.md` **§6.4** — the
  destructive/irreversible-cut `[principal-hands]` discipline this runbook instantiates.
- myelin `specs/rfc/rfc-0005-sovereignty-and-boundary-crossing.md` **§6.2** — `imported_principals`
  entries flip to class-explicit at R (no dual-accept window).
- Epic: [myelin#286](https://github.com/the-metafactory/myelin/issues/286) (Bucket-2 flag-day) ·
  this issue: [cortex#2035](https://github.com/the-metafactory/cortex/issues/2035).

**Owner legend** (every step carries one): **Andreas** · **JC** · **either** (one principal, order
doesn't matter) · **both** (both principals, coordinated / co-signed on the same call).

---

## 0. Sequence at a glance

R is one live session with both principals at the console. The order is fixed:

```
§1 Preconditions gate   → all meters green, decisions recorded, both signed   (BEFORE scheduling)
§2 T-minus / freeze      → announce, quiesce traffic, snapshot                 (both, on the call)
§3 The atomic cut        → deploy R build: DID + subject @-seg + signature flip together
§4 Engine adoption       → deployed engine imports ./wire; hand-written copies gone (git-grep proof)
§5 cortex#2034 swaps     → the 5 drift-site swaps + the vendored-schema deletion DECISION
§6 Deploy               → arc upgrade · launchd reload · ~/.config class-explicit · operator-mode bus
§7 Persisted-state purge → [principal-hands] go/no-go: discard/re-key/reissue (RFC-0001 §9.3)
§8 Verify live           → network status shows jc↔andreas folding both ways; probes round-trip
   Rollback posture      → no clean rollback; the gate is the control
```

§1 is the schedule gate. §2–§8 are the flag-day itself. §7 (the purge) is a **distinct go/no-go**
inside R, not part of "deploy".

---

## 1. Preconditions gate

**Nothing in §2 onward is scheduled until every item here is green.** This section is the
schedule-authorising review; the principals' sign-off on it (§1.7) *is* the authorisation to book R.

### 1.1 Meter — conformance runner reads zero known-defect (55 → 0)

Every windowed flip (Wave 2/3) deletes its known-defects manifest entries as it lands; R cannot fire
while any remain.

- **Command** (myelin checkout, `origin/main`): `bun test src/conformance/conformance.test.ts`
- **Expected:** full corpus green; the known-defects manifest (`src/conformance/manifest.ts`) is
  **empty** (`55 → 0`); no `loud-fail`, no stale-manifest entry (a manifested vector that now passes
  is itself a loud red).
- **Verify:** `git show origin/main:src/conformance/manifest.ts` shows an empty `MANIFEST`; CI
  conformance lane green on myelin main.
- **Owner:** either (read-only check; both confirm the reading at §1.7).

### 1.2 Meter — flag-day-inventory reports zero legacy sites

The deterministic site-inventory tool ([myelin#287](https://github.com/the-metafactory/myelin/issues/287))
scans **both** repos for un-migrated legacy-form sites (DID / NAK / capability / slug regex copies,
vendored schema, kebab NAK tokens, underscore capability ids).

- **Command:** `flag-day-inventory` (run against both the myelin and cortex checkouts per its README).
- **Expected:** `legacy sites: 0` across both repos.
- **Verify:** the tool exits non-zero if any legacy site remains; a re-introduced legacy-form site
  fails CI (the inventory tool runs in the build).
- **Owner:** either.

> Note: the stocktake site counts in myelin#286 are **estimates** (the 2026-07-17 scan; the NAK pair
> is apples-to-oranges). This tool's published per-category patterns are the ground truth — do not
> treat the stocktake numbers as the meter.

### 1.3 Meter — WP-1 federated-presence E2E harness fully live (test.todo → 0)

The harness (`src/__tests__/federated-presence.e2e.test.ts`,
[cortex#1877](https://github.com/the-metafactory/cortex/issues/1877)) ships one `test.todo` per gated
bug; each merged fix flips one live. It is the fire-precondition guard.

- **Command** (cortex checkout): `bun test src/__tests__/federated-presence.e2e.test.ts`
- **Expected:** **zero** `test.todo` remaining; every WP-3/4/6 guard is a live, passing assertion.
- **Verify:** `grep -c 'test.todo' src/__tests__/federated-presence.e2e.test.ts` → `0`.
- **Owner:** either.

### 1.4 The ./wire codecs are complete (the cut is a swap, not a build)

Before R, the deployed engine must be able to *swap* to `./wire` — every codec it will import must
already exist:

- `resolveNakReason` transport mapper ([myelin#233](https://github.com/the-metafactory/myelin/issues/233)).
- capability converged-id codec + segment-prefix matcher + presence fold-gate
  ([myelin#234](https://github.com/the-metafactory/myelin/issues/234)).
- class-explicit codec (`parseDid` / `render` / `decode` / `parseStackId` / verifier) — built
  (myelin#238).

- **Verify:** `git grep -n "resolveNakReason" origin/main -- src/wire` in myelin returns the mapper;
  the #233/#234 manifest entries are **deleted** (a completed codec both greens and removes its
  manifest entry — see §1.1).
- **Owner:** either.

### 1.5 The cortex#1973 signature-leg findings are assembled for R

The four RFC-0004 crypto-path findings land **at** R (they change with the signature format anyway).
Confirm each is implemented in the R build, not merely tracked:

1. Authority anchor moves `s[n-1]` → `s[0]` in `validateIngress` (truncation-safe attribution; SEV-high).
2. Freshness becomes admission-only (not re-applied on every re-verify) — myelin `src/identity/verify.ts:19,63,130`.
3. Federation verification floor enforced on `federated.*` ingress independent of local posture.
4. Gateway re-sign reordered **before** the empty-chain gate (stamp-before-admit).

- **Verify:** review the R build diff against
  [cortex#1973](https://github.com/the-metafactory/cortex/issues/1973); each of the four fixes is
  present with a test.
- **Owner:** both (crypto-path review — trust path).

### 1.6 DECISION — WP-4 DID-encoding-ambiguity wire decision

> **[DECISION RECORDED — [ADR-0025](../adr/0025-federated-did-encoding.md), Andreas 2026-07-19]: option (A), the hard cut.**
>
> cortex adopts the RFC-0001 §6.2 class-explicit dot-form (the sole grammar `./wire` implements); **no dual-accept window** (RFC-0001 §9). The §3 DID-flip steps proceed under this. cortex#1880's stale dual-accept criterion was struck. JC's involvement is the §10 two-party lockstep cut at execution (the history-discard consent that would have needed his co-sign is moot — the `jc↔andreas` leaf has carried `in=0/out=0`, no pre-cut federated history to lose).

**The problem (cortex#1876):** the deployed `did:mf:` prefix is overloaded across three
structurally-indistinguishable identity classes minted independently — stack `did:mf:{principal}-{stack}`,
principal `did:mf:{principal}`, agent `did:mf:{agent}` — all compared with `===`. The encoding is
provably **non-injective**: a peer id like `andreas-meta-factory` yields the same DID as boot stack
`did:mf:andreas-meta-factory`, and myelin `add()` is last-write-wins — a trust-displacement surface
currently held shut only by a hand-written runtime guard and a prose paragraph
(`identity-registry.ts:330-340`).

**What must be recorded before R (options framed, not chosen):**
- **(A) Class-explicit dot-form as the sole grammar** (RFC-0001 §6.2): `did:mf:agent.{p}.{s}.{a}`,
  `did:mf:stack.{p}.{s}`, `did:mf:principal.{p}`, `did:mf:hub.{network}` — the class tag makes the
  three classes structurally distinct; injectivity restored by construction. This is the form §3
  flips to and the rest of the RFC series assumes.
- **(B) Any residual ambiguity carve-out** the principals decide must survive the cut (e.g. a
  transitional identity-mapping for a specific carried-over name) — enumerated here if adopted, so
  §3/§7 can honour it. Default: none (RFC-0001 §9.1(6) fixes the only mappings: `did:mf:reflex` →
  `did:mf:system.reflex`, `did:mf:signal-tap` → `did:mf:system.signal-tap`, `did:mf:public` →
  `did:mf:principal.public`).

- **Verify:** ✅ recorded in ADR-0025 (merged, cortex#2236). Option (A), hard cut. This gate is CLEARED.
- **Owner:** Andreas (decision) + JC (§10 execution coordination). **No longer blocking** — recorded 2026-07-19.

### 1.7 Sign-off — the schedule gate

- **Expected:** §1.1–§1.5 all green; §1.6 recorded. Both principals review this runbook end-to-end;
  that review **is** the authorisation to schedule R (per the acceptance criteria on cortex#2035).
- **Verify:** the sign-off block at the foot of this document carries both names + date + the
  commit SHA of the R build reviewed.
- **Owner:** both.

**Gate:** if any meter is not zero, or §1.6 is not recorded, **STOP — do not schedule R.**

---

## 2. T-minus — freeze and quiesce (on the call)

Both principals are on the same call from here. R is a short window; keep it tight.

**Step 2.1 — Announce the freeze.** · Owner: both
- **Command:** post the freeze notice to the coordination thread on both stacks (`discord post …` on
  the grove server); state that federated traffic will break at the cut and old-form history will be
  discarded.
- **Expected:** both principals acknowledge in-thread; no other principal starts federated work.
- **Verify:** the freeze notice is the last message before the cut window in the thread.

**Step 2.2 — Quiesce federated traffic.** · Owner: both
- **Command:** stop any `pilot request-review --principal …` / in-flight federated dispatch; let the
  bus drain.
- **Expected:** `cortex network status --principal <id>` shows no in-flight federated work on either
  side.
- **Verify:** `in`/`out` counters stop advancing on both stacks.

**Step 2.3 — Snapshot pre-cut state (for the record, not for rollback).** · Owner: each (both)
- **Command:** record the current daemon version (`arc … version` / launchd plist), the current
  `~/.config/metafactory/cortex/<stack>/` layer set, and the JetStream stream list, into the R
  session log.
- **Expected:** a written pre-cut state record exists on both sides.
- **Verify:** the snapshot is attached to the R session log. **This is provenance only — §8: there is
  no clean rollback to it.**

---

## 3. The atomic cut — DID + subject `@`-segment + signature format flip together

The three legs are **one cut**. They MUST NOT be sequenced independently — there is no state in which
an emitter writes new-form envelope fields and old-form subjects, or new-form fields under an old
signature (RFC-0001 §9.1 atomic coupling; RFC-0002 §5). The R build lands all three per stack.

**Step 3.1 — Confirm the R build carries all three legs.** · Owner: both
- **Command:** review the tagged R build (cortex + myelin) against the leg checklist:
  1. **DID grammar** — emitter renders class-explicit dot-form at every wire position; verifier
     **rejects** legacy classless at decode (vector `inv/legacy-classless`); the twelve `did:mf`
     pattern sites + `DID_RE` regenerated from the grammar; the three §8.6 regex tightenings
     (`PRINCIPAL_RE`, `STACK_SEGMENT_REGEX`, `DID_RE`).
  2. **Subject `@`-segment** — the assistant-address segment carries the whole class-explicit agent
     DID with each `.` doubled to `--` (RFC-0002 §5); derived from the same `src/subjects.ts:124`
     source as the envelope DID.
  3. **Signature format** — RFC-0004 field-ids + CONTEXT_TAG + canonical-88 + `spec_version`, plus
     the four cortex#1973 fixes (§1.5).
- **Expected:** all three legs present in one build, per stack; the identity mapping of RFC-0001
  §9.1(6) applied.
- **Verify:** the R build's conformance run is green including `encode/agent-dotform-subject`,
  `decode/agent-roundtrip-back`, and `inv/legacy-classless` (reject).
- **Owner:** both (trust path — this is the signature/DID cut).

> The **flip itself** is the deploy of this build (§6). §3 is the readiness confirmation that the
> build is the atomic package; §4/§5 confirm what that package contains.

---

## 4. Engine adoption — the deployed engine imports `./wire`

The switch from hand-written pre-R copies to the shared `./wire` codec **is** part of the cut. After
R, no local DID/NAK/capability/slug regex copy and no vendored schema may remain.

**Step 4.1 — Engine imports `./wire`.** · Owner: both
- **Expected:** the deployed engine resolves DID/subject/NAK/capability transforms through
  `@the-metafactory/myelin/wire`, not hand-written copies.
- **Verify** (cortex checkout, R build): `git grep -nE "did:mf:[^ ]*\\)\\s*\\{|indexOf\\(\"-\"\\)" src/`
  finds **zero** hand-rolled DID splits; identity splits go through the codec (fail-loud, not
  fabricated `"default"`).
- **Owner:** both.

**Step 4.2 — Hand-written pre-R copies deleted (git-grep proof).** · Owner: both
- **Verify:** `git grep -c "did:mf:" src/` shows only codec call-sites, not pattern literals; a
  `git grep` for the segment-alphabet variants (`STACK_SLUG_RE`, `SLUG_RE`, `STACK_ID_RE`,
  `SEGMENT_RE`) returns zero local definitions. Record the grep output in the R session log.
- **Expected:** zero local regex copies; the drift gate (abnf-gen + inventory tool) green in CI.
- **Owner:** both.

---

## 5. cortex#2034 swaps + the vendored-schema deletion decision

[cortex#2034](https://github.com/the-metafactory/cortex/issues/2034) replaces the five drift-site
classes with the `./wire` codec. Four are mechanical replacement; the fifth carries a **named
principal decision**.

**Step 5.1 — Swap the five drift-site classes.** · Owner: both (item 3 is trust path)
The five classes (re-verify each at execution time against the R build):
1. Vendored `src/bus/myelin/vendor/envelope.schema.json` DID `pattern` (5 inline copies) → schema
   fragments from `./wire` generated output.
2. Segment-alphabet variants (`STACK_SLUG_RE` network.ts, `SLUG_RE` stack.ts, `STACK_ID_RE`
   provision-stack.ts, `SEGMENT_RE` review-consumer.ts) → `./wire` terminals.
3. First-hyphen DID decoders (review-consumer.ts `indexOf("-")`, cortex.ts collapse,
   probe-responder.ts, federation-reconciler.ts fabricated `"default"`) → `./wire` identity codec,
   fail-loud. **(trust path — adversarial review.)**
4. NAK vocabulary mirrors ×3 (review/release/dev consumers) + `DispatchTaskFailedReason` → `./wire` enums.
5. Parallel capability regex triplication (capability.ts, offering.ts, offer.ts) → `./wire`.

- **Expected:** zero hand-written `did:mf` patterns; the 4 hyphen-decoders deleted; one NAK enum
  source; all existing tests green (behavior-preserving — the flag-day *behavior* changes of
  cortex#1996/#2016/#2020 are separate and NOT folded in here).
- **Verify:** the cortex#2034 acceptance greps (grep-proof in the swap PRs) all return zero.
- **Owner:** both.

**Step 5.2 — DECISION: delete the vendored envelope schema (cortex#366 security control).** · Owner: both
- **Context:** the vendored `envelope.schema.json` + vendored `SIGNABLE_FIELDS` are the cortex#366
  security control — the local verify path that must catch `originator` tampering. Deleting the
  vendored schema in favour of `./wire`-generated fragments removes a second source of truth (good:
  no two-parsers-one-grammar drift) **but** re-homes the `originator`-in-`SIGNABLE_FIELDS`
  invariant onto `./wire`. This is a **named `[principal-hands]` decision**, not a mechanical swap —
  it is on the HELD list (myelin#286).
- **Expected (the decision, recorded here at execution):** the principals confirm the `./wire`
  signable-field set includes `originator`, and that the cortex#366 regression test
  (`bun test src/runner/__tests__/dispatch-listener.test.ts -t "tampered originator on signed envelope"`
  → `chain_verification_failed`, not `unknown_principal`) passes against the R build **before** the
  vendored schema is deleted.
- **Verify:** the cortex#366 test is green on the R build; the deletion PR cites this runbook step and
  both principals' confirmation.
- **Owner:** both. **Do not delete the vendored schema until this is confirmed green.**

---

## 6. Deploy — land the R build on both stacks

This is where the atomic cut **fires**: deploying the R build flips emitters + verifiers together.

**Step 6.1 — `arc upgrade` both stacks to the R build.** · Owner: each (both, coordinated)
- **Command:** `arc upgrade cortex` on each principal's host (and `arc upgrade` the myelin dependency
  so `./wire` resolves to the R codec).
- **Expected:** both stacks report the R version; the auto-installed first-party surface bundles
  resolve.
- **Verify:** `arc … version` shows the R tag on both sides; boot does not HARD-FAIL the renderer
  coverage guard.
- **Owner:** each; confirm both landed before proceeding (the cut is only atomic across the pair once
  **both** are on R).

**Step 6.2 — `~/.config` `imported_principals` → class-explicit.** · Owner: each (both)
- **Command:** edit `~/.config/metafactory/cortex/<stack>/stacks/<stack>.yaml` (and any
  `network/` layer): rewrite every `policy.ingress.scope_mappings[].imported_principals` entry to the
  class-explicit **principal-class** DID form (RFC-0005 §6.2 — no dual-accept window; agent-class
  entries are rejected at config validation).
- **Expected:** every `imported_principals` entry is a `did:mf:principal.{p}` form; no legacy
  classless entry remains.
- **Verify:** daemon boot logs no `imported_principals` config-validation warning; a probe from the
  peer's principal passes the §6.2 last-stamp lookup.
- **Owner:** each. `~/.config` edits are `[principal-hands]` — never committed to the repo.

**Step 6.3 — Confirm the bus is operator-mode.** · Owner: each (both)
- **Command:** confirm each federating stack's NATS is **operator-mode** (defines the NSC operator +
  the account the leaf binds to; mirrors `~/.config/nats/local.conf`). An anonymous / hard-isolated
  bus cannot federate.
- **Expected:** the leaf remote names an account the server knows; no `nats-server` crash on reload.
- **Verify:** `launchctl unload/load` the stack plist, then the daemon log shows the leaf link
  **connected** and the federated subscription on `federated.{me}.{my-stack}.>`.
- **Owner:** each.

---

## 7. Persisted-state purge — `[principal-hands]` go/no-go (RFC-0001 §9.3)

> **This is a distinct go/no-go, NOT part of "deploy".** It discards persisted signed state that can
> no longer verify under the new grammar. It is executed by the principals, not by automation, and it
> is irreversible. It is on the HELD list (myelin#286).

The purge is **scoped, not blind** (RFC-0001 §9.3). Enumerate first, then go/no-go, then execute.

**Step 7.1 — Enumerate every persisted old-form-DID site.** · Owner: both
Known classes and their disposition (verify each against the live deployment at execution):
- **JetStream signed history** — old-form DIDs live inside signed bytes: **discard** (§9.2, cannot be
  rewritten).
- **Registry rows** — likely keyed by id-strings, not embedding DIDs in signed material: **verify**,
  then **re-key / re-register** under RFC-0001 §6.3 Create as needed.
- **Admission / seal artifacts** — **verify** whether any embed an old-form DID; any that do are
  **discard-and-reissue**.
- **Any site class the enumeration discovers that is not on this list is added to the checklist
  before the go/no-go — never handled ad hoc.**

- **Command:** run the flag-day-inventory tool (§1.2) in its persisted-state mode + inspect the
  JetStream stream list, the registry rows, and the admission/seal store on each stack.
- **Expected:** a written, complete enumeration of every old-form site with its disposition
  (discard / re-key / reissue).
- **Verify:** the enumeration is attached to the R session log and reviewed by both principals.

**Step 7.2 — Pre-stage carried-over identities.** · Owner: both
- **Command:** map any carried-over identity through the RFC-0001 §9.1(6) mapping and pre-register
  its new-form DID (register-once: each new-form DID created exactly once, §6.3).
- **Expected:** the mapped identities have their new-form registrations staged, not yet live.
- **Verify:** the staged registrations exist and are unique (no double-create).

**Step 7.3 — GO / NO-GO on the purge scope.** · Owner: both
- **Expected:** both principals explicitly agree the enumerated scope (§7.1) and the staged mappings
  (§7.2) are complete and correct.
- **Verify:** an explicit "GO" from **both** principals, recorded in the R session log with
  timestamp. A single NO-GO **stops the purge** (and R — the flip cannot complete without it).
- **Owner:** both. **This is the last reversible-by-not-proceeding point. After §7.4 there is no
  going back.**

**Step 7.4 — Execute the purge.** · Owner: each (both, coordinated)
- **Command:** discard the JetStream signed-history streams; re-key / re-register the registry rows;
  discard-and-reissue any admission/seal artifact that embeds an old-form DID.
- **Expected:** no persisted old-form signed state remains on either stack.
- **Verify:** the flag-day-inventory persisted-state scan (§7.1) returns **zero** old-form sites on
  both stacks.
- **Owner:** each.

---

## 8. Verify live

**Step 8.1 — Live federation folds both ways.** · Owner: both
- **Command:** `cortex network status --principal andreas` and `cortex network status --principal jcfischer`.
- **Expected:** the `jc↔andreas` peers show presence folding **both ways** — `in>0 out>0` (not the
  pre-cut `in=0 out=0`).
- **Verify:** each side lists the other as a live peer with non-zero in/out presence counters.
- **Owner:** both.

**Step 8.2 — A signed envelope crosses and verifies under the class-explicit grammar.** · Owner: both
- **Command:** emit a signed probe from one stack (e.g. `agent.online` from `andreas/meta-factory`),
  targeting the peer.
- **Expected:** the peer **folds** the emitter into its presence registry; a legacy-classless probe
  is **rejected at decode** (`inv/legacy-classless`); a new-form probe round-trips
  (`encode/agent-roundtrip-out` / `decode/agent-roundtrip-back`) on the live bus.
- **Verify:** `registry.getAgents()` on the receiver contains the emitter with the class-explicit
  `verifiedScope`; the daemon log shows no `unknown_agent` / `unknown_principal` drop.
- **Owner:** both.

**Step 8.3 — Conformance CI green on both repos; drift is structurally impossible.** · Owner: either
- **Command:** trigger the conformance + inventory + abnf-gen drift lanes in CI on both repos.
- **Expected:** all green; a re-introduced legacy-form site would fail the build.
- **Verify:** CI green on cortex and myelin main post-R.
- **Owner:** either.

**Step 8.4 — Lift the freeze.** · Owner: both
- **Command:** post the all-clear to the coordination thread; resume normal federated work.
- **Expected:** federated review loop (`pilot request-review --principal …`) works end-to-end across
  the two stacks on the new grammar.
- **Verify:** a real cross-principal review round-trips.
- **Owner:** both.

---

## 9. Rollback posture

**State it plainly: the cut is destructive and there is no clean rollback.**

- A DID is inside the **signed bytes** of every envelope. At R, pre-cut signed envelopes **stop
  verifying** and **cannot be rewritten** — rewriting the DID would break the signature it sits under
  (RFC-0001 §9.2). This consequence was accepted **with** the decision, not discovered after it.
- Pre-cut signed history is **discarded, not migrated** (§7). Replay and audit of old-form history
  breaks at the cut boundary. The §2.3 snapshot is **provenance only** — it is not a restore point.
- "Rolling back" to the pre-cut build after §6/§7 would leave the stack unable to verify the new-form
  envelopes now on the bus and unable to recover the purged old-form history. There is no state that
  restores both.

**Therefore the control is the go/no-go gate, not a rollback path:**

- The real abort points are **before** the irreversible steps: the §1.7 schedule gate, and the §7.3
  purge GO/NO-GO. A single NO-GO at either stops R cleanly (nothing destructive has happened yet).
- Once §6 (deploy) + §7.4 (purge) execute, **forward is the only direction** — complete §8 and
  verify live.
- If §8 verification fails after the cut, the response is **fix-forward on the new grammar** (both
  principals, diagnose against the conformance vectors and cortex#1876/#1973 findings), **not**
  reverting the wire. Escalate as a live-federation incident if the loop does not come up.

---

## Sign-off

R is authorised to schedule only when both principals have signed §1.7, and fires only with both
present through §2–§8.

| Role | Principal | Signed (name + date) | R build SHA reviewed |
|---|---|---|---|
| Schedule gate (§1.7) | Andreas | `<REPLACE_ME>` | `<REPLACE_ME>` |
| Schedule gate (§1.7) | JC | `<REPLACE_ME>` | `<REPLACE_ME>` |
| Purge go/no-go (§7.3) | Andreas | `<REPLACE_ME>` | — |
| Purge go/no-go (§7.3) | JC | `<REPLACE_ME>` | — |

**Blocking decision still open at authoring time:**
[cortex#1876](https://github.com/the-metafactory/cortex/issues/1876) (WP-4 DID-encoding-ambiguity) —
**✅ RECORDED in ADR-0025** (hard cut, Andreas 2026-07-19, §1.6). This precondition is cleared; R remains gated on the §1.1–§1.5 meters + §1.7 two-party sign-off.
