# Design Spec — Bootstrap Your Own Luna (zero → working assistant stack)

**Status:** draft
**Owner:** principal (Andreas)
**Audience:** a **new user** standing up their first metafactory assistant stack, and the maintainers building the path they follow.
**Lineage (design-process SOP):** Research (`docs/design-onboarding-tooling-audit.md`) → this Design Spec → `blueprint.yaml` features → issues. Grounds on: `docs/sop-stack-onboarding.md`, `README-AGENTS.md` §3, `docs/config-layout/`, `arc-manifest-pier.yaml` (the bundle exemplar), ADR-0017 (surface tooling as arc bundles).
**Discussion:** community `#bootstrap` (playbook + process for new users).

---

## 1. Problem

Standing up a working assistant stack (a "Luna") today is a **~15-step recipe spread across 6 SOPs** (`design-onboarding-tooling-audit.md` §rank-1..5). The principal has done it five-plus times by hand; nobody else can. Two things are missing:

1. **A single end-to-end path** — one document a newcomer follows from a clean machine to a responding `@luna`, instead of stitching `sop-stack-onboarding` + `sop-stack-identity` + `sop-network-join` + `README-AGENTS §3` + the config-layout template themselves.
2. **A packaged shortcut** — an `arc install`-able bundle that scripts the automatable ~80% (persona + agent fragment + the `stack create → provision → make-live` chain), so the newcomer only does the irreducibly-manual edges.

Both are wanted. They are **not alternatives** — the runbook is the specification the bundle automates.

## 1.5 What "MVP" means (per Vincent + `#bootstrap`, 2026-07)

`#bootstrap` defines the target as *"fresh cortex install → a **minimum viable
product (MVP) software factory assistant**"* — not a chat toy, an assistant that
can do the software-factory work. The MVP is pinned by these constraints (the
common denominator of how this community actually runs):

| Axis | MVP constraint |
|---|---|
| **OS targets** | macOS · Debian-based Linux · WSL2 |
| **Install path** | cortex **native** install (not container — L4 compose is a parallel option, not the MVP path) |
| **Stack** | **local** (not federated) |
| **Coding agent** | **Claude Code** (already cortex's substrate) |
| **Communication** | **Discord** (aligns with DD-5) |
| **Cloud repo** | **GitHub** |

**This tiers cleanly onto what we've built:**
- **Luna-Lite** is the *floor* — chat + async, zero tools. It is NOT the MVP; it's
  the front door and the persona base.
- **The MVP = Luna-Lite + software-factory capability**: Claude-Code coding with
  the tool surface a dev assistant needs (bash, `gh`/GitHub, access to
  checked-out repos), bound to Discord, on a local stack, across the three OS
  targets. These are the "extensions to Luna" — each an explicit capability grant
  on the fragment, not baked into the light floor.
- **Full Luna** (memory via AgentState, soma-projected identity/skills, federation)
  is the ceiling — beyond MVP.

So the bootstrap journey's real deliverable is **the MVP tier**: the runbook and the
Phase-2 bundle must stand up not just a chat Luna but a *working software-factory
assistant* under the constraints above. The OS matrix (mac/Debian/WSL2) and the
capability set (Claude-Code + bash + `gh` + repo access) become first-class
acceptance criteria, not afterthoughts.

## 2. Goal (Definition of Done — a demonstrable walkthrough)

A new user on a clean machine can reach a **working, bus-routable `@luna`** that responds on their chosen surface, by following ONE path. Concretely, a reviewer can watch:

1. Prereqs installed (bun, NATS, Claude auth) and — *only if choosing Discord* — a bot app created + token in hand.
2. `arc install cortex` (+ one surface adapter bundle) → cortex present.
3. `cortex stack create luna --agent luna --apply` → a config-split stack scaffolded, born-aligned (`stack.id = <you>/luna`).
4. Bus identity + connection stood up — **either** the full account-tree chain (`arc upgrade cortex` → `network provision --apply` → `network make-live --apply`) **or** the simple-bus mode (§6.3) for a solo/local Luna.
5. `cortex start --config <pointer>` → daemon boots, connects to its bus, subscribes.
6. A message to the surface reaches `@luna` and she replies.
7. *(Better Luna, optional)* her persona/skills/memory come from a **soma projection** rather than the scaffold stub.

**Phase 2 target:** steps 3–4 collapse into `arc install luna-stack` + a short prompt, leaving only steps 1 (prereqs/Discord app) and 6 (say hi).

## 3. Grounding — what already exists (reuse, don't rebuild)

| Building block | What it is | Reuse in this spec |
|---|---|---|
| **`cortex stack create <slug>`** (#808) | Scaffolds the config-split layout (`system/`, `surfaces/`, `stacks/<slug>.yaml`, pointer, `personas/<agent>.md`, 0700 workspace) born-aligned; **dry-run by default**, `--apply` writes. Does NOT mint the signing seed. | The runbook's Step 3; the bundle's postinstall core. |
| **The lifecycle chain** | `stack create --apply` → `arc upgrade cortex` (seed) → `network provision --apply` (account tree) → `network make-live --apply` (bus creds + nats restart) → `cortex start` → optional `network join`. `stack create` prints it as "Next steps". | The canonical order the runbook and bundle both follow. |
| **`pier`** | A **shipped in-process onboarding-concierge agent**, packaged as an arc `type: agent` bundle (`arc-manifest-pier.yaml`: `provides.files` persona+fragment, `lifecycle` hooks, `__ENV__` secret placeholders, `depends_on: cortex`). | The **exemplar bundle shape** to clone. AND Pier is the guided front-door: she greets newcomers in `#onboard-your-fleet` and walks them through this very runbook. |
| **`vega`** | An in-process dev-loop orchestrator agent shipped as a **template** (copied into a stack's `agents.d/`, not `arc install`ed). | Proof that a stack is a *fleet of fragments*, not one persona — the model for shipping the `luna` fragment. |
| **`quickstart`** (L3, `src/cli/cortex/commands/quickstart.ts`) | Env-contract-driven one-command provision. | The bundle's non-interactive install spine — but see §6.2 (Discord-hard-wired). |
| **L4 compose** (`deploy/compose/`) | `docker compose up -d` container path (v6.10.0). | A second delivery target for users who want Luna in a container, not on a host. |
| **soma projection** | soma owns Luna's *content* (Purpose/Memory/skills) and **projects** it into the substrate config the runtime reads. | The "better Luna" — real identity/memory instead of the scaffold stub. Bundle `depends_on` or a documented follow-on. |
| **AgentState blueprint** (`state: {blueprint: AgentState}`) | Per-agent durable state (`~/.config/cortex/agents/luna/`). | Optional: gives Luna memory across sessions. |

**What a stack "having Luna" means:** a `luna` agent fragment (`agents.d/luna.yaml`) + `personas/luna.md`, `@luna` as the routed assistant name (`did:mf:luna`), optionally an AgentState blueprint (memory) and a soma projection (content). `stack create` writes a *generic `assistant` placeholder* (#1338); `--agent luna` (or an installed Luna persona) is what makes it Luna.

## 4. The one irreducible truth (scope boundary)

Two edges **cannot** be fully automated — the runbook documents them, the bundle flags them, neither hides them:

- **Discord app creation** — `quickstart.ts` confirms the Developer Portal has no API; creating the bot app + inviting it is manual, principal-only. *(A web/gateway surface avoids this entirely — see §6.2.)*
- **Federation trust-handoff + hub topology** — the two-party cred handoff and account-topology (`onboarding-audit` rank 1–3) are irreducibly two-party. **A solo Luna doesn't need them** (§6.3); they are opt-in when the user later federates.

Everything between these edges is scriptable.

## 5. Decision — deliver in two phases (runbook first, then bundle)

**DD-1. Ship the runbook first.** A single `docs/runbook-bootstrap-luna.md` (or a `#bootstrap`-pinned playbook) that collapses the 6 SOPs into one zero→Luna path, using today's tooling. It is shippable now, validates the flow end-to-end, and is exactly what `#bootstrap` asked for. It also becomes the executable specification for Phase 2.

**DD-2. Then codify the automatable core into an arc bundle** — `metafactory-bundle-luna-stack` — modeled on `arc-manifest-pier.yaml`. Building the bundle *before* a proven runbook risks automating a flow we haven't nailed; building it *after* means the bundle's postinstall is a mechanical transcription of a validated recipe.

**DD-3. Name things precisely (avoid the "blueprint" trap).** The stack-standup is an **arc bundle** (not a "blueprint"). Its *work* is tracked as a **`blueprint.yaml` feature** (Sense A). Luna's *memory* attaches via **`state: {blueprint: AgentState}`** (Sense B). These are three different "blueprints"; the spec keeps them apart.

**DD-4. Default to the simplest working Luna — solo, local, simple-bus.** The primary target is a **solo, local, simple-bus Luna** (no federation). Federation is an opt-in upgrade, not a prerequisite.

**DD-5. Discord-first surface (principal decision, 2026-07).** The default surface a newcomer binds Luna to is **Discord**, not web. Rationale: the entire fleet UX is Discord-native — `pier`/`escort` greet newcomers in Discord, releases + admissions flow through Discord, and the community *is* on Discord; landing a newcomer's Luna where the community already lives beats an isolated web endpoint. **Consequence, stated plainly:** this puts the one irreducible manual edge — creating a Discord bot app + inviting it (§4) — **on the critical path** of the default flow. The runbook must therefore front-load the Discord-app step and make it the clearest part of the walkthrough. The web surface stays a documented, first-class *alternative* (it's the right pick for a headless/gateway Luna and the one that avoids the manual edge), but it is no longer the recommended default.

## 6. Design detail

### 6.1 The bundle (`metafactory-bundle-luna-stack`)

Modeled on `arc-manifest-pier.yaml`:

```yaml
schema: arc/v1
name: luna-stack           # identity is manifest.name, not the repo name
version: 0.1.0
type: agent                # (candidate: a new `process` type if postinstall grows)
tier: community
targets: [cortex]
provides:
  files:
    - personas/luna.md            → ~/.config/metafactory/cortex/personas/
    - agents.d/luna.yaml          → ~/.config/metafactory/cortex/agents.d/
depends_on:
  packages:
    - { name: cortex, repo: the-metafactory/cortex }
    - { name: <surface-adapter>, repo: the-metafactory/metafactory-cortex-adapter-<web|discord> }
    # optional: soma projection, agent-state blueprint
lifecycle:
  preinstall:  scripts/check-cortex-version.sh      # (pier's pattern)
  postinstall: scripts/bootstrap-luna.sh            # runs the §6.4 chain, non-interactive
```

The bundle **provides** persona + fragment and **runs** the `stack create → provision → make-live` chain in postinstall. It **cannot** mint bus creds itself (that stays a cortex/arc CLI step invoked by the hook) nor cross the §4 edges. Secrets ride as `__ENV__` placeholders resolved at install (pier's pattern), never baked.

### 6.2 Surface choice — Discord-first (DD-5)

The default surface is **Discord** (DD-5): it lands the newcomer's Luna where the
fleet UX and the community already live (`pier`/`escort` greet there, releases +
admissions flow there). `quickstart` is already Discord-oriented, which fits.

The cost this accepts, stated plainly: creating the Discord bot app + inviting it
is the one irreducible manual edge (§4), and Discord-first puts it **on the
critical path**. So the runbook front-loads it — the Discord-app step is the first
and most carefully-documented part of the walkthrough, with the Developer-Portal
click-path spelled out (quickstart only *validates* the token; it can't create the
app).

The **web/gateway surface stays first-class** — it's the right default for a
headless/gateway Luna and the one path that avoids the manual edge, so the runbook
documents it as the explicit alternative. The bundle takes a `--surface
<discord|web>` choice (defaulting to `discord`).

### 6.3 Bus tier — simple-bus for solo, account-tree for federation

A solo Luna needs a bus but not the federation account-tree. Per **#2182**, the L4/simple-bus model is: `stack create` + `provision-stack generate` (signing seed only), then connect **anonymously** to a local unauthenticated bus (clear `system.yaml`'s `credsPath`). This is the default for a solo/local/container Luna. The full `network provision → make-live` account-tree chain is the **federation** path, opt-in. **This spec depends on #2182** landing a first-class `--simple-bus` scaffold mode; until then the runbook documents the manual `credsPath`-clear workaround.

### 6.4 The scripted chain (what postinstall / the runbook Step 3–5 runs)

```
cortex stack create luna --agent luna --apply          # config-split scaffold, born-aligned
# solo/simple-bus:
#   provision-stack generate (seed) ; clear system.yaml credsPath ; cortex start   (#2182)
# federated:
#   arc upgrade cortex (seed) ; cortex network provision luna --apply ;
#   cortex network make-live luna --apply ; cortex start ; (later) cortex network join <net>
```

### 6.5 Pier as the front-door

The community "process for new users" is: a newcomer lands in `#onboard-your-fleet`, **Pier** greets them (she already does this, airgapped/Read-only), and walks them through the runbook — or, in Phase 2, hands them the one-line `arc install luna-stack`. Pier issues nothing; she guides + surfaces admission requests. No new agent needed for the front-door — it exists.

## 7. Open decisions (need a principal call)

1. **Bundle `type`** — `agent` (reuse pier's schema) vs a new `process`/`pipeline` type for a postinstall that orchestrates a multi-step chain. *(Recommend: start `agent`; propose `process` to arc if postinstall outgrows it.)*
2. **soma projection** — bundle-in (Luna's content ships in the bundle) vs `depends_on` soma vs "connect soma later" as a documented follow-on. *(Recommend: `depends_on` optional; the scaffold stub works without it, soma makes her *your* Luna.)*
3. ~~**Default surface**~~ — **RESOLVED (DD-5): Discord-first.** The runbook front-loads the Discord-app step; web is the documented alternative.
4. **Naming** — do we ship her as `luna` (the reference assistant) or make the bundle prompt for the user's own assistant name (their Luna, their name)? The `assistant` placeholder (#1338) exists precisely so we don't hard-name. *(Recommend: bundle prompts for a name, defaults to a neutral suggestion — "your own version of Luna".)*
5. **Dependency on #2182 / #2153** — this spec's solo path assumes the simple-bus mode and web surface land. Sequence those as prerequisites, or ship the runbook against the manual workarounds now?

## 8. Acceptance criteria (binary)

- [ ] `docs/runbook-bootstrap-luna.md` exists: a single path from clean machine → responding `@luna`, no cross-references required to complete it, with the §4 manual edges called out explicitly.
- [ ] A test user (not the principal) follows the runbook and reaches a responding assistant on the web surface **without touching a Discord Developer Portal**.
- [ ] The runbook's federated path is a clearly-marked *opt-in upgrade*, not on the solo critical path.
- [ ] *(Phase 2)* `arc install luna-stack` scaffolds persona + fragment and runs the §6.4 chain in postinstall, leaving only §4 edges + "say hi" to the user.
- [ ] *(Phase 2)* the bundle refuses/fails-loud on a missing prereq (cortex version, bus, Claude auth) — pier's `check-cortex-version.sh` pattern.
- [ ] "blueprint" is used in exactly one sense per occurrence (DD-3); no doc conflates the three.

## 9. Rough edges this spec must not paper over

- Discord app creation is manual (§4) — the runbook says so up front.
- Federation is two-party and out of scope for solo (§4, §6.3) — opt-in.
- The multi-surface deploy (bot + dashboard + MC worker + registry) has no single orchestrator (`onboarding-audit` rank-5 / G4 `cortex release`) — out of scope here; Luna-solo needs only the daemon + one surface.
- `nkey_pub` write-back is in 3 sites with silent-fail risk (audit G3) — the chain in §6.4 relies on `arc upgrade cortex` handling it; the runbook verifies signing works before declaring done.

## 10. Provenance

Research: `docs/design-onboarding-tooling-audit.md` (Luna, cortex#1139). Exemplar: `arc-manifest-pier.yaml`, `personas/pier.md`, `agents.d/pier.yaml`. Lifecycle: `src/cli/cortex/commands/stack.ts`, `provision-stack.ts`, `network*.ts`. Bundle grammar: `arc/docs/skill-repo-migration-spec.md`, ADR-0017. Blueprint senses: `blueprint/blueprint.yaml`, `cortex-config.ts:992-1013`. Surface/bus edges: `#2153` (web surface), `#2182` (simple-bus). Community track: `#bootstrap`, `#onboard-your-fleet`.
