# Design: Bot Packs — hot-loadable agent brains for cortex

**Status:** Draft for review
**Date:** 2026-06-11
**Author:** Ivy (with JC), triggered by the Yarrow / SOC-demo composer (pulse#37)
**Extends:** `design-arc-agent-bots.md` (cortex#60) — this doc does NOT replace it
**Related:** arc#117 (HostAdapter), pulse v0.14.0 `examples/soc-demo/` (the first candidate pack)

---

## 1. Problem

cortex#60 solved agent **declaration**: identity, persona, presence, and
capabilities live in `agents.d/` fragments that arc can install. What it left
hardwired is agent **behavior**. Today the brain is a closed enum:

```typescript
// review-engine.ts — the entire universe of behaviors
engine: "sage" | "assistant"
```

Every behavior cortex can host is compiled into cortex: the review pipeline
(CC session), the sage subprocess runner, the chat dispatch handler. Adding
Yarrow — whose loop is *scenario → compose → validate → principal-ack →
execute pulse pipeline → per-step thread replies* — means writing a new
runner inside cortex, a new engine enum value, a release of cortex. The next
bot means doing it again.

JC's requirement: **bots are written and configured outside cortex and just
installed. Cortex handles input/output and fleet integration.** Cortex must
never need modification to host a new bot.

## 2. First principles — what is a bot, irreducibly?

| Part | What it is | Who must own it |
|---|---|---|
| **Identity** | name, avatar, platform tokens, NATS creds, signing trust | **Cortex** — it's the fleet's identity and key custodian (M3) |
| **Presence** | which surfaces it listens/speaks on (MM, Discord, Slack, bus) | **Cortex** — adapters already normalize all three platforms |
| **Capabilities** | what it offers the fleet (`soc.compose.flow`) | **Cortex catalog**, declared by the pack |
| **Policy & sovereignty** | who may invoke it, what models it may touch, blast radius | **Cortex** (M6) — never the bot's own claim |
| **Brain** | the function from inbound events to effects | **The pack** — this is the only part that is genuinely the bot |
| **State** | scratch space, caches | The pack, in a cortex-assigned scoped dir |

Everything except the brain is hosting, and cortex already does it
per-agent via config. The design problem reduces to one question: **what is
the seam between cortex and an externally-authored brain?**

## 3. The seam decision

Three candidate boundaries:

**(A) In-process plugin (dynamic `import()`).** Rejected. Cortex's process
holds every bot token, every NATS credential, and the stack signing key. A
pack's code in that process means one malicious or buggy pack owns the
fleet — the exact inversion of the governed-action work (pulse P-700..702)
and the diplomatic-pouch posture (P-703). Hot-reload of ESM modules is also
leaky (module cache, orphaned timers). In-process is how we'd get a
supply-chain story written about us.

**(B) Subprocess speaking a typed protocol.** Cortex spawns the pack's
declared command; they speak JSONL over stdio. Precedent already in-tree:
`sage-runner.ts` IS this pattern (spawn binary, parse verdict block) — just
specialized to reviews. Generalize it.

**(C) Standalone daemon on the bus.** The pack runs as its own process with
its own scoped NATS creds (cortex#60 A.2 `cortex creds issue`); cortex only
bridges presence surfaces ↔ envelopes. Already half-exists:
`runtime.mode: "standalone"`.

**Decision: B and C are one contract at two lifecycles.** The brain speaks
**envelopes in, effects out**; whether cortex spawns it per task (B) or
supervises it as a daemon (C) is a manifest field, not a different
interface. (A) is rejected for third-party packs — process isolation *is*
the sovereignty story. Builtin engines (`brain.kind: builtin` — assistant,
sage) remain in-process by definition; that is a trust statement about
first-party code, not a loophole.

## 4. The Bot Pack

An arc package, `type: agent` (extends the cortex#60 manifest):

```
yarrow/
  arc-manifest.yaml        # type: agent, targets: [cortex]
  agent.yaml               # → installed to ~/.config/metafactory/cortex/agents.d/yarrow.yaml
  persona.md               # → ~/.config/metafactory/cortex/personas/yarrow.md
  brain/
    main.ts                # the behavior — any language, any framework
  README.md
```

`agent.yaml` gains one new block (the only schema change in this design):

```yaml
id: yarrow
displayName: "Yarrow — Pulse Composer"
persona: ../personas/yarrow.md
trust: []
presence:
  mattermost: { enabled: true, ... }     # token injected by cortex secret store, not in the fragment
runtime:
  mode: in-process                        # unchanged semantics for builtin engines
  capabilities: [soc.compose.flow]
  modelClass: frontier
  sovereignty: selective
  brain:                                  # ← NEW
    kind: exec                            # builtin | exec
    run: "bun {pack}/brain/main.ts"       # {pack} expands to the arc install dir
    protocol: cortex-brain/v1
    lifecycle: daemon                     # per-task | daemon
    secrets: [VT_API_KEY]                 # principal approves at install; injected as env
    maxRestarts: 3
```

`kind: builtin` keeps today's `engine: sage|assistant` behavior — existing
agents are valid unchanged (`brain` absent ⇒ builtin ⇒ engine resolution as
today). `kind: exec` is the new seam.

## 5. The brain protocol — `cortex-brain/v1`

JSONL, newline-delimited, one JSON object per line. Same grammar for both
lifecycles; per-task uses stdin/stdout, daemon uses a cortex-assigned Unix
socket (stdio kept for logs).

**Cortex → brain (events):**

```jsonc
{ "v": 1, "type": "hello",   "agent": "yarrow", "persona": "…",
  "protocol": "cortex-brain/v1" }                                          // daemon handshake — host-authoritative identity; per-task brains get persona on task instead
{ "v": 1, "type": "task",    "task_id": "…", "capability": "soc.compose.flow",
  "payload": { /* envelope payload */ },
  "source": { "surface": "mattermost", "channel": "…", "thread": "…", "user": "…" } }
{ "v": 1, "type": "message", "task_id": "…", "text": "…", "user": "…" }   // follow-up in an open task's thread
{ "v": 1, "type": "gate_verdict", "task_id": "…", "gate": "principal-ack",
  "verdict": "pass", "principal": "…", "notes": "run it" }                                   // answer to ask_principal
{ "v": 1, "type": "cancel",  "task_id": "…" }
{ "v": 1, "type": "shutdown", "deadline_ms": 5000 }                        // drain signal (hot-swap)
{ "v": 1, "type": "effect_rejected", "task_id": "…", "effect": "dispatch",
  "reason": { "kind": "wont_do", "detail": "capability outside manifest" } } // cortex refused a brain effect — the brain decides how to degrade
```

**Brain → cortex (effects):**

```jsonc
{ "v": 1, "type": "post",         "task_id": "…", "text": "…",
  "attachment": { "filename": "flow.png", "b64": "…" } }                   // cortex posts to the task's surface/thread
{ "v": 1, "type": "ask_principal", "task_id": "…", "gate": "principal-ack",
  "prompt": "Run this flow?" }                                             // cortex renders the gate, enforces the PRINCIPAL
{ "v": 1, "type": "dispatch",     "task_id": "…", "capability": "soc.triage.email",
  "payload": { … }, "sovereignty": { "model_class": "local-only" } }       // fleet work — cortex publishes the myelin envelope
{ "v": 1, "type": "result",       "task_id": "…", "status": "complete",
  "summary": "…" }                                                         // closes the task; cortex publishes lifecycle envelope
{ "v": 1, "type": "result",       "task_id": "…", "status": "failed",
  "reason": { "kind": "cant_do" | "not_now" | "wont_do", "detail": "…" } } // typed refusal — maps 1:1 onto the dispatch failure taxonomy
{ "v": 1, "type": "log",          "level": "info", "text": "…" }
```

Properties that make this the right shape:

1. **Capability injection at the process boundary** — the pattern pulse
   actions use (`requires: ["fetch"]`, runtime injects), lifted one level.
   The brain never sees a platform token, a NATS credential, or another
   agent's identity. It *asks* for effects; cortex *performs* them under
   policy. A brain cannot post to a channel it wasn't addressed from,
   cannot dispatch a capability its manifest doesn't allow, cannot answer
   its own gate.
2. **Gates are host-enforced.** `ask_principal` routes through cortex's gate
   rendering with the principal check cortex already knows how to do — the
   Yarrow lesson (sage blocker, pulse#47: any channel member could say "run
   it") is solved once, in the host, for every future bot.
3. **Surface-agnostic.** The brain sees `source.surface` only as metadata.
   Yarrow on Mattermost today, Discord tomorrow — zero brain changes;
   cortex's adapters own the mapping both ways.
4. **Language-agnostic.** `run` is any argv. Bun/TS is the house style;
   nothing in the protocol requires it.
5. **Refusals are typed, not flattened.** `result.status: failed` carries
   `reason.kind: cant_do | not_now | wont_do` (brain side; host-emitted
   refusals may additionally carry `policy_denied | compliance_block`,
   and `not_now` may carry `retry_after_ms`) — the same taxonomy the
   dispatch layer already speaks — and cortex refusing a brain's effect
   comes back as `effect_rejected` with the same kinds. B-1 must not
   re-flatten the distinction sage-runner Phase 1 flattened.
6. **Sovereignty in `dispatch` is downgrade-only.** The manifest is the
   ceiling cortex enforces; a brain's `sovereignty` field may only TIGHTEN
   it (e.g. request `local-only` although `any` is allowed), never loosen.
   Policy is never the bot's own claim (§2).

Protocol contract details (the part implementations will cite):

- **`gate_verdict` carries the HOST-RESOLVED principal**, not whatever was
  typed in a chat thread. The brain must never infer a verdict from
  `message` text — the host performs the principal check (the pulse#47
  lesson) and only then forwards `gate_verdict`.
- **`task_id` correlation is enforced host-side.** Every effect's
  `task_id` must belong to the set of tasks currently owned by THIS brain
  instance; unknown or foreign ids are refused with `effect_rejected`
  (`wont_do`). A brain cannot post into a sibling's thread by guessing.
- **Persona delivery:** per-task brains receive `persona` on the `task`
  event; daemons receive it once in a `hello` handshake event at start.
- **`lifecycle: per-task` means alive until `result`,** not
  spawn-read-exit — long tasks emit many `post`s before closing.
- **Backpressure is host-side** for both lifecycles: cortex stops
  delivering past `maxConcurrent` (the BrainConsumer mirrors
  ReviewConsumer's pull semantics); brains never need to self-throttle.
- **Version tolerance:** cortex drops-and-logs unknown brain→cortex event
  types; brains MUST ignore unknown cortex→brain event types. That is the
  v1 forward-compat rule that lets B-2 add events without a protocol bump.
- **Attachments are capped at 256 KiB** inline (`b64`); anything larger is
  written by the brain to its scratch dir and referenced by path
  (`attachment: { filename, path }`), which cortex reads and uploads.
- **Vocabulary note:** effect/gate names use *principal* (`ask_principal`,
  `principal-ack`) per vocabulary migration 0002 R1/R2 — settled here so
  B-1 doesn't re-litigate it. `gate_verdict.verdict` reuses the existing
  gate vocabulary (`pass | fail`); aligning with the governance verdict
  enum is a B-1 audit item.

## 6. Routing: how a message reaches a brain

Already mostly built. `PlatformAdapter.attachInboundDispatch` normalizes
inbound messages → envelopes on `local.{principal}.{stack}.tasks.@{agent}.chat`.
Extend the dispatch layer with one rule:

> If the target agent's `brain.kind == "exec"`, deliver the envelope to the
> brain runner (spawn or socket) instead of the builtin chat/review
> pipeline.

The existing `ReviewConsumer` shape (pull consumer, `maxConcurrent`
backpressure, nak taxonomy, sovereignty enforcement, signature
verification) generalizes to a `BrainConsumer` — same skeleton, the
`pipelineRunner` slot becomes the protocol bridge. `cant_do / not_now /
wont_do` failure vocabulary maps 1:1 onto brain exit codes / error events.

## 7. Hot-loading

The process boundary makes this almost boring — no module-cache exorcism:

1. **Install/upgrade:** `arc install yarrow` drops the pack into
   `~/.local/share/metafactory/arc/repos/yarrow/`, writes `agent.yaml` into
   `agents.d/`, runs `cortex creds issue yarrow` (A.2) when
   `lifecycle: daemon`.
2. **Detect:** the cortex#60 A.1 watcher on `agents.d/` (plus
   `cortex agents reload` / SIGHUP) fires a registry rebuild. **This design
   makes A.1 load-bearing — it should ship first.**
3. **Swap with drain:** registry entries get a generation counter. On
   reload: new generation starts accepting; old generation's brain gets
   `shutdown` with a deadline, in-flight tasks drain (`maxConcurrent`
   already tracks them), then the old process is killed. Per-task brains
   need no drain at all — next spawn uses the new code.
4. **Supervision (daemon):** cortex restarts crashed brains up to
   `maxRestarts`, then marks the agent degraded and surfaces it
   (`agent.online` presence envelope already exists for exactly this).
5. **Open gates across a swap:** drain waits for open `ask_principal`
   gates up to the drain deadline; past it the gate is CANCELLED — cortex
   posts a visible notice in the task's thread ("brain was upgraded;
   re-trigger the request") and closes the task `failed/not_now`. No
   verdict is ever forwarded to a generation that didn't open the gate.
6. **`shutdown` escalation:** deadline passes → SIGTERM; +5 s grace →
   SIGKILL. Mirrors the existing daemon supervision shape.

Identity, presence connections, and tokens stay up across a brain swap —
the MM websocket/poller never blinks; only the brain process is replaced.
That is the practical meaning of "hot".

## 8. Security model

- **Brains are untrusted by default.** They run as separate OS processes
  with: the task payload, the persona text, a scoped scratch dir, a minimal exec environment (PATH, HOME, LANG, scoped
  TMP/scratch), and ONLY the secret env vars named in `brain.secrets` (shown to the principal at install
  time — same consent shape as arc hook installation).
- **No ambient fleet credentials.** Per-task brains get none. Daemon brains
  get their own scoped NATS creds (A.2) — addressable, revocable
  (`cortex creds revoke yarrow`), never the stack key.
- **Policy stays in cortex.** M6 trust lists, capability gates,
  `modelClass` sovereignty enforcement, envelope signing (M3) all happen on
  the cortex side of the seam. A brain emitting `dispatch` for a capability
  outside its manifest is refused with `wont_do` — same fail-closed posture
  as pulse's enforcement gate.
- **Resource caps** (v1: timeouts + maxConcurrent + maxRestarts; later:
  rlimits/containers) are host-side manifest fields.

## 9. Yarrow as the first pack (acceptance test)

Yarrow exercises every hard case the protocol must support, which is why it
should be the proving migration:

| Yarrow needs | Protocol element |
|---|---|
| Reply in-thread with YAML + PNG | `post` with attachment |
| Principal "run it" with host-side check | `ask_principal` / `gate_verdict` |
| Long-running execution with progress | multiple `post`s per task (maps from pulse `onActionStepEvent`) |
| Frontier-A self-disclosure before composing | first `post` of every task |
| Fleet sub-tasks — pulse pipelines containing `agent:` steps route their dispatch through the hosting brain | `dispatch` with downgrade-only sovereignty |

Migration: `pulse/examples/soc-demo/run-demo.ts` splits — the
`MattermostThread` poller and `MMAckGateProvider` are **deleted** (cortex
owns I/O and gates), `compose/validate/runPipeline` becomes
`yarrow/brain/main.ts` behind the protocol. The standalone mode stays for
offline rehearsal (`bun run-demo.ts` keeps working without a cortex).

## 10. What this is NOT

- Not a replacement for builtin engines — sage/assistant stay builtin
  (`brain.kind` defaults preserve them); migrating sage to a pack is a
  someday-option, not a goal.
- Not in-process plugins — rejected permanently (§3).
- Not a new bus protocol — brains that want raw NATS run `lifecycle: daemon`
  with scoped creds and speak myelin like any fleet member; the brain
  protocol is the *low-floor* option, not a wall.
- Not arc#117 — the HostAdapter work is a dependency for `arc install`
  ergonomics, but packs can be hand-dropped into `agents.d/` + pack dir
  before it lands.

## 11. Phasing

| Phase | Scope | Depends on |
|---|---|---|
| **B-0** | Finish/verify cortex#60 **A.1** (`src/common/config/watcher.ts` + fragment-watcher tests already exist in-tree — audit what remains vs. wire-up) + `cortex agents reload`; derive `capabilities[].provided_by` from agent fragments (removes the manual catalog cross-edit) | — |
| **B-1** | `brain:` schema block + `cortex-brain/v1` per-task exec: NEW sibling `exec-brain-runner.ts` modeled on `sage-runner.ts` (sage-runner itself untouched — it carries cortex#888/917/920 history; migrating sage onto the generic runner is a later option, not a B-1 goal); `BrainConsumer` from the `ReviewConsumer` skeleton | B-0 |
| **B-2** | Daemon lifecycle: socket transport, supervision, drain-on-reload, `ask_principal`/gate bridge, attachments | B-1 |
| **B-3** | `arc install <pack>` end-to-end (cortex#60 A.2/A.3, arc#117) | arc#117 |
| **B-4** | Yarrow pack migration — acceptance test for the whole seam | B-2 (B-3 optional — the hand-drop install path is the `cortex install-bot <path>` wrapper from design-arc-agent-bots.md §11) |

B-0..B-2 are cortex-internal and unblock everything; the SOC demo itself
does NOT wait for any of this (standalone wiring shipped in pulse v0.14.0
carries the talk; Yarrow-as-pack is the post-talk consolidation).

## 12. Decisions on the open questions (JC, 2026-06-11)

1. **Daemon transport: socket for protocol, stdio for logs.** Confirmed.
2. **Secrets v1: env injection with install-time consent.** Confirmed.
   Secret-store indirection (brains request decryption per use) stays a
   v2 candidate.
3. **Whole-message `post`s.** Confirmed for v1; streaming partials are a
   protocol-tolerant addition later (new event type — covered by the
   forward-compat rule in §5).
4. **Capability versioning: punt to the offering work (cortex#939),**
   with one v1 bridge rule: a pack release that CHANGES a capability's
   contract MUST publish it under a new capability id
   (`soc.compose.flow.v2`), never mutate the meaning of an existing id.
   Deterministic, zero schema work, and consumers never get silently
   re-contracted.
5. **Per-task attachment budget: 4 MiB total** (inline + scratch-path
   uploads combined), host-enforced. Over budget → `effect_rejected`
   with `wont_do` (permanent for that task — the brain must summarize or
   link instead of re-trying the same payload).
