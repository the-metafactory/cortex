# The cortex config template — config-split (multi-file) layout

**This directory IS the canonical, copy-paste-and-go config template that ships
with cortex.** The multi-file **config-split** layout is the **standard** way to
configure a cortex stack. The single-file `cortex.yaml` (repo root
`cortex.yaml.example`) is a **legacy / transitional fallback** — it still loads,
but new installs should land here.

## Even easier: `cortex stack create <slug>`

This whole copy → fill → align dance is what `cortex stack create` automates
(#808). It scaffolds this exact skeleton **born aligned** — the dir basename,
the slug, and `stack.id`'s trailing segment are all the same, so the
slug↔`stack.id` drift the install-time `warn_stack_identity_drift` detector
catches ([ADR-0004](../adr/0004-stack-slug-authority.md)) can never form — and
**unique within the principal** (it refuses a dir collision or a duplicate
`stack.id`):

```bash
# Dry-run first (DEFAULT — prints the file set it would write, touches nothing):
cortex stack create research --principal andreas

# Write it for real:
cortex stack create research --principal andreas --apply

# Then provision the signing seed → point your daemon → (optionally) federate:
arc upgrade cortex                                              # auto-provisions ~/.config/nats/cortex-research.nk
cortex start --config ~/.config/cortex/research/research.yaml
cortex network join <network>                                  # federate (optional)
```

It fills in your real `slug` / `principal` / `agent`, keeping `<REPLACE_ME>`
only for true secrets (Discord token/guild/channels + the post-first-boot
`nkey_pub`). The manual copy steps below remain the fallback.

## Quick start (copy → fill → point)

```bash
# 1. Copy this directory to your config dir, naming it after your stack slug
cp -R docs/config-layout ~/.config/cortex/research

# 2. Fill in every <REPLACE_ME> marker across the files below
#    (secrets/ids: principal id, stack signing keys, Discord token/guild/channels)
$EDITOR ~/.config/cortex/research/{system/system.yaml,stacks/research.yaml,surfaces/surfaces.yaml}

# 3. Point your daemon at the POINTER (sentinel) file — its dirname selects the layout
cortex start --config ~/.config/cortex/research/research.yaml
```

The pointer file [`research.yaml`](./research.yaml) is the file `--config`
points at; **its contents are ignored** — only its dirname selects the layout,
and its basename names the single-instance PID file (so per-stack deployments
MUST give each pointer a per-stack name — see the migration note below).

> **config-split is the standard layout.** The single-file `cortex.yaml` form
> (`cortex.yaml.example`) still loads via the transitional single-file fallback
> (no `system/system.yaml` marker present), so existing monolith deployments
> keep working unchanged — but it is **legacy**, not the form a fresh install
> should adopt. When in doubt, copy this directory.

This directory is also a **loadable reference/fixture** for the config-split
layout introduced by the IAW **CFG** epic
(`docs/plan-internet-of-agentic-work.md` §13.1) — every file parses cleanly out
of the box with `<REPLACE_ME>` markers standing in for real tokens/keys.

## Why split the config

A single fat `cortex.yaml` couples knobs with **wildly different blast radii**
on one edit surface (design doc §3.7). The split isolates them by lifecycle:

| File | Owns | Blast radius |
|---|---|---|
| `system/system.yaml` | substrate / transport: `claude`, `execution`, `attachments`, `paths`, `plugins`, `nats`, `bus` — **the dangerous transport knobs** | Whole stack |
| `network/*.yaml` | federation roster (`policy.federated.networks[]`) | Cross-principal |
| `surfaces/surfaces.yaml` | shared surface-gateway bindings (CFG.c / GW) | Cross-stack |
| `stacks/*.yaml` | per-deployment policy / capabilities / agents | One stack only |

## How composition works

The boot composer (`composeRawConfig`, `src/common/config/loader.ts`) keys off
the **marker file `system/system.yaml`**. When it is present, the composer reads
the layers in this fixed precedence and deep-merges them into the SAME
`LoadedConfig` the single file produced:

```
system/system.yaml      (base — most general)
network/*.yaml          (sorted by filename)
surfaces/surfaces.yaml
stacks/*.yaml           (most specific — wins on leaf keys)
```

Later layers win on leaf keys; nested objects deep-merge; arrays and scalars
replace wholesale. `LoadedConfig` is **unchanged** — no consumer edits. A single
monolithic `cortex.yaml` still loads via the transitional single-file fallback
(no marker file present), so existing deployments keep working unchanged.

## The `nats.subjects` landmine (CFG.b.2)

`nats.subjects` lives in **exactly one place** — `system/system.yaml` — and
nowhere else. It is the most dangerous block in the config: a duplicate or
overlapping subscribe pattern double-binds the boot subscriber and
double-delivers every envelope (the double-message problem, cortex#491). Keeping
it in one rarely-edited file removes the per-stack duplication that caused it.

The loader validates the block **loudly at load** (CFG.b.3,
`src/common/types/nats-subjects.ts`): a malformed pattern or a duplicate entry
throws a clear error rather than parsing into a silent partial config that would
double-publish.

## The surface binding map (CFG.c)

`surfaces/surfaces.yaml` holds the per-platform **surface bindings**
(Discord/Slack/Mattermost `token`, `guild`, channel/instance bindings), moved
out of each stack's `agents[*].presence.{platform}` block. It is the
`{surface-instance → stack}` map the **shared surface gateway (GW, §13.2)**
consumes to hold one platform connection per bot and route inbound messages to
the right stack.

The composer **folds** each binding back into the matching agent's
`presence.{platform}` block at load (joining on the binding's `agent:` id
against `stacks/*.yaml` `agents[].id`) and drops the top-level `surfaces:` key —
so the composed raw config is identical to the inline (pre-CFG.c) form and
`LoadedConfig` is **byte-identical**. It is a source-layout change, not a
runtime-shape change; the per-stack adapters and the per-presence-token wiring
in `src/cortex.ts` are untouched.

Binding-map shape (validated loudly at load — CFG.c.4,
`src/common/types/surfaces.ts`):

```yaml
surfaces:
  <platform>:                  # discord | slack | mattermost
    - agent: <agent-id>        # join key against stacks/*.yaml agents[].id
      stack: <principal>/<stack>   # OPTIONAL — the {instance → stack} GW routes on
      binding:                 # the required per-platform credential/instance fields
        ...
```

Required binding fields: discord → `token`, `guildId`, `agentChannelId`,
`logChannelId`; slack → `botToken` (`xoxb-…`), `appToken` (`xapp-…`),
`workspaceId` (`T…`); mattermost → `apiUrl`, `apiToken`.

**Precedence / fallback.** `surfaces.yaml` is OPTIONAL — per-stack
`presence.{platform}` is always the fallback (the three live single-file
deployments carry bindings inline and have no `surfaces.yaml`). When BOTH are
present for the same platform, the surfaces.yaml binding **wins on leaf keys**
(it is the credential surface-of-truth) while inline non-binding knobs
(`contextDepth`, `surfaceSubjects`, …) survive the merge. A binding naming an
agent absent from every stack fails **loudly** rather than silently dropping a
credential.

## The files in this template

| File | Layer | What to fill in |
|---|---|---|
| [`research.yaml`](./research.yaml) | pointer | nothing — rename it after your stack slug; contents ignored, dirname selects the layout, basename names the PID file |
| [`system/system.yaml`](./system/system.yaml) | substrate / transport | `nats.url` + identity; leave `nats.subjects` at the safe `[]` default |
| [`network/example-network.yaml`](./network/example-network.yaml) | federation roster (OPTIONAL) | peers, registry, accept-subjects — only if you federate; inert until uncommented |
| [`surfaces/surfaces.yaml`](./surfaces/surfaces.yaml) | shared surface bindings (OPTIONAL) | Discord/Slack/Mattermost `token` / `guild` / channels for each agent |
| [`stacks/research.yaml`](./stacks/research.yaml) | per-deployment stack | `principal`, `stack` signing keys, `policy` (principal-only pattern), `agents`, `github.repos` |
| [`nats-server.conf.example`](./nats-server.conf.example) | nats-server config (NOT a cortex config layer) | annotated operator-mode / MEMORY-resolver reference. Usually **generated** by `cortex network provision` + `cortex network make-live`; copy + fill only as a manual fallback |

> **`nats-server.conf.example` is the nats-server config, not part of the cortex config-split.** It documents the shape `cortex network make-live` bootstraps (the make-live bootstrap renderer is the single source of truth; a drift test keeps the two in sync). You point `nats-server -c` at your filled copy; you point the cortex daemon at the pointer file above.

- **`stacks/research.yaml`** is the file you edit daily. It carries the
  `<REPLACE_ME>` markers for your principal id, stack signing keys, the
  principal-only `policy` block (the human principal's Discord id under
  `platform_ids.discord`), the agent, and `github.repos`. Its agent declares an
  EMPTY `presence: {}` — the Discord binding folds in from `surfaces.yaml`
  (style A). The inline-presence fallback (style B) is shown commented at the
  bottom of that file.
- **`surfaces/surfaces.yaml`** binds the `ivy` agent's Discord presence (Slack +
  Mattermost commented out) — the credential surface-of-truth.
- **`network/example-network.yaml`** documents the federation layer
  (`policy.federated.{registry, networks[]}`). It is OPTIONAL and ships
  fully commented (inert) — a non-federating stack omits the `network/` dir
  entirely and the composer skips the layer. Read the network SOPs
  (`docs/sop-network-join.md`, `docs/sop-federation-onboarding.md`,
  `docs/sop-stack-onboarding.md`) before enabling anything there.

See [`docs/sop-stack-onboarding.md`](../sop-stack-onboarding.md) for the
end-to-end stand-up procedure (this template is the config it tells you to copy
at Step 3), and
[`docs/migrations/0003-config-split-layout.md`](../migrations/0003-config-split-layout.md)
for the split rationale, the loader's precedence rules, and the PID-collision
landmine.
