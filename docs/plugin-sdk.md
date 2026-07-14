# Plugin SDK — authoring a surface plugin

**Status:** describes the v1 (S5, cortex#1790) contract surface, boot-time
out-of-tree bundle discovery/loading (S6, cortex#1792), and the runtime
attach/detach/reload lifecycle (S8, cortex#1793 — see §Runtime lifecycle
below). See [ADR-0024](adr/0024-pluggable-surface-adapters.md) for the full
decision record and `CONTEXT.md` §Adapter/renderer SDK for the canonical
vocabulary this doc uses.

## What a surface plugin is

`CONTEXT.md` §Surface plugin: a **platform adapter** or a **renderer**
packaged as a separately-installable unit the running cortex loads at boot.
The two are distinct concepts (adapter: agent-bound, inbound *and* outbound,
one live connection per surface; renderer: non-agent-bound, outbound only,
`start`/`stop` lifecycle) but share ONE mechanism — one manifest shape, one
discovery/load path, one compat gate, one fail-isolation policy, one
`SurfacePluginRegistry` — because those are properties of *loading code into
the daemon*, not of what the code does (ADR-0024 D5).

## The SDK barrel

`src/surface-sdk/index.ts` is the **one** module a plugin imports the
contract from:

```ts
import type {
  // Adapter contract
  PlatformAdapter, InboundMessage, InboundAttachment, AccessDecision,
  ResponseTarget, OutboundFile, ContextMessage, ContextAttachment,
  // Renderer contract
  Renderer, RenderTarget /* the render-target contract */, Envelope, RendererKind,
  // Plugin descriptor contract
  PluginKind, SurfacePlugin, AdapterPlugin, RendererPlugin,
  SurfaceBindingEntry, BindingGroup, GatewayConstructBase,
  // Host-injected policy port (cortex#1794 S9b)
  AdapterPolicyPort,
} from "@the-metafactory/cortex/surface-sdk"; // in-tree: "../../surface-sdk" (adapters) / "../surface-sdk" (renderers)
import type { SURFACE_SDK_VERSION } from "@the-metafactory/cortex/surface-sdk";
```

*(In-tree code uses the plain relative path shown above and in the skeletons
below. An out-of-tree bundle resolves the `@the-metafactory/cortex/surface-sdk`
specifier per §Resolving the SDK in an out-of-tree bundle, below.)*

`AdapterPolicyPort` (cortex#1794 S9b) is a dependency-inversion PORT, not a
data type: it describes `resolveAccess(msg)` / `isOperatorPrincipal(platform,
platformId)` as a bound behavior, so an adapter can authorise an inbound
message without importing cortex's `PolicyEngine` / `PlatformPrincipalIndex`
/ `PrincipalRegistry` (`common/policy`) directly. The host binds the port to
its real policy engine at construction time
(`adapters/plugin-support.ts`'s `buildAdapterPolicyPort`) and forwards it
through `createAdapter`'s args — see `src/adapters/web/index.ts`'s
`WebAdapterInfra.policy` for the first consumer.

### What's IN the barrel, and why nothing else is

The barrel re-exports exactly the types the `PlatformAdapter` / `Renderer` /
`SurfacePlugin` contracts reference — nothing else. It deliberately does
**not** re-export cortex's internal implementation machinery: `MyelinRuntime`,
`PolicyEngine`/`PlatformPrincipalIndex`/`PrincipalRegistry`, `SystemEventSource`,
`Agent`/`AgentConfig`/per-platform presence types, per-kind renderer config
schemas (`DashboardRendererSchema`, `PagerDutyRendererSchema`, …), the
`cc-events` tap reader, or formatting helpers. Those remain genuine
cross-boundary imports the four in-tree adapters and two in-tree renderers
still reach for today — ADR-0024's residual couplings (blockers #5–#8/#13).
**Web is the first exception** (cortex#1794 S9b): `src/adapters/web/*.ts`
now closes ALL of them — `common/policy` (via `AdapterPolicyPort` above),
`common/types/surfaces` (its `WebBindingSchema` relocated to the
plugin-owned `src/adapters/web/schema.ts`), and `common/types/
cortex-config`'s `Agent` (narrowed to the adapter-local `AdapterAgentIdentity
{id}`, the only field it ever read) — so it compiles against `surface-sdk`
alone; a stricter test in `boundary-guard.test.ts` (below) pins this for
`web/` specifically. Discord/Slack/Mattermost still reach for all of the
above (their dependency-inversion pass is cortex#1896) — not yet resolved.
Folding them into "the SDK" would mean a breaking change to
*any* of them forces an SDK major bump, which is not what's pinned: **only**
a breaking change to `PlatformAdapter`, `Renderer`, or the `SurfacePlugin`
descriptor shapes is a major bump (ADR-0024 D1). Full decoupling of an
adapter's implementation from cortex internals is the S9–S12 extraction work
for that specific plugin, not a property the barrel enforces up front.

The audit that produced the export list — re-run it any time to check for
drift:

```bash
# Adapters: every import reaching two levels above its own platform dir.
grep -rhn "^import" src/adapters/{discord,slack,mattermost,web}/*.ts | grep "\.\./\.\./" | sort -u

# Renderers: every import leaving src/renderers/ (single "../" — renderers/
# sits one level under src/, unlike the platform adapters at two levels).
grep -rhn "^import" src/renderers/*.ts | grep -E '"\.\./' | sort -u
```

Cross-reference against `src/surface-sdk/index.ts`'s export list: anything
that maps onto `PlatformAdapter`/`Renderer`/`RenderTarget`/`Envelope`/the
`SurfacePlugin` descriptor family should be imported from the barrel;
everything else on that list is an acknowledged, intentional exclusion.

## `SURFACE_SDK_VERSION` — the compat rule

```ts
export const SURFACE_SDK_VERSION = "1.0.0";
```

A plugin declares `sdkRange` (e.g. `"^1"`) in its default-exported
`SurfacePlugin`. The **S6 loader** — not `arc install`, not a `cortex:`
version range in the bundle's manifest — is the sole authoritative gate: at
`import()` time it checks `satisfies(SURFACE_SDK_VERSION, plugin.sdkRange)`
and refuses a non-satisfying plugin with a `system.error` event, leaving the
daemon and every other plugin live. A `cortex: >=X <Y` range MAY appear in
`cortex-plugin.yaml` as advisory metadata, never as the load gate (ADR-0024
D1) — only the running daemon's true `SURFACE_SDK_VERSION` is authoritative,
and arc-install-time cortex-version checks go stale on every cortex release
that doesn't touch the contract.

**One SDK, one gate, both kinds** (D5): a breaking change to `PlatformAdapter`
*or* to `Renderer` bumps the same major, even though that conservatively
refuses plugins of the *other*, unaffected kind. Accepted as coarse-but-honest
— two independently-versioned SDKs would reintroduce the two-loaders problem
D5 exists to prevent.

Bumping `SURFACE_SDK_VERSION` is a disciplined act: a breaking change to any
type the barrel exports is a MAJOR bump, documented in this file with a
plugin-author migration note.

## Compilable skeleton — an adapter plugin

The reference is the in-tree web adapter (`src/adapters/web/`) — it's the
simplest of the four (no token grouping, no secret binding fields). A
skeleton third-party adapter, `AcmeChatAdapter`:

```ts
// acme-chat-adapter/src/adapter.ts
import type { PlatformAdapter, InboundMessage, AccessDecision, ResponseTarget, OutboundFile } from "../../surface-sdk";

export class AcmeChatAdapter implements PlatformAdapter {
  readonly platform = "acme-chat";
  readonly instanceId: string;

  constructor(instanceId: string) {
    this.instanceId = instanceId;
  }

  async start(onMessage: (msg: InboundMessage) => Promise<void>): Promise<void> {
    // open the platform connection; call onMessage(...) per inbound event
  }
  async stop(): Promise<void> {
    // tear down the connection
  }
  async getPlatformUserId(): Promise<string> {
    return "acme-bot-id"; // resolved post-start, per the PlatformAdapter contract
  }
  async fetchContext() {
    return [];
  }
  resolveAccess(_msg: InboundMessage): AccessDecision {
    return { allowed: true, features: { chat: true, async: false, team: false } };
  }
  async postResponse(_target: ResponseTarget, _text: string, _files?: OutboundFile[]): Promise<void> {}
  async sendTyping(): Promise<void> {}
  async sendProgress(): Promise<void> {}
  async clearProgress(): Promise<void> {}
  async createThread(_msg: InboundMessage, _name: string): Promise<ResponseTarget> {
    throw new Error("acme-chat: threads not supported");
  }
  async resolveLogicalTarget(): Promise<ResponseTarget | null> {
    return null;
  }
  async notifyPrincipal(_text: string): Promise<void> {}
}
```

```ts
// acme-chat-adapter/src/plugin.ts
import { z } from "zod/v4";
import type { AdapterPlugin } from "../../surface-sdk";
import { SURFACE_SDK_VERSION } from "../../surface-sdk";
import { AcmeChatAdapter } from "./adapter";

const AcmeChatBindingSchema = z.object({
  agent: z.string().optional(),
  apiKey: z.string().min(1),
});

export const acmeChatAdapterPlugin: AdapterPlugin = {
  kind: "adapter",
  id: "acme-chat",
  platform: "acme-chat",
  bindingSchema: AcmeChatBindingSchema,
  foldsIntoPresence: false,
  secretFields: ["apiKey"],
  demuxKey: (binding) => String(binding.apiKey ?? "default"),
  buildGatewayConstructArgs: (group, base) => ({ instanceId: base.instanceId }),
  createAdapter: (args) => new AcmeChatAdapter((args as { instanceId: string }).instanceId),
};

// cortex-plugin.yaml declares: kind: adapter, sdkRange: "^1"
// The default export IS the SurfacePlugin, carrying `sdkRange` as a field
// (ADR-0024 D1: "sdkRange in its default-exported SurfacePlugin"). The S6
// loader reads `defaultExport.sdkRange`; the exact default-export contract
// (this field-on-plugin shape vs a wrapper) is finalized by the S6 loader.
export default { ...acmeChatAdapterPlugin, sdkRange: "^1" as const };
```

## Compilable skeleton — a renderer plugin

The reference is the in-tree `DashboardRenderer` (`src/renderers/dashboard.ts`)
for shape, and `PagerDutyRenderer` for a renderer that actually does I/O. A
trivial third-party renderer, `LogLineRenderer` (writes one line per envelope
to stdout):

```ts
// log-line-renderer/src/renderer.ts
import type { Renderer, Envelope, RenderTarget } from "../../surface-sdk";

export interface LogLineRendererConfig {
  id?: string;
  subscribe: string[];
}

export class LogLineRenderer implements Renderer {
  readonly kind = "log-line" as const;
  readonly id: string;
  readonly subjects: string[];

  constructor(config: LogLineRendererConfig) {
    this.id = config.id ?? "log-line"; // OQ10: id defaults to kind
    this.subjects = config.subscribe;
  }

  async start(): Promise<void> {}
  async stop(): Promise<void> {}

  async render(envelope: Envelope): Promise<void> {
    // MUST NOT throw (surface-router wraps this, but don't rely on it) and
    // MUST NOT publish on the bus as a side effect of rendering.
    process.stdout.write(`${envelope.type} <- ${envelope.source}\n`);
  }

  get surfaceConfig(): RenderTarget {
    return { id: this.id, subjects: this.subjects, render: (envelope) => this.render(envelope) };
  }
}
```

```ts
// log-line-renderer/src/plugin.ts
import { z } from "zod/v4";
import type { RendererPlugin } from "../../surface-sdk";
import { LogLineRenderer, type LogLineRendererConfig } from "./renderer";

const LogLineRendererSchema = z.object({
  kind: z.literal("log-line"),
  id: z.string().optional(),
  subscribe: z.array(z.string()).min(1),
});

export const logLineRendererPlugin: RendererPlugin = {
  kind: "renderer",
  id: "log-line",
  rendererKind: "log-line",
  configSchema: LogLineRendererSchema,
  createRenderer: (config) => new LogLineRenderer(config as LogLineRendererConfig),
};

// cortex-plugin.yaml declares: kind: renderer, sdkRange: "^1"
export default { ...logLineRendererPlugin, sdkRange: "^1" as const };
```

## Boundary-guard test

`src/surface-sdk/__tests__/boundary-guard.test.ts` walks every in-tree
platform-adapter file and both registered renderer implementations and fails
if any of them imports a plugin-contract symbol (the barrel's export list)
from its pre-SDK location instead of `../surface-sdk` / `../../surface-sdk`.
It is scoped to the CONTRACT surface only — it does not (and is not meant
to) forbid the other cross-boundary imports discussed above; those are
tracked as ADR-0024's residual couplings, resolved plugin-by-plugin as each
one extracts (S9–S12).

The same file also carries a second, STRICTER check scoped to `web/` only
(cortex#1794 S9b): rather than a symbol allowlist, it asserts NO `../../`
import survives in `src/adapters/web/*.ts` unless it resolves to
`surface-sdk` — the full "compiles against the SDK alone" bar, not just "the
contract types are re-exported from the right place." This is what a plugin
author should expect once their own adapter finishes its dependency-inversion
pass; run the audit command above against your own directory to check.

## Loading & the first-party exemption

`src/adapters/loader.ts` discovers installed bundles (`arc list --json`),
then gates each one through, in order: an unconditional org-trust check (only
`the-metafactory`-org repos ever load, ADR-0024 D4 mitigation #1), the
`system.plugins.external` flag (default OFF — see
`docs/config-layout/system/system.yaml`), the SDK compat range, a
duplicate-id/namespace-shadow check, and finally structural shape validation
of the imported default export. None of this is something a plugin author
needs to implement — it's listed here so you know WHY an installed bundle
might not load, and what "first-party" buys you.

**The `external: false` default means a THIRD-party bundle needs an explicit
principal opt-in to load at all.** Two exemptions let a bundle load anyway,
both anchored on something only CORTEX's own reviewed source controls —
never anything the bundle's own manifest, `id`, `kind`, or arc's `tier` field
says about itself (both were empirically checked and rejected as spoofable —
see `isFirstPartyRendererBundle`'s doc comment in `loader.ts`):

- **Renderer** (ADR-0024 §OQ9): the bundle's `repoUrl` is on
  `FIRST_PARTY_RENDERER_REPOS`, a hardcoded, PR-reviewed allowlist in
  `loader.ts`. Empty today — no first-party renderer bundle ships yet.
- **Adapter** (cortex#1794 S9a, epic #1784 "transparent repackaging"
  decision, 2026-07-12): the bundle's `repoUrl` matches an entry under
  cortex's OWN `arc-manifest.yaml` `dependencies:` block, read fresh at
  every boot (`readCortexDeclaredAdapterRepos`) — NOT a hardcoded allowlist,
  so declaring a new first-party adapter bundle is a plain `arc-manifest.yaml`
  PR, no loader code change. **Narrowed** (PR #1942 code-review fix): a
  dependency only counts if its `name` ALSO follows the compass#115
  `metafactory-cortex-adapter-<name>` repo-naming standard — being declared
  as a cortex dependency for some OTHER reason (`arc`, the package manager;
  `metafactory-bundle-discord`, ADR-0017 CLI/skill tooling) never grants the
  exemption, even though both are real, org-trusted, cortex-declared
  dependencies. This is what makes extracting an in-tree adapter (e.g.
  `web`) into its own bundle a *transparent* repackage: once cortex declares
  `metafactory-cortex-adapter-web`, `arc upgrade cortex` auto-installs it,
  this exemption loads it, and the surface keeps working with zero config
  change on any existing stack — `external` never has to be flipped for a
  repackage that isn't adding new third-party capability, only relocating
  cortex's own code. **Today the narrowed set is genuinely empty** — no
  declared cortex dependency currently has an adapter-shaped name — so the
  exemption is a real no-op until the first such bundle is declared, not an
  accident of the raw dependency list happening to be empty (it isn't).

Both exemptions compose with (never replace) the org-trust gate — an
exempt-looking bundle from outside `the-metafactory` is still refused before
either allowlist is even consulted. If your bundle isn't declared as a
cortex dependency and isn't loading, that's `system.plugins.external: false`
doing its job; a principal opts in per-stack, or cortex's maintainers add
your repo to the appropriate anchor once it's reviewed as truly first-party.

**Threat-model note:** both exemptions, and the unconditional org-trust
gate underneath them, ultimately rest on arc recording `repoUrl` as a
package's real git clone source (verified empirically against a live
`arc list --json`, S6). If a future arc version decoupled `repoUrl` from the
actual clone source (e.g. an unauthenticated `--repo-url` override), every
trust gate in this file would fall together — that is an explicit, named
cross-repo (arc) dependency of cortex's entire plugin trust model, not
something `loader.ts` can independently verify or defend against on its own.

## Runtime lifecycle (S8) — attach/detach/reload + state loss

cortex#1793 (S8, ADR-0024 D3) adds `cortex plugin list|unload|reload|load` —
activating/deactivating a plugin **without restarting the daemon**. Talks to
a running daemon over the bus (`system.plugin.control-request`/`-response`,
`src/bus/system-events.ts`; the daemon-side handler is
`src/gateway/plugin-control-server.ts`; the domain logic is
`src/gateway/plugin-runtime.ts`). Every mutating verb is **dry-run by
default** — `--apply` is required to actually send the mutation (repo
convention, mirrors `cortex network`/`cortex stack`).

### Renderers are the cheap half; adapters are the hard half

Per-instance detach for **renderers** already existed before S8:
`SurfaceRouter.register()` returns an `{ unregister }` handle
(`src/bus/surface-router.ts:262`) — the renderer boot loop in `cortex.ts`
used to discard it; S8 retains it. A renderer has no inbound connection and
no drain machinery is needed (the router already bounds every `render()`
call with a timeout + `Promise.allSettled` isolation), so renderer
`unload`/`reload`/`load` are all fully supported:

- **`unload`** — `unregister()` (leaves the router's dispatch list) then
  `stop()`. Always available.
- **`reload`** — cache-bust re-`import()` of the SAME arc bundle, construct
  a fresh instance from the ORIGINAL parsed config, **attach the new
  instance before detaching the old one** (ADR-0024 D3: "duplicate delivery
  is strictly safer than a blind window for a pager" — reloading `pagerduty`
  must never leave a transient gap in `local.{principal}.system.>`
  coverage). Only supported for a renderer that was constructed from an
  **arc-installed bundle** — an in-tree renderer (`dashboard`, `pagerduty`)
  has no bundle to re-import and refuses with a clear "restart required"
  message.
- **`load`** — activates a renderer whose `renderers[]` config entry existed
  at boot but failed to construct because the plugin hadn't loaded yet
  (`plugins.external` was off, or the bundle failed a transient gate). The
  ORIGINAL raw config entry is reused verbatim, so `load` constructs exactly
  what boot would have — never a runtime-improvised config.

**Adapters** have no per-instance detach outside the (env-gated,
off-by-default) shared `SurfaceGateway` — see
`src/gateway/surface-gateway.ts`'s `attachAdapter`/`detachAdapter`. Every
live stack today runs the classic per-stack boot path
(`wireSurfaceAdapters`), which has no live detach at all (ADR-0024 blocker
#13). So:

- **`unload`** — works only when the daemon is running with
  `CORTEX_GATEWAY=1`; otherwise refused with a clear reason (never a silent
  no-op).
- **`reload`** / **`load`** — out of scope for this slice for ADAPTERS.
  Re-constructing an adapter instance needs the binding-seed + demux-key
  inputs `GatewayAdapterFactory` owns today; that shim is tracked separately
  at cortex#1896. `cortex plugin unload` + a config-driven restart is the v1
  path for picking up an adapter code change.

### The bun cache-bust finding

`cortex#1793`'s scratch verification: bun 1.3.2's dynamic `import()` only
honors a `?v=` cache-busting query string when the specifier is a **plain
filesystem path**. The identical query string on a **`file://` URL** —
which is what the S6 loader's boot-time import uses
(`pathToFileURL(resolved.absPath).href`, `src/adapters/loader.ts`) —
resolves to the SAME cached module every time, no matter how many distinct
`?v=` values are tried. `reimportRendererPlugin` (`src/adapters/loader.ts`)
therefore imports via the plain absolute path for a `bust: true` re-import;
`loadOneBundle`'s boot-time import is unchanged (a bundle's first import for
the process lifetime never needs busting). Re-verify this against any future
bun upgrade before assuming reload still works — it is a bun implementation
detail, not a documented guarantee.

### State loss on detach/reload — by design, plugin authors must design for it

Detaching (or reloading — detach is half of reload) a live instance
discards ALL of its in-memory state. This is intentional (ADR-0024's
renderer-delta consequence: "a renderer's resources are scoped to its
lifetime… still true, and it's exactly what makes per-instance
destroy-and-reconstruct safe"), but every plugin author must design for it:

- **Renderers**: a ring buffer / dedup cache resets to empty on
  detach/reload. Design any per-envelope derivation to be **reload-stable**
  — e.g. `PagerDutyRenderer`'s `dedup_key` is derived per-envelope from
  `${envelope.source}:${envelope.type}` (`src/renderers/pagerduty.ts`), not
  from in-memory state, so a duplicate delivery across a reload is
  correctly deduped by the PROVIDER (PagerDuty), not by cortex.
- **Adapters** (when gateway-attached `unload`/future `reload` applies):
  progress placeholders (`sendProgress`/`clearProgress` state), thread
  caches, and the live platform websocket/HTTP connection are ALL lost on
  detach. A re-attached adapter instance starts cold — it does NOT resume
  mid-conversation state from before the detach. Adapter authors MUST
  tolerate a cold re-attach: never assume `postResponse`/`sendProgress` will
  land against a placeholder created by a PRIOR instance, and treat every
  `start()` as a fresh connection with no memory of what came before.
  Response routing itself is wire-level (`response_routing.adapter_instance`
  + `channel_id`/`thread_id` echoed on the envelope), so a cold re-attach
  does not break REPLIES — only best-effort UX affordances (a "typing…"
  placeholder update, a cached thread lookup) are lost.

## Resolving the SDK in an out-of-tree bundle (cortex#1950)

An out-of-tree bundle imports the contract as `import type` — so at RUNTIME the
loader's dynamic `import()` never resolves the SDK (the types are erased). The
bundle only needs the SDK types RESOLVABLE at TYPE-CHECK time, so its standalone
`bunx tsc --noEmit` passes. cortex makes that resolvable **without publishing a
package and without a bundle vendoring a hand-copied subset** (which drifts on
every `SURFACE_SDK_VERSION` bump and does not scale past one bundle):

**cortex ships a self-contained, generated `.d.ts`.** `bun run sdk:dts`
(`scripts/gen-surface-sdk-dts.ts`) rolls the barrel up into ONE flat file,
`src/surface-sdk/generated/surface-sdk.d.ts`, with every transitive contract
type inlined and the *only* external import being `zod/v4` (which every plugin
already depends on — the binding/config schemas are zod). `package.json`
exposes it:

```jsonc
"exports": {
  "./surface-sdk": {
    "types": "./src/surface-sdk/generated/surface-sdk.d.ts", // ← the flat artifact
    "default": "./src/surface-sdk/index.ts"
  }
}
```

Pointing a consumer at the raw `src/surface-sdk/index.ts` does **not** work — it
transitively drags cortex's whole source tree + dev-deps into the bundle's `tsc`.
The flat `.d.ts` pulls none of it.

**The artifact cannot drift.** It is generated from the barrel, never
hand-edited, and CI (`.github/workflows/ci.yml` → `surface-sdk-dts-sync`)
regenerates it and fails on any diff. Because `SURFACE_SDK_VERSION` is inlined
into the artifact, the shipped types always track the contract version.

**A bundle resolves the artifact via a pinned single-file sync** (the reference
implementation is `metafactory-cortex-adapter-web`):

- a `postinstall` step fetches just `surface-sdk.d.ts` from cortex at a **pinned
  ref** into a gitignored `sdk/` dir (no cortex dependency tree, no clone — one
  file);
- `tsconfig.json` `paths` maps `@the-metafactory/cortex/surface-sdk` → that
  local file. Since the file lands in the bundle's own tree, its `zod/v4` import
  resolves the bundle's OWN single zod — no cross-instance zod-type skew.

*(A bundle that would rather take a real package dependency can instead
`bun add github:the-metafactory/cortex#<ref>` and import the same specifier via
the `exports` map above — but that pulls cortex's entire runtime dep tree
(react, discord.js, …) into the bundle for types alone, so the single-file sync
is preferred for a lean adapter/renderer bundle.)*

**Versioning — staleness is never silent.** The bundle pins a cortex ref, so a
`SURFACE_SDK_VERSION` major bump in cortex does not silently re-type the bundle
— it stays on the pinned types until its maintainer bumps the ref (an explicit,
reviewable change). If a bundle is left on types too old for the running daemon,
the **S6 loader's `satisfies(SURFACE_SDK_VERSION, sdkRange)` gate refuses it at
`import()` with a `system.error`** — staleness fails loud at load, never silently
mis-compiles against a contract the daemon no longer honours.

## Out of scope for this doc

- Dynamic bundle loading / the compat-gate loader implementation (S6) — see
  `src/adapters/loader.ts`.
- Zero-downtime handover between old+new instance of the SAME platform
  (v2 — the S8 issue's explicit out-of-scope line).
- Retiring `GatewayAdapterFactory` and the adapter `reload`/`load` verbs that
  depend on it (tracked separately, cortex#1896).
