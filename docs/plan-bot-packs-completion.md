# Plan: Bot Packs completion — bridge, install, Yarrow migration

**Status:** Executable handoff — written for a clean session with zero prior context
**Date:** 2026-06-12
**Tracking:** cortex#1021 (phases B-0..B-2 merged), pulse#37 (Yarrow / SOC demo)
**Design (normative):** `docs/design-bot-packs.md` (cortex main) — read §5/§6/§7/§8/§12 before any work
**Author:** Ivy, end of the B-0..B-2 autonomous run

---

## 0. State snapshot (verified 2026-06-12)

| Done | Where |
|---|---|
| SOC demo stack (validator, 19-block palette, Yarrow composer, standalone MM wiring, rehearsal 8/8 stub) | pulse v0.14.0, `examples/soc-demo/` |
| Bot-packs design, decision-complete | cortex `docs/design-bot-packs.md` (#1019) |
| cortex-brain/v1 protocol + per-task exec runner | cortex `src/brain/{protocol,exec-brain-runner}.ts` (#1024) |
| Hot `agents.d/` reload + derived capability catalog | cortex `src/cortex.ts` reconcile, `src/common/agents/capability-catalog.ts` (#1027) |
| `brain:` schema + BrainConsumer + boot/reload wiring | cortex `src/common/types/cortex-config.ts`, `src/bus/brain-consumer.ts` (#1033) |
| Daemon lifecycle: authed unix socket, supervision, drain, 4 MiB budgets | cortex `src/brain/daemon-brain-host.ts` (#1035) |
| `SurfacePrincipalGate` — implemented + tested, **NOT booted** (DenyAll default) | cortex `src/bus/surface-principal-gate.ts` |
| arc `CortexHostAdapter` — paths, detect, `supports("agent")` | arc `src/lib/hosts/cortex.ts` (arc#117 CLOSED) |

**Two tracks remain. Track B is the critical path to Yarrow-on-cortex.**

```
Track B (critical):  W-1 inbound reply-bridge ──► W-2 boot the surface gate ──► W-3 Yarrow pack (B-4)
Track A (parallel):  W-4 arc install hooks (B-3 finish) ──► `arc install yarrow` joins W-3
Independent:         W-5 SOC-demo pre-stage checklist (JC-owned env, unchanged)
```

---

## W-1 — Adapter inbound reply-bridge (`PrincipalReplySource`)

**Goal:** a live implementation of the `PrincipalReplySource` seam in
`src/bus/surface-principal-gate.ts` so a gate prompt posted to a surface
thread can receive the principal's reply.

**Mechanism (study first):**
- `SurfacePrincipalGate` renders prompts via the `dispatch.task.post` path and
  awaits a reply through the injected `PrincipalReplySource` (typed seam; only
  shipped impl is a test stub).
- Inbound surface messages already flow: `PlatformAdapter.attachInboundDispatch`
  (mattermost/discord/slack adapters) normalizes messages → dispatch envelopes.
  The bridge taps THAT flow: when an inbound message's channel/thread matches an
  OPEN gate's `response_routing`, route it to the gate instead of (or in
  addition to) chat dispatch.
- Identity: match `user_id` against the configured principal
  (`principal.mattermostId` / `discordId` in cortex config) — **identity-based,
  never message-text inference** (the pulse#47 lesson; same rule the gate's
  unit tests pin).

**Shape suggestion (validate against the adapters):** a small
`GateReplyRouter` registered with the adapters' inbound dispatch — open gates
register `(surface, channel, thread) → resolver`; first matching
principal-authored message resolves; non-principal messages are ignored (not
errors). Construct `SurfacePrincipalGate` in `src/cortex.ts` where
`DenyAllPrincipalGate` is currently built (search `DenyAllPrincipalGate` —
the honest comment there marks the spot), gated on: live adapter for the
surface AND configured principal platform id; otherwise keep DenyAll.

**Probes:** principal reply pass/fail; non-principal ignored; timeout → fail;
bus-only task keeps DenyAll; reload with open gate still cancels per B-2 drain.

## W-2 — Boot the gate (part of the same PR as W-1)

Flip the construction in `src/cortex.ts` (per-agent, where BrainConsumers are
built): `SurfacePrincipalGate` when bridge + principal id available, DenyAll
otherwise. Update the honest comments. Extend
`src/__tests__/cortex.agents-reload.test.ts` boot probes.

## W-3 — B-4: Yarrow pack migration (pulse#37)

**Goal:** Yarrow runs as a cortex bot pack; pulse's standalone MM wiring stays
for offline rehearsal only.

1. **New repo or pulse subdir `yarrow/`** (JC's call; default: new repo
   `the-metafactory/yarrow` per design §4 pack layout):
   - `arc-manifest.yaml` — `type: agent`, `targets: [cortex]`
   - `agent.yaml` → `agents.d/yarrow.yaml`: id `yarrow`, displayName
     "Yarrow — Pulse Composer", persona path, `runtime.mode: in-process`,
     `capabilities: [soc.compose.flow]`, `modelClass: frontier`,
     `brain: { kind: exec, run: "bun {pack}/brain/main.ts", lifecycle: daemon,
     secrets: [ANTHROPIC_API_KEY, VT_API_KEY], dispatch_capabilities: [] }`
   - `persona.md` — from pulse `examples/soc-demo/composer/SYSTEM_PROMPT.md`
2. **`brain/main.ts`** — speaks cortex-brain/v1 over the daemon socket:
   - reads `CORTEX_BRAIN_SOCKET_TOKEN` + socket path env; first line =
     `{v:1,type:"auth",token}`; then handles `hello`, `task`, `gate_verdict`,
     `shutdown`
   - per task: catalog (`buildCatalog`) → `compose()` → `validatePipeline()`
     re-check → `post` YAML+summary (+PNG ≤256 KiB inline or scratch path) →
     `ask_principal` ("Run this flow?") → on pass run `runPipeline` with
     `onActionStepEvent` → `post` per step → `result`
   - imports pulse as a library (`pulse` is arc-installed; import from the
     installed pack or depend on the repo) — the compose/validate/run code is
     unchanged, only the I/O shell is replaced
3. **Delete from the pulse demo path (keep for offline mode):**
   `MattermostThread` poller + `MMAckGateProvider` become unused in cortex
   mode — `run-demo.ts` stays as the standalone/rehearsal entry; note in
   README which mode is which.
4. **Install (hand-drop until W-4):** copy pack dir, write fragment into
   `~/.config/cortex/agents.d/`, `cortex creds issue yarrow` if daemon,
   `cortex agents reload`. JC provisions the MM bot identity + channel
   (design §6 — agent must NOT touch `cortex.yaml` / `~/.config/cortex/`
   except `agents.d/` + `personas/` drops).
5. **Acceptance (design §9 table):** scenario in MM thread → Yarrow posts
   flow + diagram → JC (principal-checked!) replies "run it" → per-step
   replies → artifact. This is the live probe that closes pulse ISA
   ISC-35..38 (DEFERRED-VERIFY) — update `pulse/ISA.md` Verification when done.

## W-4 — B-3 finish: arc install hooks (parallel track)

arc `src/lib/hosts/cortex.ts` exists (paths/detect/supports). Remaining per
its own header comment: **post-install side effects once arc exposes
per-adapter install hooks** —
1. arc: per-adapter post-install hook surface (or use existing
   `scripts.postinstall` convention) running `cortex agents reload` and
   `cortex creds issue <id>` (daemon packs) after artifact drop.
2. arc: `type: agent` manifest flow e2e — manifest → fragment + persona land
   in the adapter's `agentsDir`/`personasDir`; probe with a fixture pack.
3. Finish with `arc install yarrow` against the W-3 pack as the e2e test.
Check cortex#60 §6.2/§11 (design-arc-agent-bots.md) for the agreed shapes;
file work on the ARC repo following its conventions.

## W-5 — SOC demo pre-stage (JC-owned, independent of all tracks)

From pulse#37: MM env for the standalone demo (`MATTERMOST_URL/BOT_TOKEN/
CHANNEL_ID/OPERATOR_ID`), real-LLM rehearsal
(`ANTHROPIC_API_KEY=… bun examples/soc-demo/rehearse.ts` + refresh the README
table), Whois/MISP creds, backup recording. The talk does NOT wait on Tracks
A/B.

---

## Execution protocol (how this repo-set actually works)

- **SOPs:** compass dev-pipeline + worktree discipline. Worktrees:
  `git worktree add ../<repo>-<slug> -b feat/<slug> origin/main` then
  **`bun install`** (a fresh worktree without node_modules fails the pre-push
  smoke hook with phantom tsc errors).
- **Gates before every push:** `bun test` (full), `bunx tsc --noEmit`,
  `bash scripts/check-carveouts.sh` (cortex vocab ratchet — say "principal",
  never "operator"; it scans docs too).
- **Known flake:** cortex#1028-class — one rotating full-suite failure
  (CO-2 boot / api.test sqlite / fs.watch debounce). Re-run once; verify
  isolation; do not chase.
- **Review loop:** `SAGE_STACK=default sage dispatch the-metafactory/<repo>#<N>
  --org jc --post --wait 900` — ALWAYS via a harness-tracked background task,
  never shell `&` (the waiter dies with the shell). Sage posts duplicate
  reviews per dispatch (cortex#422) — dedupe by commit_id, take the latest.
  Per round: fix blockers + real importants, defer-with-issue the rest,
  disposition table comment, re-dispatch. Converge in ≤3 rounds.
- **Merging:** cortex base policy requires a non-author approval; the bot
  account self-authors, so merges happen on JC's explicit word via
  `gh pr merge --squash --delete-branch --admin`. Never `--admin` without his
  word in the session.
- **NATS down** (`CONNECTION_REFUSED` from sage/cortex):
  `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/ch.invisible.nats-server.plist`,
  verify `nc -z 127.0.0.1 4222`.
- **Key anchors:** `src/bus/surface-principal-gate.ts` (PrincipalReplySource
  seam), `src/cortex.ts` grep `DenyAllPrincipalGate` (boot site) +
  `startBrainConsumersForAgent` (per-agent wiring) + the agents.d reconcile,
  `src/brain/daemon-brain-host.ts` (`CORTEX_BRAIN_SOCKET_TOKEN`, hello,
  drain), `src/adapters/*/index.ts` (`attachInboundDispatch`),
  pulse `examples/soc-demo/` (compose/validate/run to wrap).

## Suggested order for one clean session

1. W-1 + W-2 (one cortex PR, review loop, JC merge)
2. W-3 pack skeleton + brain/main.ts (pulse or new repo; PR; JC provisions
   identity in parallel — ask him early, it's his only blocking input)
3. Hand-drop install → live acceptance run → close pulse ISA deferred ISCs
4. W-4 on arc whenever (can interleave); finish with `arc install yarrow`
5. Update cortex#1021 (close it — all phases done) + pulse#37 + memory files
