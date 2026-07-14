/**
 * cortex#1788 (S3, ADR-0024 D5) — Web/SSE `AdapterPlugin`.
 * cortex#1794 (S9) — final MOVE slice: this file now lives in the
 * `metafactory-cortex-adapter-web` bundle repo, not cortex core. It (and
 * `./index.ts`) import ONLY from `./vendor/surface-sdk` (a vendored type-only
 * stand-in for cortex's plugin SDK barrel — see that file's doc for why) plus
 * intra-directory siblings (`./index`, `./schema`) — no cortex runtime module
 * at all, in-tree or otherwise.
 *
 * S9b's in-tree version of this file imported `stringBindingField` +
 * `buildAdapterPolicyPort` from cortex's `src/adapters/plugin-support.ts` — a
 * REAL runtime (non-type-only) cross-boundary import that the S9b boundary-
 * guard test never caught, because that test only flags `../../`
 * (two-level) specifiers and `../plugin-support` is one level up. Both are
 * inlined below instead: `stringBindingField` is a three-line pure helper
 * (verbatim copy); `buildAdapterPolicyPort`'s no-triad fallback is replaced
 * by {@link NO_POLICY_PORT}, a local constant reproducing the EXACT
 * `denyCode: "no_policy"` / `isOperatorPrincipal === false` behaviour
 * cortex's `common/policy` gives an unbound port (see the constant's doc for
 * the byte-for-byte comparison). Behavior is unchanged; only the import
 * boundary moved.
 *
 * `createAdapter`'s body is still, structurally, cortex's pre-registry
 * `the pre-registry factory's web`'s body (C-110) — this slice only moved
 * the file and closed the one remaining cross-repo import; it does not
 * change what gets constructed.
 */

import { WebAdapter, type AdapterAgentIdentity } from "./index";
import { WebBindingSchema, type WebBinding } from "./schema";
import type { AdapterPlugin, AdapterPolicyPort, InboundMessage } from "./vendor/surface-sdk";

/**
 * Construction args `createAdapter` accepts — the same shape
 * `the pre-registry factory's web` accepted pre-registry (`WebFactoryArgs`,
 * cortex's `src/gateway/gateway-adapters.ts`), minus the `Agent`/
 * `SystemEventSource` cortex-internal types (cortex#1794 S9b — see module
 * doc). `source` is used only by {@link resolveWebAgent}'s
 * synthetic-identity fallback — like the pre-registry factory, it is never
 * forwarded into `WebAdapterInfra`. `policy` is the host-bound
 * {@link AdapterPolicyPort} — forwarded from cortex's
 * `GatewayConstructBase.policy` (only caller today: `buildGatewayAdapters`).
 */
interface WebCreateArgs {
  instanceId: string;
  webBinding: WebBinding;
  source: { agent: string } | undefined;
  agent?: AdapterAgentIdentity;
  policy?: AdapterPolicyPort;
}

/**
 * cortex#1794 (S9b) — the web-local, `Agent`-free replacement for cortex's
 * `plugin-support.ts`'s `resolveFactoryAgent` (which returns a full cortex
 * `Agent` — persona/trust/presence — that `WebAdapter` never reads past
 * `.id`). Same fallback order and the SAME thrown error message as
 * `resolveFactoryAgent`: `args.agent` wins; else derive `{id: source.agent}`
 * from the gateway source identity; else throw (a caller must supply one or
 * the other).
 */
function resolveWebAgent(args: {
  agent?: AdapterAgentIdentity;
  source: { agent: string } | undefined;
}): AdapterAgentIdentity {
  if (args.agent) return args.agent;
  if (!args.source) {
    throw new Error(
      "AdapterPlugin.createAdapter: constructing an adapter requires either `agent` or `source` (neither was supplied)",
    );
  }
  return { id: args.source.agent };
}

/**
 * cortex#1794 (S9 MOVE) — inlined verbatim from cortex's
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
 * cortex#1794 (S9 MOVE) — the bundle-local "no policy configured" port,
 * used ONLY as `createAdapter`'s fallback when no caller-supplied `policy`
 * is present (e.g. a hand-built `WebCreateArgs` that bypasses the host's
 * `buildGatewayConstructArgs`, which always forwards one today). Reproduces
 * cortex's `common/policy` behaviour for an all-undefined policy triad
 * EXACTLY:
 *   - `resolveAccess`: cortex's `resolvePolicyAccess` returns the constant
 *     `DENY_NO_POLICY` ({ allowed: false, features: {chat:false,async:false,
 *     team:false}, denyCode: "no_policy", denyReason: "cortex.yaml has no
 *     policy.principals[] declared…" }) when `engine`/`index`/`registry` are
 *     all `undefined`, with `isDM: true` spread in when `msg.isDM === true`.
 *   - `isOperatorPrincipal`: cortex's version returns `false` whenever
 *     `engine`/`index` are `undefined`, before ever consulting `platform`/
 *     `platformId`.
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

export const webAdapterPlugin: AdapterPlugin = {
  kind: "adapter",
  id: "web",
  platform: "web",
  // cortex#1789 (S4) — the exact schema `surfaces.web[].binding` validated
  // pre-S4 (`WebSurfaceBindingSchema` in cortex's `common/types/surfaces.ts`).
  // cortex#1794 (S9) — now defined in `./schema` (plugin-owned, ships in
  // this bundle).
  bindingSchema: WebBindingSchema,
  // Unlike discord/slack/mattermost, web has no legacy inline-presence shape
  // to fold into — the gateway factory consumes `surfaces.web[]` directly.
  // PRESERVE: web does NOT fold.
  foldsIntoPresence: false,
  // No secrets in a web binding — auth is CF Access at the edge, not a bot
  // token (`broadcastUrl` is a non-secret endpoint).
  secretFields: [],
  demuxKey: (binding) => stringBindingField(binding, "instanceId"),
  // No groupBindings — one adapter per binding, demuxed on the configured
  // tenant instanceId.
  buildGatewayConstructArgs: (group, base) => {
    const firstEntry = group.entries[0];
    const webBinding = (firstEntry?.binding ?? {}) as unknown as WebBinding;
    return {
      instanceId: base.instanceId,
      binding: firstEntry?.binding,
      webBinding,
      source: base.source,
      // cortex#1794 (S9b) — forward the host-bound port straight through.
      // `base.policy` is `unknown` at the registry layer and this function's
      // own return type is `Record<string, unknown>`, so no cast is needed
      // here — `createAdapter` below is where it's narrowed back to
      // `AdapterPolicyPort`.
      policy: base.policy,
    };
  },
  createAdapter: (args) => {
    const a = args as unknown as WebCreateArgs;
    return new WebAdapter(
      resolveWebAgent(a),
      a.webBinding,
      {
        instanceId: a.instanceId,
        principal: {},
        // cortex#1794 (S9b) — `WebAdapterInfra.policy` is REQUIRED; default
        // to the "no policy configured" port (deny-by-default —
        // {@link NO_POLICY_PORT}) when no host port was supplied, e.g. a
        // caller that builds `WebCreateArgs` by hand without going through
        // `buildGatewayConstructArgs`.
        policy: a.policy ?? NO_POLICY_PORT,
      },
    );
  },
};

// cortex#1794 (S9 MOVE) — this bundle's `cortex-plugin.yaml` declares
// `kind: adapter`, `id: web`, `entry: ./src/plugin.ts`, `sdkRange: "^1"`.
// The default export IS the `SurfacePlugin` (ADR-0024 D1: "sdkRange in its
// default-exported SurfacePlugin") — cortex's S6 loader reads
// `defaultExport.sdkRange` at `import()` time to gate compatibility.
export default { ...webAdapterPlugin, sdkRange: "^1" as const };
