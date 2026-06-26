/**
 * cortex#1209 — `__ENV__` placeholder resolution for surface secret fields.
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
 * These are the surface secret fields per the issue. The Slack tokens MUST be
 * resolved on the RAW object BEFORE the Zod parse, because
 * `SlackPresenceSchema` regex-constrains `botToken` to `^xoxb-` / `appToken`
 * to `^xapp-` — a placeholder would fail the regex if it reached the schema.
 * Discord/Mattermost have no such constraint, but resolving all four on the
 * raw object in one pass keeps the seam in a single place.
 *
 * Fail-closed (matches the loader's existing idiom — schema/permission/
 * fragment errors all THROW at load): a declared placeholder whose env var is
 * unset/empty raises a fatal `EnvPlaceholderError` that NAMES the env var.
 * The literal `__X__` is NEVER passed through to an adapter (it would surface
 * as a confusing Discord/Slack auth failure far from the real cause).
 *
 * Security: the resolved secret is NEVER logged; the error names the env var,
 * never its value; the value is never written back to disk (the caller mutates
 * the in-memory raw object only).
 */

/**
 * A surface secret field whose VALUE is exactly `__SOME_ENV_VAR__` resolves to
 * `process.env.SOME_ENV_VAR`. The match is anchored end-to-end: a partial
 * occurrence (e.g. `Bearer __X__`) is treated as an inline literal and passes
 * through unchanged. The capture is `[A-Z0-9_]+` — conventional SCREAMING_CASE
 * env-var names (the Pier/vega precedent: `PIER_BOT_TOKEN`, `VEGA_BOT_TOKEN`).
 */
import { isPlainObject } from "../types/object-guards";
import type { Surfaces } from "../types/surfaces";

export const ENV_PLACEHOLDER_PATTERN = /^__([A-Z0-9_]+)__$/;

/**
 * Fatal error raised when a declared placeholder's environment variable is
 * unset or empty. Carries the offending env-var name + the config field path
 * so the boot path / principal sees exactly which variable to set, WITHOUT the
 * resolved value ever appearing in the message.
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
 * Resolve a single scalar value. A non-string, or a string that is NOT a pure
 * `__ENV__` placeholder, is returned byte-identical (the backward-compat
 * invariant — inline tokens are untouched). A pure placeholder is resolved
 * from `process.env`; an unset / empty / whitespace-only env var throws
 * `EnvPlaceholderError` (a whitespace-only value would otherwise reach
 * `connect()` as a garbage token — cortex#1209 review nit 1).
 */
function resolveScalar(value: unknown, fieldPath: string): unknown {
  if (typeof value !== "string") return value;
  // The capture group is `string | undefined`; an absent match (inline literal)
  // OR an unexpectedly-empty capture both pass through unchanged. The undefined
  // guard narrows `envVar` to `string` without a type assertion (the project
  // lint forbids both `as` and `!` here).
  const envVar = ENV_PLACEHOLDER_PATTERN.exec(value)?.[1];
  if (envVar === undefined) return value; // inline literal — passthrough
  const resolved = process.env[envVar];
  if (resolved === undefined || resolved.trim() === "") {
    throw new EnvPlaceholderError(envVar, fieldPath);
  }
  return resolved;
}

/**
 * Defence-in-depth assertion (cortex#1209 review — belt-and-suspenders). Throws
 * `EnvPlaceholderError` if `value` is STILL an unresolved `__ENV__` placeholder
 * at the point a token is about to be handed to an adapter. Every load path is
 * supposed to have resolved placeholders already; this guards against a future
 * path that forgets to, so a literal `__X__` can never reach `connect()`.
 */
export function assertNoUnresolvedPlaceholder(value: unknown, fieldPath: string): void {
  if (typeof value !== "string") return;
  const envVar = ENV_PLACEHOLDER_PATTERN.exec(value)?.[1];
  if (envVar === undefined) return;
  throw new EnvPlaceholderError(envVar, fieldPath);
}

/**
 * Resolve the surface secret tokens on a single agent-shaped raw object — one
 * that may carry `presence.{discord,mattermost,slack}`. Mutates the object in
 * place (the raw object is freshly parsed/cloned by the caller, so this is
 * safe and idempotent). `pathPrefix` labels the field in error messages
 * (e.g. `agents[0]` or a fragment filename).
 */
export function resolveAgentPresenceTokens(
  agentLike: Record<string, unknown>,
  pathPrefix: string,
): void {
  const presence = agentLike.presence;
  if (!isPlainObject(presence)) return;

  const discord = presence.discord;
  if (isPlainObject(discord) && "token" in discord) {
    discord.token = resolveScalar(
      discord.token,
      `${pathPrefix}.presence.discord.token`,
    );
  }

  const mattermost = presence.mattermost;
  if (isPlainObject(mattermost) && "apiToken" in mattermost) {
    mattermost.apiToken = resolveScalar(
      mattermost.apiToken,
      `${pathPrefix}.presence.mattermost.apiToken`,
    );
  }

  const slack = presence.slack;
  if (isPlainObject(slack)) {
    if ("botToken" in slack) {
      slack.botToken = resolveScalar(
        slack.botToken,
        `${pathPrefix}.presence.slack.botToken`,
      );
    }
    if ("appToken" in slack) {
      slack.appToken = resolveScalar(
        slack.appToken,
        `${pathPrefix}.presence.slack.appToken`,
      );
    }
  }
}

/**
 * Post-compose pass over a whole raw config object (the deep-merged result of
 * `composeRawConfig`). Walks the cortex-shape `agents[]` array and resolves
 * each agent's surface secret tokens. Mutates `raw` in place.
 *
 * Legacy bot.yaml-shape configs (flat top-level `discord:[]` / `mattermost:[]`,
 * no `presence` nesting) carry inline tokens only and are unaffected — they
 * have no `agents[].presence` to walk. agents.d/ fragments are resolved
 * separately at `loadAgentFromFile` (they never pass through this composer).
 */
export function resolveSurfaceTokensInRawConfig(raw: Record<string, unknown>): void {
  const agents = raw.agents;
  if (!Array.isArray(agents)) return;
  for (let i = 0; i < agents.length; i++) {
    const agent: unknown = agents[i];
    if (isPlainObject(agent)) {
      resolveAgentPresenceTokens(agent, `agents[${i}]`);
    }
  }
}

/**
 * The secret token field(s) under each platform's `surfaces[].binding`. Mirror
 * of the `presence.{platform}` token fields above — the surfaces.yaml binding
 * map carries the SAME credentials in a `binding` sub-object.
 */
const SURFACE_BINDING_TOKEN_FIELDS: { platform: keyof Surfaces; fields: readonly string[] }[] = [
  { platform: "discord", fields: ["token"] },
  { platform: "slack", fields: ["botToken", "appToken"] },
  { platform: "mattermost", fields: ["apiToken"] },
];

/**
 * cortex#1209 review (MAJOR) — resolve `__ENV__` placeholders in the
 * gateway-binding token fields of the SEPARATELY-captured `Surfaces` object.
 *
 * `composeRawConfigWithSurfaces` captures + validates the `surfaces:` binding
 * map BEFORE `foldSurfaceBindings` folds it into `raw.agents[].presence`, then
 * threads that pre-resolution object through `LoadedConfig.surfaces` →
 * `startGatewayIfEnabled` → `buildGatewayAdapters`, which parses each
 * `binding` and constructs an adapter from it. `resolveSurfaceTokensInRawConfig`
 * only touches the folded `raw.agents[]` copy, so the gateway path would
 * otherwise hand the literal `__X__` to Discord/Mattermost `connect()`.
 *
 * Resolving here (same fail-closed `EnvPlaceholderError`, same trim check) on
 * the captured object closes the leak symmetrically. Mutates `surfaces` in
 * place — it is the fresh result of `SurfacesSchema.parse`, not aliased to raw.
 */
export function resolveSurfaceBindingTokens(surfaces: Surfaces): void {
  for (const { platform, fields } of SURFACE_BINDING_TOKEN_FIELDS) {
    const entries = surfaces[platform];
    if (!Array.isArray(entries)) continue;
    for (let i = 0; i < entries.length; i++) {
      const binding = (entries[i] as { binding?: unknown }).binding;
      if (!isPlainObject(binding)) continue;
      for (const field of fields) {
        if (field in binding) {
          binding[field] = resolveScalar(
            binding[field],
            `surfaces.${platform}[${i}].binding.${field}`,
          );
        }
      }
    }
  }
}
