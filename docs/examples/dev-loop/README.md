# Operator-driven dev-loop — deployment template (#1206)

These are **deployed-config templates**, not repo source. They stand up the
in-process orchestrator agent **vega** (the principal's pilot — "Pilot" is the
orchestrator role, "vega" is the principal's instance/name for it) described in
[`docs/design-operator-driven-dev-loop.md`](../../design-operator-driven-dev-loop.md).

```
agents.d/vega.yaml      → {configRoot}/agents.d/vega.yaml
personas/vega.md        → {configRoot}/personas/vega.md
```

## What it does (S1)

When the **principal** posts `implement {repo}#{N}` (e.g. `@vega implement
cortex#1196`) in Discord, vega publishes a `tasks.dev.implement` dispatch
through the **stack's own runtime**. cortex derives
`local.{principal}.{stack}.tasks.dev.implement` and zone-routes it; the live
`dev` consumer claims it and opens a PR. The merge stays a **human gate**.

The command is **principal-gated, fail-closed**: only the principal's
authenticated Discord id is honored (PolicyEngine `authorIsPrincipal`). Every
other sender's command is ignored.

## Deploy

1. Copy `agents.d/vega.yaml` into your stack's `agents.d/` and
   `personas/vega.md` into `personas/`.
2. Fill the `<REPLACE_ME>` markers in `vega.yaml` (vega's own Discord bot
   token + guild/channel ids). The bot must be a member of the guild where the
   principal will issue commands.
3. Ensure the stack has a live `dev` agent (`agents.d/dev.yaml`, declaring
   `dev.implement`) — that is what claims the dispatch.
4. Reload: `cortex agents reload` (the daemon hot-reloads the fragment and
   synthesizes the `dev.orchestrate` catalog entry for vega).

## How the wiring works

- `runtime.capabilities: [dev.orchestrate]` is the routing **marker** the
  dispatch-handler reads to activate the orchestrator-command branch for **this
  agent only**. The gate is agent-AGNOSTIC — it routes on the capability, NOT on
  the id — so any agent declaring `dev.orchestrate` (here, `vega`) is the
  dispatch target. No consumer subscribes to it — vega publishes `dev.implement`;
  it never runs `claude -p`.
- The dispatch envelope is built by the `dev-events` builder and published via
  `runtime.publish()` — wire-protocol-native, no hand-spliced subject, no raw
  connection, no hand-signing (the [[use-stack-primitives]] rule).

## Scope

S1 = command → dispatch only. The review leg (S2) and the fix-cycle + principal
merge gate (S3) are separate slices. The merge is always human.
