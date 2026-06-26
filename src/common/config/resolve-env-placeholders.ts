/**
 * cortex#1209 / cortex#1217 — `__ENV__` placeholder resolution for surface
 * secret fields, with **fail-SOFT per-surface** degradation (cortex#1217).
 *
 * Bot-pack fragments declare a Discord/Slack/Mattermost surface token as a
 * placeholder (Pier ships `presence.discord.token: __PIER_BOT_TOKEN__`;
 * vega ships `__VEGA_BOT_TOKEN__`, #1206) with the contract "resolved at
 * install time from the host environment … NEVER stored in this file."
 *
 * The resolution happens at **config-LOAD**, not arc-install: the on-disk
 * config keeps the `__X__` placeholder; the real secret lives only in the
 * daemon's environment + process memory. This honours the "never stored"
 * comment — the token never touches disk.
 *
 * Scope (deliberately NARROW — not a blind whole-config walk):
 *   - `presence.discord.token`
 *   - `presence.mattermost.apiToken`
 *   - `presence.slack.botToken`, `presence.slack.appToken`
 *   - the gateway-binding mirror of the same fields under a `surfaces.yaml`
 *     binding map (`surfaces.{discord,slack,mattermost}[].binding.<token>`),
 *     which the surface gateway consumes via a SEPARATELY-captured `Surfaces`
 *     object that bypasses the raw-config walk (cortex#1209 review — the
 *     `CORTEX_GATEWAY=1` path was leaking the literal placeholder to
 *     `connect()`).
 *
 * The Slack tokens MUST be resolved on the RAW object BEFORE the Zod parse,
 * because `SlackPresenceSchema` regex-constrains `botToken` to `^xoxb-` /
 * `appToken` to `^xapp-` — a placeholder would fail the regex if it reached the
 * schema. Discord/Mattermost have no such constraint, but resolving all four on
 * the raw object in one pass keeps the seam in a single place.
 *
 * ── cortex#1217 — fail SOFT, do not throw ────────────────────────────────────
 *
 * The original #1209 resolver was fail-CLOSED: a declared placeholder whose env
 * var was unset/empty threw a fatal `EnvPlaceholderError` that aborted the
 * WHOLE config load. In production that turned one agent's missing surface token
 * into a daemon FATAL-boot → launchd `KeepAlive` restart → FATAL again = a
 * crash loop that took the ENTIRE stack offline (forge/luna/echo/vega), not
 * just the agent with the missing secret. An `arc upgrade` that wiped a
 * hand-added token bricked the meta-factory stack.
 *
 * The blast radius of one agent's missing surface token must be that ONE
 * surface — never the stack. So the surface-token path now degrades instead of
 * throwing: when a surface secret placeholder cannot be resolved we
 *
 *   1. DISABLE that one surface — `presence.<platform>.enabled = false` for the
 *      per-agent path (the adapter loop in `src/cortex.ts` skips every
 *      `enabled === false` instance, so the adapter is never constructed and
 *      `connect()` is never called); the gateway-binding path has no per-binding
 *      `enabled` flag, so the unresolvable binding ENTRY is dropped from the
 *      `Surfaces` map (`buildGatewayAdapters` then never builds an adapter for
 *      it).
 *   2. SCRUB the literal — the offending token field is replaced with an inert,
 *      clearly-non-credential sentinel that still satisfies the field's schema
 *      (Discord/Mattermost: any non-empty string; Slack: the `xoxb-`/`xapp-`
 *      prefix the regex requires). The literal `__X__` therefore NEVER survives
 *      onto the parsed config and can never reach an adapter — defence in depth
 *      on top of the `enabled:false` skip. (No fail-open: the sentinel is not a
 *      real token, and the surface it belongs to is disabled anyway.)
 *   3. BUBBLE UP ONCE — a clear principal-facing WARN to `process.stderr`
 *      naming the agent + the env var + the fix (`arc secrets set <agent>
 *      <VAR>`), plus a structured {@link SurfaceTokenWarning} collected into the
 *      caller's sink so the boot path can re-surface it (NOT silent).
 *
 * A RESOLVED placeholder still resolves to its real value; an INLINE
 * (non-placeholder) token passes through byte-identical — the backward-compat
 * invariant is unchanged. Only the missing-env path changed from throw → soft.
 *
 * The strict `EnvPlaceholderError` + {@link assertNoUnresolvedPlaceholder} are
 * retained: the gateway's belt-and-suspenders assertion still guards against a
 * literal reaching `connect()` on any FUTURE path that forgets to resolve, and
 * any non-surface secret that legitimately needs fail-closed can keep throwing.
 *
 * Security: the resolved secret is NEVER logged; warnings name the env var,
 * never its value; nothing is written back to disk (callers mutate the
 * in-memory raw object only).
 */
import { isPlainObject } from "../types/object-guards";
import type { Surfaces } from "../types/surfaces";

/**
 * A surface secret field whose VALUE is exactly `__SOME_ENV_VAR__` resolves to
 * `process.env.SOME_ENV_VAR`. The match is anchored end-to-end: a partial
 * occurrence (e.g. `Bearer __X__`) is treated as an inline literal and passes
 * through unchanged. The capture is `[A-Z0-9_]+` — conventional SCREAMING_CASE
 * env-var names (the Pier/vega precedent: `PIER_BOT_TOKEN`, `VEGA_BOT_TOKEN`).
 */
export const ENV_PLACEHOLDER_PATTERN = /^__([A-Z0-9_]+)__$/;

/**
 * The platform a disabled surface belongs to — carried on a
 * {@link SurfaceTokenWarning} so the boot path can name the surface.
 */
export type SurfacePlatform = "discord" | "mattermost" | "slack";

/**
 * Structured record of a surface disabled by cortex#1217 fail-soft degradation.
 * The boot path collects these (via the `warnings` sink) so it can re-surface a
 * consolidated principal-facing notification beyond the per-field stderr WARN.
 * Carries the env-var NAME, never its value.
 */
export interface SurfaceTokenWarning {
  /** Agent id whose surface was disabled (or the binding's `agent` field). */
  agent: string;
  /** Which platform surface was disabled. */
  platform: SurfacePlatform;
  /** The unset/empty env var that the placeholder referenced. */
  envVar: string;
  /** The config field path of the offending token (for the principal). */
  fieldPath: string;
}

/**
 * Fatal error raised by the STRICT resolution path (retained for the
 * belt-and-suspenders {@link assertNoUnresolvedPlaceholder} guard and for any
 * non-surface secret that legitimately needs fail-closed). The surface-token
 * load path NO LONGER throws this (cortex#1217 — it fails soft); the error type
 * survives because the gateway-adapters assertion still uses it to guarantee a
 * literal `__X__` can never reach `connect()` on a future un-resolved path.
 *
 * Carries the offending env-var name + the config field path so the boot path
 * sees exactly which variable to set, WITHOUT the resolved value ever appearing
 * in the message.
 */
export class EnvPlaceholderError extends Error {
  public readonly envVar: string;
  public readonly fieldPath: string;

  constructor(envVar: string, fieldPath: string) {
    super(
      `config: surface secret field "${fieldPath}" declares the placeholder ` +
        `__${envVar}__ but environment variable ${envVar} is unset or empty. ` +
        `Export ${envVar} in the cortex daemon's environment before launch ` +
        `(e.g. \`export ${envVar}=...; arc install\`). The token is resolved ` +
        `at config-load and never written to disk.`,
    );
    this.name = "EnvPlaceholderError";
    this.envVar = envVar;
    this.fieldPath = fieldPath;
  }
}

/**
 * Defence-in-depth assertion (cortex#1209 review — belt-and-suspenders). Throws
 * `EnvPlaceholderError` if `value` is STILL an unresolved `__ENV__` placeholder
 * at the point a token is about to be handed to an adapter. Every load path is
 * supposed to have resolved (or, post-#1217, disabled+scrubbed) placeholders
 * already; this guards against a future path that forgets to, so a literal
 * `__X__` can never reach `connect()`.
 */
export function assertNoUnresolvedPlaceholder(value: unknown, fieldPath: string): void {
  if (typeof value !== "string") return;
  const envVar = ENV_PLACEHOLDER_PATTERN.exec(value)?.[1];
  if (envVar === undefined) return;
  throw new EnvPlaceholderError(envVar, fieldPath);
}

/**
 * The discriminated result of a SOFT scalar resolution. `passthrough` carries
 * the value to write back (a non-string, an inline literal, or the resolved
 * secret); `missing` names the env var that was unset/empty so the caller can
 * disable + scrub + warn.
 */
type SoftResolve =
  | { readonly kind: "passthrough"; readonly value: unknown }
  | { readonly kind: "missing"; readonly envVar: string };

/**
 * Resolve a single scalar WITHOUT throwing. A non-string, or a string that is
 * NOT a pure `__ENV__` placeholder, passes through byte-identical (the
 * backward-compat invariant — inline tokens are untouched). A pure placeholder
 * resolves from `process.env`; an unset / empty / whitespace-only env var
 * yields `{ kind: "missing" }` (a whitespace-only value would otherwise reach
 * `connect()` as a garbage token — cortex#1209 review nit 1).
 */
function resolveScalarSoft(value: unknown): SoftResolve {
  if (typeof value !== "string") return { kind: "passthrough", value };
  // The capture group is `string | undefined`; an absent match (inline literal)
  // OR an unexpectedly-empty capture both pass through unchanged. The undefined
  // guard narrows `envVar` to `string` without a type assertion (the project
  // lint forbids both `as` and `!` here).
  const envVar = ENV_PLACEHOLDER_PATTERN.exec(value)?.[1];
  if (envVar === undefined) return { kind: "passthrough", value }; // inline literal
  const resolved = process.env[envVar];
  if (resolved === undefined || resolved.trim() === "") {
    return { kind: "missing", envVar };
  }
  return { kind: "passthrough", value: resolved };
}

/**
 * An inert, clearly-non-credential sentinel that REPLACES a surface token whose
 * env var could not be resolved, so the literal `__X__` never survives onto the
 * parsed config. It still satisfies the field's schema:
 *   - Slack `botToken` requires `^xoxb-`, `appToken` requires `^xapp-`.
 *   - Discord `token` (and Mattermost `apiToken`) only require a non-empty
 *     string.
 * The sentinel embeds the env-var name for debuggability and is never a real
 * token; the surface it belongs to is `enabled:false`, so it is never used.
 */
function disabledSentinel(platform: SurfacePlatform, field: string, envVar: string): string {
  if (platform === "slack" && field === "botToken") return `xoxb-DISABLED-${envVar}`;
  if (platform === "slack" && field === "appToken") return `xapp-DISABLED-${envVar}`;
  return `DISABLED-MISSING-SECRET-${envVar}`;
}

/**
 * Emit the one principal-facing WARN for a disabled surface to `process.stderr`
 * — the launchd-log channel where the cortex#1217 crash-loop incident was
 * diagnosed. Names the agent, the env var, and the exact fix. Never the value.
 */
function emitSurfaceDisabledWarning(w: SurfaceTokenWarning): void {
  process.stderr.write(
    `cortex config WARN: ${w.platform} surface for agent "${w.agent}" DISABLED — ` +
      `${w.fieldPath} declares placeholder __${w.envVar}__ but env var ${w.envVar} ` +
      `is unset or empty. This ONE surface will not start; the rest of the stack ` +
      `boots normally. Fix: \`arc secrets set ${w.agent} ${w.envVar}\` (then reinstall).\n`,
  );
}

/**
 * Resolve ONE token field on a per-agent presence block, failing soft. On a
 * resolved/inline value it writes the value back. On a missing env var it
 * disables the surface (`block.enabled = false`), scrubs the literal to an inert
 * sentinel, and records + emits a warning. Mutates `block` in place.
 */
function softResolvePresenceField(
  block: Record<string, unknown>,
  field: string,
  platform: SurfacePlatform,
  agent: string,
  fieldPath: string,
  warnings: SurfaceTokenWarning[] | undefined,
): void {
  if (!(field in block)) return;
  const res = resolveScalarSoft(block[field]);
  if (res.kind === "passthrough") {
    block[field] = res.value;
    return;
  }
  // Missing env → fail soft: disable THIS surface + scrub the literal + warn.
  block.enabled = false;
  block[field] = disabledSentinel(platform, field, res.envVar);
  const warning: SurfaceTokenWarning = { agent, platform, envVar: res.envVar, fieldPath };
  emitSurfaceDisabledWarning(warning);
  if (warnings !== undefined) warnings.push(warning);
}

/**
 * Resolve the surface secret tokens on a single agent-shaped raw object — one
 * that may carry `presence.{discord,mattermost,slack}`. Mutates the object in
 * place (the raw object is freshly parsed/cloned by the caller, so this is safe
 * and idempotent). `pathPrefix` labels the field in messages (e.g. `agents[0]`
 * or a fragment filename); the agent id (when present on `agentLike`) labels
 * the warning so `arc secrets set <agent> <VAR>` is actionable.
 *
 * cortex#1217: a missing env var DISABLES that surface (+ scrubs + warns)
 * instead of throwing. `warnings` is the optional collection sink.
 */
export function resolveAgentPresenceTokens(
  agentLike: Record<string, unknown>,
  pathPrefix: string,
  warnings?: SurfaceTokenWarning[],
): void {
  const presence = agentLike.presence;
  if (!isPlainObject(presence)) return;

  const agent =
    typeof agentLike.id === "string" && agentLike.id.length > 0 ? agentLike.id : pathPrefix;

  const discord = presence.discord;
  if (isPlainObject(discord)) {
    softResolvePresenceField(
      discord,
      "token",
      "discord",
      agent,
      `${pathPrefix}.presence.discord.token`,
      warnings,
    );
  }

  const mattermost = presence.mattermost;
  if (isPlainObject(mattermost)) {
    softResolvePresenceField(
      mattermost,
      "apiToken",
      "mattermost",
      agent,
      `${pathPrefix}.presence.mattermost.apiToken`,
      warnings,
    );
  }

  const slack = presence.slack;
  if (isPlainObject(slack)) {
    softResolvePresenceField(
      slack,
      "botToken",
      "slack",
      agent,
      `${pathPrefix}.presence.slack.botToken`,
      warnings,
    );
    softResolvePresenceField(
      slack,
      "appToken",
      "slack",
      agent,
      `${pathPrefix}.presence.slack.appToken`,
      warnings,
    );
  }
}

/**
 * Post-compose pass over a whole raw config object (the deep-merged result of
 * `composeRawConfig`). Walks the cortex-shape `agents[]` array and resolves
 * each agent's surface secret tokens (cortex#1217 fail-soft). Mutates `raw` in
 * place; appends any disabled-surface warnings to `warnings`.
 *
 * Legacy bot.yaml-shape configs (flat top-level `discord:[]` / `mattermost:[]`,
 * no `presence` nesting) carry inline tokens only and are unaffected — they
 * have no `agents[].presence` to walk. agents.d/ fragments are resolved
 * separately at `loadAgentFromFile` (they never pass through this composer).
 */
export function resolveSurfaceTokensInRawConfig(
  raw: Record<string, unknown>,
  warnings?: SurfaceTokenWarning[],
): void {
  const agents = raw.agents;
  if (!Array.isArray(agents)) return;
  for (let i = 0; i < agents.length; i++) {
    const agent: unknown = agents[i];
    if (isPlainObject(agent)) {
      resolveAgentPresenceTokens(agent, `agents[${i}]`, warnings);
    }
  }
}

/**
 * The secret token field(s) under each platform's `surfaces[].binding`. Mirror
 * of the `presence.{platform}` token fields above — the surfaces.yaml binding
 * map carries the SAME credentials in a `binding` sub-object.
 */
const SURFACE_BINDING_TOKEN_FIELDS: { platform: SurfacePlatform; fields: readonly string[] }[] = [
  { platform: "discord", fields: ["token"] },
  { platform: "slack", fields: ["botToken", "appToken"] },
  { platform: "mattermost", fields: ["apiToken"] },
];

/**
 * cortex#1209 review (MAJOR) + cortex#1217 — resolve `__ENV__` placeholders in
 * the gateway-binding token fields of the SEPARATELY-captured `Surfaces` object,
 * failing soft.
 *
 * `composeRawConfigWithSurfaces` captures + validates the `surfaces:` binding
 * map BEFORE `foldSurfaceBindings` folds it into `raw.agents[].presence`, then
 * threads that pre-resolution object through `LoadedConfig.surfaces` →
 * `startGatewayIfEnabled` → `buildGatewayAdapters`, which parses each `binding`
 * and constructs an adapter from it. `resolveSurfaceTokensInRawConfig` only
 * touches the folded `raw.agents[]` copy, so the gateway path would otherwise
 * hand the literal `__X__` to Discord/Mattermost `connect()`.
 *
 * The gateway has NO per-binding `enabled` flag (it builds an adapter for every
 * entry present), so the fail-soft disable mechanism here is to DROP the
 * unresolvable binding entry from the `Surfaces[platform]` array — then
 * `buildGatewayAdapters` simply never builds an adapter for it. A resolved /
 * inline value is written back unchanged. Mutates `surfaces` in place (it is the
 * fresh result of `SurfacesSchema.parse`, not aliased to raw); appends warnings.
 */
export function resolveSurfaceBindingTokens(
  surfaces: Surfaces,
  warnings?: SurfaceTokenWarning[],
): void {
  for (const { platform, fields } of SURFACE_BINDING_TOKEN_FIELDS) {
    const entries = surfaces[platform];
    if (!Array.isArray(entries)) continue;

    // Indices of unresolvable binding entries, recorded as we scan, then spliced
    // out (descending) after the scan. Splice mutates the typed array in place —
    // the same reference threaded to `LoadedConfig.surfaces` — without any cast.
    const dropIndices: number[] = [];
    for (let i = 0; i < entries.length; i++) {
      const entry: unknown = entries[i];
      const binding = isPlainObject(entry) ? entry.binding : undefined;
      if (!isPlainObject(binding)) continue; // nothing to resolve — keep verbatim

      let missingEnvVar: string | undefined;
      let missingField: string | undefined;
      for (const field of fields) {
        if (!(field in binding)) continue;
        const res = resolveScalarSoft(binding[field]);
        if (res.kind === "passthrough") {
          binding[field] = res.value;
        } else {
          missingEnvVar = res.envVar;
          missingField = field;
          break; // one missing token disables the whole binding entry
        }
      }

      if (missingEnvVar !== undefined && missingField !== undefined) {
        // Fail soft: mark this binding entry for drop so the gateway never
        // builds it (there is no per-binding `enabled` flag to flip).
        const agent =
          isPlainObject(entry) && typeof entry.agent === "string" && entry.agent.length > 0
            ? entry.agent
            : `surfaces.${platform}[${i}]`;
        const warning: SurfaceTokenWarning = {
          agent,
          platform,
          envVar: missingEnvVar,
          fieldPath: `surfaces.${platform}[${i}].binding.${missingField}`,
        };
        emitSurfaceDisabledWarning(warning);
        if (warnings !== undefined) warnings.push(warning);
        dropIndices.push(i);
      }
    }

    // Remove dropped entries back-to-front so earlier indices stay valid.
    for (let j = dropIndices.length - 1; j >= 0; j--) {
      const idx = dropIndices[j];
      if (idx !== undefined) entries.splice(idx, 1);
    }
  }
}
