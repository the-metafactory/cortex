# Cursor Substrate Review Agent — Design Specification

**Status:** Draft — architecture design for a Cursor-CLI-based review agent that plugs into the cortex/myelin infrastructure as a sibling to the pi.dev review agent.
**Date:** 2026-05-13
**Driver:** Andreas Aastroem
**Related docs:** `docs/design-pi-dev-review-agent.md` (the sibling design this mirrors), `docs/design-arc-agent-bots.md` (substrate-pluggable bot packaging — Cursor lands as the fourth standalone-substrate worked example), `docs/architecture.md` (§6 bus contracts; §9 agent + presence/renderer model).
**Closes:** cortex#70
**Reference repos:** `the-metafactory/sage` (reference standalone bot, pi.dev substrate), `the-metafactory/alpha` (this bot, Cursor substrate)

---

## 1. Why a Second Standalone Substrate

Cortex already runs two substrate patterns in production:

| | Pattern | Example | How dispatch works |
|---|---------|---------|---------------------|
| 1 | **In-process child** | Luna, Echo, Forge | cortex daemon spawns `claude --print --output-format stream-json` via `src/runner/cc-session.ts` |
| 2 | **Out-of-process bus peer** | sage (the-metafactory/sage) | Independent daemon on pi.dev substrate, listens on `local.{org}.dispatch.sage.*`, executes via the `pi` CLI, publishes results back on `local.{org}.review.*` |

Adding Cursor as a third recognised substrate is **complementary to sage**, not a replacement. Two value propositions:

1. **Substrate diversity.** When alpha (Cursor) and sage (pi.dev) join the same NATS queue group, two reviewers from different brains compete on the same review tasks via claim-first-wins (per cortex#112 Q5 lock-in). Principals get a substrate-A/B without writing routing logic. A bug in any single substrate's reviewer cannot silently degrade review quality across the fleet.

2. **Codebase locality.** Sage on pi.dev reviews diff-only. Cursor-agent runs in a working directory with the PR head ref cloned, so it can read whole files, trace symbols across modules, and reason about test coverage. This is a capability sage cannot economically replicate: a `DeepArchitecture` lens that requires the repo present at cwd is naturally Cursor-shaped.

The bus contracts, envelope shape, fragment shape, and lifecycle hooks are all identical to sage's. The only new thing in this design is the substrate-specific shim that makes `cursor-agent` runnable as a daemon worker. Cortex itself gains exactly one mechanical change: `"cursor"` joins the substrate enum in `src/common/types/cortex-config.ts:253`.

---

## 2. Cursor CLI — Research Findings

Verified 2026-05-12 against `cursor.com/docs/cli` (Jan 16, 2026 changelog) and the Trigger.dev integration reference. Research already locked in cortex#70's issue body; reproduced here for the design doc audience.

| Axis | Status | Notes |
|---|---|---|
| Headless CLI binary | ✅ `cursor-agent` (alias `agent`) | Installable via `curl https://cursor.com/install \| bash`; container-friendly |
| Headless / one-shot | ✅ `-p` / `--print` flag | One process per task; `--force` (alias `--yolo`) skips per-tool approvals |
| Output format | ✅ `--output-format stream-json` | NDJSON; events: `system-init` / `user-message` / `assistant-message` / `tool-call-started` / `tool-call-completed` / `result`. Structurally parallel to Claude Code's `stream-json` with field-name differences. |
| Resume | ✅ `--continue` / `--resume=<id>` | Same shape as Claude Code's `--resume`. Not used in v1 (one process per dispatch). |
| **`--system-prompt` flag** | ❌ **NONE** | Persona is file-based only: `.cursor/rules/*.mdc`, `AGENTS.md`, `CLAUDE.md` at cwd root. |
| Daemon mode | ❌ one-shot only | No IPC channel for new tasks; every envelope = new `cursor-agent` invocation. |
| License | Active Cursor subscription; CLI still beta | Background Agents (cloud) consume cloud usage on top. |

**Bottom line:** Cursor satisfies the standalone-substrate contract well enough for a bus-peer reviewer. The single structural gap is the missing `--system-prompt` flag, which forces a per-dispatch workdir-staging step that writes the persona into `.cursor/rules/persona.mdc` before invoking the binary. This is the entire substrate-specific divergence from sage; everything else (bus, envelope, lens engine, verdict, gh posting) is shared code.

---

## 3. Architecture — Mirror of Sage with One New Layer

```
                                ┌───────────────────────────┐
                                │      NATS (Myelin bus)    │
                                └────────────┬──────────────┘
                                             │
              local.{org}.tasks.code-review.>│  local.{org}.tasks.@did-mf-alpha.>
                       (queue: code-reviewers)│  ← competes with sage on the same queue
                                             ▼
            ┌───────────────────────────────────────────────────┐
            │                  src/bus/bridge.ts                │
            │   validate envelope → dispatch.task.started       │
            └────────────────────────┬──────────────────────────┘
                                     │
                                     ▼
            ┌───────────────────────────────────────────────────┐
            │           src/lenses/workflow.ts                  │
            │                                                   │
            │  ┌─────────────────────────────────────────────┐  │
            │  │  prepareWorkdir():                          │  │
            │  │    mkdtemp <workdir-root>/<dispatch-id>     │  │
            │  │    git clone --depth=1 PR head → repo/      │  │
            │  │    write repo/.cursor/rules/persona.mdc     │  │
            │  └─────────────────────────────────────────────┘  │
            │                  │                                │
            │                  ▼                                │
            │  ┌─────────────────────────────────────────────┐  │
            │  │  CodeQuality lens:                          │  │
            │  │    cursor-agent -p --force                  │  │
            │  │      --output-format stream-json            │  │
            │  │    (NDJSON stream → events + collected text)│  │
            │  └─────────────────────────────────────────────┘  │
            │                  │                                │
            │                  ▼                                │
            │  decideVerdict → gh pr review --comment|approve   │
            │  workdir.cleanup()                                │
            └────────────────────────┬──────────────────────────┘
                                     │
                                     ▼
              local.{org}.code.pr.review.{approved|…}
              local.{org}.dispatch.task.completed
```

The shape is **identical** to sage from `bus/bridge.ts` outward. The new layer is the per-dispatch workdir lifecycle that bridges the persona-staging gap. Every other module ships as vendored code from sage at version 0.1.0, with the plan to extract `@the-metafactory/lenses` and `@the-metafactory/myelin-bus` as shared libraries once both bots are running in parallel.

---

## 4. Substrate-Specific Divergence — the Persona-Staging Shim

`cursor-agent` reads persona content from files in the working directory at invocation time. It does not accept persona content on the command line or on stdin. To run alpha's persona, the daemon prepares a fresh per-dispatch workdir on every envelope claim:

```
${ALPHA_WORKDIR_ROOT}/<dispatch-id>/
  repo/                                     ← shallow git clone of the PR's head ref
    .cursor/rules/persona.mdc               ← alpha.md content (frontmatter stripped)
    PR.md                                   ← rendered PR metadata for cursor to read
    diff.patch                              ← unified diff for cursor to read
    <files from the PR's head ref>
```

`ALPHA_WORKDIR_ROOT` defaults to `~/Library/Caches/alpha/workdirs/`. The daemon shells out to `git init` + `git remote add` + `git fetch --depth=1 origin pull/N/head` + `git checkout FETCH_HEAD`; the shallow clone keeps the workdir small and the setup fast even on large repos. After the dispatch publishes its terminal envelope (`dispatch.task.completed` or `dispatch.task.failed`), `workdir.cleanup()` removes the directory recursively.

Two reasons for stripping YAML frontmatter from the persona before staging it: (1) cursor's `.mdc` convention does not parse the frontmatter and would render it as literal text at the top of the persona, polluting the reviewer's voice; (2) the identity/trust/runtime metadata is for cortex's agent registry, not for the LLM.

Cleanup is also a security boundary. The cloned repo contains the PR author's untrusted code; running cursor-agent against it grants read access to that code under the daemon's process identity. Tearing down the workdir after the dispatch prevents accumulation of stale code on the principal's machine and shortens the window in which a malicious payload could be re-exercised by an unrelated process.

---

## 5. Stream-JSON Event Mapping

Cursor's `--output-format stream-json` emits one NDJSON object per event. The runner parses lines as they arrive (drain on `\n`, leave partial line in buffer for next chunk), preserving every event for audit while extracting the assistant text used by the lens prompt.

| Cursor event type | Carries | Mapped to |
|---|---|---|
| `system-init` | Session start, model name, available tools | Logged; no envelope (lens-internal) |
| `user-message` | The prompt cursor received | Logged; no envelope (we already published `dispatch.task.started` upstream) |
| `assistant-message` | Cursor's text reply (streamed) | Collected into the lens output buffer |
| `tool-call-started` | Cursor invoked a tool (read, edit, bash, …) | Logged; future: surfaced as `dispatch.task.progress` with tool name |
| `tool-call-completed` | Tool returned | Logged; future: surfaced as `dispatch.task.progress` |
| `result` | Final structured result | Collected into the lens output buffer; runner returns |

The lens prompt asks for a single JSON object as the final assistant message. The runner's `runCursorJson<T>()` parses the concatenated text using the same four-pass extraction algorithm sage uses (raw → greedy fence → balanced-brace slice → non-greedy fence) — preserved verbatim so the two substrates produce structurally identical findings.

Unknown event types are kept in the `events` array but ignored for text extraction. This is intentional: cursor's CLI is beta and the event schema is unversioned. New event types should not break the runner; they should accumulate in the audit log and be addressed by a follow-up PR.

---

## 6. Configuration — Same Pattern as Sage

### 6.1 Cortex fragment — agents.d/alpha.md

Dropped by arc at install time. Same shape as sage's fragment (frontmatter + persona body), with the runtime block declaring the Cursor substrate:

```markdown
---
id: alpha
did: did:mf:alpha
displayName: Alpha
roles: [agent-restricted]
trust: [luna, sage, holly, ivy, pilot, fern]
runtime:
  substrate: cursor          # NEW enum member — see §9
  mode: standalone
  capabilities:
    - code-review
    - typescript
    - github-pr-review
    - deep-architecture
---

# Alpha — Persona
...
```

### 6.2 Daemon environment — rendered into the launchd plist

```
NATS_URL                 = nats://localhost:4222
NATS_CREDS_FILE          = ~/.config/nats/creds/alpha.creds
ALPHA_ORG                = metafactory
ALPHA_DID                = did:mf:alpha
ALPHA_SOURCE             = metafactory.alpha.local
ALPHA_DATA_RESIDENCY     = CH
ALPHA_WORKDIR_ROOT       = ~/Library/Caches/alpha/workdirs
CURSOR_API_KEY           = (optional — headless-auth fallback)
```

Cursor manages its own auth state under `~/.cursor/` (set up interactively via `cursor-agent login` once per machine). The daemon does not need to forward provider API keys the way sage forwards keys to pi.dev. The single narrow exception is `CURSOR_API_KEY`, which lets headless deployments authenticate without the interactive flow.

---

## 7. Bus Contracts — Unchanged

Same subjects, same envelopes as any cortex agent (per `docs/architecture.md` §6 and the sage design §4). The only difference is the source process.

| Subject | Direction | Carries |
|---|---|---|
| `local.{org}.tasks.code-review.>` | Inbound | Broadcast review tasks (queue group `code-reviewers` — shared with sage for substrate diversity) |
| `local.{org}.tasks.@did-mf-alpha.>` | Inbound | Direct review tasks targeting alpha specifically |
| `local.{org}.dispatch.task.started` | Outbound | Review begins |
| `local.{org}.dispatch.task.progress` | Outbound | After each lens completes |
| `local.{org}.dispatch.task.completed` | Outbound | Review finished |
| `local.{org}.dispatch.task.failed` | Outbound | Error/crash |
| `local.{org}.code.pr.review.{approved\|changes-requested\|commented}` | Outbound | Verdict envelope |

Nak reasons (`cant_do`, `wont_do`, `not_now`, `compliance_block`) unchanged per architecture §7.3.

---

## 8. Implementation — `the-metafactory/alpha`

Repository scaffolded at `~/Developer/alpha/`; not yet pushed. Layout mirrors sage's at v0.1.0:

| Path | Purpose | Provenance |
|---|---|---|
| `arc-manifest.yaml` | `schema: arc/v1`, `type: agent`, `targets: [cortex, darwin-launchd]`, `runtime.substrate: cursor` | New |
| `alpha.md` | Persona file with identity frontmatter | New |
| `bin/alpha` | Launcher; resolves install root + execs `bun run src/cli/index.ts` | Sage's bin/sage, renamed |
| `scripts/{check-cortex-version,check-cursor-installed,signal-cortex-reload,issue-nats-creds,start-daemon,stop-daemon,drain-tasks}.sh` | Lifecycle hooks | Sage's scripts with cursor-specific changes in `check-cursor-installed.sh` |
| `services/ai.meta-factory.alpha.plist` | launchd unit (token-replaced by arc) | Sage's plist with ALPHA_* vars |
| `src/cli/index.ts` | `alpha review \| serve \| init` commands | Sage's CLI with ALPHA_* + workdir option |
| `src/cursor/runner.ts` | `cursor-agent -p --force --output-format stream-json` wrapper, NDJSON streaming, JSON extraction | New |
| `src/cursor/env.ts` | Allow-listed env forwarding (CURSOR_*, shell essentials) | New (analog of sage's pi/env.ts) |
| `src/cursor/workdir.ts` | Per-dispatch workdir lifecycle (shallow clone + persona stage + cleanup) | New |
| `src/bus/{envelope,subjects,bridge}.ts` | Myelin envelope + NATS bridge | Vendored from sage |
| `src/github/{gh,env}.ts` | gh CLI wrapper | Vendored from sage |
| `src/lenses/{types,workflow,code-quality}.ts` | Lens engine | Vendored from sage, with `code-quality.ts` rewritten to call `runCursorJson` with `cwd=workdir.repoDir` and PR data staged on disk rather than stdin |

**Code reuse plan:** the vendored modules (`bus/`, `github/`, `lenses/types.ts`, lens scaffolding) are duplicated at first deploy. Once alpha is the second consumer in production, the shared code extracts into `@the-metafactory/lenses` and `@the-metafactory/myelin-bus` as separate packages; sage and alpha both depend on them. This is the classic two-consumer extraction pattern — extracting after the first consumer is speculation, extracting after the second is mechanical.

---

## 9. What Changes in Cortex (One Line)

The substrate enum at `src/common/types/cortex-config.ts:253` gains `"cursor"`:

```ts
// Before
substrate: z.enum(["claude-code", "codex", "pi-dev", "custom"]),

// After
substrate: z.enum(["claude-code", "codex", "pi-dev", "cursor", "custom"]),
```

That is the entire required cortex change. Test coverage in `src/common/config/__tests__/fragment-loader.test.ts` and `src/cli/cortex/commands/__tests__/agents.test.ts` extends to include the new variant; existing tests for `claude-code`, `codex`, `pi-dev`, `custom` stay green unchanged.

Cortex does not spawn `cursor-agent`. The Cursor daemon owns its own process lifecycle under launchd. Cortex's only contribution is recognising the substrate in fragments, scoping NATS creds, and rendering substrate provenance on the dashboard.

### 9.1 What does NOT change

- `PresenceSchema` — alpha has no chat surface in v0.1 (verdicts surface via the bus → cortex dashboard render path)
- `CortexConfigSchema` top level — no new blocks
- `src/cortex.ts` — no new adapters or wiring
- `src/runner/` — alpha is standalone, not a cortex-spawned child
- `docs/architecture.md` — substrate enum is illustrative there, but the model is unchanged

---

## 10. Distribution Modes

### 10.1 Broadcast — competing consumers with sage

```
cortex publishes → local.metafactory.tasks.code-review.typescript
                 → queue group `code-reviewers`
                 → competing consumers: sage (pi.dev), alpha (cursor)
                 → first to claim executes
```

This is the cortex#112 Q5 lock-in for competing-consumers: NATS queue group, claim-first-wins, no reservation, no auction. Principals get substrate diversity at the cost of nothing: the bus picks whichever reviewer is idle, and consistent over-claiming by one substrate is a signal to investigate (slow review on the other, bad routing, broken auth).

### 10.2 Direct — `@alpha review #N`

```
cortex publishes → with target_principal: "did:mf:alpha"
                 → only alpha's `local.{org}.tasks.@did-mf-alpha.>` subscription receives
                 → alpha claims unconditionally (or naks `not_now` if at capacity)
```

Principals use this when they specifically want the Cursor substrate (for example, to exercise the `DeepArchitecture` lens or to investigate a substrate-A/B disagreement).

### 10.3 Delegate — not in v1

Same scope boundary as sage: delegate mode (drive a PR to merge with multiple review-fix cycles) is deferred to a later phase. v1 ships single-shot review on dispatch.

---

## 11. Security and Sovereignty

### 11.1 Sandbox

- The cloned repo at `${ALPHA_WORKDIR_ROOT}/<dispatch-id>/repo/` is treated as untrusted input. `cursor-agent` runs against it with the daemon's process identity; the workdir teardown after dispatch shortens the window of exposure.
- `cursor-agent --force` skips per-tool approvals. The daemon process is sandboxed at the OS level (launchd `ProcessType: Background`, no elevated privileges) rather than per-tool inside cursor-agent.
- `gh` CLI is scoped to review operations only (`pr view`, `pr diff`, `pr review --comment|approve`). No merge, no push.
- The daemon's env allow-list (`src/cursor/env.ts`) forwards only `CURSOR_*` keys and shell essentials to the cursor-agent subprocess. Provider API keys (Anthropic, OpenAI, etc.) are NOT forwarded — cursor manages auth internally.

### 11.2 Envelope sovereignty

Alpha publishes with `sovereignty: { classification: "local", data_residency: "CH", max_hop: 0, frontier_ok: true, model_class: "any" }` by default. Same sovereignty model as cortex agents and sage. Principals override via env (`ALPHA_DATA_RESIDENCY`).

When cortex#112 Phase B lands the NKey 3-tier identity chain, alpha's envelopes gain a `signed_by[]` chain-of-stamps. The v1 design is forward-compatible: signing fields are optional in the envelope schema today, and adding them later does not require a wire-format flip.

---

## 12. Migration Path

### Phase 1 — Local development (no cortex change required)

- [x] Scaffold `the-metafactory/alpha` repo (local, not pushed) — mirrors sage's structure
- [ ] First end-to-end run: `bun run src/cli/index.ts review the-metafactory/cortex#92` with a real PR
- [ ] Verify the persona staging shim produces sane reviewer voice on cursor-agent
- [ ] Verify NDJSON event parsing handles all event types observed in a real run

### Phase 2 — Substrate enum lands in cortex (this PR)

- [ ] Add `"cursor"` to the substrate enum in `cortex-config.ts:253`
- [ ] Update tests in `fragment-loader.test.ts` + `agents.test.ts`
- [ ] Update `docs/design-arc-agent-bots.md` §3.2 to add Cursor to the worked examples
- [ ] This document lands as the design reference

### Phase 3 — Publish alpha

- [ ] Push `the-metafactory/alpha` to GitHub
- [ ] Principal runs `arc install github:the-metafactory/alpha` against the running cortex
- [ ] Mint NATS creds (`cortex creds issue alpha`) scoped to alpha's declared capabilities
- [ ] Verify launchd loads the plist; daemon connects bus; capability registry shows alpha
- [ ] Run a real review dispatch end-to-end against the bus

### Phase 4 — Competing-consumer experiment

- [ ] Sage and alpha both join the `code-reviewers` queue group
- [ ] Publish a synthetic review burst; verify NATS distributes across both
- [ ] Quality A/B on a week of real PRs: agreement rate, disagreement examples, surfaced bugs unique to each substrate

### Phase 5 — DeepArchitecture lens

- [ ] Implement the cross-file lens that exercises Cursor's whole-repo context advantage
- [ ] Gate on path/extension predicates (only fires on substantial diffs)
- [ ] Compare findings against sage's CodeQuality + Architecture lenses on the same PRs

### Phase 6 — Schema migration (depends on meta-factory v2-agent)

- [ ] Once `metafactory/v2-agent` schema lands in meta-factory, migrate alpha's manifest from `schema: arc/v1` to `schema: metafactory/v2-agent`
- [ ] Sage migrates in the same window
- [ ] Lens engine extracts into `@the-metafactory/lenses` shared package; both bots depend on it

---

## 13. Testing Strategy

| Test | Method |
|---|---|
| Cursor CLI presence | `command -v cursor-agent` in install preflight; daemon-startup probe (`cursor-agent --version`) |
| Persona staging | Unit test: prepareWorkdir() writes `.cursor/rules/persona.mdc` with frontmatter stripped |
| Workdir cleanup | Unit test: workdir handle's `cleanup()` is idempotent and survives missing-dir |
| NDJSON streaming | Unit test: feed canned chunks through the stdout handler; assert events array + collected text |
| JSON extraction | Reuse sage's `extractJson` test fixtures (raw, fenced, prose-wrapped) — same algorithm |
| End-to-end review | Real PR against a test repo; assert verdict envelope + posted comment |
| Competing consumers | Spin up sage + alpha; publish 1 task; assert exactly one claims and posts |
| Bus envelope validation | Reuse `myelin/examples/` fixtures — same envelope schema |
| gh CLI sandbox | Attempt unauthorised op (e.g. `pr merge`) → asserted blocked |

---

## 14. Failure Modes

| Failure | Detection | Recovery |
|---|---|---|
| `cursor-agent` not on PATH | `check-cursor-installed.sh` preinstall script | Install refuses; principal runs `curl https://cursor.com/install \| bash` |
| Cursor not authenticated | First dispatch errors on cursor-agent invocation | `dispatch.task.failed` with detail; principal runs `cursor-agent login` or sets `CURSOR_API_KEY` |
| Cursor CLI emits unparseable NDJSON | runner's JSON.parse fallback collects line as text | Lens output may fail JSON extraction → `dispatch.task.failed` with detail |
| `git clone` of PR head fails | prepareWorkdir() rejects | `dispatch.task.failed` with `reason: workdir-setup-failed` |
| Review timeout (>10 min) | cursor runner timer | SIGKILL the subprocess; `dispatch.task.failed` |
| NATS disconnect | Status iterator logs `disconnect` event | Auto-reconnect with backoff; launchd restarts on FATAL consumer-loop failure |
| Workdir disk pressure | OS-level monitoring (out of scope here) | Principal drains queue and `rm -rf ${ALPHA_WORKDIR_ROOT}` between dispatches |

---

## 15. Open Questions

| # | Question | Impact |
|---|---|---|
| 1 | Should the workdir survive `dispatch.task.failed` for post-mortem inspection? Currently `cleanup()` runs in `finally`. | Debug workflow |
| 2 | Should alpha publish `dispatch.task.progress` envelopes for each cursor `tool-call-started` event? Higher fidelity vs envelope volume. | Observability vs noise |
| 3 | Cursor's session caching (`--resume`) could amortise model context across lenses in the same dispatch. v1 ships fresh-session per lens. | Performance |
| 4 | When `cursor-agent` is unauthenticated, does the CLI exit non-zero with a stable error string? Some installs prompt interactively. | Failure detection |
| 5 | DeepArchitecture lens needs a path/extension predicate to avoid firing on trivial diffs. Same shape as sage's Security lens predicate. | Phase 5 design |
| 6 | Stack identity (cortex#112 Phase A `stack:` block) lands after this PR. Alpha's manifest is forward-compatible (optional fields), but the principal-supplied `stack_id` should appear in arc-rendered fragments once Phase A merges. | Forward-compat |
| 7 | Should alpha and sage share a single launchd `EnvironmentVariables` block (common org/data-residency) or stay independent? Convenience vs blast-radius. | Principal ergonomics |

Questions 1–5 do not block this PR. Questions 6–7 are forward-compatibility notes that resolve in later phases.

---

## 16. References

- cortex#70 — issue body (research findings reproduced in §2)
- cortex#91 / `docs/design-substrate-harness.md` (PR #92) — SessionHarness contract; alpha is a `bus-peer` substrate participant
- cortex#112 — Internet of Agentic Work synthesis; competing consumers (Q5), stack identity (Q1), NKey chain (Phase B), namespace extension (Q7)
- `docs/design-pi-dev-review-agent.md` — sage's design; this document mirrors its structure section-by-section
- `docs/design-arc-agent-bots.md` §3.2 — standalone-substrate install shape; updated alongside this PR
- `the-metafactory/sage` — reference implementation of a standalone bus-peer reviewer
- `the-metafactory/alpha` — reference implementation of the Cursor-substrate reviewer (scaffolded; not yet pushed)
- arc#117 — multi-backend `HostAdapter` rollout (`CursorHostAdapter` for skills is tracked there, separate from cursor-as-runtime-substrate covered here)

---

*This document is the design specification for the Cursor-substrate review agent. Implementation follows the phased plan in §12.*
