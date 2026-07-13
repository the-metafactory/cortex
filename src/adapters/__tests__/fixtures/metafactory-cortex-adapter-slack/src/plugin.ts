/**
 * cortex#1788 (S3, ADR-0024 D5) — Slack `AdapterPlugin`.
 * cortex#1795 (S10) — final MOVE slice: this file now lives in the
 * `metafactory-cortex-adapter-slack` bundle repo, not cortex core. It (and
 * `./index.ts`) import the SDK CONTRACT (type-only) from
 * `@the-metafactory/cortex/surface-sdk` — resolved by `tsconfig.json`'s
 * `paths` to the flat `.d.ts` that `bun run sync:sdk` fetches from cortex at
 * the pinned ref (`.cortex-sdk-ref`), NOT a hand-vendored copy (cortex#1950)
 * — plus intra-directory siblings (`./index`, `./schema`). No cortex runtime
 * module at all, in-tree or otherwise — the SDK imports are `import type`,
 * erased at runtime: no `common/policy`, no `common/types/surfaces`, no
 * `common/types/cortex-config`, no `bus/system-events`, no `bus/myelin/runtime`,
 * no `../envelope-renderer`, no `../plugin-support`. The binding schema
 * moved to `./schema` (plugin-owned data, S4's own principle); the presence
 * schema is a plugin-owned DUPLICATE of cortex-config's (see `./schema`'s
 * module doc for why it can't be a relocation); the agent identity narrowed
 * to {@link AdapterAgentIdentity}; the policy-resolution calls became a
 * host-injected `AdapterPolicyPort`; the system-event emission became a
 * host-injected `AdapterSystemEventPort`; the shared envelope→markdown
 * renderer became a host-injected function — the S10 in-tree inversion slice
 * that made this possible (mirrors cortex#1794 S9b/S9's identical pass for
 * `web`).
 *
 * `createAdapter`'s body is still, structurally,
 * `defaultGatewayAdapterFactory.slack`'s pre-registry body (`src/gateway
 * /gateway-adapters.ts`) — this slice inverted WHERE its dependencies come
 * from, not WHAT it constructs; behavior is unchanged. Slack has no grouping
 * (one adapter per binding, demuxed by workspace id) — `groupBindings` is
 * absent.
 */

import { SlackAdapter, type AdapterAgentIdentity } from "./index";
import { SlackBindingSchema, SlackPresenceSchema, type SlackPresence } from "./schema";
import type {
  AdapterPlugin,
  AdapterPolicyPort,
  AdapterSystemEventPort,
  Envelope,
  InboundMessage,
} from "@the-metafactory/cortex/surface-sdk";

/**
 * Construction args `createAdapter` accepts — the same shape
 * `defaultGatewayAdapterFactory.slack` accepted pre-registry
 * (`SlackFactoryArgs`, `src/gateway/gateway-adapters.ts`), minus the
 * `Agent`/`SystemEventSource`/`MyelinRuntime`/policy-triad cortex-internal
 * types (cortex#1795 S10 — see module doc). `source` is used only by
 * {@link resolveSlackAgent}'s synthetic-identity fallback — like the
 * pre-registry factory, it is never forwarded into `SlackAdapterInfra`
 * directly (the `systemEvents` port already closes over the real source).
 */
interface SlackCreateArgs {
  instanceId: string;
  source: { agent: string } | undefined;
  presence: SlackPresence;
  agent?: AdapterAgentIdentity;
  principal?: Record<string, unknown>;
  policy?: AdapterPolicyPort;
  systemEvents?: AdapterSystemEventPort;
  formatEnvelope?: (envelope: Envelope) => string;
  trustedBotIds?: ReadonlySet<string>;
  surfaceSubjects?: string[];
  surfaceFallbackChannelId?: string;
}

/**
 * cortex#1795 (S10) — the slack-local, `Agent`-free replacement for cortex's
 * `plugin-support.ts`'s `resolveFactoryAgent` (which returns a full cortex
 * `Agent` — persona/trust — that `SlackAdapter` never reads past `.id`/
 * `.displayName`/`.presence`). Same fallback order and the SAME thrown
 * error message as `resolveFactoryAgent`: `args.agent` wins; else derive a
 * synthetic identity from the gateway source identity + presence; else
 * throw (a caller must supply one or the other).
 */
function resolveSlackAgent(
  args: { agent?: AdapterAgentIdentity; source: { agent: string } | undefined },
  presence: SlackPresence,
): AdapterAgentIdentity {
  if (args.agent) return args.agent;
  if (!args.source) {
    throw new Error(
      "AdapterPlugin.createAdapter: constructing an adapter requires either `agent` or `source` (neither was supplied)",
    );
  }
  return { id: args.source.agent, displayName: args.source.agent, presence: { slack: presence } };
}

/**
 * cortex#1795 (S10) — inlined verbatim from cortex's
 * `src/adapters/plugin-support.ts` (a three-line pure helper; not worth a
 * cross-repo dependency for). Safely reads a string-typed field off a raw
 * `Record<string, unknown>` binding for `demuxKey`'s ungrouped case. Bare
 * `String(binding.x ?? "")` would trip `@typescript-eslint/no-base-to-string`
 * (`binding.x` is `unknown`) and risks stringifying a non-string value to
 * `"[object Object]"`, silently misgrouping bindings.
 */
function stringBindingField(binding: Record<string, unknown>, field: string, fallback = ""): string {
  const value = binding[field];
  return typeof value === "string" ? value : fallback;
}

/**
 * cortex#1795 (S10) — the bundle-local "no policy configured" port, used
 * ONLY as `createAdapter`'s fallback when no caller-supplied `policy` is
 * present (e.g. a hand-built `SlackCreateArgs` that bypasses the host's
 * `buildGatewayConstructArgs`/`baseFactoryArgs`, both of which always
 * forward one today). Byte-identical to cortex's
 * `metafactory-cortex-adapter-web` bundle's `NO_POLICY_PORT` — reproduces
 * `common/policy`'s behaviour for an all-undefined policy triad EXACTLY.
 * See cortex's `src/common/policy/resolve-access.ts` (`DENY_NO_POLICY`,
 * `resolvePolicyAccess`, `isOperatorPrincipal`) for the source this mirrors.
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
 * cortex#1795 (S10) — reduced-fidelity fallback for `createAdapter`'s
 * `formatEnvelope`, used ONLY when no host-supplied formatter is present
 * (the same "hand-built args" edge case `NO_POLICY_PORT` covers). Reproduces
 * the DEFAULT branch of cortex's shared `adapters/envelope-renderer.ts`'s
 * `formatEnvelopeAsMarkdown` (compact JSON code-block) — NOT its
 * `dispatch.task.*` lifecycle special-casing (~150 lines of cortex-internal
 * formatting shared with Discord/Mattermost, deliberately not duplicated
 * here). Both real hosts (`gateway-adapters.ts`'s `buildGatewayAdapters`,
 * `runner/surface-adapter-boot.ts`'s `baseFactoryArgs`) always forward the
 * real formatter, so this fallback never fires in production. Exported (not
 * just module-private) so `__tests__/slack-adapter.test.ts` can reuse it as
 * `makeAdapter`'s default `formatEnvelope` instead of duplicating the format
 * — the test asserts against this exact shape (see its
 * `**review.cycle.completed**` assertion).
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

export const slackAdapterPlugin: AdapterPlugin = {
  kind: "adapter",
  id: "slack",
  platform: "slack",
  // cortex#1789 (S4) — `SlackBindingSchema`, the exact schema
  // `surfaces.slack[].binding` validated pre-S4 (see discord/plugin.ts's
  // comment for the full rationale). cortex#1795 (S10) — now defined in
  // `./schema` (plugin-owned, ships in this bundle). `SlackPresenceSchema`
  // (also `./schema`, a plugin-owned duplicate — see that module's doc)
  // stays in use below, in `buildGatewayConstructArgs`, for the gateway-path
  // parse.
  bindingSchema: SlackBindingSchema,
  foldsIntoPresence: true,
  secretFields: ["botToken", "appToken"],
  demuxKey: (binding) => stringBindingField(binding, "workspaceId"),
  // No groupBindings — one adapter per binding, demuxed on workspaceId.
  buildGatewayConstructArgs: (group, base) => {
    const firstEntry = group.entries[0];
    const presence = SlackPresenceSchema.parse(firstEntry?.binding ?? {});
    return {
      instanceId: base.instanceId,
      source: base.source,
      binding: firstEntry?.binding,
      presence,
      // cortex#1795 (S10) — forward the host-bound ports straight through.
      // `base.policy`/`base.systemEvents`/`base.formatEnvelope` are `unknown`
      // at the registry layer (see `GatewayConstructBase`'s doc) and this
      // function's own return type is `Record<string, unknown>`, so no cast
      // is needed here — `createAdapter` below is where they're narrowed
      // back to their real types.
      policy: base.policy,
      systemEvents: base.systemEvents,
      formatEnvelope: base.formatEnvelope,
    };
  },
  createAdapter: (args) => {
    const a = args as unknown as SlackCreateArgs;
    const {
      instanceId, presence,
      principal, policy, systemEvents, formatEnvelope,
      trustedBotIds, surfaceSubjects, surfaceFallbackChannelId,
    } = a;
    return new SlackAdapter(
      resolveSlackAgent(a, presence),
      presence,
      {
        instanceId,
        principal: principal ?? {},
        // cortex#1795 (S10) — `policy` is REQUIRED on `SlackAdapterInfra`;
        // default to the "no policy configured" port (deny-by-default — see
        // `NO_POLICY_PORT`'s doc) when no host port was supplied.
        policy: policy ?? NO_POLICY_PORT,
        // `formatEnvelope` is REQUIRED on `SlackAdapterInfra`; default to
        // the reduced-fidelity local fallback (see its doc) when no host
        // formatter was supplied.
        formatEnvelope: formatEnvelope ?? fallbackFormatEnvelope,
        ...(systemEvents !== undefined && { systemEvents }),
        ...(trustedBotIds !== undefined && { trustedBotIds }),
        ...(surfaceSubjects !== undefined && { surfaceSubjects }),
        ...(surfaceFallbackChannelId !== undefined && { surfaceFallbackChannelId }),
      },
    );
  },
};

// cortex#1795 (S10 MOVE) — this bundle's `cortex-plugin.yaml` declares
// `kind: adapter`, `id: slack`, `entry: ./src/plugin.ts`, `sdkRange: "^1"`.
// The default export IS the `SurfacePlugin` (ADR-0024 D1: "sdkRange in its
// default-exported SurfacePlugin") — cortex's S6 loader reads
// `defaultExport.sdkRange` at `import()` time to gate compatibility, and
// requires the default export (not a named one) to satisfy the
// `AdapterPlugin` shape (`src/adapters/loader.ts`'s `isAdapterPluginShape`).
export default { ...slackAdapterPlugin, sdkRange: "^1" as const };
