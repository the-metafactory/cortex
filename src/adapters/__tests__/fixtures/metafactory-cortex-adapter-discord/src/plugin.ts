/**
 * cortex#1788 (S3, ADR-0024 D5) — Discord `AdapterPlugin`.
 * cortex#1797 (S12, ADR-0024 D5 extraction lane) — INVERSION slice: this file
 * now compiles against `surface-sdk` alone (plus intra-directory siblings)
 * so it can extract to the `metafactory-cortex-adapter-discord` bundle,
 * mirroring `metafactory-cortex-adapter-{web,slack,mattermost}`'s S9/S10/S11
 * inversions — the LAST of the four in-tree adapters to invert.
 *
 * `createAdapter`'s body is still, structurally, cortex's pre-registry
 * `defaultGatewayAdapterFactory.discord`'s body (relocated verbatim at S3) —
 * this slice only closes the remaining cross-boundary imports (`common/policy`,
 * `bus/system-events`, `bus/myelin/runtime`, `common/types/cortex-config`,
 * `common/types/surfaces`, `../plugin-support`, `../../gateway/discord-token-groups`);
 * it does not change what gets constructed. Discord is the ONLY in-tree
 * adapter with non-default `groupBindings` (token-keyed grouping — see
 * `./token-groups.ts`'s doc).
 */

import { DiscordAdapter } from "./index";
import { DiscordPresenceSchema, DiscordBindingSchema, type DiscordPresence } from "./schema";
import { groupDiscordBindingsByToken } from "./token-groups";
import type {
  AdapterPlugin,
  AdapterPolicyPort,
  AdapterSystemEventPort,
  BindingGroup,
  GatewayConstructBase,
  Envelope,
  InboundMessage,
} from "@the-metafactory/cortex/surface-sdk";

/**
 * Construction args `createAdapter` accepts — the same shape
 * `defaultGatewayAdapterFactory.discord` accepted pre-registry
 * (`DiscordFactoryArgs`, cortex's `src/gateway/gateway-adapters.ts`), minus
 * the `Agent`/`SystemEventSource`/`MyelinRuntime`/policy-triad cortex-internal
 * types (cortex#1797 S12 — see module doc). `source` is used only by
 * {@link resolveDiscordAgent}'s synthetic-identity fallback.
 */
interface DiscordCreateArgs {
  instanceId: string;
  source: { agent: string } | undefined;
  presence: DiscordPresence;
  allowedGuildIds: ReadonlySet<string>;
  presenceByGuildId: ReadonlyMap<string, DiscordPresence>;
  agent?: { id: string; displayName: string; presence: { discord?: DiscordPresence } };
  principal?: Record<string, unknown>;
  policy?: AdapterPolicyPort;
  systemEvents?: AdapterSystemEventPort;
  formatEnvelope?: (envelope: Envelope) => string;
  trustedBotIds?: ReadonlySet<string>;
  surfaceSubjects?: string[];
  surfaceFallbackChannelId?: string;
}

/**
 * cortex#1797 (S12) — the discord-local, `Agent`-free replacement for
 * cortex's `plugin-support.ts`'s `resolveFactoryAgent` (which returns a full
 * cortex `Agent` — persona/trust — that `DiscordAdapter` never reads past
 * `.id`/`.displayName`/`.presence`). Same fallback order and the SAME thrown
 * error message as `resolveFactoryAgent`: `args.agent` wins; else derive a
 * synthetic identity from the gateway source identity; else throw.
 */
function resolveDiscordAgent(
  args: { agent?: { id: string; displayName: string; presence: { discord?: DiscordPresence } }; source: { agent: string } | undefined },
  presence: DiscordPresence,
): { id: string; displayName: string; presence: { discord?: DiscordPresence } } {
  if (args.agent) return args.agent;
  if (!args.source) {
    throw new Error(
      "AdapterPlugin.createAdapter: constructing an adapter requires either `agent` or `source` (neither was supplied)",
    );
  }
  return { id: args.source.agent, displayName: args.source.agent, presence: { discord: presence } };
}

/**
 * cortex#1797 (S12) — inlined verbatim from cortex's
 * `src/adapters/plugin-support.ts` (a three-line pure helper; not worth a
 * cross-repo dependency for). Safely reads a string-typed field off a raw
 * `Record<string, unknown>` binding for `demuxKey`'s ungrouped fallback.
 */
function stringBindingField(binding: Record<string, unknown>, field: string, fallback = ""): string {
  const value = binding[field];
  return typeof value === "string" ? value : fallback;
}

/**
 * cortex#1797 (S12) — the bundle-local "no policy configured" port, used
 * ONLY as `createAdapter`'s fallback when no caller-supplied `policy` is
 * present. Byte-identical to `metafactory-cortex-adapter-{web,slack,mattermost}`'s
 * `NO_POLICY_PORT` — reproduces cortex's `common/policy` behaviour for an
 * all-undefined policy triad EXACTLY.
 */
const DENY_NO_POLICY = {
  allowed: false,
  features: { chat: false, async: false, team: false },
  denyCode: "no_policy",
  denyReason:
    "cortex.yaml has no policy.principals[] declared; v2.0.0 requires a policy block. " +
    "Run `bun src/cli/cortex/commands/migrate-config.ts <your-config.yaml>` to synthesise one from legacy fields.",
} as const;

export const NO_POLICY_PORT: AdapterPolicyPort = {
  resolveAccess: (msg: InboundMessage) =>
    msg.isDM === true ? { ...DENY_NO_POLICY, isDM: true } : { ...DENY_NO_POLICY },
  isOperatorPrincipal: () => false,
};

/**
 * cortex#1797 (S12) — reduced-fidelity fallback for `createAdapter`'s
 * `formatEnvelope`, used ONLY when no host-supplied formatter is present.
 * Reproduces the DEFAULT branch of cortex's shared `adapters/envelope-renderer.ts`'s
 * `formatEnvelopeAsMarkdown` (compact JSON code-block) — NOT its
 * `dispatch.task.*` lifecycle special-casing, deliberately not duplicated
 * here (mirrors slack/mattermost's identical fallback).
 */
export function fallbackFormatEnvelope(envelope: Envelope): string {
  const corr = envelope.correlation_id ? ` [${envelope.correlation_id}]` : "";
  return [
    `**${envelope.type}**${corr}`,
    "```json",
    JSON.stringify(envelope.payload, null, 2),
    "```",
  ].join("\n");
}

export const discordAdapterPlugin: AdapterPlugin = {
  kind: "adapter",
  id: "discord",
  platform: "discord",
  // cortex#1789 (S4) — `DiscordBindingSchema`, the exact schema
  // `surfaces.discord[].binding` validated pre-S4. cortex#1797 (S12) — now
  // defined in `./schema` (plugin-owned, ships in this bundle), not imported
  // back from `common/types/surfaces`. `DiscordPresenceSchema` (the fuller
  // presence shape) stays in use below, in `buildGatewayConstructArgs`, for
  // the separate gateway-path parse.
  bindingSchema: DiscordBindingSchema,
  foldsIntoPresence: true,
  secretFields: ["token"],
  // Used only as the ungrouped-fallback demux key; `groupBindings` below
  // always runs for discord, so this is a spec-completeness fallback, not a
  // live code path today.
  demuxKey: (binding) => stringBindingField(binding, "guildId"),
  // Discord delivers every guild event for a bot token over ONE gateway
  // session — bindings are token-keyed, not guild-keyed. The only in-tree
  // adapter with non-default grouping.
  groupBindings: (entries) => groupDiscordBindingsByToken(entries),
  buildGatewayConstructArgs: (group: BindingGroup, base: GatewayConstructBase) => {
    const presences = group.entries.map((entry) => DiscordPresenceSchema.parse(entry.binding));
    const presenceByGuildId = new Map(presences.map((p) => [p.guildId, p] as const));
    const allowedGuildIds = new Set(presenceByGuildId.keys());
    return {
      instanceId: base.instanceId,
      source: base.source,
      // The FIRST entry's binding — matches the pre-registry loop's
      // `binding: firstBinding` (forwarded for observability/test
      // assertions only; `presence` below is what construction consumes).
      binding: group.entries[0]?.binding,
      presence: presences[0],
      allowedGuildIds,
      presenceByGuildId,
      // cortex#1797 (S12) — forward the host-bound ports straight through,
      // mirroring web/slack/mattermost's `buildGatewayConstructArgs`.
      // `base.policy`/`base.systemEvents`/`base.formatEnvelope` are
      // `unknown` at the registry layer; `createAdapter` below narrows them
      // back to their real types.
      policy: base.policy,
      systemEvents: base.systemEvents,
      formatEnvelope: base.formatEnvelope,
    };
  },
  createAdapter: (args) => {
    const a = args as unknown as DiscordCreateArgs;
    const {
      instanceId, presence, allowedGuildIds, presenceByGuildId,
      principal, policy, systemEvents, formatEnvelope,
      trustedBotIds, surfaceSubjects, surfaceFallbackChannelId,
    } = a;
    return new DiscordAdapter(
      resolveDiscordAgent(a, presence),
      presence,
      {
        instanceId,
        principal: principal ?? {},
        allowedGuildIds,
        presenceByGuildId,
        ...(trustedBotIds !== undefined && { trustedBotIds }),
        ...(surfaceSubjects !== undefined && { surfaceSubjects }),
        ...(surfaceFallbackChannelId !== undefined && { surfaceFallbackChannelId }),
        // cortex#1797 (S12) — `policy`/`formatEnvelope` are REQUIRED on
        // `DiscordAdapterInfra`; default to the "no policy configured" /
        // reduced-fidelity fallbacks (see their docs above) when no host
        // port/formatter was supplied — e.g. a hand-built `DiscordCreateArgs`
        // that bypasses `buildGatewayConstructArgs`/the per-stack boot path.
        policy: policy ?? NO_POLICY_PORT,
        formatEnvelope: formatEnvelope ?? fallbackFormatEnvelope,
        ...(systemEvents !== undefined && { systemEvents }),
      },
    );
  },
};

// cortex#1797 (S12 MOVE) — this bundle's `cortex-plugin.yaml` declares
// `kind: adapter`, `id: discord`, `entry: ./src/plugin.ts`, `sdkRange: "^1"`.
// The default export IS the `SurfacePlugin` (ADR-0024 D1: "sdkRange in its
// default-exported SurfacePlugin") — cortex's S6 loader reads
// `defaultExport.sdkRange` at `import()` time to gate compatibility.
export default { ...discordAdapterPlugin, sdkRange: "^1" as const };
