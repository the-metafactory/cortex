# EBH-7 — swarm-posture structural check (cortex#2349, epic #2341)

Structural least-privilege + attack-path analysis of cortex's own agent fleet, using
[`swarm-posture`](https://github.com/NorthwoodsSentinel/swarm-posture) (NorthWoods
Sentinel Labs, Apache-2.0 — the same reviewers who authored the NWS security review
this epic responds to).

**The thesis** (from the issue): *"Security doesn't compose — you can't audit a swarm
by auditing its workers one at a time."* cortex spawns multi-agent teams
(`src/runner/agent-team.ts`: moderator + participants) — a real invoke-graph where a
composed escalation (a chain of individually-authorized invocations reaching data no
single worker should) can hide from a per-worker review. This directory holds the
structural model of that graph plus the check's findings.

## Files

- `cortex-fleet.swarm.json` — the committed swarm description (`swarm-posture`'s
  schema). Reviewable, diff-visible; regenerate/hand-correct it whenever the fleet's
  tool grants or delegation edges change.
- `../../../scripts/security/run-swarm-posture.ts` — the CI wrapper that invokes the
  upstream tool against this file.
- `../../../.github/workflows/swarm-posture.yml` — the CI job (warn-only).

## Vendor vs. invoke

**Invoked, not vendored.** `swarm-posture.ts` is a single ~140-line zero-dependency
file; copying it into this repo would create a second, unreviewable copy of a security
tool's algorithm that silently drifts from upstream. Instead, CI checks out
`NorthwoodsSentinel/swarm-posture` at a **pinned commit SHA**
(`12d042d9f936bc99fed9bd00c29da5e06211b953`, tag-free — the same "pin the engine, not
a movable ref" discipline `confidentiality-gate.yml` already uses for its reusable
workflow) into a sibling checkout path, and `run-swarm-posture.ts` runs it as a
subprocess against the committed `cortex-fleet.swarm.json`. Bumping the pin is a
one-line, reviewable diff; there is exactly one copy of the check's logic, and it's
upstream's.

There is no `cortex` mode in `swarm-posture`'s own `adapt.ts` (only `pai`, `pi`,
`langgraph`, `crewai`), so this fleet description is **hand-modeled from source**, not
adapter-generated. The sources read are listed in the JSON file's own `_provenance`
block so the model's basis stays visible next to the data.

## The fleet model

Eight workers, five sensitivity tiers. The tiers are cortex's actual reach classes —
not the generic PAI-adapter categories in `swarm-posture`'s own `adapt.ts`:

| Tier | Name | What reaches it |
|---|---|---|
| 1 | `filesystem` | `Read`/`Grep`/`Glob`/`Write`/`Edit` — the repo/config tree |
| 2 | `network-egress` | `WebFetch`/`WebSearch` — outbound web |
| 3 | `external-service` | `tool.mcp.*` grants — third-party accounts reachable via MCP servers (Discord, GitHub, Drive, …) |
| 4 | `secrets` | `Bash` — env vars, `~/.env`, credential files, NATS seeds, tokens |
| 5 | `full-authority` | the reserved `operator` capability — full tool grant + full MCP namespace (`deriveMcpGrants` returns `["*"]`) + `trusted: true` (bypasses the inbound prompt-injection hard block, `resolve-access.ts:381-388`) |

`sensitive_at_or_above: 3` — filesystem/network-egress are cortex's normal working
reach for any assistant; external-service/secrets/full-authority are the
escalation classes.

### Workers

| id | role | reach | invokes |
|---|---|---|---|
| `principal-session` | `principal` | full-authority (all tiers ≥3 — holds the `operator` capability) | `team-moderator` |
| `team-moderator` | `team-council` | shell-and-secrets, third-party-services | `team-analyst`, `team-creative`, `team-critic` |
| `team-analyst` / `team-creative` / `team-critic` | `team-council` | shell-and-secrets, third-party-services | — |
| `concierge-anon` | `concierge` | filesystem only | — |
| `concierge-authenticated` | `concierge` | filesystem only (cortex#2386 — see "Finding 1" below) | — |
| `review-bot` | `code-reviewer` | shell-and-secrets | — |

**Why these eight, and not a bigger or smaller roster:**

- `principal-session` / `team-moderator` / `team-analyst` / `team-creative` /
  `team-critic` model `src/bus/dispatch-handler.ts`'s `handleTeam` — the `team:`
  keyword handler. It hardcodes **exactly three participants**
  (`analyst`/`creative`/`critic`, dispatch-handler.ts:1678-1680) and passes
  `allowedTools`, `mcpGrants`, and `agentEnv` **unchanged** into every session
  `AgentTeamOpts` propagates them to (moderator + all three participants +
  synthesis — see `agent-team.ts`'s own docblock and cortex#2111/#2133 comments
  at the call site). There is no per-participant narrowing in this call site: no
  `TeamParticipantConfig.allowedTools`/`disallowedTools` override is set, so
  every team session gets the SAME tool/MCP reach as whoever typed `team:`.
  `docs/security/ebh-6-posture-findings.md` independently corroborates the same
  propagation pattern for a different flag (`bashGuardDisabled`, `agent-team.ts:
  610,733,915`) — this is a general property of the mechanism, not specific to
  one config field.
- `concierge-anon` / `concierge-authenticated` model Pier (`agents.d/pier.yaml`,
  `personas/pier.md`) — the one real, shipped, public in-tree agent. The anon
  worker is the `openOnboarding` path (`resolve-access.ts`'s
  `anonOnboardingAccess`): a hardcoded, enforced `["Read"]` allowlist,
  `mcpGrants: []`, `trusted: false`. The authenticated worker models what
  happens when a *mapped, non-anonymous* principal messages Pier. Until
  cortex#2386 this was Finding 1 below — persona `allowedTools` was
  advisory-only, so an authenticated sender's tool reach came from the
  sender's own role, not Pier's declared `[Read]`. Since #2386,
  `dispatch-handler.ts` enforces the persona's `allowedTools` for EVERY
  sender (not only the anon gate), so `concierge-authenticated` is modeled
  identically to `concierge-anon` here — see "Finding 1" for the resolution
  and its residual scope (dispatch-only; the web-gateway path is a separate,
  still-open hole, cortex#1758).
- `review-bot` models Echo, using the `agent-echo` role literally declared in
  the committed `cortex.yaml.example` (`policy.roles: id: agent-echo →
  keyword.chat, tool.bash, tool.read, tool.glob, tool.grep`).

**What's deliberately NOT in the model:** `TeamParticipantConfig.kind:
"bus-peer"` (a documented primitive in `agent-team.ts` for delegating a
participant to a REMOTE cortex over the bus) is a live, callable mechanism but
has **no current call site** — `handleTeam` never sets `kind`, so every
shipped team session is `"local"`. Modeling it as a worker would misrepresent
something as *currently wired* that is only *available*. It is flagged as a
forward-looking risk in Finding 3 instead of baked into the JSON as a phantom
edge — see `swarm-posture`'s own scope note: it "reads your declared config;
it does not run your agents," and an unused code path is not declared
reachable config.

### `role_owns` — the judgment call

- **`principal`** owns everything. This is the home principal / trust root by
  design (`resolve-access.ts:381-388`, cortex#741) — the one role meant to
  hold the `operator` capability.
- **`code-reviewer`**, **`concierge`**, **`team-council`** own only
  `repo-and-config-files`. None of these are, by design, supposed to hold
  unscoped shell/secrets or third-party-service reach — a code reviewer reads
  the repo, a concierge answers onboarding questions from docs, and an ad-hoc
  analyst/creative/critic persona reasons over context. None of that requires
  Bash or MCP.

This was decided *before* running the check, not adjusted afterward to make
the report look clean — see "Findings" below for what it actually flagged.

## Findings (as of cortex commit `93d0d5df`, PRE-cortex#2386)

**This console block is a historical snapshot, preserved verbatim** — it was
NOT re-run against the upstream tool after cortex#2386 landed (this repo does
not vendor `swarm-posture.ts`; regenerating it requires the pinned
NorthwoodsSentinel/swarm-posture checkout CI uses). Finding 1 below is
annotated **RESOLVED (cortex#2386)** based on updating
`cortex-fleet.swarm.json`'s `concierge-authenticated` worker to match the
code's new (enforced) reach — see the resolution note directly under Finding
1 for what changed and what did NOT. Findings 2–4 are untouched by #2386 and
remain open.

Ran `bun <pinned-swarm-posture-checkout>/swarm-posture.ts
docs/security/swarm-posture/cortex-fleet.swarm.json`:

```
swarm-posture — cortex-fleet  (8 workers · sensitive = external-service and above)

POSTURE  6 worker(s) over-broad for their role, 0 escalation path(s). Not least-privilege.
  8 workers · 7 reach sensitive data · 2 can spawn other agents · 6 reach shell-and-secrets

EXCESSIVE PERMISSIONS (least-privilege / blast radius)
  ⚠ team-moderator (role: team-council) reaches shell-and-secrets (external-service), shell-and-secrets (secrets), third-party-services (external-service) — its role does not own this; scope down.
  ⚠ team-analyst (role: team-council) reaches shell-and-secrets (external-service), shell-and-secrets (secrets), third-party-services (external-service) — its role does not own this; scope down.
  ⚠ team-creative (role: team-council) reaches shell-and-secrets (external-service), shell-and-secrets (secrets), third-party-services (external-service) — its role does not own this; scope down.
  ⚠ team-critic (role: team-council) reaches shell-and-secrets (external-service), shell-and-secrets (secrets), third-party-services (external-service) — its role does not own this; scope down.
  ⚠ concierge-authenticated (role: concierge) reaches shell-and-secrets (external-service), shell-and-secrets (secrets), third-party-services (external-service), full-authority (external-service), full-authority (secrets), full-authority (full-authority) — its role does not own this; scope down.
  ⚠ review-bot (role: code-reviewer) reaches shell-and-secrets (external-service), shell-and-secrets (secrets) — its role does not own this; scope down.

ATTACK PATHS (composed escalation — a chain a per-worker review can't see)
  none — no invocation chain reaches sensitive data its origin doesn't own.

━━ SUMMARY ━━
  6 structural finding(s): 6 excessive-permission, 0 attack-path
```

**These are genuine, unmassaged findings against the shipped reference
config** (`cortex.yaml.example` + `agents.d/pier.yaml` + the `handleTeam` call
site) — nothing in `role_owns` was loosened after seeing this output.

### Finding 1 — Pier's persona confinement is not actually enforced for authenticated senders

`personas/pier.md` declares `allowedTools: [Read]` — Pier's whole documented
security posture is "it only reads, it issues nothing." But
`docs/persona-format.md`'s own error-handling table says this plainly:

> `allowedTools` … Field is **advisory in v1** — runtime enforcement (filtering
> the substrate's tool palette to this allowlist) lands in a future cortex
> release; until then the runner **ignores the field** with an info-level log.

The only path where Pier's tools are *actually* clamped is the anonymous
open-onboarding path (`anonOnboardingAccess` in `resolve-access.ts`, a
hardcoded `["Read"]` + `mcpGrants: []` + `trusted: false`, confirmed live at
`dispatch-handler.ts:641-644`). For any *mapped, authenticated* principal who
messages Pier, `resolvePolicyAccess` resolves tool grants from **that
sender's own role**, not from Pier's persona, and `agents.d/pier.yaml`
declares no `agentDisallowedTools` to narrow it back down
(`dispatch-handler.ts:925-947`, the `effectiveAllowedTools`/`effectiveDisallowed`
computation). So `concierge-authenticated`'s worst-case reach in the model
above — full shell/secrets/MCP reach plus the `operator` capability if the
sender happens to be the principal — is real, not a hand-wavy hypothetical: it is what the code does
today, for any sender whose own role is broad. **The fix is narrow and
concrete**: declare `agentDisallowedTools` (or an equivalent enforced
allowlist) on Pier's agent config so its confinement is enforced at the same
layer as everything else, not left to an advisory persona field the runner
admits it ignores.

**RESOLVED (cortex#2386 / EBH-7a).** Rather than hand-adding
`agentDisallowedTools` to `agents.d/pier.yaml` alone (the narrow fix this
finding proposed), `dispatch-handler.ts` now derives the SAME kind of
deny-list from the persona's `allowedTools` frontmatter directly — every
`DispatchHandler`-routed agent whose persona declares `allowedTools` gets it
enforced this way, not just Pier. Mechanically: `personaAllowedTools()`
reads `personas/<id>.md`'s frontmatter (cached per path), and its complement
against `CLAUDE_TOOL_INVENTORY` is merged into `effectiveDisallowed` right
alongside `agentDisallowedTools` — declaring `allowedTools` at all also adds
`--strict-mcp-config` (the canonical tool set never names an `mcp__*` tool,
so a declared allowlist implicitly means "no MCP" too). This applies
regardless of who the sender is — the authenticated-vs-anonymous distinction
this finding turned on no longer matters for the tool-reach question, which
is why `concierge-authenticated` above is now modeled identically to
`concierge-anon`.

**What this does NOT resolve:**
- **The web-gateway path (cortex#1758) still bypasses this entirely.**
  `src/gateway/bus-inbound-sink.ts` never loads the bound stack's agent
  config, so it can't compute the persona complement — confirmed live, not
  just structurally: `pylon` (`agents.d/pylon.yaml`) already declares an
  explicit `agentDisallowedTools` covering the full CC tool set plus
  `strictMcpConfig: true`, is dispatched via the AMT web surface (i.e.
  through this gateway), and cortex's own event telemetry shows pylon
  sessions invoking `Edit`/`Write`/`Agent` anyway (e.g. session
  `5dee443d-2246-4b7f-b3bc-0c9505b2922f`). Pier itself is Discord-bound, not
  gateway-routed, so this residual gap does not apply to Pier's real deployed
  path — but it means neither `agentDisallowedTools` nor the new persona
  `allowedTools` derivation is a complete answer for any FUTURE
  gateway-routed agent. See `docs/security/hardening-plan.md` /
  `design-session-sandbox.md` for the kernel-level (L1–L3) fix.
- **Unknown/typo'd tool names in `allowedTools` are not rejected**, only
  logged (to stderr, at dispatch time) — a persona author who typos a tool
  name gets a narrower allowlist than intended, not an install-time error.
  `docs/persona-format.md`'s aspirational "reject registration" validator for
  malformed persona frontmatter does not exist in code today (pre-dates
  #2386; out of this fix's scope).

### Finding 2 — the built-in `team:` council has no per-agent least privilege

`handleTeam`'s three hardcoded participants (`analyst`/`creative`/`critic`)
get the exact same `allowedTools`/`mcpGrants`/`agentEnv` as whoever typed
`team: …` — there is no role differentiation at all between three
general-purpose reasoning personas and the invoking principal's own grant.
Concretely: if a principal's session is manipulated by indirect prompt
injection (fetched issue text, a webhook-relayed comment, etc. — the exact
threat class this epic's F1/F6 findings are about) into emitting a `team:`
message, the attacker rides the **full 3-way fan-out** with the principal's
own Bash/MCP reach, not a scoped-down "just discuss this" surface. This
showed up as 4 of the 6 excessive-permission findings (moderator + 3
participants), and is why the POSTURE headline reads "6 worker(s) over-broad
… not least-privilege" rather than a clean bill of health.

Because the *only* role in the shipped example that holds `keyword.team` is
`principal` — the same role that legitimately owns every sensitive class —
`swarm-posture` correctly reports **zero attack paths** for this edge (an
origin invoking a deputy that reaches only what the origin already owns
directly is blast radius, not escalation; see the tool's own doc comment on
why it skips that case). That is the accurate structural call, not a blind
spot: the real risk here is unscoped blast radius from the fixed 3x fan-out,
not composed privilege escalation. It would become composed escalation the
moment any role *other* than `principal` gains `keyword.team` without gaining
matching `role_owns` — which is exactly the kind of future-config drift this
gate exists to catch.

### Finding 3 — `TeamParticipantConfig.kind: "bus-peer"` is a live, unused escalation surface

`agent-team.ts` implements delegating a team participant to a **remote**
cortex stack over the bus (`BusPeerHarness`, cortex#114 Phase B.2b). No
current call site sets `kind: "bus-peer"` — `handleTeam` always uses the
default `"local"` — so it is not in the committed `swarm.json` (see "What's
deliberately NOT in the model" above). But the mechanism is real, tested, and
one line away from being wired into any future team-mode caller. When it is,
it should get its own worker entry with reach modeled as crossing the trust
boundary entirely (the remote stack's own policy determines reach, which is
unbounded from the local swarm's perspective) — flagged here so it isn't
forgotten when a future PR adds a call site.

### Finding 4 — Echo's review-bash grant is unscoped

`agent-echo`'s role in `cortex.yaml.example` grants `tool.bash` with **no**
`bash_allowlist` (`policy.principals[].session_config.*.bash_allowlist`, the
scoping mechanism `resolve-access.ts` reads). A code reviewer plausibly needs
to run `bun test`/`tsc --noEmit`/`bun lint` as part of a review — that's a
reasonable capability, which is why `code-reviewer` is not simply denied
`shell-and-secrets` outright in this write-up. But *unscoped* Bash reaches
the full secrets tier (env vars, credential files, tokens), which is broader
than "run the test suite." The concrete fix is to populate a
`bash_allowlist` scoping Echo's shell to review-relevant commands, not to
strip Bash entirely.

## What this check is and isn't

**Structural only.** It reads declared config (`cortex-fleet.swarm.json`,
itself hand-derived from real source — see `_provenance`) and computes
reachability; it does **not** run cortex, does not spawn real Claude Code
sessions, and cannot tell you whether a real model actually falls for a given
prompt injection. That's **behavioral simulation** (intent-fidelity
measurement under live injection) — explicitly out of scope for this issue
per the epic's own "Horizon" section, and NorthWoods Sentinel Labs' paid
tier.

It is also only as accurate as the hand-modeling above — there is no
automated `cortex` adapter mode in `swarm-posture`'s `adapt.ts` today, so
drift between this file and the real `resolve-access.ts`/`agent-team.ts`
behavior is caught only by whoever re-reads the source at update time, not by
tooling. Treat `cortex-fleet.swarm.json` the same way the upstream README
tells framework-adapter users to treat a generated file: "a first draft you
can correct by hand, not gospel" — except here it started as a hand draft, so
the correction loop is a human (or agent) re-reading `resolve-access.ts` /
`agent-team.ts` / `dispatch-handler.ts` and updating the JSON, not
re-running an adapter.

## CI wiring

`.github/workflows/swarm-posture.yml` runs on every push/PR that touches
agent/tool-grant config (`agents.d/**`, `personas/**`, `cortex.yaml.example`,
`docs/config-layout/**`, `src/common/policy/**`, `src/runner/agent-team.ts`,
`src/bus/dispatch-handler.ts`, or this directory). It is a **standalone,
non-required** workflow — the same warn-only mechanism
`confidentiality-gate.yml` already uses in this repo (GitHub doesn't allow
`continue-on-error` on a job calling a reusable workflow, but a workflow that
is simply never added to `protect-main`'s required status checks cannot
block a merge either way, and `run-swarm-posture.ts` itself also always
exits 0 once the check ran — belt and braces). The step summary carries the
finding count and full output for every run.

### What it would take to make this blocking

1. **Burn-in window** — run WARN-ONLY long enough to see the real
   finding/false-positive rate across a few weeks of agent-config PRs (same
   acceptance bar `confidentiality-gate.yml` used: "≥3-day warn-only burn-in
   with <1 false BLOCK/week").
2. **A drift baseline, not a zero-tolerance gate** — `run-swarm-posture.ts`
   would need to parse the "N structural finding(s)" line and fail only on a
   *regression* against a committed baseline count (or a fixed ceiling this
   PR's four findings become), not on the pre-existing findings above —
   otherwise flipping to blocking requires fixing all four findings in the
   same PR as the gate, which inverts the intended order (land the gate,
   *then* decide whether/when to fix what it found).
3. **A principal decision on the findings themselves** — scoping Echo's
   `bash_allowlist`, deciding whether/how to narrow the `team:` council's
   default tool grant, and declaring `agentDisallowedTools` on Pier are
   product/security decisions, not something this issue's tooling change
   should silently resolve.
4. **Enrollment in `protect-main`'s required status checks** — a held ops
   step, principal-only, per the same posture-change discipline
   `confidentiality-gate.yml`'s header documents (OD-1 admin-bypass posture).
