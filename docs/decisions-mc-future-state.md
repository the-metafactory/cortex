# MC future-state — open decisions log (D-1..D-17)

**Source:** `docs/plan-mc-future-state.md` §7 "Open decisions (pre-ADR forks — decide in R0, don't drift)". Fork, Options, and Recommendation text below are copied verbatim from that table. This log adds only the disposition tag and this header note.

**Disposition:** Low-stakes items proceed on the recommendation; ratification items await the principal (Andreas) before their blocked slices open.

---

## D-1 — Prior-plan Q4: legacy tabs vs cockpit `[ADOPT — recommendation]`

**Fork:** Prior-plan Q4: legacy tabs vs cockpit

**Options:** (a) replace outright; (b) keep both indefinitely; (c) replace with one-release escape hatch

**Recommendation:** **(c)** — cockpit replaces; legacy tabs behind `?legacy=1` for one release, then CK-10 deletes them (the removal has an owner)

**Blocks:** CK-3, CK-10

---

## D-2 — Step-up MFA mechanism — must be loopback-viable `[NEEDS PRINCIPAL RATIFICATION]`

**Fork:** Step-up MFA mechanism — **must be loopback-viable**

**Options:** Local TOTP enrolled at the daemon vs OS-presence (Touch ID helper) vs WebAuthn against the daemon; CF-Access re-auth as ADDITIONAL non-loopback hardening only

**Recommendation:** On the loopback bind CF Access is not in the request path at all, so it cannot be the mechanism — prefer local TOTP or OS-presence at the daemon decider seam; record loopback semantics explicitly (terminal possession ≠ step-up)

**Blocks:** FND-3

---

## D-3 — RTT thresholds + health fold precedence `[ADOPT — recommendation]`

**Fork:** RTT thresholds + health fold precedence

**Options:** Threshold values; null semantics; input precedence

**Recommendation:** Straw man: amber ≥ 500 ms, red ≥ 2000 ms, null ⇒ unobserved; collector-health > transport verdict > presence; codify in FND-4 ADR

**Blocks:** OBS-2/4, FLG-11

**Note:** this decision is codified in `docs/adr/0022-mc-health-and-rtt.md` (FND-4 deliverable, this same slice).

---

## D-4 — Glass dry-run/canary posture for live-member mutations `[NEEDS PRINCIPAL RATIFICATION]`

**Fork:** Glass dry-run/canary posture for live-member mutations

**Options:** Preview endpoint returning intended actions (typed-confirm carries preview hash) vs two-step arm/fire vs CLI-only for mutations

**Recommendation:** Preview-endpoint + typed-confirm-with-hash, **hash REQUIRED in commit body, stale ⇒ 409** (closest glass analog to C-1483, doubles as the idempotency anchor)

**Blocks:** FLG-8/9/6

---

## D-5 — Dispatch-to-peer gate level `[ADOPT — recommendation]`

**Fork:** Dispatch-to-peer gate level

**Options:** typed-confirm only vs step-up MFA

**Recommendation:** typed-confirm (mints nothing, touches no secret, reversible) — but record it; escalate if dispatch grammar gains destructive verbs

**Blocks:** FLG-10

---

## D-6 — Prior-plan Q5: Mode B pull-forward before Mode A `[ADOPT — recommendation]`

**Fork:** Prior-plan Q5: Mode B pull-forward before Mode A

**Options:** Pull SPX-10 into pre-release vs keep post-release

**Recommendation:** Eligible (federation substrate shipped; it's packaging/ops) but keep post-release unless a concrete hosting need lands — the release gate is local/federated/multi-principal/fleets, not spawn

**Blocks:** SPX-10

*Not on the executor's explicit ADOPT/RATIFICATION lists — tagged ADOPT by extension of the stated rule (the recommendation is the conservative, low-stakes default: keep post-release). Flagged for principal spot-check if that judgment call should instead have been a ratification item.*

---

## D-7 — Runner permission-arbitration channel design `[ADOPT — recommendation]`

**Fork:** Runner permission-arbitration channel design

**Options:** Blocking PreToolUse hook waiting on a decision file/socket with timeout-deny vs harness-level permission-mode vs session restart-with-grant

**Recommendation:** Design note owned by FND-2's recovered doc; hooks must stay non-blocking toward the bus — the wait lives runner-side, fail-closed on timeout

**Blocks:** SPX-8

*Not on the executor's explicit ADOPT/RATIFICATION lists — tagged ADOPT because the recommendation only assigns doc ownership and restates an already-settled fail-closed/non-blocking invariant; it does not itself commit to a mechanism. Flagged for principal spot-check if that judgment call should instead have been a ratification item.*

---

## D-8 — `sessions` origin schema shape (#1295) `[ADOPT — recommendation]`

**Fork:** `sessions` origin schema shape (#1295)

**Options:** `origin_stack_id` column + backfill vs composite natural key

**Recommendation:** Column + backfill (extends ADR-0011 canonical rows; keeps read model simple)

**Blocks:** CK-4a

---

## D-9 — WORKING pre-release semantics `[ADOPT — recommendation]`

**Fork:** WORKING pre-release semantics

**Options:** Ship queued-only (spawn stays parked) vs pull C2 (SPX-2) forward

**Recommendation:** **Queued-only pre-release**; `awaiting hands` copy lands exactly with SPX-2 — decide, don't drift (the epic-#1190-parked coupling made explicit)

**Blocks:** CK-4b, SPX-3

---

## D-10 — Envelope-flow counter feed shape (D5 + bus traffic strip) `[ADOPT — recommendation]`

**Fork:** Envelope-flow counter feed shape (D5 + bus traffic strip)

**Options:** WS frame extension on `use-websocket.ts` vs REST poll `/api` extension

**Recommendation:** WS frame (the presence channel already rides it; polling multiplication is the thing CK-3 is killing); the traffic strip consumes the same frame — never a second feed

**Blocks:** CK-5

---

## D-11 — Hub-admin allowlist provisioning for glass verbs `[NEEDS PRINCIPAL RATIFICATION]`

**Fork:** Hub-admin allowlist provisioning for glass verbs

**Options:** How a principal's daemon key gets onto `REGISTRY_HUB_ADMIN_PUBKEYS` for FLG-2/6/8/9 (manual env today)

**Recommendation:** Runbook documented in FND-1; **execution is a hard FLG-2 gate** [principal-hands]; self-service enrollment out of scope (touches #1324 did:web direction)

**Blocks:** FLG-2

---

## D-12 — Sealed-artifact transit path (FLG-6) `[ADOPT — recommendation]`

**Fork:** Sealed-artifact transit path (FLG-6)

**Options:** Sealed blob transits worker/browser (ciphertext, but new exfil/tamper surface) vs daemon→registry→daemon with glass as trigger-only

**Recommendation:** **Daemon→registry→daemon; glass triggers and observes, never carries** — keeps invariant 6 literal (nothing PSK-derived enters worker/browser, even encrypted)

**Blocks:** FLG-6

---

## D-13 — Prior-plan Q1 (silently pre-decided in v1 — reopened): sandbox substrate `[NEEDS PRINCIPAL RATIFICATION]`

**Fork:** Prior-plan Q1 (silently pre-decided in v1 — reopened): sandbox substrate

**Options:** CF Managed Agents vs self-hosted sandbox vs both behind the `ExecutionBackend` interface

**Recommendation:** Decide in FND-2's recovered design doc with explicit "decides prior-Q1" language; the interface (SPX-1/SPX-4) is substrate-neutral by construction, so the spike can proceed CF-shaped while the decision is recorded

**Blocks:** SPX-4, SPX-6

---

## D-14 — Prior-plan Q2 (silently pre-decided in v1 — reopened): egress-proxy ownership `[NEEDS PRINCIPAL RATIFICATION]`

**Fork:** Prior-plan Q2 (silently pre-decided in v1 — reopened): egress-proxy ownership

**Options:** Substrate-provided (CF Outbound Workers) vs cortex-owned proxy vs standalone service

**Recommendation:** Decide in FND-2's recovered doc / SPX-5 threat-model doc with explicit "decides prior-Q2" language; ownership determines where the audit log and per-sandbox identity live

**Blocks:** SPX-5

---

## D-15 — Human-presence signal source (PEOPLE view) `[NEEDS PRINCIPAL RATIFICATION]`

**Fork:** Human-presence signal source (PEOPLE view)

**Options:** Explicit self-set status vs surface-derived (e.g. Discord presence) vs last-human-input heuristic — plus the consent/visibility posture

**Recommendation:** Decide in PPL-1's mini-ADR; lean explicit-status + surface-derived hybrid with **opt-in visibility per network** (human presence is personal data; sovereignty applies to people before stacks)

**Blocks:** PPL-1/2

---

## D-16 — Session attribution shape (SESSIONS ledger) `[NEEDS PRINCIPAL RATIFICATION]`

**Fork:** Session attribution shape (SESSIONS ledger)

**Options:** Free-form tag vs controlled vocabulary (repo/domain) vs registry-backed project ref

**Recommendation:** Column + controlled vocabulary seeded from repos/domains, extensible — decided in a SES-1 design note; keep it a *schema field*, not a naming convention

**Blocks:** SES-1..3

---

## D-17 — Work-object home (WORK marketplace) `[NEEDS PRINCIPAL RATIFICATION]`

**Fork:** Work-object home (WORK marketplace)

**Options:** Registry-hosted vs a new M7 service vs bus-native events + MC projection

**Recommendation:** WRK-0 decides; lean **bus-native work events + MC projection** (dispatch-don't-dictate; the bus is already the shared truth) — ties to the IoAW market-economics extension (#1298 thread)

**Blocks:** WRK-0/1, MESH-0

---

*Note (plan §7): Prior-plan Q3 (meta-sandboxing as default enterprise backend vs opt-in profile) is assigned to the SPX-11 design doc scope — not a pre-R0 fork, and so is not listed as a D-N row above.*
