# Reference multi-file config layout (IAW CFG)

This directory is a **documented, loadable reference** for the multi-file
`cortex` config layout introduced by the IAW **CFG** epic
(`docs/plan-internet-of-agentic-work.md` §13.1). It is an example/fixture, not a
live deployment — copy it to your config dir and fill in real tokens/keys.

## Why split the config

A single fat `cortex.yaml` couples knobs with **wildly different blast radii**
on one edit surface (design doc §3.7). The split isolates them by lifecycle:

| File | Owns | Blast radius |
|---|---|---|
| `system/system.yaml` | substrate / transport: `claude`, `execution`, `attachments`, `paths`, `nats`, `bus` — **the dangerous transport knobs** | Whole stack |
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

## This example

- [`system/system.yaml`](./system/system.yaml) — the substrate layer, with the
  prominently-commented `nats.subjects` block (kept at the safe `[]` default).
- [`surfaces/surfaces.yaml`](./surfaces/surfaces.yaml) — the surface binding map;
  binds the `ivy` agent's Discord presence (Slack + Mattermost commented out).
- [`stacks/research.yaml`](./stacks/research.yaml) — one per-deployment stack
  (principal + one agent), carrying no transport knobs and an EMPTY
  `presence: {}` — its Discord binding folds in from `surfaces.yaml`.

`network/` is omitted here — the network roster lands with the federation
phases; it is an optional layer the composer skips when absent.
