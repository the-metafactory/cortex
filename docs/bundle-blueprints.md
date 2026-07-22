# Agent Bundle Blueprints

**What this is.** Three shipped/real agent bundles, presented as **blueprints** —
annotated, clone-me reference shapes for building your own cortex agent. Pick the
one closest to what you want, copy its skeleton, change the persona + name.

> **Terminology (this ecosystem overloads "blueprint" — keep them apart):**
> - **agent bundle blueprint** *(this doc)* — a reference *template* for an arc
>   `type: agent` bundle. A pattern to clone.
> - **`blueprint.yaml`** — the feature dependency-graph (`blueprint` CLI). Unrelated.
> - **`state: { blueprint: AgentState }`** — a per-agent durable-**memory** bundle. Unrelated.
>
> When we say "blueprint" below we always mean the first.

Every one is the **same arc shape**: an in-process cortex agent = `arc-manifest.yaml`
(`type: agent`, `targets: [cortex]`, `provides.files`, `capabilities`, `lifecycle`)
+ a `personas/<id>.md` (the character) + an `agents.d/<id>.yaml` fragment (id,
capabilities, `presence`). They differ only in **behavior, surface, and privilege**.

> **These aren't hypothetical — the gallery is already published.** The ecosystem
> ships teaching-sample agent bundles under the `metafactory-cortex-agent-<name>`
> naming class, all public and `arc install`-able:
> `metafactory-cortex-agent-escort` (the canonical concierge sample) and
> `metafactory-cortex-agent-example-{deterministic,hybrid,non-deterministic}` (the
> three brain-class teaching samples). **Luna-Lite joins them** as
> `metafactory-cortex-agent-luna-lite` — the simplest one, the assistant floor.
> A newcomer can `arc install` any of these and read the source as a template.

---

## Blueprint 1 — **Luna-Lite** · the assistant (the floor)

*Clone this when you want: a plain, capable assistant on your own stack.*

The simplest possible agent — a chat assistant, surface-neutral, zero privilege.
The "hello world" of agent bundles, and the front door for a new user.

| Facet | Shape |
|---|---|
| **Purpose** | General chat assistant (`@luna-lite`) |
| **Capabilities** | `chat`, `async` |
| **Surface** | **neutral** — `presence: {}` (binds nothing; you bind it in `surfaces.yaml`, or dispatch over the bus) |
| **Privilege** | minimal — reads its own config; **no** write/network/bash/secrets |
| **Identity** | shares the stack's bus identity; mints nothing |
| **Teaches** | the irreducible minimum: manifest + persona + fragment, and that `presence: {}` is the valid "no surface" form |

```yaml
# arc-manifest.yaml (essence)
type: agent
targets: [cortex]
provides: { files: [{source: personas/luna-lite.md, target: ~/.config/cortex/personas/luna-lite.md},
                    {source: agents.d/luna-lite.yaml, target: ~/.config/cortex/agents.d/luna-lite.yaml}] }
capabilities: { filesystem: {read: [~/.config/cortex], write: []}, network: [], bash: {allowed: false}, secrets: [] }
lifecycle: { preinstall: [scripts/check-cortex-version.sh], postinstall: [scripts/signal-cortex-reload.sh] }
```

Repo: `the-metafactory/metafactory-cortex-agent-luna-lite` (grammar class
`metafactory-cortex-agent-<name>`, alongside escort + the examples). Install (once
public + published): `arc install luna-lite` — or from URL today.

---

## Blueprint 2 — **Pier** · the concierge (guide, don't grant)

*Clone this when you want: an agent that greets people and drives a workflow it
must never complete itself.*

The shipped community onboarding concierge. It greets newcomers on a public
channel, walks them through a two-tier flow, and **surfaces admission requests to
the principal — it issues nothing**. The load-bearing pattern: an agent that
*guides* a privileged action without *holding* the privilege.

| Facet | Shape |
|---|---|
| **Purpose** | Onboarding concierge (`@pier`) — greet + guide + surface |
| **Capabilities** | `onboarding`, `chat` |
| **Surface** | **hard-wired** to the community Discord guild (`presence.discord` with resolve-at-install `__PIER_*__` ids) |
| **Privilege** | **airgapped** — `openOnboardingAllowedTools: [Read]`; issues no creds, runs no privileged CLI |
| **Identity** | in-process, shares the stack identity; `trust: [luna]` |
| **Teaches** | the **surfaces-not-issues** boundary (a principal — never the agent — runs the grant), resolve-at-install secret placeholders, and `openOnboarding: true` (a stranger can reach it before holding any role) |

```yaml
# the distinguishing bits vs Luna-Lite
identity: { id: pier }
runtime: { capabilities: [onboarding, chat] }
presence: { discord: { enabled: true, guildId: __PIER_GUILD_ID__, agentChannelId: __PIER_AGENT_CHANNEL_ID__, ... } }
openOnboarding: true
openOnboardingAllowedTools: [Read]   # the airgap
```

Reference: `arc-manifest-pier.yaml`, `personas/pier.md`, `agents.d/pier.yaml` (in cortex).

---

## Blueprint 3 — **Escort** · the quest concierge (stateful, verified onboarding)

*Clone this when you want: onboarding as a guided, per-person, verifiable journey
— not a linear doc.*

The gamified successor to Pier (guildhall's quest-engine concierge). It opens a
**private thread per arrival**, verifies identity (e.g. a GitHub handle), and runs
onboarding as a **stateful quest** with per-step checks. Where Pier is a public
greeter, Escort is a personal guide with memory of *where you are* in the flow.

| Facet | Shape |
|---|---|
| **Purpose** | Per-arrival quest concierge — thread-per-newcomer, verified, resumable |
| **Capabilities** | `onboarding`, `chat` (+ quest/verification behaviors) |
| **Surface** | Discord, but **thread-scoped** — drives the `create_private_thread` brain effect (one thread per arrival) |
| **Privilege** | still surfaces-not-issues (Pier's boundary), + verification (GitHub handle) |
| **State** | **stateful** — tracks each newcomer's quest progress (the case for `state: {blueprint: AgentState}`) |
| **Teaches** | how a concierge scales: private per-person threads + step-checks + resumable progress turn a runbook into a quest |

> Status: **PUBLISHED** — `the-metafactory/metafactory-cortex-agent-escort`
> (public), described in-repo as *"canonical sample of a cortex agent bundle —
> deterministic onboarding greeter"*. Its gamified/quest extensions (per-arrival
> threads, verification) are the roadmap; the agent-bundle shape is shipped.

---

## How the three inform `#bootstrap`

```
         guides                    delivers               is the script
   ┌────────────────┐         ┌──────────────┐        ┌──────────────┐
   │  Pier → Escort │  ──────▶│  Luna-Lite  │◀───────│  the runbook │
   │  (concierge)   │  hand   │  (the bundle)│  reads  │  (the spec)  │
   └────────────────┘  over   └──────────────┘        └──────────────┘
```

- **Pier** is the front-door **now**: it can walk a newcomer through the runbook and
  hand them `arc install luna-lite`.
- **Luna-Lite** is the **payload**: the one-command assistant they end up with.
- **Escort** is where the concierge **grows**: each runbook step becomes a quest step
  with a check (✅ stack created · ✅ bus connected · ✅ `@luna` responds), per person,
  resumable.

The blueprints make the pattern **legible**: a newcomer can see the range (assistant
→ concierge → quest concierge), understand that all three are the *same arc shape*,
and clone the one they need.

## References

Bundle shape: `arc/docs/skill-repo-migration-spec.md`, ADR-0017. Pier:
`arc-manifest-pier.yaml` + `personas/pier.md` + `agents.d/pier.yaml`. Escort:
guildhall quests + `src/brain/protocol.ts` (`create_private_thread`, ADR cortex#2206).
Luna-Lite: `the-metafactory/metafactory-cortex-agent-luna-lite`. Companion spec:
`design-bootstrap-luna.md`.
