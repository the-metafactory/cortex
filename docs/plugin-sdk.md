# Plugin SDK — authoring a surface plugin

**Status:** describes the v1 (S5, cortex#1790) contract surface. Boot-time
discovery/loading of OUT-OF-TREE bundles is a later slice (S6) — today every
plugin registered against this SDK is still in-tree (`createDefaultSurfacePluginRegistry`,
`src/adapters/registry.ts`), dogfooding the same contract an out-of-tree
bundle will compile against. See [ADR-0024](adr/0024-pluggable-surface-adapters.md)
for the full decision record and `CONTEXT.md` §Adapter/renderer SDK for the
canonical vocabulary this doc uses.

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
} from "@cortex/surface-sdk"; // in-tree: "../../surface-sdk" (adapters) / "../surface-sdk" (renderers)
import { SURFACE_SDK_VERSION } from "@cortex/surface-sdk";
```

*(The `@cortex/surface-sdk` specifier is illustrative of how an out-of-tree
bundle resolves the SDK once S6's loader ships it; in-tree code today uses
the plain relative path shown above and in the skeletons below.)*

### What's IN the barrel, and why nothing else is

The barrel re-exports exactly the types the `PlatformAdapter` / `Renderer` /
`SurfacePlugin` contracts reference — nothing else. It deliberately does
**not** re-export cortex's internal implementation machinery: `MyelinRuntime`,
`PolicyEngine`/`PlatformPrincipalIndex`/`PrincipalRegistry`, `SystemEventSource`,
`Agent`/`AgentConfig`/per-platform presence types, per-kind renderer config
schemas (`DashboardRendererSchema`, `PagerDutyRendererSchema`, …), the
`cc-events` tap reader, or formatting helpers. Those remain genuine
cross-boundary imports the four in-tree adapters and two in-tree renderers
still reach for today — ADR-0024's residual couplings (blockers #5–#8/#13),
not yet resolved. Folding them into "the SDK" would mean a breaking change to
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

## Out of scope for this doc

- Dynamic bundle loading / the compat-gate loader implementation (S6).
- Runtime `cortex plugin list|load|unload|reload` verbs (S8).
- Publishing an npm package for the SDK — a bundle resolves it via S6's
  loader import mechanism, not `npm install`.
- Retiring `GatewayAdapterFactory` (tracked separately, cortex#1896).
