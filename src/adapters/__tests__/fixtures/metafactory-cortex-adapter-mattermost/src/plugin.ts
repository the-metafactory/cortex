/**
 * cortex#1788 (S3, ADR-0024 D5) — Mattermost `AdapterPlugin`.
 * cortex#1796 (S11, ADR-0024 D5 extraction lane) — INVERSION slice: this file
 * now compiles against `surface-sdk` alone (plus intra-directory siblings)
 * so it can extract to the `metafactory-cortex-adapter-mattermost` bundle,
 * mirroring `metafactory-cortex-adapter-web`'s S9b (cortex#1794) inversion.
 *
 * S9b's in-tree web-plugin.ts imported `stringBindingField` +
 * `buildAdapterPolicyPort` from cortex's `src/adapters/plugin-support.ts` — a
 * REAL runtime (non-type-only) cross-boundary import that its own S9b
 * boundary-guard test never caught (it only flagged `../../`, two-level,
 * specifiers; `../plugin-support` is one level up). Both are inlined below
 * from the start, using the SAME fix web's S9 MOVE applied:
 * `stringBindingField` is a three-line pure helper (verbatim copy);
 * `buildAdapterPolicyPort`'s no-triad fallback is replaced by
 * {@link NO_POLICY_PORT}, a local constant reproducing the EXACT
 * `denyCode: "no_policy"` / `isOperatorPrincipal === false` behaviour
 * cortex's `common/policy` gives an unbound port (see the constant's doc for
 * the byte-for-byte comparison, verbatim from web's `plugin.ts`). Behavior is
 * unchanged; only the import boundary moved.
 *
 * `createAdapter`'s body is still, structurally, cortex's pre-registry
 * `the pre-registry factory's mattermost`'s body (relocated verbatim at S3)
 * — this slice only closes the remaining cross-boundary imports; it does not
 * change what gets constructed. Mattermost has no grouping (one adapter per
 * binding, demuxed by apiUrl, single-binding fallback) — UNCHANGED.
 */

import { MattermostAdapter, type MattermostAgentIdentity } from "./index";
import { MattermostPresenceSchema, MattermostBindingSchema, type MattermostPresence } from "./schema";
import type { AdapterPlugin, AdapterPolicyPort, InboundMessage } from "@the-metafactory/cortex/surface-sdk";

/**
 * Construction args `createAdapter` accepts — the same shape
 * `the pre-registry factory's mattermost` accepted pre-registry
 * (`MattermostFactoryArgs`, cortex's `src/gateway/gateway-adapters.ts`),
 * minus the `Agent`/`SystemEventSource`/`MyelinRuntime`/policy-triad
 * cortex-internal types (cortex#1796 S11 — see module doc). `source` is used
 * only by {@link resolveMattermostAgent}'s synthetic-identity fallback; `runtime`
 * is stored on `infra` but never read (forward-compat placeholder — see
 * `index.ts`'s `MattermostAdapterInfra.runtime` doc). `policy` is the
 * host-bound {@link AdapterPolicyPort} — forwarded from cortex's
 * `GatewayConstructBase.policy` (the gateway path) or built by the per-stack
 * boot path (`surface-adapter-boot.ts`) from its resolved policy triad via
 * cortex-side `buildAdapterPolicyPort`.
 */
interface MattermostCreateArgs {
  instanceId: string;
  source: { agent: string } | undefined;
  presence: MattermostPresence;
  runtime: unknown;
  agent?: MattermostAgentIdentity;
  principal?: Record<string, unknown>;
  policy?: AdapterPolicyPort;
}

/**
 * cortex#1796 (S11 MOVE-equivalent) — the mattermost-local, `Agent`-free
 * replacement for cortex's `plugin-support.ts`'s `resolveFactoryAgent`
 * (which returns a full cortex `Agent` — persona/trust/presence — that
 * `MattermostAdapter` never reads past `.id`/`.displayName`/`.presence`).
 * Same fallback order and the SAME thrown error message as
 * `resolveFactoryAgent`: `args.agent` wins; else derive a synthetic
 * gateway-owned identity from `args.source.agent`; else throw (a caller must
 * supply one or the other). Mirrors `syntheticGatewayAgent`'s shape for the
 * fields this adapter actually reads (`id`, `displayName`, `presence`) —
 * `persona`/`trust` are dropped since `MattermostAdapter` never reads them.
 */
function resolveMattermostAgent(args: {
  agent?: MattermostAgentIdentity;
  source: { agent: string } | undefined;
  presence: MattermostPresence;
}): MattermostAgentIdentity {
  if (args.agent) return args.agent;
  if (!args.source) {
    throw new Error(
      "AdapterPlugin.createAdapter: constructing an adapter requires either `agent` or `source` (neither was supplied)",
    );
  }
  return {
    id: args.source.agent,
    displayName: args.source.agent,
    presence: { mattermost: args.presence },
  };
}

/**
 * cortex#1796 (S11) — inlined verbatim from cortex's
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
 * cortex#1796 (S11) — the bundle-local "no policy configured" port, used
 * ONLY as `createAdapter`'s fallback when no caller-supplied `policy` is
 * present. Reproduces cortex's `common/policy` behaviour for an
 * all-undefined policy triad EXACTLY — see
 * `metafactory-cortex-adapter-web`'s `src/plugin.ts` `NO_POLICY_PORT` for
 * the byte-for-byte source this mirrors (cortex's
 * `src/common/policy/resolve-access.ts`, `DENY_NO_POLICY` /
 * `resolvePolicyAccess` / `isOperatorPrincipal`).
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

export const mattermostAdapterPlugin: AdapterPlugin = {
  kind: "adapter",
  id: "mattermost",
  platform: "mattermost",
  // cortex#1789 (S4) — `MattermostBindingSchema`, the exact schema
  // `surfaces.mattermost[].binding` validated pre-S4 (see discord/plugin.ts's
  // comment for the full rationale). `MattermostPresenceSchema` stays in use
  // below, in `buildGatewayConstructArgs`, for the gateway-path parse.
  // cortex#1796 (S11) — both now plugin-owned (`./schema`), not imported
  // back from `common/types/surfaces`/`common/types/cortex-config`.
  bindingSchema: MattermostBindingSchema,
  foldsIntoPresence: true,
  secretFields: ["apiToken"],
  // apiUrl is optional on the presence schema but required on the binding
  // schema; the binding-resolver keys the interim instance on it too.
  demuxKey: (binding) => stringBindingField(binding, "apiUrl", "<unset>"),
  // No groupBindings — one adapter per binding.
  buildGatewayConstructArgs: (group, base) => {
    const firstEntry = group.entries[0];
    const presence = MattermostPresenceSchema.parse(firstEntry?.binding ?? {});
    return {
      instanceId: base.instanceId,
      source: base.source,
      binding: firstEntry?.binding,
      runtime: base.runtime,
      presence,
      // cortex#1796 (S11) — forward the host-bound port straight through,
      // mirroring web's `buildGatewayConstructArgs` (cortex#1794 S9b).
      // `base.policy` is `unknown` at the registry layer and this
      // function's own return type is `Record<string, unknown>`, so no
      // cast is needed here — `createAdapter` below narrows it back to
      // `AdapterPolicyPort`.
      policy: base.policy,
    };
  },
  createAdapter: (args) => {
    const a = args as unknown as MattermostCreateArgs;
    const { instanceId, source, presence, runtime, principal, policy } = a;
    return new MattermostAdapter(
      resolveMattermostAgent(a),
      presence,
      {
        instanceId,
        principal: principal ?? {},
        runtime,
        systemEventSource: source,
        // cortex#1796 (S11) — `MattermostAdapterInfra.policy` is REQUIRED;
        // default to the "no policy configured" port (deny-by-default —
        // {@link NO_POLICY_PORT}) when no host port was supplied, e.g. a
        // caller that builds `MattermostCreateArgs` by hand without going
        // through `buildGatewayConstructArgs` or the per-stack boot path.
        policy: policy ?? NO_POLICY_PORT,
      },
    );
  },
};

// cortex#1796 (S11 MOVE) — this bundle's `cortex-plugin.yaml` declares
// `kind: adapter`, `id: mattermost`, `entry: ./src/plugin.ts`, `sdkRange: "^1"`.
// The default export IS the `SurfacePlugin` (ADR-0024 D1: "sdkRange in its
// default-exported SurfacePlugin") — cortex's S6 loader reads
// `defaultExport.sdkRange` at `import()` time to gate compatibility.
// Mirrors `metafactory-cortex-adapter-web`'s `src/plugin.ts` default export.
export default { ...mattermostAdapterPlugin, sdkRange: "^1" as const };
