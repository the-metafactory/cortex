## Configuration files

cortex is configured with the **config-split (multi-file) layout** — this is the
**standard**. A stack's config is a directory the daemon points `--config` at; a
pointer (sentinel) file's dirname selects the layout, and the boot composer
(`composeRawConfig`, `src/common/config/loader.ts`) deep-merges the layers in a
fixed precedence (later layers win on leaf keys), producing the SAME
`LoadedConfig` the old single file produced.

| Layer | Owns | Blast radius |
|---|---|---|
| `system/system.yaml` | substrate / transport: `claude`, `execution`, `inference` (model providers/profiles), `attachments`, `paths`, `plugins`, **`nats` (incl. the `nats.subjects` landmine — ONE place), `bus`** | whole stack |
| `network/*.yaml` | federation roster (`policy.federated.{registry, networks[]}`) — OPTIONAL | cross-principal |
| `surfaces/surfaces.yaml` | shared surface-gateway bindings (Discord/Slack/Mattermost tokens) — OPTIONAL | cross-stack |
| `stacks/*.yaml` | per-deployment `principal` / `stack` / `policy` / `capabilities` / `agents` / `github` | one stack |

Precedence: `system/` → `network/*` (sorted) → `surfaces/` → `stacks/*` (sorted).
`nats.subjects` lives in **exactly one place** (`system/system.yaml`) — a
duplicate double-binds the boot subscriber and double-delivers every envelope
(cortex#491). Never re-declare it in a stack file.

- **Single-file `cortex.yaml` is LEGACY.** It still loads via the transitional
  single-file fallback (no `system/system.yaml` marker present), so monolith
  deployments keep working — but it is not the form a fresh install should adopt.
- **Pointer-file naming is load-bearing.** cortex derives its single-instance
  PID file from the `--config` basename; per-stack deployments MUST give each
  pointer a per-stack name (`research.yaml`, `work.yaml`, …), never a uniform
  `cortex.yaml`, or the second daemon collides on `cortex-cortex.pid`.
- **`inference` is substrate-layer, opt-in, and `claude-code` stays the
  default.** The `inference` block (model `providers` + named `profiles`) lives
  in `system/system.yaml` beside `claude`/`execution` — never in a stack file.
  An agent opts in with `runtime.substrate: api-agent` +
  `runtime.inferenceProfile: <name>`; an agent that omits `substrate` is
  unchanged (design D3). Do NOT reuse `runtime.model` — that selects the Sage
  review engine. Credentials are `env:NAME` **references** only (a literal is
  rejected at load) and a provider `baseUrl` is a reviewed **model-egress
  destination**, so provider/profile edits are policy changes (D6). The API
  harness is **text-only — NO TOOLS** (D5): no Bash/edits/skills/attachments,
  no streaming progress (one terminal envelope). See
  [`docs/config-layout/README.md`](docs/config-layout/README.md) §"Model
  providers" for the opt-in walkthrough + current limitations, and
  [`docs/design-api-model-provider-support.md`](docs/design-api-model-provider-support.md).

**Canonical template:** [`docs/config-layout/`](docs/config-layout/) — copy that
directory to `~/.config/metafactory/cortex/<slug>/`, fill the `<REPLACE_ME>` markers, point
your daemon at the pointer file. The repo-root `cortex.yaml.example` is the
legacy single-file reference. See
[`docs/config-layout/README.md`](docs/config-layout/README.md),
[`docs/sop-stack-onboarding.md`](docs/sop-stack-onboarding.md) (Step 3 copies
this template), and
[`docs/migrations/0003-config-split-layout.md`](docs/migrations/0003-config-split-layout.md).
