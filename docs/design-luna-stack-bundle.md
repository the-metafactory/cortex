# Design Spec — the Luna-Stack bundle (Phase 2: stand up a whole Luna stack)

**Status:** draft + validated prototype
**Owner:** principal (Andreas)
**Audience:** maintainers building the Phase-2 one-install stack stand-up, and reviewers of the prototype bundle.
**Lineage (design-process SOP):** `design-bootstrap-luna.md` (DD-1 runbook-first, DD-2 then-bundle, DD-4 solo/local/simple-bus, DD-5 Discord-first) → this spec → the validated prototype at `~/Developer/metafactory-bundle-luna-stack-proto/`.
**Grounds on (verified, not asserted):** `metafactory-bundle-luna-light/` (the Phase-1 exemplar), `cortex/arc-manifest-pier.yaml` + `agents.d/pier.yaml` (the surface-bound agent exemplar), `cortex/src/cli/cortex/commands/{stack,provision-stack,quickstart,quickstart-lib}.ts` (the actual CLI surface), `arc/src/lib/{validate-manifest,repo-name}.ts` + `arc/src/types.ts` (the validator), `arc/docs/skill-repo-migration-spec.md` (naming grammar + manifest contract).

---

## 1. What the bundle is

Luna-Stack is **luna-light's bigger sibling.** Where luna-light ships a persona +
agent fragment onto a stack you *already run*, Luna-Stack's install **stands up
the whole stack**: it scaffolds a config-split cortex stack, provisions the
signing seed, binds the Discord surface, and boots the daemon — so one
`arc install` plus a bot token plus a slug gives you a responding `@luna` on
Discord. It is the Phase-2 target of `design-bootstrap-luna.md` §2: steps 3–5 of
the bootstrap walkthrough collapse into one install, leaving the operator only
the §4 manual edge (creating the Discord app) and "say hi".

It keeps luna-light's shape — an in-process cortex agent (persona + `agents.d`
fragment) that shares the stack's bus identity and mints no credentials of its
own — and adds one thing: an install-time **bootstrap hook** that drives the
cortex CLI.

### Name + class (recommendation, with justification)

**Recommended: `metafactory-cortex-agent-luna-stack`, manifest `type: agent`.**

The choice is between `metafactory-bundle-luna-stack` and
`metafactory-cortex-agent-luna-stack`. The class-choice rule
(`skill-repo-migration-spec.md` §3.1) is mechanical:

- `metafactory-bundle-<name>` is for **CLI-led or multi-skill *cross-app*
  collections** (e.g. `metafactory-bundle-discord`, which ships a `discord` CLI
  used across apps). Luna-Stack is neither: it targets **only cortex**, and its
  **lead artifact is the persona + fragment** — the postinstall orchestration is
  lifecycle glue, not a separately-installable CLI. So `bundle` does **not** fit
  by the rule.
- `metafactory-cortex-agent-<name>` is the **app-coupled agent class** — a
  bundle inseparable from cortex's runtime and CLI. That is exactly Luna-Stack
  (it drives `cortex stack create` / `cortex quickstart`). It also keeps it
  sorting adjacent to its documented siblings — the shipped `metafactory-cortex-
  agent-escort` and `metafactory-cortex-agent-luna-light` (per
  `bundle-blueprints.md`).

On the **manifest `type`**: keep `type: agent` for v0.1.0. It reuses the proven
pier/luna-light schema (arc validates it today), and the orchestration is a
`lifecycle` hook — the same way luna-light runs a reload hook while declaring
`bash.allowed: false` for the agent. `process` is the candidate **upgrade** (it
exists in arc's `ArtifactType`) if the orchestration ever outgrows the agent
shape, but arc's `process` type carries extra pulse-process requirements this
bundle does not need — so it is deferred, not adopted (matches
`design-bootstrap-luna.md` open Q1: "start `agent`; propose `process` if
postinstall outgrows it").

> **Prototype-dir caveat.** The validated skeleton lives in a dir named
> `metafactory-bundle-luna-stack-proto` (per the task), so its manifest `name`
> is `luna-stack-proto` to satisfy arc's §4.2 name-derivation *in that dir*. The
> shipping repo is `metafactory-cortex-agent-luna-stack` / `name: luna-stack`.
> See §7 finding (F4): arc's `toStrictName` does not know the
> `metafactory-cortex-agent-` prefix, so on the real repo the derivation guard
> does not fire and `name: luna-stack` passes anyway.

## 2. The manifest shape

Verified against `arc validate` (passes). Full source:
`~/Developer/metafactory-bundle-luna-stack-proto/arc-manifest.yaml`.

| Field | Value | Why |
|---|---|---|
| `schema` | `arc/v1` | required literal |
| `type` | `agent` | reuse the proven schema; `process` deferred (§1) |
| `targets` | `[cortex]` | single-target install into cortex HostAdapter |
| `identity.id` | `luna` | routes as `@luna` (the reference assistant) |
| `provides.files` | **LIST** of `{source, target}` | drops `personas/luna.md` + `agents.d/luna.yaml` (arc `types.ts:420` — a list, never a map; pier's map form is legacy) |
| `dependencies` | `cortex >=6.10.0`, `metafactory-cortex-adapter-discord >=0.1.0` | read **by name** for the first-party load exemption (cortex's own loader lane) |
| `depends_on.packages` | `{name, repo}` for the discord adapter | the arc **auto-install** contract (cortex#2028) — arc clones + installs it on `arc install luna-stack` |
| `capabilities` | fs read `~/.config/cortex`, `network: []`, `bash.allowed: false`, `secrets: []` | describes the **agent** (Luna reads her own config, rides the stack bus identity). The install-time chain is a *lifecycle hook*, a separate axis — same modeling as luna-light |
| `lifecycle.preinstall` | `scripts/preinstall-gate.sh` | cortex-version + `LUNA_BOT_TOKEN` gate |
| `lifecycle.postinstall` | `scripts/postinstall-bootstrap.sh` | the stand-up orchestration |

Discord binding lives in `agents.d/luna.yaml`'s `presence.discord` (pier-style,
DD-5), with every id a resolve-at-install `__LUNA_*__` placeholder — no live
token or snowflake is ever committed (compass#84 / L2). An unset value fails
SOFT (surface disabled, stack still boots), matching pier.

## 3. The postinstall orchestration (the exact chain)

**Strategy: prefer `cortex quickstart`; hand-stitched chain as documented
fallback.** The key grounding discovery: `cortex quickstart`
(`src/cli/cortex/commands/quickstart.ts`, cortex#2094) already **is** the
scripted stand-up chain — one idempotent, env-contract-driven command that does
preflight → validate env → write nats conf → `cortex stack create` → patch the
surfaces/stack/system configs (the Discord binding) → provision the signing seed
→ (re)start services → healthy-boot gate. It is Discord-first via
`--surface discord` (default; cortex#2164), and re-runnable without damage. This
is what `design-bootstrap-luna.md` §3 anticipated as "the bundle's non-
interactive install spine." So the bundle **rides quickstart** rather than
re-implementing a fragile chain.

**Path A (preferred) — map `LUNA_*` → quickstart's `CTX_*` contract and exec:**

```bash
export CTX_PRINCIPAL=$LUNA_PRINCIPAL   CTX_SLUG=$LUNA_SLUG
export CTX_NATS_PORT=$LUNA_NATS_PORT   CTX_NATS_MON=$LUNA_NATS_MON
export CTX_GUILD_ID=$LUNA_GUILD_ID     CTX_CHANNEL_ID=$LUNA_CHANNEL_ID
export CTX_LOG_CHANNEL_ID=${LUNA_LOG_CHANNEL_ID:-$LUNA_CHANNEL_ID}
export CTX_MY_DISCORD_ID=$LUNA_MY_DISCORD_ID
export CTX_DISCORD_TOKEN=$LUNA_BOT_TOKEN     # gates success; never echoed
cortex quickstart --surface discord
```

The `CTX_*` required contract is verified from `quickstart-lib.ts`:
`CTX_PRINCIPAL, CTX_SLUG, CTX_NATS_PORT, CTX_NATS_MON, CTX_GUILD_ID,
CTX_CHANNEL_ID, CTX_LOG_CHANNEL_ID, CTX_MY_DISCORD_ID` + secret
`CTX_DISCORD_TOKEN` (gates) + optional `CLAUDE_CODE_OAUTH_TOKEN`.

**Path B (fallback / reference) — the discrete chain quickstart wraps**, verified
against `stack.ts` + `provision-stack.ts` (these are the real command
signatures):

```bash
# 1. Scaffold, born-aligned, --agent luna (not the generic `assistant` default)
cortex stack create $LUNA_SLUG --principal $LUNA_PRINCIPAL --agent luna --apply
# 2. Provision the signing seed (solo needs only the seed, not the account tree)
arc upgrade cortex        # OR: cortex provision-stack generate $LUNA_PRINCIPAL \
                          #        --seed-path ~/.config/nats/$LUNA_SLUG.nk \
                          #        --stack-id $LUNA_PRINCIPAL/$LUNA_SLUG
# 2b. SIMPLE-BUS (#2182 gap): clear nats.credsPath in system.yaml for anonymous
#     local-bus connect. NO --simple-bus flag exists yet (see F1). quickstart's
#     local-nats path avoids this edit — another reason Path A is preferred.
#     FEDERATED instead: cortex network provision $SLUG --apply
#                        cortex network make-live $SLUG --apply
# 3. Boot + reload
cortex start --config ~/.config/metafactory/cortex/$LUNA_SLUG/$LUNA_SLUG.yaml
cortex agents reload
```

**Discord-first, front-loaded manual edge.** Per DD-5, the Discord-app creation
(§4) is on the critical path. The bundle handles it as the **preinstall gate**
(§below), not the postinstall — the install refuses to even start until
`LUNA_BOT_TOKEN` is present, so the operator hits the clearest possible stop
*before* anything is scaffolded.

### The preinstall gate

`scripts/preinstall-gate.sh` (mirrors luna-light's `check-cortex-version.sh` +
pier's `PIER_BOT_TOKEN` gate). It fails loud, before any file is written, on:

1. `cortex` not on PATH → tells you to `arc install cortex`.
2. cortex `< 6.10.0` → tells you to `arc upgrade cortex` (quickstart is the spine).
3. **`LUNA_BOT_TOKEN` unset** → prints the full Discord Developer-Portal
   click-path (create app → Bot → Reset Token → Message Content Intent → OAuth2
   invite → Copy IDs). This is the DD-5 manual edge, made the loudest thing.
4. `LUNA_GUILD_ID` / `LUNA_CHANNEL_ID` unset → **WARN only** (fail SOFT: the
   stack still stands up; the Discord surface is disabled until they're set),
   matching pier's soft-warn discipline.

## 4. What it can't do (the irreducible edges) — and how it degrades honestly

- **Creating the Discord bot app is manual** (`design-bootstrap-luna.md` §4;
  quickstart's own doc-comment confirms "the Developer Portal has no API").
  Degrade: the preinstall gate **refuses** with the exact click-path, before
  scaffolding. It never pretends to have done it.
- **Federation is out of scope for solo** (§4, DD-4). The bundle stands up a
  **solo/local/simple-bus** Luna; `cortex network provision/make-live/join` are
  the opt-in upgrade, never on this path. Degrade: not attempted, documented as
  the next step.
- **`cortex quickstart` is Linux/systemd-first.** Its service step renders
  systemd user units on Linux; on **macOS** it only restarts an *already-loaded*
  launchd service (load/unload stays arc-owned). On a fresh macOS host the
  daemon may need an explicit `cortex start --config <pointer>` / `arc upgrade
  cortex` to register the plist. Degrade: the postinstall prints this caveat and
  the exact command; Path B's `cortex start` covers it. (This matters — the
  primary principal is on macOS. See F2.)
- **soma content is not bundled.** Luna ships the scaffold persona, not the
  principal's projected identity/memory. Degrade: honest in the persona ("no
  private memory yet"); soma projection is the documented upgrade.

## 5. Acceptance criteria (binary)

- [ ] `arc install luna-stack` with `LUNA_BOT_TOKEN` + `LUNA_SLUG` (+ guild/channel
      ids) set → a booted stack with `@luna` bound to a Discord channel and
      responding, **OR** a clear stop at the one manual edge (missing token →
      the preinstall gate's Developer-Portal instructions).
- [ ] With `LUNA_BOT_TOKEN` **unset**, the install aborts in preinstall with the
      click-path and writes **nothing** (no partial stack).
- [ ] The postinstall is **idempotent** — a re-run after fixing one env var does
      not clobber an already-stood-up stack (inherited from quickstart's
      idempotence; Path B guards each step).
- [ ] The stood-up stack is **solo/simple-bus** — no `network provision` /
      `make-live` runs; federation stays opt-in.
- [ ] **Content-safe**: no live token or snowflake in any shipped file; every id
      is a `__LUNA_*__` / `<REPLACE_ME>` placeholder.
- [ ] `arc validate` passes on the bundle. *(Met by the prototype.)*

## 6. Prototype status

Validated skeleton at `~/Developer/metafactory-bundle-luna-stack-proto/`:
`arc-manifest.yaml` (passes `arc validate`), `personas/luna.md` (public-safe,
adapted from luna-light), `agents.d/luna.yaml` (Discord presence, `__LUNA_*__`
placeholders), `scripts/preinstall-gate.sh` + `scripts/postinstall-bootstrap.sh`
(executable, `bash -n` clean). No git remote, not published, never installed on
a live stack — authored for review.

## 7. CLI-surface findings (real gaps to file)

- **F1 — No first-class simple-bus scaffold mode (`cortex#2182` not landed).**
  Neither `stack create` nor `provision-stack` has a `--simple-bus` flag or any
  `credsPath`-clearing step (grep of both command files: empty). The solo/
  anonymous-bus model the spec's DD-4 default depends on is today a **manual
  `system.yaml` edit** (blank `nats.credsPath`). *Mitigation in place:*
  `cortex quickstart`'s local-nats path is functionally the solo bus (local
  nats conf + seed only, no account tree), so the bundle reaches a solo Luna via
  Path A without the manual edit — but a discrete `--simple-bus` scaffold flag
  would let Path B stand alone. **File against cortex#2182.**
- **F2 — `cortex quickstart` is Linux/systemd-first; macOS service step is
  partial.** Step 7 renders systemd units on Linux (hard-requires cortex#2071)
  but on macOS only restarts an already-loaded launchd service. For a Mac-first
  principal, a fresh-host install may not register the daemon plist via
  quickstart alone. **File: a macOS-parity path for quickstart's service step
  (or document the `cortex start` follow-up as a first-class branch).**
- **F3 — `stack create` default agent is `assistant`, and the Discord binding
  lives in two possible places.** The scaffold writes a generic `assistant`
  fragment (#1338); the bundle instead drops its own `agents.d/luna.yaml`
  (id `luna`) via `provides.files`. But quickstart patches the Discord binding
  into `surfaces/surfaces.yaml`, while the bundle's fragment carries
  `presence.discord` (pier-style). **Open reconciliation:** does Luna bind
  Discord via the agent fragment's `presence` or via `surfaces.yaml`? Both exist;
  the bundle should pick one so the two don't double-bind. Needs a design call
  (see open questions).
- **F4 — arc's §4.2 name-derivation (`toStrictName`) doesn't know the
  `metafactory-cortex-agent-` / `-adapter-` / `-renderer-` classes.** It only
  strips `metafactory-skill-`, `metafactory-bundle-`, and
  `metafactory-<app>-skill-`. So for the shipped cortex agent bundles (escort,
  luna-light, this one) the derivation guard **returns null and silently does
  not apply** — `name` is unchecked against the dir. Not blocking (permissive,
  not wrong), but the validator's §4.2 enforcement has a blind spot for the
  exact classes cortex ships. **File against arc** (extend `toStrictName` to the
  `-agent-`/`-adapter-`/`-renderer-` app classes).

## 8. Open questions for the principal

1. **Fragment `presence` vs `surfaces.yaml` for the Discord binding (F3).** The
   pier exemplar puts `presence.discord` on the agent fragment; quickstart
   patches `surfaces.yaml`. Which is canonical for a bundle-shipped agent? (Recommend:
   fragment `presence` for a single-surface agent like Luna, since it travels
   with the bundle; reserve `surfaces.yaml` for shared cross-agent gateway
   bindings.)
2. **`luna` vs a prompted name.** Ship her as the reference `@luna`, or prompt
   for the operator's own assistant name (their Luna, their name)? The
   `assistant` placeholder (#1338) exists so we needn't hard-name. (Recommend:
   default `luna`, allow `LUNA_AGENT_ID` override — matches
   `design-bootstrap-luna.md` open Q4.)
3. **`type: agent` now vs push arc for `type: process`.** Adopt the deferred
   `process` type now (needs arc's pulse-process requirements clarified), or stay
   `agent` until the orchestration demonstrably outgrows it? (Recommend: stay
   `agent`; revisit if the postinstall grows a second orchestration concern.)
4. **Sequence vs #2182 / F1.** Ship the bundle now against quickstart's local-
   nats solo path (works today), or block on a first-class `--simple-bus`
   scaffold flag so Path B is self-sufficient? (Recommend: ship against
   quickstart now; F1 is a nice-to-have, not a blocker.)
5. **macOS parity (F2).** Is a Linux-first stand-up acceptable for v0.1.0 (with
   the documented macOS `cortex start` follow-up), or is macOS parity a release
   gate given the primary principal runs macOS?

## 9. Provenance

Exemplars: `metafactory-bundle-luna-light/` (Phase-1), `cortex/arc-manifest-pier.yaml`
+ `agents.d/pier.yaml` + `scripts/pier/`. CLI surface (verified):
`cortex/src/cli/cortex/commands/{stack,provision-stack,quickstart,quickstart-lib,agents}.ts`.
Validator: `arc/src/lib/{validate-manifest,repo-name}.ts`, `arc/src/types.ts`,
`arc/src/cli.ts`. Naming + manifest contract: `arc/docs/skill-repo-migration-spec.md`.
Design lineage: `design-bootstrap-luna.md` (DD-1/2/4/5), `bundle-blueprints.md`.
