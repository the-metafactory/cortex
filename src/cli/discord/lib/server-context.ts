/**
 * Server-context resolution — the single place that decides WHICH guild a
 * `discord` command resolves channel/thread names against, and which
 * token / default-channel / cached-channels apply.
 *
 * Two complementary mechanisms layer over the single-guild base config:
 *
 *   1. `-g, --guild <id>`   — overrides the guildId used for NAME resolution.
 *   2. `-s, --server <name>` — selects a named profile from `config.servers`,
 *      layering its guildId (required) plus optional botToken / defaultChannel
 *      / channels over the top-level values.
 *
 * Precedence (highest wins): explicit `--guild` flag  >  `--server` profile
 * >  top-level config. The `--channel` flag (handled by the caller) likewise
 * beats a profile's `defaultChannel`.
 *
 * Back-compat invariant: with neither `--guild` nor `--server`, the resolved
 * context is byte-identical to the top-level config — the legacy single-guild
 * path is untouched.
 *
 * This module is intentionally PURE (no I/O, no process.exit, no network) so
 * the precedence logic is unit-testable in isolation. Callers translate a
 * thrown `ServerContextError` into a CLI error + exit code.
 */

import type { ChannelConfig, DiscordCliConfig, ServerProfile } from "./config";

/** Flags that influence server-context resolution, parsed from argv. */
export interface ServerContextOptions {
  /** Raw `--guild <id>` value, if provided. */
  guild?: string;
  /** Raw `--server <name>` value, if provided. */
  server?: string;
}

/**
 * The effective context a command operates in after layering flags + profile
 * over the base config. `guildId` may still be undefined when nothing supplies
 * one (same as today's "Guild ID required" path) — the caller validates it.
 */
export interface ResolvedServerContext {
  /** Guild ID used for channel/thread NAME resolution (may be undefined). */
  guildId?: string;
  /** Bot token to authenticate API calls (may be undefined). */
  botToken?: string;
  /** Default channel name when none passed on the command line. */
  defaultChannel?: string;
  /** Cached channel name→id map for guild-agnostic id posting. */
  channels?: Record<string, ChannelConfig>;
  /** Guild that owns the resolved cached channel map, when known. */
  channelsGuildId?: string;
  /** Name of the profile applied, when `--server` was used. */
  serverName?: string;
}

/** Raised for caller-facing, user-fixable resolution failures. */
export class ServerContextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ServerContextError";
  }
}

/**
 * Resolve the effective server context from base config + flags.
 *
 * @throws ServerContextError when the named profile is unknown, the profile
 *   is missing its required guildId, or `--guild` and `--server` disagree on
 *   the guild.
 */
export function resolveServerContext(
  config: DiscordCliConfig,
  opts: ServerContextOptions
): ResolvedServerContext {
  // Start from the top-level (grove) values — the no-flag path returns these
  // unchanged, preserving byte-identical legacy behaviour.
  let guildId = config.guildId;
  let botToken = config.botToken;
  let defaultChannel = config.defaultChannel;
  let channels = config.channels;
  let channelsGuildId = config.channels ? config.guildId : undefined;
  let serverName: string | undefined;

  // ── Layer 1: named server profile ────────────────────────────────────────
  if (opts.server) {
    const profile = config.servers?.[opts.server];
    if (!profile) {
      throw new ServerContextError(
        `Server profile "${opts.server}" not found. ` +
          `Register it with: discord config set-server ${opts.server} <guildId>`
      );
    }
    if (!profile.guildId) {
      throw new ServerContextError(
        `Server profile "${opts.server}" is missing guildId. ` +
          `Set it with: discord config set-server ${opts.server} <guildId>`
      );
    }
    guildId = profile.guildId;
    serverName = opts.server;
    // Optional overrides fall back to the top-level values when absent.
    if (profile.botToken) botToken = profile.botToken;
    if (profile.defaultChannel) defaultChannel = profile.defaultChannel;
    if (profile.channels) {
      channels = profile.channels;
      channelsGuildId = profile.guildId;
    }
  }

  // ── Layer 2: explicit --guild flag (highest precedence for guildId) ───────
  if (opts.guild) {
    // A profile + an explicit guild that disagree is almost certainly a
    // principal mistake — fail loudly rather than silently picking one.
    if (serverName && guildId && opts.guild !== guildId) {
      throw new ServerContextError(
        `Conflicting guild: --guild ${opts.guild} but --server "${serverName}" ` +
          `resolves to guild ${guildId}. Pass only one, or make them agree.`
      );
    }
    guildId = opts.guild;
  }

  return { guildId, botToken, defaultChannel, channels, channelsGuildId, serverName };
}

/**
 * Return a cached channel id only when the cache belongs to the same guild the
 * command is currently resolving names in. This keeps a top-level `channels:`
 * map from silently targeting another guild after `--guild`/`--server`.
 */
export function cachedChannelId(
  ctx: ResolvedServerContext,
  channelName: string
): string | undefined {
  if (!ctx.guildId || ctx.channelsGuildId !== ctx.guildId) return undefined;
  return ctx.channels?.[channelName]?.id;
}

/**
 * Register (or update) a named server profile in the config object, mutating
 * and returning it. Pure aside from the in-place mutation — does NOT persist;
 * the caller saves. `guildId` is required; `defaultChannel` is optional. A
 * per-profile token is intentionally NOT settable here so this command never
 * writes a token (token sharing across guilds is the whole point).
 *
 * @throws ServerContextError on an empty name or guildId.
 */
export function registerServerProfile(
  config: DiscordCliConfig,
  name: string,
  guildId: string,
  defaultChannel?: string
): DiscordCliConfig {
  if (!name) throw new ServerContextError("Server profile name is required.");
  if (!guildId) throw new ServerContextError("guildId is required.");

  config.servers ??= {};
  const existing: ServerProfile | undefined = config.servers[name];
  const next: ServerProfile = { ...existing, guildId };
  if (defaultChannel) next.defaultChannel = defaultChannel;
  config.servers[name] = next;
  return config;
}
