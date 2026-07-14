# Design — Decouple the Discord CLI + skills into the `metafactory-bundle-discord` bundle

**Status:** plan · **Date:** 2026-06-19 · **ADR:** [0017](adr/0017-surface-tooling-arc-bundles.md) · **Drives:** the epic below

## Goal

Move cortex's Discord *tooling* (CLI + skills) out of the runtime repo into a standalone,
arc-installable bundle under `the-metafactory` org, and have cortex consume it as a
dependency — so surface tooling is modular + reusable, and we can use it to manage
onboarding in the metafactory community (Luna runs `fleet-admit`; Pier surfaces).

Cortex keeps the live Discord **adapter** (`src/adapters/discord/`); only the **tooling**
(`src/cli/discord/`) moves.

## Extraction facts (verified)

- Nothing in cortex imports from `src/cli/discord/` → removing it breaks no cortex internals.
- `src/cli/discord/` imports only its own `./lib/*` **plus one** shared helper:
  `lib/config.ts → ../../../common/config/config-path`. That helper (a `~/.config/cortex`
  path resolver) is vendored into the bundle. No other coupling.
- `src/cli/discord/skill/SKILL.md` + `Workflows/` already exist — the wrapping skill ships
  with the CLI as one unit.

## Target repo: `the-metafactory/metafactory-bundle-discord`

```
metafactory-bundle-discord/
  arc-manifest.yaml        # name: discord, namespace: metafactory, type: skill/bundle, provides
  cli/                     # the extracted discord CLI (discord.ts + lib/, config-path vendored)
  skills/
    discord/SKILL.md       # the existing CLI-wrapping skill (post/read/role/threads)
    fleet-admit/SKILL.md   # NEW — the two-tier admission procedure
  bin/discord              # the PATH shim arc installs (replaces cortex's ~/.local/bin/discord)
  README.md  CLAUDE.md  package.json  tests
```

Skills provided:

| Skill | Wraps | Granted to |
|---|---|---|
| `discord-post` / `discord-read` | `discord post` / `read` | any agent that speaks on Discord (Pier *surfacing*, #137) |
| `discord-role` | `discord role add/remove` | role-grant capability (Luna) |
| `fleet-admit` | `discord role add community-fleet` + `cortex network admit` | the composed admission procedure (Luna) |

## Distribution (repo-first)

- **Now:** `arc install <git-url of metafactory-bundle-discord>` — install from the repo. NOT on
  the metafactory registry yet.
- **Cortex dependency:** cortex `arc-manifest.yaml` `dependencies:` declares
  `metafactory-bundle-discord`. (Confirm whether arc auto-resolves package deps on
  `arc install cortex`; if not, install the bundle explicitly + record the intent.)
- **Later:** registry publication → `arc install metafactory-bundle-discord` by name.

## Onboarding wiring (the payoff)

- Grant `allowedSkills` per agent: **Luna → `fleet-admit`** (trusted executor),
  **Pier → `discord-post`** only (public surface), default-deny elsewhere.
- Flow: newcomer → Pier (guides, public, zero authority) → surfaces a passive request in
  `#assistant-fleet-onboarding` → **principal** tells Luna "admit them" → Luna runs
  `fleet-admit`. Pier never pings Luna (Luna trusts no bots; Pier isn't a principal).

## Slices (epic)

- **S0** — this ADR + design doc (the decision). *(this PR)*
- **S1** — create `the-metafactory/metafactory-bundle-discord`; extract `src/cli/discord/` (CLI +
  existing skill) into it; vendor `config-path`; arc-manifest; tests pass standalone;
  `arc install` from repo works.
- **S2** — cortex consumes the bundle: remove `src/cli/discord/` from cortex; `~/.local/bin/discord`
  comes from the bundle; cortex `arc-manifest` declares the dependency; cortex build + tests
  green without the CLI. *(the decoupling)*
- **S3** — add `fleet-admit` + `discord-role` / `discord-post` skills to the bundle.
- **S4** — wire onboarding: install the bundle, set `allowedSkills` (Luna→`fleet-admit`,
  Pier→`discord-post`), verify the admit flow end-to-end in the community.

Each slice: build → adversarial review → gate → merge (auto-dev SOP). PR merges
dual-announce to `#cortex` on both grove + metafactory-community.
