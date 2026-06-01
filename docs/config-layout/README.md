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

## This example

- [`system/system.yaml`](./system/system.yaml) — the substrate layer, with the
  prominently-commented `nats.subjects` block (kept at the safe `[]` default).
- [`stacks/research.yaml`](./stacks/research.yaml) — one per-deployment stack
  (principal + one agent), carrying no transport knobs.

`surfaces/` and `network/` are omitted here — `surfaces.yaml` lands with CFG.c
and the network roster with the federation phases; both are optional layers the
composer skips when absent.
