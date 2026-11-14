# EBH-6 — sovereignty enforcement posture (R1-F3) + principal-DM guard-disable / principal-map integrity (R1-F4)

Investigation for cortex#2348 (epic #2341, execution-boundary hardening), responding to the
NorthWoods Sentinel review's R1-F3/R1-F4 (`docs/security/reviews/2026-07-23-nws-security-review.md`).
Read-only investigation; no application code, config, or security posture changed.

**Method note.** Every claim below is tagged **VERIFIED** (with `file:line` or a command
citation) or **UNVERIFIED**. Two claims carried in the review or the hardening plan turned out
to be stale — see R1-F4 §4. Line numbers are as of `origin/main` at commit `2a270262` plus
`c25a7c3d` (EBH-1, merged the same day this investigation was run) — several R1-F1/R1-F6-adjacent
files changed shape today; where the review's cited line numbers no longer match, the current
number is used and the drift is called out.

---

## R1-F3 — sovereignty enforcement posture

### Headline

`sovereigntyEnforce` still defaults to `false` on both consumers that carry it (review-consumer
**and** brain-consumer — the review only names the former). It is **not exposed anywhere as a
config key** — there is no `cortex.yaml` / config-split field that could turn it on even if a
principal wanted to; it exists solely as a constructor option, set to `true` only inside test
files. The review's named "audit→enforce" prerequisite (cortex#327, "bind model class to the
signing identity") is **closed but does not do what its own tracking issue implied** — it wires
envelope *signer* verification, not *this agent's own model-class* attestation. The actual
model-class-spoofability gap remains **open and tracked** (#2117), and the mechanism most likely
to close it (a config-declared harness→placement map, independent of self-declaration) is an
**unmerged PR with failing CI** (#2201).

### 1. Default confirmed on current main — VERIFIED

- `src/bus/review-consumer.ts:500` — `this.sovereigntyEnforce = opts.sovereigntyEnforce ?? false;`
- Deny gate: `src/bus/review-consumer.ts:878` (`enforced: this.sovereigntyEnforce` on the audit
  event) and `:881` (`if (this.sovereigntyEnforce) { … term … }`, else falls through to an
  audit-only stderr line). Matches the review's cited line numbers exactly — this file hasn't
  drifted.
- **New finding, not in the review:** `src/bus/brain-consumer.ts` carries the **identical**
  pattern independently — `sovereigntyEnforce?: boolean` (`:243`), default `?? false` (`:390`),
  gated deny at `:513`. The review's R1-F3 only names `review-consumer.ts`; brain-consumer is a
  second, separately-defaulted instance of the exact same audit-only posture.

### 2. `evaluateSovereignty` decision core — VERIFIED fail-closed

`src/bus/sovereignty-gate.ts`:
- Missing/non-object sovereignty block → `deny` (`:74–76`).
- `frontier_ok !== true` (not just `=== false`) counts as "demands local" — a **missing**
  `frontier_ok` fails closed, not open (`:78–80`).
- Demand-first (cortex#1023) — the agent's class is examined only when the task demands a local
  model; a task that explicitly permits frontier (`frontier_ok: true`) allows a class-less agent,
  because there is nothing to protect from a frontier model in that case (`:82–97`). This is a
  deliberate, documented correction of an earlier stricter-but-wrong version that denied
  class-less agents unconditionally (see the docblock `:57–67`) — the current logic is sound.
- An agent that can't prove its class, when the task demands local, is denied (`:88–97`).
- A `local-only` agent is always allowed (`:109–110`) — it cannot leak to a frontier model by
  construction.

The decision core is genuinely sound. **The gap is entirely in what feeds it default posture,
not in the core's logic.**

### 3. Nothing wires `sovereigntyEnforce` from config — VERIFIED

- `grep -rn "sovereigntyEnforce" src/` outside test files returns only the four locations above
  (type decl, private field, `?? false` default, and the `if` check) in each of
  `review-consumer.ts` and `brain-consumer.ts`. **Zero** call sites in
  `src/runner/review-consumer-boot.ts`, `src/runner/brain-consumer-boot.ts`, or `src/cortex.ts`
  ever set it.
- No config key exists anywhere: `grep -rn "sovereigntyEnforce\|sovereignty_enforce\|sovereignty\.enforce" docs/config-layout/ cortex.yaml.example` returns nothing.
- Contrast with `modelClass`, which **is** wired: `docs/config-layout/README.md:141` and
  `docs/config-layout/system/system.yaml:172,178` document a per-inference-profile
  `modelClass: frontier|local-only|any` key, and `agent.runtime.modelClass` (per-agent, in
  `stacks/<slug>.yaml`) feeds `AgentModelClass` into both consumers
  (`src/runner/review-consumer-boot.ts:183–184`, `src/runner/brain-consumer-boot.ts:399–400`).
  `modelClass` is config-reachable. `sovereigntyEnforce` is not — flipping it today requires a
  **code change** to the boot files, not a config edit.
- `docs/config-layout/README.md:194` states this plainly for the adjacent `api-agent` path:
  *"`modelClass` / `dataResidency` not enforced (#2117) — Validated, resolved, and carried on the
  profile, but admission does not gate on them. Not a control."*

### 4. What actually blocks turning it on — VERIFIED, with one stale-link correction

- `src/bus/review-consumer.ts:861` (docblock) and the merged PR that introduced the gate
  (GitHub cortex#906, `feat(bus): consumer-side sovereignty gate`, merged) both state the
  audit-only default is deliberate: *"A self-declared `modelClass` is honest-but-spoofable. The
  hard-deny posture should wait until model class is bound to the **signing identity**
  (cortex#327 audit→enforce)."*
- **cortex#327** (`feat: wire verifySignedByChain into review-consumer inbound path`) is
  **CLOSED**, merged by PR #329 on 2026-05-17 — over two months before this review. On its face
  this reads as "the prerequisite shipped, the flag should have flipped by now."
- **Reading PR #329's actual diff corrects this.** It wires `ReviewConsumerOpts.signatureVerifier`
  → `verifySignedByChain(envelope, …)`, called on the **inbound envelope's `signed_by` chain**
  (`src/runner/review-consumer-boot.ts:213–230`, confirmed live-wired, gated on
  `agent.trust.length > 0`). This verifies **who sent the request** (the requester's signing
  identity) — it says nothing about whether the **executing (consuming) agent's own
  `agent.runtime.modelClass`** is truthful. Those are different trust objects: #327 authenticates
  the envelope's origin; the sovereignty gate's spoofability concern is about the *receiving*
  agent's self-declared class, which is a **static boot-config field, never signed, never
  verified against anything.**
- So the prerequisite #906 actually needed — binding *this agent's* model-class claim to a
  verifiable identity/attestation — is **not what #327 built**, and remains open. The live,
  explicitly-tracked instance of this exact gap is **cortex#2117** (open, label `next` not `now`):
  *"admission still trusts self-declared modelClass; resolved profile's policy fields unread"* —
  for the `api-agent` substrate, a *resolved* profile's real `modelClass`/`dataResidency` exist
  and are populated but have **zero non-test readers**; admission still reads the spoofable
  self-declared value (`review-consumer.ts:861` cited by #2117 itself).
- The mechanism that would plausibly close the gap for good — not by trusting either
  self-declaration or an envelope signer, but by having the **executing stack's own config**
  declare which harness/model combination is actually placed where — is **cortex PR #2201**,
  *"feat(runner): model-placement execute gate — enforce frontier_ok/model_class"* (closes
  #2195, RFC-0005 §2.5). Status: **OPEN, unmerged**, `mergeable: MERGEABLE`, but CI has two
  **FAILURE** checks (`Vocab carve-out gate`, `Test`) as of the last run. Its own description:
  *"Harness→placement map config-declared (`execution.model_placement`), fail-closed on unknown
  … Inert without config. No merge."* — i.e. even once merged, it ships inert until a principal
  additionally configures `execution.model_placement`.

**Net:** the audit→enforce flip is gated on real, unfinished work (#2117 open / #2201 unmerged
with failing CI), not on a shipped-but-forgotten prerequisite. The review's phrasing implying the
prerequisite (#327) is what's pending is imprecise — #327 shipped and is a genuinely good control
(envelope-origin authentication), but it does not touch the specific spoofability #906 named.

### Recommendation for the principal

- Sovereignty enforcement is **audit-only in every deployment today, with no way to change that
  via config** — this is worth stating explicitly in the deployment's security posture doc
  regardless of the technical prerequisite discussion, per the review's own recommendation.
- Do not treat cortex#327 as "the blocker, now cleared" — it isn't the blocker. The real blockers
  are #2117 (design decision: enforce-now vs. explicit-deferral for `api-agent` modelClass) and
  #2201 (unmerged, CI-red, and inert without additional config even once merged).
- Two decisions for the principal:
  1. Is audit-only acceptable as the **permanent** posture for the current deployment shape (no
     `api-agent`/frontier-class agents actually in play), or does it need a real enforce path
     before any frontier-capable agent is onboarded?
  2. Should `sovereigntyEnforce` be **promoted to a real config key** (even while still
     defaulting `false`) so "turn it on" is a principal action instead of a code change — this is
     a small, low-risk change independent of the #2117/#2201 prerequisite work.

---

## R1-F4 — principal-DM guard-disable + principal-map integrity

### Headline

The trigger chain is fully traced and matches the review's description. The realistic exposure is
narrower than "any relayed content reaches a guard-off session" — every producer I could find
(bus dispatch, GitHub webhook relay, the web gateway, `async:`/`team:` prefixes) is structurally
unable to set the guard-off flag for content it didn't itself author as the mapped principal. The
more concrete residual risk is **indirect prompt injection *during* an already-legitimate
guard-off session** (the agent fetching attacker-controlled text via its own tool calls, e.g.
`WebFetch`/`gh issue view`), where the only defense is prose (`security-preamble.ts`), because
`bash-guard.hook.ts`'s `disabled` branch short-circuits before reaching **even the brand-new
EBH-1 path-containment logic** merged into that same file today. Separately: the review's own
compensating control **"G-301 (issue #42) is the client's own planned hardening" is stale** —
issue #42 is an unrelated, already-merged migration PR, and there is no tracked G-301 anywhere in
the repo.

### 1. Guard-disable trigger chain — VERIFIED end to end

1. `src/common/policy/resolve-access.ts:341–348` — for a resolved principal, pick
   `session_config.dm` when `msg.isDM === true` (else `session_config.default`); read
   `bashGuard = block?.bash_guard ?? true` from that block. **This is a per-principal config
   value** (`policy.principals[].session_config.{dm,default}.bash_guard`), not something
   automatically derived from holding the `operator` capability — `isOperator` (`:323`,
   `allow("operator")`) and `bashGuard` are two **independent** reads from the same resolved
   principal, combined into one `AccessDecision` at `:365–389`.
2. `src/bus/dispatch-handler.ts:974` — `const bashGuardDisabled = access.bashGuard === false;`
   Threaded into `handleAsync`/`handleTeam`/`handleSync` uniformly (`:1091,1094,1097`) — the
   `async:`/`team:` prefixes do not bypass or alter this; they read the same `access` resolved
   from the same triggering message.
3. `src/runner/cc-session.ts:269–275` (`resolveBashGuardEnv`) — `bashGuardDisabled: true` →
   `CORTEX_BASH_GUARD` env is unconditionally set to `JSON.stringify({disabled:true})`.
4. `src/runner/hooks/bash-guard.hook.ts:270–273` — parses `CORTEX_BASH_GUARD`; `guardRaw.disabled`
   → `{ok:true, config:null}` (a well-formed instruction, not a parse failure).
5. `src/runner/hooks/bash-guard.hook.ts:1144–1153` — `config === null` → `pass()` (emits
   `{"continue":true}`), **unconditionally**, before any of the file's containment/allowlist
   logic runs. The in-code comment is explicit that this is deliberately *not* an auto-approve
   grant — it defers to Claude Code's own permission gate (cortex#777, closed, confirms the same
   distinction: cortex's guard never auto-approves; only Claude Code's own permission engine can).
   **What CC's own permission posture actually is for a principal-DM session** (which
   `--allowedTools`/permission-mode it launches with) I did not trace to a definitive answer —
   **UNVERIFIED** beyond "no `--dangerously-skip-permissions`" (confirmed absent from
   `buildClaudeArgs`, `src/runner/claude-invoker.ts:56–79`).

The review's paraphrase `if (parsed.disabled) return null` is directionally right but not a
literal quote of the current code (`if (guardRaw.disabled) return { ok: true, config: null, reason: "" };`, `:273`) — cosmetic drift only, not a correctness issue in the review.

**Identity basis (confirms the review, doesn't just parrot it) — VERIFIED:** `dmType` on the
inbound message is computed **per message**, by the platform adapter (traced in the discord
adapter's test fixture, `src/adapters/__tests__/fixtures/metafactory-cortex-adapter-discord/src/index.ts:531–555` — the live bundle lives out-of-tree per ADR-0024, so this fixture is the best
available reference for the shipped contract): `authorIsPrincipal = isOperatorPrincipal("discord",
message.author.id)`, keyed on the platform's own authenticated sender id
(`src/common/policy/resolve-access.ts:398–411`). This means a guard-off session can only be
triggered by a message whose **platform-authenticated author id** resolves to a principal holding
the DM/`operator` capability — not by message *content*, not by who a message claims to be from.

### 2. Content-producer reachability table — VERIFIED unless noted

| Producer | Can it reach a guard-off principal-DM session? | Basis |
|---|---|---|
| A direct DM literally authored by the mapped principal's platform account | **By design, yes** — this is the intended G-300 elevated channel, not an untrusted-content leak. | `docs/design-dm-operator-channel.md:15,41`; identity chain above |
| Forged/spoofed `authorId` on an inbound message | **No** (assuming platform + adapter integrity) | `dmType`/`bashGuard` key off the platform's own authenticated sender id, resolved via `PolicyEngine`; no code path lets message *content* substitute for the platform-verified author |
| `async:` / `team:` prefixed messages from a non-principal | **No** — same per-message `access` resolution as any other message; these prefixes select a dispatch *mode*, not a different trust path | `src/bus/dispatch-handler.ts:1091,1094,1097` |
| Bus-dispatched capability tasks (`tasks.*`, local or federated, via `dispatch-listener.ts`) | **No, structurally** — `bashGuardDisabled` on this path is explicitly documented RECEIVING-STACK-AUTHORITATIVE and never wire-supplied; **no config field currently sets it** at this call site | `src/runner/dispatch-listener.ts:556–567` ("There is no corresponding config field today … `cortex.ts` does not currently pass it"), `:2170–2178` |
| GitHub webhook relay (`src/taps/gh-webhook/`) | **No** — the CF Worker forwards HMAC-validated events to `grove-api` / an optional cortex forwarder URL; it never constructs an `InboundMessage` with `isDM`/`dmType` (those are adapter-message concepts) | `src/taps/gh-webhook/src/index.ts` (confirmed no `InboundMessage`/`handleMessage` reference in the file). **Partially unverified**: I did not trace the full downstream path from a forwarded GH event to wherever it eventually becomes a CC session prompt (`github-events.ts` / channel-thread flow) to independently confirm `isDM` stays false there — high confidence, not full end-to-end proof. |
| Web gateway (`WebAdapter` / `BusInboundSink`, #1758) | **No** — confirmed the web path **bypasses `DispatchHandler.handleMessage` entirely**, going through the runner dispatch-listener/bus path instead, which (per the row above) has no wiring to set `bashGuardDisabled` | issue #1758 (open): *"the web surface … `BusInboundSink` bypasses `dispatchHandler.handleMessage` … the runner dispatch-listener omits persona by design"*; independently corroborated by EBH-1's own PR text ("The web-gateway path (#1758) sets no `CORTEX_CHANNEL`, so the [path] guard is inert there") |
| Team-mode sub-agents spawned *from within* an already-legitimate guard-off session | **Yes, by propagation, not injection** — `bashGuardDisabled` flows unchanged to every participant `CCSessionOpts` (`src/runner/agent-team.ts:610,733,915`). Not a new external-content vector — it widens the guard-off blast radius to multiple concurrent sessions spawned by the same trusted trigger. | `src/runner/agent-team.ts` |
| **Content the guard-off session itself fetches mid-conversation** (`WebFetch`, `gh issue view`, reading a repo file containing attacker text, etc.) | **Yes — this is the real residual risk**, not message forwarding | See §3 below |

### 3. The actual exposure: indirect injection into an already-open guard-off session

Once a legitimate principal-DM session is running with the bash guard off, nothing about that
session's *trust in its own tool outputs* changes. If the principal asks it to summarize a GitHub
issue, fetch a URL, or read a file whose contents an attacker controls, the fetched text can carry
a prompt injection that then tries to redirect the (guard-disabled) session. The only defenses at
that point:

- `VERIFICATION RULE` and `CONFIG IMMUTABILITY` in `security-preamble.ts:37–43,113–119` — **prose
  only**, not gated by `skipBashGuard`/`skipFilesystemRestriction` (they're always included,
  confirmed by re-reading the full function), but an LLM instruction an injected payload can try
  to override.
- **EBH-1's new `path-guard.hook.ts`** (merged today, commit `c25a7c3d`) — this DOES apply to
  Read/Write/Edit/Glob/Grep/NotebookEdit in a principal-DM session: `CORTEX_PATH_GUARD` is
  populated from the same `invokeDirs` regardless of DM-vs-normal
  (`src/bus/dispatch-handler.ts:972`, unaffected by `bashGuardDisabled`), so **as long as the
  cortex config directory is never itself included in that principal's `allowedDirs`**, a
  Write/Edit into the config tree is deterministically denied even in a guard-off DM
  (`src/runner/hooks/path-guard.hook.ts:436–465`). This is new since the review was written and
  meaningfully narrows R1-F4 for the file-tool surface.
- **Bash remains a full blind spot.** `bash-guard.hook.ts`'s `config === null` branch
  (`:1150–1153`) returns `pass()` **before** reaching its own EBH-1-added path-containment checks
  for `cat`/`head`/`tail`/`ls`/`wc`/`file`/`git` (`PATH_CHECKED_COMMANDS`, `:384`) — so a
  guard-off session's Bash tool has **zero cortex-owned protection**, including against reading or
  overwriting the config directory via `cat`/`echo >`/`sed -i`/etc. The only remaining backstop is
  whatever Claude Code's own permission engine does for that session — which I could not verify
  (see §1).

### 4. Principal-map integrity — VERIFIED location + partial protection, one stale claim corrected

- `policy.principals[].platform_ids` (the principal↔platform-ID mapping) lives in
  `stacks/<slug>.yaml` under the config-split layout (per `CLAUDE.md`'s config-layout table:
  `stacks/*.yaml` owns `principal`/`policy`). This is inside the directory the `CONFIG
  IMMUTABILITY` prose rule names — `configDir = configPath.replace(/\/[^/]+$/, "")`
  (`security-preamble.ts:110–112`), the dirname of the resolved `--config` pointer, which for a
  config-split stack IS the `stacks/` directory.
- Protection is **split by tool surface**, as above: Read/Write/Edit/Glob/Grep/NotebookEdit
  against that file are deterministically blocked by the new path-guard (assuming the config dir
  isn't in `allowedDirs`, which it structurally shouldn't be for any code-focused agent); Bash
  writes are not blocked by anything cortex-owned in a guard-off session.
- **Stale claim, corrected:** the review states *"G-301 (issue #42) is the client's own planned
  hardening"* as a compensating control, and `docs/security/hardening-plan.md:49` repeats it
  ("land G-301 (#42 lineage)"). **GitHub issue #42 is `feat(common): C-108.x — AgentRegistry over
  CortexConfig (MIG-7.2a)`, MERGED, and has nothing to do with authentication hardening** — it's
  an early MIG-7 migration PR about the in-memory agent trust-closure registry. Searching the repo
  and GitHub for "G-301" turns up **no design doc section, no blueprint entry, and no dedicated
  issue** — only this same wrong citation repeated in two places, plus (unsurprisingly) the
  current EBH-6 issue (#2348) itself, which is not G-301. `docs/design-dm-operator-channel.md`
  fully documents G-300 (§"G-300: Principal DM with Elevated Privileges") but has no G-301
  section. **G-301 does not currently exist as trackable work — it is a named-but-never-filed
  placeholder.**

### Recommendation for the principal

- The guard-disable trigger is sound (platform-authenticated identity, per-message resolution,
  no producer found that can forge it). The realistic risk is indirect prompt injection reaching
  an already-legitimate guard-off session via its own tool calls, where Bash has zero cortex-owned
  containment (file tools now do, as of EBH-1 today).
- Two decisions for the principal:
  1. Should `bash-guard.hook.ts`'s disabled branch also route through the same
     path-containment checks EBH-1 just added for the allowlisted case, rather than bypassing them
     entirely? (This would not re-enable command-shape restriction — it would just stop
     guard-off Bash from having *zero* path awareness, closing the gap the file-tool surface just
     closed.)
  2. G-301 needs to be **filed as a real issue** (it currently is not one) before it can be
     "landed" — the review and hardening-plan citations should be corrected to stop pointing at
     #42.

---

## Open questions for the principal (binary)

1. **R1-F3 — Config exposure.** Should `sovereigntyEnforce` be promoted to a real (still
   default-`false`) config key now, independent of the #2117/#2201 prerequisite work, so enabling
   it is a principal action rather than a code change? Yes / No.
2. **R1-F3 — Enforce-now vs. explicit-deferral for `api-agent`.** Per #2117's own framing: enforce
   the *resolved* inference-profile `modelClass` now (small, closes the design's stated intent),
   or document the deferral explicitly and wait for #2201 (model-placement gate)? Enforce-now /
   Defer.
3. **R1-F4 — Bash path-awareness in guard-off sessions.** Should `bash-guard.hook.ts`'s
   `disabled`-branch also run the EBH-1 path-containment checks (not the command-shape allowlist,
   just containment) rather than a bare `pass()`? Yes / No.
4. **R1-F4 — G-301.** File G-301 as an actual GitHub issue now, and correct the two stale `#42`
   citations (review + hardening-plan)? Yes / No.

---

## Claims I could not verify

- The exact Claude Code CLI permission-mode / `--allowedTools` shape a principal-DM session
  actually launches with, beyond confirming `--dangerously-skip-permissions` is never passed
  (`src/runner/claude-invoker.ts:56–79`). This determines whether Claude Code's own permission
  gate is a real backstop for guard-off Bash or effectively a rubber stamp for that session type.
- The full path from a GitHub webhook-relayed event to wherever it eventually becomes a CC session
  prompt (github-events processing → channel/thread dispatch) — confirmed the webhook receiver
  itself never touches `InboundMessage`/`handleMessage`, but did not independently trace every
  hop after that to rule out some other route back into DM classification.
- Mission Control API / CF Worker (`src/surface/mc/`) and the myelin wire-crypto internals
  (`signed_by` chain verification implementation itself) were out of scope for the original review
  and remain out of scope here — not read.
