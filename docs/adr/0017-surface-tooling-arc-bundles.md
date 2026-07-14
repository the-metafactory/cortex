# ADR-0017 — Surface tooling distributed as arc bundles; Cortex core owns runtime + adapters

**Status:** accepted · **Date:** 2026-06-19 · **Refs:** ADR-0014 (capability-authorized agents), design-bot-packs.md, the marketplace building-block direction (#95)

> **Naming note (cortex#1905 / compass#116):** the tooling bundle named `metafactory-discord` throughout this ADR was **renamed to `metafactory-bundle-discord`** to conform to the `metafactory-bundle-<name>` component-repo-naming standard (compass PR #115). This ADR is left in its original wording as a matter of historical accuracy; read every `metafactory-discord` mention below as the bundle now named `metafactory-bundle-discord`.

## Context

Cortex today vendors each surface's *principal/agent tooling* inline — the Discord
CLI + its skill live at `src/cli/discord/` (CLI `discord.ts` + `lib/` + `skill/SKILL.md` + `Workflows/`).
More surfaces are coming (Mattermost, Slack, …), and the same shape would repeat:
a per-surface CLI + skills baked into the cortex monolith.

But there are **two distinct Discord concerns in the repo, and they are already decoupled**:

1. **The adapter** (`src/adapters/discord/`) — the live bot *presence*, woven into the
   bus / dispatch / surface-router. This *is* cortex's M7 surface; it is the runtime.
2. **The CLI + skills** (`src/cli/discord/`) — principal/agent *tooling* (post / read /
   role / threads, plus the wrapping skill). Nothing in cortex imports from it; it imports
   only its own `./lib/*` plus one shared helper (`common/config/config-path`). It is a
   self-contained unit whose only consumers are external (the `~/bin/discord` shim and
   agents via the skill).

We want surface tooling to be **modular, independently versioned, reusable outside
cortex, and distributable** — the marketplace building-block direction — without
destabilising the runtime.

## Decision

**Split the surface concern across two layers:**

- **Cortex core owns the runtime + the surface ADAPTERS** (live presence). Adapters stay
  in cortex — they are woven into the bus and are the M7 surface, not separable tooling.
- **Surface TOOLING (CLI + skills) is extracted into per-surface arc bundles.** The first
  is **`metafactory-discord`** (the Discord CLI + the existing skill + the new
  `fleet-admit` / `discord-role` / `discord-post` skills). Cortex **declares the bundle as
  a dependency** (`arc-manifest.yaml` `dependencies:`).

**Distribution:** repo-first. The bundle is a repository under the `the-metafactory` org,
`arc install`-able **from the git repo**. Registry publication (`arc install metafactory-discord`
by name) is a later step — we are NOT bundling/distributing it on the metafactory registry yet.

**Per-agent scoping:** which agent may invoke which skill is governed by cortex's
`allowedSkills` (cortex#710), not by what's installed. Luna → `fleet-admit` (trusted
executor); Pier → `discord-post` only (public surface, for #137); default-deny `Skill`
elsewhere. The public/trusted boundary (ADR-0015, the Pier gate) is enforced by the
grant, from one shared pack.

## Consequences

- Cortex shrinks: the Discord CLI source leaves the runtime repo; cortex consumes it as a
  dependency. The one shared helper (`config-path`) is vendored into the bundle (small,
  path-resolution only) so the bundle is standalone.
- Each future surface follows the same shape (`metafactory-mattermost`, …) — a clean,
  repeatable pattern instead of monolith growth.
- The bundle is reusable outside cortex (a PAI session can `arc install metafactory-discord`
  for the skills without running the daemon).
- A dependency edge is introduced (cortex → metafactory-discord). Until arc auto-resolves
  package dependencies on `arc install cortex`, the bundle is installed explicitly; the
  `dependencies:` declaration records the intent and is the seam to close.

## Alternatives considered

- **Keep everything in cortex (status quo).** Rejected: monolith growth, no reuse, every
  surface re-bakes its CLI into the runtime repo.
- **Extract the adapter too (surfaces as full plugins: adapter + CLI + skills per bundle).**
  Rejected *for now* — the adapter is deeply woven into the bus/dispatch/surface-router; a
  plugin adapter model is a much larger change. Deferred to a separate future ADR; this ADR
  extracts only the cleanly-decoupled tooling layer.
- **A skills-only bundle that wraps the cortex-resident CLI.** Rejected: leaves the CLI in
  the monolith and creates a "CLI must be on PATH" coupling between the bundle and cortex;
  shipping the CLI *with* the skills (they already live together at `src/cli/discord/`)
  keeps them versioned as one unit.
