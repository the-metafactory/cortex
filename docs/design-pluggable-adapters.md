# Design: Pluggable surface plugins — adapters and renderers, out-of-tree, arc-installable, hot-loadable

**Status:** draft for principal review (grounds [ADR-0024](adr/0024-pluggable-surface-adapters.md), Status *proposed*) · **Date:** 2026-07-09 (renderer fold-in 2026-07-11) · **Epic:** [#1784](https://github.com/the-metafactory/cortex/issues/1784) · **S0:** [#1785](https://github.com/the-metafactory/cortex/issues/1785) · **Lifts the deferral in** [ADR-0017](adr/0017-surface-tooling-arc-bundles.md) §Alternatives L64–67

> This design is the S0 artifact for epic #1784. It grounds ADR-0024. Everything downstream (S1–S13) implements what the ADR ratifies. Where the epic's proposal left a genuine choice, this doc makes a recommendation and marks it **[AWAITING PRINCIPAL DECISION]** — those are the four pinned decisions the ADR must settle before it moves from *proposed* to *accepted*.

> **Scope change (2026-07-11, grill-with-docs).** The original draft covered **platform adapters** only. A grilling session established that **renderers** hit the *same* structural wall — adding one today edits a closed enum and cuts a cortex release — and that the loading machinery is identical. Principal-approved outcome: **two plugin classes, one SDK barrel** (§3.5). Adapters and renderers stay distinct *concepts*; they share the manifest, discovery/load path, compat gate, fail-isolation policy, and registry, because those are properties of *loading code into the daemon*, not of what the code does.

---

## 1. Problem — a surface change means a whole-cortex release

Today Discord, Mattermost, Slack, and the web/SSE surface are all compiled into cortex core (`src/adapters/{discord,mattermost,slack,web}/`). Adding a surface, upgrading a platform SDK, or removing one means cutting and deploying a whole cortex release. The platform npm deps (`discord.js`, `@slack/socket-mode`, `@slack/web-api`) sit in cortex's own `package.json:47-55`, so every stack — even one that binds only Discord — carries the transitive weight of every surface.

[ADR-0017](adr/0017-surface-tooling-arc-bundles.md) already extracted the surface *tooling* (the Discord CLI + skills → the `metafactory-bundle-discord` arc bundle, epic #1171) and **explicitly deferred the adapter**: *"Extract the adapter too … Rejected for now — the adapter is deeply woven into the bus/dispatch/surface-router; a plugin adapter model is a much larger change. Deferred to a separate future ADR"* (`docs/adr/0017-surface-tooling-arc-bundles.md:64-67`). This design lifts that deferral: it extends the arc-bundle shape from the tooling layer to the **adapter** layer, so a surface becomes a per-platform bundle a principal installs, upgrades, and removes independently of cortex releases.

**Goal (the epic's Definition of Done, restated):** on a stack whose cortex checkout contains *no* Slack code, `arc install metafactory-slack` + a `surfaces.slack[]` binding + a daemon reload yields a live Slack surface — no cortex release, no code change in the cortex repo — and a broken compat range refuses that one bundle without taking the daemon or any other adapter down.

### 1.1 Vocabulary (CONTEXT.md is authoritative)

This design uses the repo's terms exactly as pinned in `CONTEXT.md` §"Surfaces, substrates, dispatch routing". **`CONTEXT.md` is authoritative and beats instinct.** The distinctions below are load-bearing for this design, not pedantry — conflating them is what makes "just make adapters pluggable" read as if it also covered renderers, or as if the router's subscriber contract were an adapter.

- **Platform adapter** (the unqualified word **adapter**) — a live, agent-bound connection to ONE surface (Discord, Mattermost, Slack, web/SSE), holding that surface's credential and speaking its native protocol. It is **both** a **dispatch source** (inbound: platform message → envelope) and the driver of a **dispatch sink** (outbound: lifecycle envelope → `postResponse`/`sendProgress`). Contract: `PlatformAdapter` (`src/adapters/types.ts:183-264`).
- **Render target** — the **surface-router**'s render-only subscriber contract: `{ id, subjects, filter?, visibility?, render() }`. The router does the subject matching, isolation, and timeout. **It is NOT an adapter.** It is named `SurfaceAdapter` in code today (`src/bus/surface-router.ts:76`) — a misnomer; the rename to `RenderTarget` is a tracked follow-up. Nothing in this design should be read as "the router registers adapters."
- **Renderer** — a **render target** *plus* a lifecycle (`start`/`stop`) and a `kind`, and **not agent-bound**: it projects bus state to a destination that is not a conversational surface (Mission Control dashboard, PagerDuty, a webhook). Contract: `Renderer` (`src/renderers/types.ts:59-82`), which exposes its render-target face via `readonly surfaceConfig` (`:79-81`).
- **Dispatch source / dispatch sink** — architectural **roles**, not types. An adapter plays both; a renderer plays sink only. A sink never signs.

Three properties separate a renderer from an adapter (`CONTEXT.md`, §Renderer):

|  | inbound? (dispatch source) | agent-bound? (agent presence) | lifecycle? (`start`/`stop`) |
|---|---|---|---|
| **Platform adapter** | yes | yes | yes |
| **Renderer** | no | no | yes |
| **Render target** | no | no | no |

- **Surface plugin** (the unqualified word **plugin**) — a platform adapter **or** a renderer packaged as a separately-installable unit the running daemon loads at boot. A plugin declares its `kind` (`adapter` | `renderer`). ADR-0024 specifies the load mechanism, compat contract, and trust posture.
- **Plugin SDK** (the **adapter/renderer SDK**) — the ONE stable, versioned barrel a surface plugin compiles against: it exports **`PlatformAdapter` AND `Renderer`** plus the envelope/target types they need, plus the version constant the loader gates on (§3.1). An out-of-tree plugin imports from here and nowhere else in cortex.
- **bundle** — arc's *delivery* unit. A plugin ships **in** a bundle. Not synonyms.
- **binding** — a `surfaces.{platform}[]` entry `{ agent, stack?, binding }` mapping platform credentials to an agent/stack (`src/common/types/surfaces.ts:327-341`). **Adapters have bindings; renderers do not** (§3.5).
- **surface gateway** — the separate-process surface owner (cortex#524) that holds one platform connection per bot-user identity, publishes **unsigned** on the local hop, and lets the **bound stack re-sign on ingest**. The stack is the sole cryptographic signer (M3).
- **substrate harness** — the M6 layer that executes a dispatch. Adapters and renderers are M7; harnesses are M6. This design touches only M7.

New terms this design coins (landing in CONTEXT.md on branch `docs/adapter-sink-vocabulary`, not in this PR): **compat gate**, **SurfacePluginRegistry**, **`SURFACE_SDK_VERSION`**.

---

## 2. Current state — verified stocktake (2026-07-09, worktree @ v6.7.0 / c447e062)

The epic's stocktake was captured @ origin/main `83e73ec2`; re-verified here against the current tree. LOC counts are exact; line numbers below supersede the epic's where they drifted (S9/cortex#1523 moved per-stack construction since 83e73ec2 — see §2.1).

| # | Finding | Status | Evidence (current tree) |
|---|---|---|---|
| 1 | Four in-core adapters: discord 2 858 / mattermost 1 469 / slack 1 189 / web 535 LOC | ✅ | `wc -l src/adapters/{discord,mattermost,slack,web}` |
| 2 | Clean adapter contract exists — `start/stop`, `updateConfig?` (F-092), `attachInboundDispatch?` | ✅ | `src/adapters/types.ts:183-264` (`updateConfig?` :251, `attachInboundDispatch?` :263) |
| 3 | Gateway construction has an injected factory seam, but hardcodes 4 platform methods + per-platform loops | ⚠️ | `src/gateway/gateway-adapters.ts:189-195` (factory iface), `:372-472` (`buildGatewayAdapters` per-platform loops) |
| 4 | Both construction paths now route through the same injected factory (S9 already extracted the per-stack loop) | ⚠️ **delta vs epic** | `src/cortex.ts:107,3152` → `wireSurfaceAdapters` (`src/runner/surface-adapter-boot.ts`); both call `defaultGatewayAdapterFactory` |
| 5 | dispatch-handler imports platform-generic code from `adapters/discord/*` | ❌ blocker | `src/bus/dispatch-handler.ts:25` (`attachment-types`), `:51` (`attachments`), `:52` (`channel-context`) |
| 6 | Legacy worklog reaches through `DiscordAdapter` — static import + `getClient()` + `formatEventForDiscord` | ❌ blocker | `src/cortex.ts:134` (import), `:335` (`formatEventForDiscord`), `:5882,5889` (`getClient`), `:5936` (format call) |
| 7 | `SurfacesSchema` is `.strict()` with 4 hardcoded platform keys — no out-of-tree platform validates | ❌ blocker | `src/common/types/surfaces.ts:327-341` |
| 8 | Platform npm deps live in cortex `package.json` | ❌ blocker | `package.json:47,48,55` |
| 9 | arc bundles + `dependencies:` ranges + repo-first install proven | ✅ | ADR-0017, `metafactory-bundle-discord` installed under `~/.local/share/metafactory/arc/repos/` |
| 10 | arc semver-range *enforcement* between installed packages + bundle `bun install` | ⚠️ likely missing | arc-side slice (arc#284 / S7) |
| 11 | Daemon runs TS via bun → dynamic `import()` of installed bundle source is feasible | ✅ | `src/cortex.ts:1` shebang; plists run `~/.local/bin/cortex start` |
| 12 | Config hot-reload machinery exists (`applied` vs `requiresRestart`) | ✅ | `src/common/config/watcher.ts:12-16,101-106` |
| 13 | Gateway lifecycle is all-or-nothing `start()/stop()`; no per-adapter runtime attach/detach | ❌ missing | `src/gateway/surface-gateway.ts:167,191` |
| 14 | No existing ADR/issue covers adapter extraction/hot-loading | ✅ gap | ADR-0001..0023 checked; this fills it |

### 2.1 The one material delta from the epic's stocktake

The epic (blocker #4) says the legacy per-stack boot "statically imports/constructs Discord/Mattermost/Slack" in `cortex.ts` at `:143,169,170` / construction `~:3771-4160`. Since 83e73ec2, **S9 (cortex#1523) already extracted that construction** into `wireSurfaceAdapters` (`src/runner/surface-adapter-boot.ts`), which calls the *same* `defaultGatewayAdapterFactory` the gateway uses (`src/gateway/gateway-adapters.ts:264-347`, module doc §"S9 … a second caller" :54-69). So:

- The "two construction paths must both consume the registry" work (S3) is **further along than the epic implies** — both paths already funnel through one factory object. S3 becomes "turn that fixed 4-method factory into a platform-keyed registry", not "unify two divergent construction sites."
- The **real** remaining `cortex.ts`↔adapter coupling is **blocker #6, not #4**: `cortex.ts` still *statically imports* `DiscordAdapter` (`:134`) purely for the worklog reach-through (`getClient()` at `:5889`, `formatEventForDiscord` at `:335,5936`). That static import is what pins `discord.js` into the core dependency graph regardless of the factory. **S2 (worklog decoupling) is therefore load-bearing for the discord extraction (S12), and blocker #4 is mostly retired.** The ADR records this so S3's issue can be trimmed.

### 2.2 Renderer-side stocktake (the fold-in) — verified 2026-07-11

The renderer track was not in the epic's stocktake. Verified against the current tree:

| # | Finding | Status | Evidence (current tree) |
|---|---|---|---|
| R1 | `createRenderer()` switches on a **CLOSED** `RendererKind` enum; `cli-tail` + `webhook-out` throw `UnimplementedRendererKindError` | ❌ **blocker (the renderer-side twin of the adapter blocker)** | `src/renderers/index.ts:32-49` (switch), `:22-30` (error); enum `src/common/types/cortex-config.ts:1020-1025` |
| R2 | Adding a renderer today = edit the enum **AND** the discriminated-union schema **AND** the factory = a cortex release | ❌ blocker | `cortex-config.ts:1020-1025` (enum) + `:1193` (`RendererSchema` discriminated union) + `renderers/index.ts:33` (switch) |
| R3 | `SurfaceRouter.register()` **already returns an `{ unregister }` handle** — per-instance runtime detach for render targets EXISTS | ✅ **contract present** | `src/bus/surface-router.ts:262` (declared), `:456-464` (implementation splices the adapter out) |
| R4 | …but the renderer boot path **discards** that handle | ⚠️ trivially fixable | `src/cortex.ts:3257` — `router.register(renderer.surfaceConfig);` return value dropped; shutdown instead calls `router.stop()` wholesale (`:5857`) + `renderer.stop()` per instance (`:5864-5868`) |
| R5 | Per-renderer **fail-isolation at boot already exists** — one broken renderer logs + skips, daemon and peers keep running | ✅ | `src/cortex.ts:3254-3268` (try/catch around `createRenderer` + `start()`), plus schema-reject `continue` at `:3243-3249` |
| R6 | Renderer contract explicitly declares **"Renderers are static across hot-reload"** with a stated rationale | ❌ **decision to reverse** | `src/renderers/types.ts:45-57` |
| R7 | Renderers have **no binding**, no demux key, no token-grouping — they are configured by a flat `renderers[]` array, not `surfaces.{platform}[]` | ✅ structural difference | `src/common/types/config.ts:916` (`renderers: z.array(z.unknown()).optional()`), parsed per-item at `cortex.ts:3242` |
| R8 | Renderers **DO carry secrets** — PagerDuty `routingKey`, webhook-out `authHeader` | ⚠️ **corrects a fold-in assumption** | `cortex-config.ts:1142` (`routingKey: z.string().min(1)`), `:1179` (`authHeader: z.string().optional()`) |
| R9 | `renderer.id` is a **hardcoded per-kind constant**, so two same-kind instances collide on id | ❌ defect surfaced by the fold-in | `src/renderers/dashboard.ts:59` (`this.id = "dashboard"`), `src/renderers/pagerduty.ts:73` (`this.id = "pagerduty"`) |
| R10 | Neither in-tree renderer has an npm dep (PagerDuty uses `fetch`; dashboard is an in-memory buffer) | ✅ | `src/renderers/dashboard.ts:35-38`, `src/renderers/pagerduty.ts:38-41` (type-only imports) |
| R11 | `DashboardRenderer` is a **retained-but-inert stub** — nothing in production reads `getRecent()`; the real bus→MC seam is a *different* render target | ✅ **corrects a fold-in assumption** | `src/renderers/dashboard.ts:1-32` (module doc: "SUPERSEDED as the MC feed", "functionally inert"); live seam is `src/surface/mc/projection/dispatch-lifecycle-renderer.ts` |
| R12 | Removing `kind: dashboard` from the union is a **config-breaking change** (a principal carrying it fails that renderer) | ⚠️ | `src/renderers/dashboard.ts:18-21` (module doc states exactly this) |
| R13 | The **G-1111 §4.6 fail-safe rule** requires ≥2 distinct platform classes covering `local.{principal}.system.>`; dashboard+pagerduty are that pair | ⚠️ **constrains extraction** | `src/renderers/types.ts:15-21`, `src/renderers/dashboard.ts:22-26`, `src/renderers/pagerduty.ts:4-8` |

**Three of these materially change the fold-in as briefed** — recorded here rather than silently absorbed:

- **R8 kills "renderers have no secrets."** The fold-in's per-kind difference list said renderers have "no `secretFields`". Two facts: (a) **`secretFields` does not exist anywhere in cortex today** (`grep -rniE 'secret_?fields' src/ docs/` → empty; it is not in the plugin manifest shape in §3.1 either), and (b) renderer configs **do** hold credentials — a PagerDuty routing key and a webhook auth header. What renderers lack is a **binding** (agent↔surface credential mapping) and therefore a *per-binding* secret in `surfaces.*`; they still carry *config* secrets in `renderers[]`. **Consequence:** the D4 confidentiality/hygiene mitigations apply to renderer bundles **identically**, and no "renderers are less sensitive" carve-out is warranted. The honest per-kind difference is *no binding schema, no demux key, no token-grouping* — not *no secrets*.
- **R11 corrects the reason "dashboard stays in-tree."** It stays in-tree, but **not** because `DashboardRenderer` serves Mission Control — it does not. It is an inert ring-buffer stub; MC's live feed is `src/surface/mc/projection/dispatch-lifecycle-renderer.ts`, a render target registered by MC itself, not a `Renderer` produced by `createRenderer()`. The correct reason is **R12 + R13**: removing `kind: dashboard` breaks configs, and it is one half of the G-1111 §4.6 fail-safe pair. The conclusion survives; the rationale had to change.
- **R9 breaks a registry keyed by `(kind, id)` for renderers.** `renderers[]` is an array — a principal may declare two `kind: pagerduty` entries (different routing keys, different `subscribe` sets). Both construct with `id = "pagerduty"`. A `(kind, id)`-keyed **instance** registry would collide and a hot `unload pagerduty` verb would be ambiguous. See §3.5 for the resolution (registry keys plugin *classes*; instances are keyed separately and need a config-supplied `id`).

---

## 3. Proposed architecture

Five pieces, layered so extraction is "move a module out", never "rewire the core". The order below is the dependency order (S3 → S4 → S5 → S6 → S8), matching the epic's wave plan.

### 3.1 Plugin SDK — ONE stable, versioned contract surface for BOTH classes (S5)

A dedicated export surface in cortex (`src/surface-sdk/`, new) re-exports the *stable* subset a plugin links against — **for both plugin classes**:

- **adapter side:** `PlatformAdapter`, `InboundMessage`, `ResponseTarget`, `AccessDecision`, `OutboundFile`, the message/target types (`src/adapters/types.ts:183-264`);
- **renderer side:** `Renderer` (`src/renderers/types.ts:59-82`), `RendererVisibility`, and the render-target contract it exposes as `surfaceConfig` (`src/bus/surface-router.ts:76`, today misnamed `SurfaceAdapter` — the SDK re-exports it under its intended name `RenderTarget`, which is also the cheapest place to land that rename);
- **shared:** `Envelope`, `PayloadFilter`, and the `SurfacePlugin` manifest shape (below).

Cortex exports a single integer-major `SURFACE_SDK_VERSION` (new; none exists today — `grep -rn "SDK_VERSION" src/` → empty). Plugins declare the range they satisfy.

> **Naming note (fold-in):** the draft called this `ADAPTER_SDK_VERSION` / `src/adapter-sdk/`. Because the barrel now carries the `Renderer` contract too, an adapter-specific name would be a lie on day one. Renamed to `SURFACE_SDK_VERSION` / `src/surface-sdk/` before anything is built. The S5 issue should adopt these names.

```ts
// The shape a plugin's entry file default-exports. ONE manifest, two kinds.
export type SurfacePlugin = AdapterPlugin | RendererPlugin;

interface SurfacePluginBase {
  /** semver range over cortex's SURFACE_SDK_VERSION, e.g. "^1". THE compat gate (§4). */
  sdkRange: string;
  /** stable plugin id, unique within its kind. Registry key is (kind, id). */
  id: string;
}

export interface AdapterPlugin extends SurfacePluginBase {
  kind: "adapter";
  /** platform id — the surfaces.{platform} key and adapter.platform (e.g. "slack"). Equals `id`. */
  platform: string;
  /** the binding schema this platform contributes to SurfacesSchema (§3.3). */
  bindingSchema: ZodTypeAny;
  /** binding → demux key (Slack: workspaceId; Mattermost: apiUrl; Discord: token group). */
  demuxKey(binding: unknown): string;
  /** optional: platforms that group multiple bindings onto one connection (Discord tokens). */
  groupBindings?(bindings: unknown[]): BindingGroup[];
  /** construct (never start) an adapter — the registry entry the factory calls. */
  createAdapter(args: AdapterFactoryArgs): PlatformAdapter;
}

export interface RendererPlugin extends SurfacePluginBase {
  kind: "renderer";
  /** renderer kind — the `renderers[].kind` discriminant (e.g. "pagerduty"). Equals `id`. */
  rendererKind: string;
  /** the config schema this kind contributes to RendererSchema (§3.5). MUST include `kind` +
   *  `subscribe`; MAY include secrets (PagerDuty routingKey, webhook authHeader — see R8). */
  configSchema: ZodTypeAny;
  /** construct (never start) a renderer — the factory entry `createRenderer` dispatches to. */
  createRenderer(config: unknown): Renderer;
}
```

The SDK is the **contract**; its version is what the compat gate checks (§4). Keeping it a distinct module (not "import from `src/adapters/types.ts`") lets cortex refactor internals freely while holding the SDK surface stable, and gives the ADR one file whose changelog *is* the compat history. **One barrel, one version, both classes** — a plugin that ships an adapter and a renderer together (a hypothetical `metafactory-slack` shipping the adapter plus a Slack-alerting renderer) declares one `sdkRange`.

### 3.2 Bundle shape (arc) — one repo per surface (S9–S12, S7 arc-side)

Per-surface repo `metafactory-<platform>`, the same repeatable shape ADR-0017 established for tooling, now carrying the adapter:

```
metafactory-slack/
  arc-manifest.yaml        # version; dependencies: (compat metadata, advisory)
  cortex-plugin.yaml       # kind, id, entry file, sdkRange, cortex range (advisory)
  package.json             # @slack/socket-mode, @slack/web-api — deps leave cortex core
  src/index.ts             # default-exports a SurfacePlugin
```

`arc install metafactory-slack` lands it under `~/.local/share/metafactory/arc/repos/metafactory-slack/` and runs its `bun install` (arc#284 / S7). Distribution is **repo-first** (ADR-0017's decision) — registry-by-name publication is later and gated on a principal sign-off (HOLD).

The manifest is **one file for both kinds** — `cortex-plugin.yaml` (not `cortex-adapter.yaml`; the draft's name predates the fold-in). It carries `kind: adapter | renderer`; `entry`; `sdkRange`; and the advisory `cortex` range. A renderer bundle (`metafactory-pagerduty`) has the identical shape with `kind: renderer` and, typically, no `package.json` deps at all (R10).

### 3.3 Discovery + loading — one kind-keyed registry with fail-isolation (S3, S4, S6)

**This is the whole point of one plugin class:** discovery, the compat gate, `import()`, shape validation, fail-isolation, and registration are **written once** and parameterised by `kind`. We refuse to build the loader twice.

- **SurfacePluginRegistry** (S3): replace the fixed 4-method `GatewayAdapterFactory` (`src/gateway/gateway-adapters.ts:189-195`) with a registry keyed by **`(kind, id)`** — `Map<"adapter"|"renderer", Map<id, SurfacePlugin>>`. Both adapter construction paths (`buildGatewayAdapters` + `wireSurfaceAdapters`) resolve their per-binding factory from the `adapter` half; the renderer boot loop (`src/cortex.ts:3242-3268`) resolves `createRenderer` from the `renderer` half instead of the closed switch (`src/renderers/index.ts:32-49`). The in-tree adapters *and* the in-tree renderers register at boot exactly as bundles do — **dogfooding**: extraction later is "delete the in-tree registration + move the module out", not "rewire the core."
  - **The registry keys plugin *classes*, not instances (R9).** `(kind, id)` identifies the *code* — `("adapter","slack")`, `("renderer","pagerduty")`. Live **instances** are separate: an adapter instances per binding (`instanceId`, `src/adapters/types.ts:186`), a renderer instances per `renderers[]` entry. Today every renderer hardcodes `id` to its kind (`dashboard.ts:59`, `pagerduty.ts:73`), so two `kind: pagerduty` entries produce two renderers with the same `id` — indistinguishable in router metrics and unaddressable by a future `unload` verb. **S3 must add an optional `id` to each renderer config** (defaulting to `kind` for the single-instance case) and pass it into the constructor. This is a pre-existing defect the fold-in surfaces; it is filed as its own slice, not fixed opportunistically.
- **Registry-contributed schemas** (S4): the same move on both sides.
  - *Adapters:* `SurfacesSchema` (`src/common/types/surfaces.ts:327-341`) stops being `.strict()` over 4 hardcoded keys and composes its per-platform schemas from the registry (each `AdapterPlugin.bindingSchema`). An installed bundle *contributes* its binding schema, so `surfaces.slack[]` validates even though no Slack code ships in cortex.
  - *Renderers:* `RendererSchema` (`src/common/types/cortex-config.ts:1193`) stops being a fixed `z.discriminatedUnion("kind", [...])` over four literals and composes from each `RendererPlugin.configSchema`; `RendererKindSchema` (`:1020-1025`) stops being a closed `z.enum` and becomes the registered key set. `UnimplementedRendererKindError` (`src/renderers/index.ts:22-30`) disappears: an unknown kind is no longer "recognised by the schema but unimplemented" — it is simply *not registered*, which is the honest error.
  - Unknown-key strictness is preserved *against the registered set* on both sides (a typo `discrod:` or `kind: pagerduy` still fails loudly, naming the registered alternatives).
- **Loader** (S6, the trust-path slice): at boot the daemon scans installed bundles for `cortex-plugin.yaml`, runs the **compat gate** (§4), `await import(entry)`, validates the `SurfacePlugin` shape *for its declared kind*, and registers it under `(kind, id)`. **Per-plugin failure isolation** — a bad/incompatible/throwing plugin is skipped with a `system.error` event; the daemon and every other plugin keep running (DoD steps 3 & 5). Fail-isolation is a *robustness* boundary, not a security one (§6).
  - Renderer-side, boot fail-isolation **already exists and is the pattern to generalise**: `src/cortex.ts:3254-3268` wraps `createRenderer` + `start()` in a try/catch that logs and continues, and `:3243-3249` skips a schema-rejected renderer. The loader's per-plugin isolation should collapse into that same shape (upgraded from `console.error` to a `system.error` event).

### 3.4 Discord token-grouping travels into the registry entry (S3)

`groupDiscordBindingsByToken` (`src/gateway/discord-token-groups.ts`, used at `gateway-adapters.ts:385`) is platform-specific: Discord delivers all guild events for a bot token over one gateway session, so bindings are token-keyed not guild-keyed. This logic must move *into* the discord `AdapterPlugin.groupBindings()` (the generic loop calls `groupBindings?.()` when present, else one-adapter-per-binding). **No discord special-case survives in the generic loop** — else extraction (S12) strands it.

### 3.5 Two plugin classes, one SDK — what is shared and what differs

**Renderers face the same wall as adapters, for the same reason.** Adding a renderer today means editing a closed `RendererKind` enum (`src/common/types/cortex-config.ts:1020-1025`), the `RendererSchema` discriminated union (`:1193`), **and** the `createRenderer` switch (`src/renderers/index.ts:32-49`) — three in-tree edits and a cortex release. `cli-tail` and `webhook-out` have sat in the enum, unimplemented, throwing `UnimplementedRendererKindError` (`:22-30`), since MIG-7.2d: the enum promised a plugin point the factory never delivered. That is the renderer-side twin of the adapter blocker, and it is *the same bug*.

**Decision (principal-approved, grill-with-docs 2026-07-11): two plugin classes, ONE SDK barrel.** A **platform adapter** and a **renderer** remain distinct concepts — the `CONTEXT.md` table (§1.1) is the definition, and nothing in this design blurs it. But *loading code into a daemon* does not care what the code does. So they share:

| Shared (properties of loading code into the daemon) | Differs (properties of what the code does) |
|---|---|
| One manifest file `cortex-plugin.yaml`, discriminated by `kind: adapter \| renderer` | Adapter contributes a **binding schema** to `surfaces.{platform}[]`; renderer contributes a **config schema** to `renderers[]` |
| One discovery + `import()` + shape-validation path (S6) | Adapter needs a **demux key** (binding → connection) and optional **`groupBindings`** (Discord token grouping); a renderer has neither — `renderers[]` is a flat array, one instance per entry (R7) |
| One compat gate: `satisfies(SURFACE_SDK_VERSION, plugin.sdkRange)`, loader-authoritative (§4, D1) | Adapter declares `platform` + `createAdapter()`; renderer declares `rendererKind` + `subscribe` subjects + `createRenderer()` |
| One per-plugin fail-isolation policy: skip the plugin, `system.error`, daemon + peers live (§3.3) | Adapter is a **dispatch source and sink**; renderer is a **dispatch sink only** — it never publishes as a side effect of rendering (`src/renderers/types.ts:40-43`) |
| One registry keyed by `(kind, id)` (§3.3) | Adapter is **agent-bound** (holds a chat-surface credential, carries an agent presence); renderer is not |
| One trust posture: in-process, full daemon authority (§6, D4) | Adapter attaches to the **surface gateway**; renderer attaches to the **surface-router** as a render target via `surfaceConfig` (`src/renderers/types.ts:79-81`) |

**Rejected: merging them into one class.** A single `SurfacePlugin` interface where a renderer stubs the **ten** adapter-only required methods (`getPlatformUserId`, `fetchContext`, `resolveAccess`, `postResponse`, `sendTyping`, `sendProgress`, `clearProgress`, `createThread`, `resolveLogicalTarget`, `notifyPrincipal` — `src/adapters/types.ts:205-249`; the fold-in brief estimated eight) buys nothing and destroys the property that makes the router safe: a render target *cannot* publish, and the type system should say so. The distinction is real; only the loader is shared.

**Renderers DO carry secrets (R8).** `PagerDutyRendererSchema.routingKey` (`cortex-config.ts:1142`) and `WebhookOutRendererSchema.authHeader` (`:1179`) are credentials. What a renderer lacks is a **binding** — the agent↔surface credential mapping — not secrets in general. Every D4 mitigation (org-trusted repos, `check-shippable-hygiene.ts` + `confidentiality-gate` on bundle repos, provenance pinning) applies to renderer bundles **unchanged**. There is no "renderers are lower-risk" carve-out: a renderer bundle runs in-process with the same full daemon authority as an adapter bundle, and `await import()` executes its top-level code identically.

---

## 4. Compat model — **[AWAITING PRINCIPAL DECISION #1]**

The issue requires picking ONE primary gate and naming who refuses. The epic's proposal carries *both* an `sdkRange` and a `cortex: >=X <Y` range. **Recommendation: the SDK semver range is the primary (authoritative) gate; the cortex version range is optional advisory metadata only.** Who refuses: **the loader (runtime, authoritative); arc install (advisory warning only).**

**Why SDK-range over cortex-version-range as the gate:**

- The whole point of the epic is that *a surface change should not require a cortex release* — and, symmetrically, *a cortex release should not invalidate an unchanged surface*. A `cortex: ">=6.7 <7"` gate couples the bundle to cortex's marketing version, which bumps for reasons unrelated to the adapter contract (a dashboard change, a federation change). Every such release would force bundles to widen their range or re-publish — re-coupling exactly what we decoupled.
- The **SDK version is the honest contract**: it bumps major only when `PlatformAdapter`, `Renderer`, or `SurfacePlugin` breaks. cortex can go 6.7 → 7.0 and, as long as `SURFACE_SDK_VERSION` stays `1.x`, every `sdkRange: "^1"` bundle loads unchanged. The gate tracks the thing that actually breaks compatibility.
- **Only the loader knows the truth.** `SURFACE_SDK_VERSION` is a property of the *running* daemon. arc install sees the *installed-at-that-moment* cortex, which `arc upgrade cortex` can change afterward — so arc install can only *warn*, never authoritatively gate. The loader, running inside the daemon, checks `satisfies(SURFACE_SDK_VERSION, plugin.sdkRange)` at load time and is the sole authority. This also gives the fail-isolation contract its home: the loader refuses one bundle with a `system.error` reason and keeps the rest live (DoD step 5).

**Consequence to accept:** cortex must treat `SURFACE_SDK_VERSION` as a real semver contract with discipline — a breaking change to `PlatformAdapter`/`Renderer`/`SurfacePlugin` is a *major* SDK bump (and a documented migration for bundle authors), not a silent edit. This is the cost of the decoupling; it is the right cost.

**The `cortex` range stays** in `cortex-plugin.yaml` as optional human/advisory metadata (arc install may surface "bundle targets cortex ~6.x; you run 7.0"), but it is **not** the load gate.

> If the principal prefers a cortex-version-range gate (simpler mental model, one version to reason about), the trade is: bundles re-declare/re-publish on cortex releases that don't touch the adapter contract, and arc-install-time checks become misleading after `arc upgrade cortex`. Recommendation stands on SDK-range; this is the decision to confirm.

---

## 5. Hot-load semantics — **[AWAITING PRINCIPAL DECISION #3]**

The epic proposes "both, verbs in S8." **Recommendation: boot-time discovery is the v1 MVP bar (S6); runtime `load`/`unload`/`reload` verbs land as a separate slice (S8), not gated into the v1 loader.**

**MVP (S6):** the daemon discovers + compat-gates + imports + registers bundles **at boot**. Installing a bundle and *restarting the daemon* is enough to bring a surface live — that already delivers the epic's core value (no cortex release). This is low-risk: no cache busting, no drain, no per-adapter attach/detach.

**Runtime hot verbs (S8):** `cortex adapter list|load|unload|reload`. These carry three real hazards the ADR must name and S8 must handle:

1. **Module-cache busting.** bun caches a module by resolved path; a plain re-`import()` returns the cached instance and never picks up a new bundle version. The proposal busts the cache with a query-param import (`import(entry + "?v=" + version)`). **State loss / bounded leak:** the *old* module object is not evicted from the cache — it is only dereferenced. Its top-level singletons (a `discord.js` `Client`, timers, an SSE server) survive until GC, and GC cannot run while a reachable reference exists. So `unload` MUST call `adapter.stop()` and drop *every* reference (registry entry, gateway/router attachment, any closure) before the next `load` — otherwise the platform connection leaks. This is a **documented, bounded leak** (one stale module tree per reload), acceptable for a principal-driven verb, not for an automatic reload-on-file-change loop.
2. **In-flight drain.** An adapter is a live dispatch source *and* sink. `unload` must (a) stop accepting new inbound (`adapter.stop()` tears down the platform listener), and (b) let in-flight outbound lifecycle deliveries settle. Recommendation: `stop()` stops inbound immediately; the outbound sink drains for a bounded window (reuse the sink drain the `DispatchSink`/`ReviewSink` already implement — `src/adapters/dispatch-sink.ts`), then detaches. A dispatch mid-flight whose sink detaches before completion loses its surface delivery — surfaced as a `system.error`, not a silent drop.
3. **Per-adapter attach/detach (blocker #13).** `SurfaceGateway.start()/stop()` (`src/gateway/surface-gateway.ts:167,191`) is all-or-nothing today. S8 adds per-adapter attach/detach on the gateway *and* the router so one adapter unloads without cycling the others. This is the bulk of S8's real work.

**State loss on reload (explicit):** adapters hold connection state (Discord session, Slack socket, progress-message placeholders keyed by `sessionId`, `src/adapters/types.ts:167`). A `reload` = full `stop()` + reconstruct: **in-memory adapter state is lost by design** (progress placeholders reset; the platform reconnects fresh). Nothing durable is lost (no adapter owns durable state — response routing is wire-level, `CONTEXT.md:189`), but a "working…" placeholder mid-dispatch may orphan. Acceptable for a principal-driven verb; documented so nobody expects seamless reconnection.

> If the principal wants runtime verbs in v1 (S6), the loader slice grows to absorb S8's attach/detach + drain — larger, and it collides with the trust-path review lane the wave plan isolates S6 into. Recommendation keeps S6 boot-only and S8 separate.

### 5.1 Renderer hot-load semantics — and the reversal of "renderers are static"

**Renderers are cheaper to hot-load than adapters, by one decisive fact:** `SurfaceRouter.register()` **already returns an `{ unregister }` handle** (`src/bus/surface-router.ts:262`), and the implementation genuinely detaches one target — it splices that adapter out of the router's list (`:456-464`). Per-instance runtime detach for render targets **already exists**. Contrast the adapter side, where `SurfaceGateway.start()/stop()` is all-or-nothing (`src/gateway/surface-gateway.ts:167,191`) and per-adapter attach/detach is blocker #13 — the bulk of S8's real work.

The renderer gap is not the mechanism, it is the **call site**: the boot loop discards the handle (`src/cortex.ts:3257` — `router.register(renderer.surfaceConfig);`, return value dropped), and shutdown tears the whole router down (`:5857`) rather than detaching instances. So renderer hot-unload is: *retain the handle, call it, then `renderer.stop()`.* That is a small S8 sub-slice, not a subsystem.

**This design REVERSES a decision documented in the code.** `src/renderers/types.ts:45-57` states it plainly, and the reversal must be explicit rather than silent:

> *"**Renderers are static across hot-reload.** Unlike platform adapters (which carry an `updateConfig(AgentConfig)` hook that the `ConfigWatcher` invokes on bot.yaml changes), renderers have no config-update surface. A change to `renderers[]` — adding a pagerduty integration, rotating a routing key, expanding the dashboard subscription set — requires a cortex restart to take effect. This is intentional for the v1 slice: a renderer's resources (HTTP clients, ring buffers, subscriptions) are scoped to its lifetime, and the failure modes of partial hot-reload (a routing key swap mid-flight) are easier to reason about with a full stop/start cycle. A future iteration MAY add an `updateConfig(RendererConfig)` hook if the principal-visible cost of the restart proves too high (Holly cycle 1 W3)."*
> — `src/renderers/types.ts:45-57`

**Why that rationale no longer holds.** It rests on three premises, and the fold-in changes two of them:

1. *"A restart is cheap enough."* — **Changed.** The premise held when a renderer change meant editing config on a stack whose renderer code shipped in the binary anyway. Under this design a renderer arrives as a **separately-installable bundle** whose whole promise is "install it without a cortex release." A plugin you can install but not activate without a full daemon restart delivers half the epic's value, and it drags every *other* surface on that stack (every live Discord/Slack connection, every in-flight dispatch) through a restart to activate an unrelated PagerDuty sink. The restart's cost is no longer scoped to the thing being changed. That *is* "the principal-visible cost of the restart proving too high" — the condition the original comment itself named as the trigger for revisiting.
2. *"Partial hot-reload is harder to reason about than stop/start (a routing key swap mid-flight)."* — **Sidestepped, not contradicted.** The original worry is about **`updateConfig`-style mutation**: patching a live renderer's routing key underneath in-flight renders. This design does **not** add `updateConfig(RendererConfig)`. It adds **detach + destroy + construct + attach**: `unregister()` (`surface-router.ts:262`) removes the target from the router's dispatch list *first*, so no render can observe a half-swapped renderer; then `stop()` releases resources; then a fresh instance is constructed from the new config and re-registered. The mid-flight-swap failure mode the comment feared is structurally excluded — we honour its reasoning by *not* doing the thing it warned against. Full stop/start remains the semantic; the fold-in only shrinks its blast radius from *the daemon* to *one renderer*.
3. *"A renderer's resources are scoped to its lifetime."* — **Still true, and now load-bearing in our favour.** Because a renderer owns nothing durable and is a pure sink, destroying and reconstructing one is safe in a way that destroying an adapter is not (an adapter drops a live platform connection and orphans progress placeholders). The premise the comment used to justify *restart-only* is exactly what makes *per-instance reload* safe.

**Net:** the original decision is reversed on its own stated terms. The comment predicted the revisit condition and it has arrived. `src/renderers/types.ts:45-57` must be rewritten in the S8 renderer sub-slice (not silently — the doc comment is the decision record and must cite ADR-0024).

**Renderer-specific hot-load hazards** (the renderer analogue of §5's three):

1. **Module-cache busting** — identical to the adapter case; the query-param import trick and the *documented, bounded one-tree-per-reload leak* apply unchanged. `unload` MUST `unregister()`, `stop()`, and drop every reference before the next `load`.
2. **In-flight drain — strictly simpler.** A renderer has no inbound to stop and no outbound sink to drain. The router already wraps every `render()` in a per-call timeout + `Promise.allSettled` isolation (`src/renderers/types.ts:36-39`), so `unregister()` stops *new* renders immediately and at most one in-flight `render()` per subscription is outstanding. Drain = await the router's existing render timeout. **No new drain machinery.**
3. **State loss on reload (explicit).** A reloaded renderer loses in-memory state by design: `DashboardRenderer`'s ring buffer (`src/renderers/dashboard.ts:53`) resets — harmless today, because nothing in production reads it (`:16`, R11). PagerDuty holds no state beyond its `dedup_key` derivation, which is computed per-envelope from `${envelope.source}:${envelope.type}` (`src/renderers/pagerduty.ts:23-24`) and is therefore reload-stable. **Nothing durable is lost on either.**
4. **The G-1111 §4.6 fail-safe pairing is a reload-window hazard (new).** The rule requires ≥2 distinct platform classes covering `local.{principal}.system.>` so a degraded sink does not blind the principal (`src/renderers/types.ts:15-21`). Reloading the *pagerduty* renderer detaches the paging sink for the reload window; a `system.process.crashed` that lands in that window is rendered only to the (inert) dashboard. S8 must either (a) refuse to unload a renderer that would drop `system.>` coverage below two classes, or (b) attach-then-detach (register the new instance before unregistering the old — the router tolerates two targets with the same subjects; duplicate delivery for the overlap window is strictly safer than a blind window for a pager). **Recommendation: (b), attach-before-detach, and let PagerDuty's `dedup_key` absorb the duplicate.**

---

## 6. Trust model — **[AWAITING PRINCIPAL DECISION #4]**

**A loaded adapter bundle runs in-process with the daemon's full authority.** State this plainly; do not let the compat gate be mistaken for a security gate.

**The accepted risk.** An adapter loaded into the stack daemon (the per-stack `wireSurfaceAdapters` path) runs *inside the daemon process*. It therefore has — regardless of whether it ever calls the signer — access to everything the daemon has: the stack's NKey seed (it can mint signed envelopes as the stack), config secrets, the CC-session spawn path, bash, and the filesystem. `await import(entry)` executes arbitrary bundle code at load. **A malicious or compromised bundle = full stack compromise.** The compat gate (§4) gates *compatibility*, and fail-isolation (§3.3) gates *crashes/incompat* — **neither is a security boundary.**

**Mitigations (reduce likelihood; the risk itself is accepted):**

- **Org-trusted repos only.** v1 loads bundles only from the `the-metafactory` org via arc's repo-first install (ADR-0017). No arbitrary third-party / by-name registry loads. Installing a bundle is an explicit, reviewed act.
- **Same CI floor as cortex on bundle repos.** `scripts/check-shippable-hygiene.ts` (blocking) + the `confidentiality-gate` (gitleaks) run on every bundle repo — no live snowflakes, internal emails, seeds, or secrets ship (per the Critical Rules two-gate model).
- **Provenance pinning + upgrade-is-a-trust-act.** arc pins bundle install to a repo + ref; document that `arc upgrade`-ing a bundle re-executes new code with full authority and MUST be treated as a code-review event, not a passive fetch.
- **Fail-isolation is not a sandbox — say so.** The loader's per-bundle try/catch stops a *broken* bundle from crashing boot; it does nothing against a *malicious* one. The ADR states this explicitly so the isolation guarantee is never over-read.

**Future work (named, not built):** (a) registry signing — verify a bundle signature at install (mirrors the federation signing track, ADR-0018/0023); (b) if a real trust boundary is ever required, the **separate-process-over-IPC** adapter model (§ADR alternatives) is the escalation path — it is rejected *for v1* on cost/latency, but it is the architecturally-correct answer to "I need to run an untrusted adapter", and the design leaves that door open. The gateway's existing separate-process, unsigned-publish, stack-re-signs-on-ingest model (`CONTEXT.md:181`) is the partial precedent.

> The decision to confirm: **accept in-process/full-authority for v1 with the four mitigations above, org-trusted bundles only.** The alternative is to require the separate-process model from day one (safer, materially more work + latency, and unnecessary while every bundle is first-party). Recommendation: accept for v1.

---

## 7. In-tree adapters after extraction — **[AWAITING PRINCIPAL DECISION #2]**

The epic proposes: extraction PRs **delete** the in-tree adapter. **Recommendation: delete on extraction — keep only the in-tree *mock* adapter as the permanent contract-test dogfood.**

**Why delete, not keep-as-fallback:**

- A fallback copy is a **second source of truth** — the bundle and the in-tree copy drift, and "which one loads?" becomes a support question.
- The monolith never shrinks (defeats the epic's Why) and, decisively, **the platform npm deps cannot leave `package.json` (blocker #8) while an in-tree copy imports them.** `discord.js` stays pinned into core exactly as long as `src/adapters/discord/` and `cortex.ts:134` exist. Keep-as-fallback = never achieve the dependency extraction that is half the point.
- The **SDK + the in-tree mock** already provide the permanent in-tree contract anchor. The mock adapter drives the contract tests (`bun test src/adapters src/gateway`, DoD step 7) forever — the registry always has at least one in-tree entry, so "both paths consume the registry" stays exercised in CI without shipping a real platform.

So: each extraction PR (S9–S12) *deletes* the real in-tree adapter and its deps once its bundle is proven; the mock stays. Web pilots first (S9) precisely because it is the safest to delete (gateway-only, no npm dep, no secret in binding — §8).

> If the principal wants a transitional fallback (in-tree copy retained behind a flag for one release while bundles bake), that is a defensible conservative path — but it must be *time-boxed* (delete by release N+1) or blocker #8 never resolves. Recommendation: delete on extraction, no fallback, mock is the anchor.

### 7.1 How D2 applies to renderers — and the dashboard exception **[NEW OQ8]**

D2 as drafted says "extraction deletes the in-tree implementation." Applied to renderers it needs one restatement and one exception.

**Restatement.** The rule is not *"cortex ships no real in-tree plugins."* It is: **no plugin has two sources of truth.** An in-tree copy is forbidden *because* a bundle of the same plugin also exists — the drift and the "which one loads?" support question are what D2 kills, plus the npm-dep pin (blocker #8). A plugin that is **never extracted** has one source of truth and violates nothing.

**The `dashboard` renderer is that case, and it needs an explicit exception.** Three reasons, and note that the obvious one is **wrong**:

- ❌ *"Because `DashboardRenderer` serves Mission Control, and MC is core."* — **False.** Verified: `DashboardRenderer` is an in-memory ring-buffer stub, explicitly **superseded** as the MC feed by ADR-0005 §4, and **nothing in production reads its `getRecent()`** (`src/renderers/dashboard.ts:1-32`, esp. `:14-17`; the doc calls it "functionally inert as an MC feed"). The live bus→MC seam is a *different* render target — `src/surface/mc/projection/dispatch-lifecycle-renderer.ts` — registered by MC itself, push-based, never produced by `createRenderer()`. Do not justify the exception this way.
- ✅ *Removing `kind: dashboard` from the config union is a **config-breaking change**.* A principal whose `renderers[]` carries `kind: dashboard` and who has not installed a bundle gets that renderer skipped (`cortex.ts:3243-3249`). Wider blast radius than the plugin work owns (`src/renderers/dashboard.ts:18-21` says exactly this).
- ✅ *It is one half of the **G-1111 §4.6 fail-safe pair***, the two operationally-distinct classes covering `local.{principal}.system.>` (`src/renderers/types.ts:15-21`). Extracting it means a stack can be one `arc install` away from having **zero** system-event sinks. Retiring it needs that rule re-homed first.

**Recommendation:** `dashboard` **stays in-tree permanently** and registers through the registry like any other plugin (dogfooding, §3.3) — the renderer-side analogue of the mock adapter, except it is a real, shipping renderer rather than a test double. It is therefore the renderer track's permanent in-tree contract anchor; no renderer mock is needed. **D2 must be reworded** from "extraction deletes the in-tree adapter" to *"a plugin that ships as a bundle has no in-tree copy; plugins that never extract (mock adapter, dashboard renderer) stay in-tree as the permanent contract anchors."* → **OQ8.**

**`pagerduty` is the renderer pilot** — leaf-y, zero npm deps (R10), zero in-tree consumers, one config secret. It extracts and its in-tree copy is deleted, per D2 proper. But see §8: its extraction interacts with G-1111 §4.6 and with the OQ6 default-off posture, and that interaction is a genuine open question, not a detail.

---

## 8. Extraction order + per-adapter risk table

Order = the wave plan (S9 web → S10 slack ∥ S11 mattermost → S12 discord). Discord is last and hard-gated on S1 (relocate generic modules out of `adapters/discord/`) + S2 (worklog decoupling), because until those land, deleting `src/adapters/discord/` breaks `dispatch-handler.ts` (blocker #5) and `cortex.ts` (blocker #6).

| Adapter | LOC | npm deps | Legacy-path wiring | Secrets in binding | Blockers gating extraction | Risk | Wave |
|---|---|---|---|---|---|---|---|
| **web/SSE** | 535 | none | none (gateway-only, `CONTEXT`/epic note) | none (CF Access at edge, no bot token) | none | **Low — pilots the pattern** | S9 |
| **slack** | 1 189 | `@slack/socket-mode`, `@slack/web-api` | gateway + per-stack | botToken, appToken | needs arc#284 (dep install) proven | Medium | S10 |
| **mattermost** | 1 469 | (mattermost client) | gateway + per-stack | apiToken | disjoint from slack → parallel | Medium | S11 |
| **discord** | 2 858 | `discord.js` | gateway + per-stack + **worklog reach-through** + **generic modules imported by dispatch-handler** | token(s) | **S1 (#5) + S2 (#6) MUST land first** | **High — last** | S12 |

**Discord-specific debts to clear before S12** (all filed as their own slices, not "fixed while I'm in here"):
- Relocate `attachment-types`, `attachments`, `channel-context` out of `src/adapters/discord/` into a platform-generic home so `dispatch-handler.ts:25,51,52` no longer imports from a discord path (S1 / #1786).
- Decouple the worklog from `DiscordAdapter.getClient()` + `formatEventForDiscord` (`cortex.ts:134,335,5889,5936`) onto a platform-neutral sink so the static import can go (S2 / #1787).
- Move `groupDiscordBindingsByToken` into the discord `AdapterPlugin.groupBindings()` (S3 / §3.4).

### 8.1 Renderer track — extraction order + risk

The renderer track runs **in parallel with, and behind, the adapter track**: it shares S3–S7 (registry, schemas, SDK, loader, arc) and adds only its own extraction slices. **PagerDuty is the renderer pilot.**

| Renderer | LOC-ish | npm deps | In-tree consumers | Secrets in config | Blockers gating extraction | Risk | Disposition |
|---|---|---|---|---|---|---|---|
| **pagerduty** | ~130 | none (`fetch`) | none | `routingKey` (`cortex-config.ts:1142`) | needs registry-contributed `RendererSchema` (S4) + G-1111 §4.6 coverage rule re-homed | **Low–Medium — the renderer pilot** | extract → bundle; delete in-tree (D2) |
| **dashboard** | ~110 | none | none in production (`getRecent()` unread — `dashboard.ts:16`) | none | — | — | **stays in-tree permanently** (§7.1); the renderer track's contract anchor |
| **cli-tail** | 0 (unimplemented) | none | none | none | none — it is *only* an enum entry + a throw | **Lowest** | **born as a bundle**; delete the enum entry + the `UnimplementedRendererKindError` arm |
| **webhook-out** | 0 (unimplemented) | none | none | `authHeader` (`cortex-config.ts:1179`) | none | **Lowest** | **born as a bundle**; same |

**Why pagerduty pilots rather than cli-tail.** `cli-tail`/`webhook-out` are *easier* (they are zero LOC — they exist only as an enum literal and a `throw` at `src/renderers/index.ts:38-40`) and they are the best **proof** that the plugin point works: implementing one as an out-of-tree bundle is the renderer-track analogue of the epic's Slack DoD ("a surface with no code in cortex"). But they prove nothing about **deleting** in-tree code, which is the other half of the epic. So: **`cli-tail` is the first *born-as-a-bundle* renderer** (proves the load path, zero deletion risk, should ship inside S6 as the loader's own end-to-end test), and **`pagerduty` is the first *extraction*** (proves the deletion path). They are different proofs; run both.

**Two constraints the renderer track must respect:**

1. **G-1111 §4.6 vs. extraction.** Extracting `pagerduty` means a stack that has not run `arc install metafactory-pagerduty` has **one** class (the inert dashboard) covering `local.{principal}.system.>` — the fail-safe pairing rule is silently violated, and it is violated *by an install-state*, not by a config error. The rule "fires at config-load (MIG-1.10), not in the Zod schema" (`cortex-config.ts:1015-1018`), so it must be taught the difference between *"you configured one sink"* (an error) and *"you configured two, one's bundle isn't installed"* (a different, louder error). **→ OQ9.**
2. **The OQ6 default-off flag compounds it.** If external-plugin loading is default-off behind `system.adapters.external` (§3.3, OQ6 — recommended, secure default), then on a fresh stack the extracted `pagerduty` bundle is installed but **not loaded**, and the principal's paging sink is silently absent. A secure default for *adapters* (don't load third-party code) becomes a **fail-open default for renderers** (don't page). These pull in opposite directions and the flag's name (`adapters.external`) already mis-scopes what it gates. **→ OQ9/OQ10.**

---

## 9. Decisions this design locks (subject to §4–§7 confirmation)

1. **Compat gate = SDK semver range**, authoritative at the **loader**; cortex-version range is advisory metadata; arc install warns only. **Applies to both plugin kinds unchanged** — one `SURFACE_SDK_VERSION`, one gate; a renderer bundle declaring `sdkRange: "^1"` is refused or admitted by the same check. *(→ ADR-0024 D1)*
2. **Extraction deletes the in-tree implementation**; the in-tree **mock adapter** and the in-tree **dashboard renderer** are the permanent contract anchors; no fallback copies. **Renderer delta:** the rule is "no plugin has two sources of truth", so a never-extracted plugin (mock, dashboard) legitimately stays in-tree — D2 needs rewording (§7.1, **OQ8**). *(→ D2)*
3. **v1 MVP = boot-time discovery** (S6); runtime `load/unload/reload` verbs are a separate slice (S8). **Renderer delta:** S8's renderer half is far smaller — `SurfaceRouter.register()` already returns `{ unregister }` (`surface-router.ts:262,456-464`), so there is no attach/detach subsystem to build and no drain machinery (the router's per-render timeout is the drain). The work is "retain the handle the boot loop drops at `cortex.ts:3257`" plus attach-before-detach for G-1111 §4.6 coverage (§5.1). *(→ D3)*
4. **In-process = full daemon authority**, accepted for v1 with four mitigations. **Applies to renderer bundles identically** — `await import()` runs their top-level code with the same authority, and their configs carry real secrets (R8: `routingKey`, `authHeader`). No lower-risk carve-out for renderers. *(→ D4)*
5. **Both construction paths already share one factory** (S9); S3 turns that factory into a `(kind, id)`-keyed **SurfacePluginRegistry** rather than unifying two sites — the epic's blocker #4 is mostly retired, blocker #6 is the real residual. *(→ ADR consequence)*
6. **The in-tree adapters and renderers dogfood the registry** — extraction is "move the module out", never "rewire the core." *(→ D2/D3)*
7. **Two plugin classes, one SDK barrel** (§3.5). Adapter and renderer stay distinct concepts (`CONTEXT.md`); the manifest, discovery/load path, compat gate, fail-isolation policy, and registry are shared and built once. *(→ D5, new)*
8. **The `src/renderers/types.ts:45-57` "renderers are static across hot-reload" decision is REVERSED** on its own stated terms (§5.1). Its doc comment is a decision record and is rewritten, citing ADR-0024, in the S8 renderer sub-slice. *(→ D5 consequence)*
9. **Renaming before building:** `ADAPTER_SDK_VERSION` → `SURFACE_SDK_VERSION`, `src/adapter-sdk/` → `src/surface-sdk/`, `cortex-adapter.yaml` → `cortex-plugin.yaml`, `AdapterModule` → `SurfacePlugin`, `AdapterFactoryRegistry` → `SurfacePluginRegistry`. Nothing is built yet, so this costs an issue-title edit, not a migration. *(→ S5/S3/S6 issue updates)*

---

## 10. Open questions for the principal

> **✅ ALL RATIFIED 2026-07-11.** The principal accepted D1–D5 and every recommendation below.
> **OQ9 is resolved as (b) + (a):** boot **hard-fails** when `local.{principal}.system.>` coverage drops below two distinct platform classes, **and** first-party renderer bundles are exempt from the default-off `system.plugins.external` flag. The risk is deliberately moved from *silent no-page* to *loud no-boot* — a stack that cannot page refuses to start rather than running blind. See ADR-0024 §OQ9 for the implementation constraints (config-error vs install-state-error must be distinguished; "first-party" must be a checkable property, not a naming convention; inert `dashboard` must not satisfy coverage alone).
> **S12b (pagerduty extraction) is unblocked**, but MUST land the boot-coverage hard-fail before or with the extraction, never after.
> The questions are retained below as the decision record.


- **OQ1 — compat gate (pinned #1):** confirm SDK-range-primary + loader-authoritative, or prefer cortex-version-range? (§4)
- **OQ2 — fallback (pinned #2):** delete-on-extraction with mock-only anchor, or a time-boxed in-tree fallback? (§7)
- **OQ3 — hot-reload bar (pinned #3):** boot-discovery-only v1, or runtime verbs in v1? (§5)
- **OQ4 — trust (pinned #4):** accept in-process/full-authority for v1, or require separate-process isolation from day one? (§6)
- **OQ5 — SDK versioning discipline:** who owns the `SURFACE_SDK_VERSION` changelog + bundle-author migration notes, and does a breaking SDK bump block release until first-party bundles are updated in lock-step? (§3.1, §4)
- **OQ6 — `system.adapters.external` flag:** the wave plan lists "flipping `system.adapters.external` on any live stack" as a HOLD. Should external-plugin loading be **default-off behind this flag** for the whole v1 (in-tree registrations always load; external plugins only when the principal opts a stack in)? Recommendation: **yes** — secure default, matches the dev-loop-dormant-by-default posture. **Two riders from the fold-in:** (a) rename it `system.plugins.external` — it gates renderers too, and `adapters.external` would be a lie; (b) see OQ9 — for the pagerduty renderer, "default-off" is *fail-open*, not secure. (§3.3, §8.1)
- **OQ7 — registry-by-name publication:** stays a post-v1 HOLD (ADR-0017 already deferred it), confirmed? (§3.2)

**New open questions raised by the renderer fold-in:**

- **OQ8 — does D2 ("delete in-tree on extraction") need a dashboard exception?** **I believe YES, and the ADR should carry it explicitly.** The `dashboard` renderer never extracts (config-breaking to remove; one half of the G-1111 §4.6 fail-safe pair) — so it stays in-tree permanently as the renderer track's contract anchor, exactly as the mock adapter does on the adapter side. D2 should be reworded from *"extraction deletes the in-tree implementation"* to *"a plugin that ships as a bundle has no in-tree copy; never-extracted plugins (mock adapter, dashboard renderer) are the permanent in-tree anchors."* **Note the exception's usual justification is false:** `DashboardRenderer` does **not** serve Mission Control — it is an inert ring-buffer stub whose `getRecent()` nothing reads (`src/renderers/dashboard.ts:1-32`), and MC's real feed is a different render target. The exception is right; the reason had to be corrected. (§7.1)
- **OQ9 — how does extracting `pagerduty` interact with the G-1111 §4.6 fail-safe rule and OQ6's default-off flag?** After extraction, a stack that has not installed the bundle — or has installed it but left `system.plugins.external` off (the OQ6 *recommended secure default*) — has **one** class covering `local.{principal}.system.>`, and the one it has is inert. The pager silently does not page. This is the one place where "don't load third-party code by default" (secure for adapters) is **fail-open** (unsafe for renderers). Options: (a) exempt first-party renderer bundles from the flag; (b) hard-fail boot when `system.>` coverage drops below two classes (turns a missing `arc install` into a boot failure — loud, and arguably correct for a paging sink); (c) keep `pagerduty` in-tree too, and pilot the renderer track with a *born-as-a-bundle* `cli-tail` instead, deferring any renderer extraction. **Recommendation: (b) + (a) for first-party**, but this is a principal call — it trades boot availability against alert availability. (§8.1)
- **OQ10 — is a `renderers[].id` field acceptable as a schema addition in S3?** Two `kind: pagerduty` entries currently both construct with `id = "pagerduty"` (`src/renderers/pagerduty.ts:73`), colliding in router metrics and making a future `unload` verb ambiguous. A registry keyed by `(kind, id)` needs instance ids to be distinct. Fix: optional `id` on each renderer config, defaulting to `kind`. Additive, non-breaking. Confirm it lands in S3 rather than as a separate bug. (§3.3, R9)
- **OQ11 — should `cli-tail` / `webhook-out` be deleted from the enum now, or born as bundles?** They are enum entries that throw (`src/renderers/index.ts:38-40`) — a plugin point the factory never delivered. Recommendation: **born as bundles**, and ship `cli-tail` inside S6 as the loader's own end-to-end proof (a renderer with zero cortex code, exactly mirroring the Slack DoD). Their enum entries + the `UnimplementedRendererKindError` arm are then deleted. Confirm. (§8.1)
- **OQ12 — who owns rewriting `src/renderers/types.ts:45-57`?** The reversal (§5.1) invalidates a documented decision that cites "Holly cycle 1 W3". The comment must be rewritten to cite ADR-0024 rather than silently contradicted. Confirm this lands in the S8 renderer sub-slice, and that no other doc carries the "renderers are static" claim. (§5.1)

---

## 11. Feature breakdown (epic #1784 slices — ground truth is the wave-plan comment)

S0 (this doc + ADR-0024) · S1 relocate generic modules · S2 worklog decouple · S3 **SurfacePluginRegistry** (+ `renderers[].id`, OQ10) · S4 registry-contributed schemas (**both** `SurfacesSchema` and `RendererSchema`) · S5 **plugin SDK** (`PlatformAdapter` + `Renderer`, `SURFACE_SDK_VERSION`) · S6 loader + compat gate + fail-isolation (trust-path lane; ships `cli-tail` as a born-as-a-bundle renderer proof, OQ11) · S7 arc-side dep install + compat surfacing (arc#284) · S8 runtime attach/detach + `cortex plugin` verbs (**+ renderer sub-slice: retain the `unregister` handle; rewrite `renderers/types.ts:45-57`**, OQ12) · S9 web pilot extraction · S10 slack · S11 mattermost · S12 discord (last) · **S12b pagerduty renderer extraction** (gated on OQ9) · S13 docs/glossary/release.

The renderer track adds **no new shared slices** — it rides S3–S7 and contributes one extraction (S12b) plus one sub-slice of S8. That is the fold-in's payoff: one loader, two kinds.

**HOLDS (not executor decisions):** merging this ADR without the principal's review; creating any new `the-metafactory/*` repo (S9–S12, S12b); arc registry publication; community announcements; flipping `system.plugins.external` on a live stack; **extracting `pagerduty` before OQ9 is settled** (it can silently disable a stack's paging sink).
