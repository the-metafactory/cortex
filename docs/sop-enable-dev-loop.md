# SOP — Enable the dev-loop on a stack (= declare `local` offerings)

**Status:** active
**Owner:** principal
**Audience:** a **principal** opting one of their **stacks** into the agentic dev-loop (`dev.implement` / `merge.approve` / `release.cut` / `code-review`).
**Authoritative detail:** [`CONTEXT.md`](../CONTEXT.md) §Capability offering / §Scope · [`docs/design-capability-offering.md`](design-capability-offering.md) §8 (CO-6) · [`docs/design-agentic-dev-pipeline.md`](design-agentic-dev-pipeline.md) (the dev-loop) · [`docs/iteration-dev-loop.md`](iteration-dev-loop.md) W5.1 · [ADR-0009](adr/0009-offerings-per-stack-no-shared-layer.md) (offerings are per-stack).

> **What this is — and what it replaces.** "Enable the dev-loop on a stack" used
> to be a bespoke recipe (hand-wire capabilities + JetStream streams + the
> approver — the W5.1 framing in [cortex#925](https://github.com/the-metafactory/cortex/issues/925)).
> CO-6 ([cortex#945](https://github.com/the-metafactory/cortex/issues/945), epic
> [#939](https://github.com/the-metafactory/cortex/issues/939)) **re-points** that
> onto the general **capability-offering** model: enabling the dev-loop is nothing
> more than **declaring the dev-loop capabilities as `local` offerings**. No new
> mechanism — the offering model (CO-1), the consumer wiring (CO-2), and the
> `cortex offer` CLI (CO-3) already deliver everything this SOP needs.

---

## Pre-flight

After reading this SOP, output:

```
SOP: enable-dev-loop | stack: {principal}/{slug} | offers: dev.implement, release.cut, code-review.{flavor} [, merge.approve] | scope: local | apply: {dry-run|--apply}
```

---

## The one idea

A **capability offering** is the provider-side triple `(capability, offer-scope,
accept-policy)` — the policy that elevates a held capability into *exposed work*
(CONTEXT.md §Capability offering). **Offer-scope `local` = the offering stack
only** — it binds to its own `local.{principal}.{thisstack}` subject. That is
*exactly* the scope the dev-loop wants: `dev.implement`, `merge.approve`, and
`release.cut` are **internal by nature** — you never let a stranger run dev, merge
your PRs, or cut your releases. So:

> **Enabling the dev-loop on a stack ≡ offering its capabilities at `--scope local`.**

This is the secure default of the offering model, not a special case
(design §2: *default-deny, opt-in-widen*; a capability not offered is `local`-only
already). Declaring the offering makes the intent **explicit, declarative, and
reviewable** in the stack's own config — and it is the same `cortex offer` leg
that widens `code-review` to `public` for the marketplace (CO-5), so the dev-loop
and the marketplace share one control plane.

---

## Step 1 — declare the dev-loop offerings

From the principal's machine, against the stack's config dir (or pass `--stack`
when the config-split dir holds more than one stack):

```bash
# dev agent — implement a slice (internal only)
cortex offer dev.implement  --scope local --config ~/.config/cortex/<slug>

# release agent — cut a release (internal only, principal-gated)
cortex offer release.cut    --scope local --config ~/.config/cortex/<slug>

# review lane — scope is the principal's call:
#   local      → review only your own stack's PRs
#   public     → the PR-review marketplace (CO-5; requires CO-7 hardening)
cortex offer code-review.typescript --scope local --config ~/.config/cortex/<slug>
```

Each command is **dry-run by default** — it prints the offerings edit + the
generated federation-config projection diff and touches nothing. Re-run with
`--apply` to write. The write is guarded exactly like `config-merge`: timestamped
backup → validate-the-composed-whole → write → re-compose-and-revalidate with
restore-on-failure.

Equivalently, edit `stacks/<slug>.yaml` `policy.offerings[]` by hand — `cortex
offer` is the ergonomic front-end, not a separate source of truth (ADR-0009: the
offering lives self-contained in the per-stack config):

```yaml
policy:
  offerings:
    - capability: dev.implement
      scopes: [local]
    - capability: release.cut
      scopes: [local]
    - capability: code-review.typescript
      scopes: [local]
```

A `local`-only offering carries **no** `accept` — `local` is *this* stack, so
there is nobody-within-tier to gate (CO-1 coherence; a stray `accept` on a
local-only offering is a validation error).

### `merge.approve` — offerable, but its consumer lives in pilot

You may also `cortex offer merge.approve --scope local`. Be aware of the honest
asymmetry: **cortex does not host a `merge.approve` consumer.** The approver-bot
(Ivy — the five-check merge gate) is a **pilot**-side component
(`docs/design-agentic-dev-pipeline.md` §Approver-bot; spec'd, not yet implemented
in cortex). Declaring the offering records the *intent* in the stack's config and
generates the federation projection, but no cortex-resident agent will claim a
`tasks.merge.approve` envelope today. Offer it when the approver is wired (W5.0 /
pilot); for now `dev.implement`, `release.cut`, and `code-review.*` are the
capabilities cortex *itself* consumes.

---

## Step 2 — the agent must HOLD the capability

An offering is the *exposure policy* over a capability an agent **holds**. The
agent in `agents[]` whose `runtime.capabilities[]` declares `dev.implement` (or
bare `dev`) / `release.cut` (or bare `release`) / `code-review.*` is the one whose
JetStream consumer binds. `cortex offer` validates (cross-block, on
`CortexConfigSchema`) that the offered capability is actually held by some agent
in the stack — you cannot offer a capability no agent provides.

The boot wiring is already in place (CO-2, `src/cortex.ts`): each dev-loop
consumer resolves its offering via `resolveOffering` and binds on the scope
prefixes `offeringSubjectPatterns` admits. With these offerings at `local`, the
bound subjects are **byte-identical** to the dormant-by-default boot — the
offering makes the intent explicit without changing a single subscribed subject.

---

## Step 3 — apply, restart, verify

```bash
# 1. Apply each offering (writes stacks/<slug>.yaml + a timestamped .bak)
cortex offer dev.implement  --scope local --config ~/.config/cortex/<slug> --apply
cortex offer release.cut    --scope local --config ~/.config/cortex/<slug> --apply
cortex offer code-review.typescript --scope local --config ~/.config/cortex/<slug> --apply

# 2. Confirm the exposure surface
cortex offer list --config ~/.config/cortex/<slug>

# 3. Restart the stack so the daemon re-composes config + re-binds consumers
arc upgrade Cortex     # or reload the stack's launchd plist
```

After restart, the boot log shows the dev-loop consumers **ready** (rather than
`DORMANT`) for the agents that hold the capabilities, e.g.:

```
cortex: dev.implement consumer ready for agent=<id> pattern=local.<principal>.<slug>.tasks.dev.implement
cortex: release consumer ready for agent=<id> capability=release.cut … PRINCIPAL-GATED, ALWAYS-HUMAN
```

(The exact readiness depends on the G-1111 runtime-subscription gate; a stack with
runtime subscriptions still disabled logs `DORMANT` — that is a runtime-enablement
concern, not an offering one.)

---

## Why this is the right shape (the re-point rationale)

| Bespoke W5.1 framing (#925) | CO-6 offering framing |
|---|---|
| Hand-wire capabilities + streams + approver per stack | `cortex offer <cap> --scope local` — one declarative leg |
| Enablement is a one-off recipe | Enablement is config the offering model already governs |
| Dev-loop has its own enablement path | Dev-loop is the **first internal customer** of the general model — same path as the public `code-review` marketplace, just at `local` scope |
| "Is the dev-loop on?" answered by reading wiring | Answered by `cortex offer list` |

The dev-loop being **dormant-by-default** is not an accident to be flagged on per
stack — it is the *correct* default of the offering model (default-deny → `local`,
then a deliberate widen). CO-6 makes "turn it on" a first-class, tooled act
instead of a bespoke recipe. See `docs/design-capability-offering.md` §8 (CO-6)
and `docs/iteration-dev-loop.md` W5.1.
