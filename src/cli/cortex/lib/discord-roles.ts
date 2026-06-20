/**
 * Discord guild-role helpers for `cortex network admit` (ADR-0015, O-5).
 *
 * These are RUNTIME helpers the cortex daemon-side `network admit` command
 * depends on to grant the `community-fleet` role — NOT principal/agent tooling.
 * They were carried in the in-repo Discord CLI lib until that CLI + its skills
 * were extracted into the `metafactory-discord` arc bundle (ADR-0017, epic
 * #1171 S2). The CLI tooling moved out; this slice keeps the small slice the
 * runtime actually imports inside cortex, because the daemon cannot import from
 * an external `arc install`-able bundle.
 *
 * Scope is deliberately narrow: only the role-grant REST calls
 * (`resolveRoleId` / `assignRole`), the CLI config loader (`loadConfig`), and
 * the server-context resolver (`resolveServerContext`) that the admit path
 * uses. Posting / reading / threads / attachments stayed with the bundle.
 *
 * Config is read from `~/.config/cortex/cli.yaml` (cortex-first, grove
 * fallback) via the shared `common/config/config-path` resolver — the same
 * file the extracted CLI writes, so a principal who has run the bundle's
 * `discord config set …` keeps a working admit path.
 */

import { existsSync, readFileSync } from "fs";
import YAML from "yaml";
import { resolveConfigFilePath } from "../../../common/config/config-path";

const DISCORD_API = "https://discord.com/api/v10";
const CONFIG_FILENAME = "cli.yaml";

// =============================================================================
// Config shapes (subset of the extracted CLI's DiscordCliConfig — only the
// fields the admit path's server-context resolution reads).
// =============================================================================

export interface ChannelConfig {
  /** Discord channel ID */
  id: string;
}

/** A named server profile — a second (or third, …) guild the same bot is in. */
export interface ServerProfile {
  /** Discord guild/server ID for this profile (required) */
  guildId: string;
  /** Per-profile bot token; falls back to top-level botToken when absent */
  botToken?: string;
  /** Per-profile default channel; falls back to top-level defaultChannel */
  defaultChannel?: string;
  /** Per-profile cached channel name→id map */
  channels?: Record<string, ChannelConfig>;
}

export interface DiscordCliConfig {
  /** Discord bot token */
  botToken?: string;
  /** Discord guild/server ID */
  guildId?: string;
  /** Default channel name to post to */
  defaultChannel?: string;
  /** Named channel configs */
  channels?: Record<string, ChannelConfig>;
  /** Named server profiles for guilds other than the top-level (grove) one */
  servers?: Record<string, ServerProfile>;
}

/**
 * Load the Discord CLI config from `~/.config/cortex/cli.yaml`
 * (cortex-first, grove fallback — GV-1 / cortex#1076). Returns `{}` when no
 * config exists so the admit path degrades to "skipped_no_token" rather than
 * throwing.
 */
export function loadConfig(): DiscordCliConfig {
  const path = resolveConfigFilePath(CONFIG_FILENAME);
  if (!existsSync(path)) return {};
  const text = readFileSync(path, "utf-8");
  return (YAML.parse(text) as DiscordCliConfig | undefined) ?? {};
}

// =============================================================================
// Server-context resolution — decides WHICH guild + token the admit path acts
// against. Pure (no I/O). Ported verbatim from the extracted CLI's
// server-context.ts, trimmed to what the admit path uses.
// =============================================================================

/** Flags that influence server-context resolution. */
export interface ServerContextOptions {
  /** Raw `--guild <id>` value, if provided. */
  guild?: string;
  /** Raw `--server <name>` value, if provided. */
  server?: string;
}

/** The effective context after layering flags + profile over the base config. */
export interface ResolvedServerContext {
  /** Guild ID used for role resolution (may be undefined). */
  guildId?: string;
  /** Bot token to authenticate API calls (may be undefined). */
  botToken?: string;
  /** Default channel name when none passed on the command line. */
  defaultChannel?: string;
  /** Cached channel name→id map. */
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
 * Precedence (highest wins): explicit `--guild` flag > `--server` profile >
 * top-level config. With neither flag, the resolved context is byte-identical
 * to the top-level config.
 *
 * @throws ServerContextError when the named profile is unknown, the profile is
 *   missing its required guildId, or `--guild` and `--server` disagree.
 */
export function resolveServerContext(
  config: DiscordCliConfig,
  opts: ServerContextOptions,
): ResolvedServerContext {
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
          `Register it with: discord config set-server ${opts.server} <guildId>`,
      );
    }
    if (!profile.guildId) {
      throw new ServerContextError(
        `Server profile "${opts.server}" is missing guildId. ` +
          `Set it with: discord config set-server ${opts.server} <guildId>`,
      );
    }
    guildId = profile.guildId;
    serverName = opts.server;
    if (profile.botToken) botToken = profile.botToken;
    if (profile.defaultChannel) defaultChannel = profile.defaultChannel;
    if (profile.channels) {
      channels = profile.channels;
      channelsGuildId = profile.guildId;
    }
  }

  // ── Layer 2: explicit --guild flag (highest precedence for guildId) ───────
  if (opts.guild) {
    if (serverName && guildId && opts.guild !== guildId) {
      throw new ServerContextError(
        `Conflicting guild: --guild ${opts.guild} but --server "${serverName}" ` +
          `resolves to guild ${guildId}. Pass only one, or make them agree.`,
      );
    }
    guildId = opts.guild;
  }

  return { guildId, botToken, defaultChannel, channels, channelsGuildId, serverName };
}

// =============================================================================
// Guild role management (O-5 — community-fleet admission). REST wrappers over
// the Discord v10 API. The bot token is NEVER included in error messages.
// =============================================================================

/** Result type for assignRole. */
export interface RoleResult {
  success: boolean;
  error?: string;
}

/** Discord API role shape (narrowest projection this module reads). */
interface DiscordApiRole {
  id: string;
  name: string;
}

/**
 * Map a non-204 HTTP response from a role assignment call to a `RoleResult`.
 * The bot token is NEVER passed here and cannot appear in the output.
 */
function mapRoleError(status: number, body: string, guildId: string): RoleResult {
  if (status === 403) {
    return {
      success: false,
      error:
        `Bot lacks Manage Roles permission (or its highest role is below the target role) ` +
        `in guild ${guildId}. Ensure the bot has Manage Roles and its role is above community-fleet.`,
    };
  }
  if (status === 404) {
    return { success: false, error: `member or role not found in guild ${guildId}` };
  }
  return { success: false, error: `${status}: ${body}` };
}

/**
 * Assign a guild role to a member.
 *
 * Wraps `PUT /guilds/{guild}/members/{user}/roles/{role}` (Discord v10).
 * Success = 204 (no body). Error mappings: 403 → bot lacks Manage Roles (or
 * its highest role sits below the target); 404 → member or role not found;
 * other → surfaces the HTTP status + body. The bot token is NEVER included in
 * error messages.
 *
 * Prerequisite (document; do NOT attempt to self-grant): the bot must have the
 * **Manage Roles** permission AND its highest role must sit above
 * `community-fleet` in the guild role hierarchy.
 */
export async function assignRole(
  botToken: string,
  guildId: string,
  userId: string,
  roleId: string,
): Promise<RoleResult> {
  const res = await fetch(
    `${DISCORD_API}/guilds/${guildId}/members/${userId}/roles/${roleId}`,
    {
      method: "PUT",
      headers: { Authorization: `Bot ${botToken}` },
    },
  );

  if (res.status === 204) return { success: true };

  const body = await res.text();
  return mapRoleError(res.status, body, guildId);
}

/**
 * Resolve a role name (or snowflake id) to a role id.
 *
 * A 17–20 digit input is treated as an id and returned unchanged (no network
 * call). Otherwise lists the guild's roles and matches case-insensitively by
 * name, throwing on not-found or an ambiguous (multi-id) match.
 */
export async function resolveRoleId(
  botToken: string,
  guildId: string,
  roleNameOrId: string,
): Promise<string> {
  // Snowflake passthrough — no network call needed.
  if (/^\d{17,20}$/.test(roleNameOrId)) return roleNameOrId;

  const res = await fetch(`${DISCORD_API}/guilds/${guildId}/roles`, {
    headers: { Authorization: `Bot ${botToken}` },
  });

  if (!res.ok) {
    throw new Error(`Failed to list roles in guild ${guildId}: ${res.status}`);
  }

  const roles = (await res.json()) as DiscordApiRole[];
  const lower = roleNameOrId.toLowerCase();
  const matches = roles.filter((r) => r.name.toLowerCase() === lower);

  if (matches.length === 0) {
    throw new Error(
      `Role "${roleNameOrId}" not found in guild ${guildId}. ` +
        `Pass the role's snowflake id directly, or check: discord roles --server <profile>`,
    );
  }

  // Distinct ids — same name (case-insensitive) but different ids is ambiguous.
  const distinctIds = [...new Set(matches.map((r) => r.id))];
  if (distinctIds.length > 1) {
    const names = matches.map((r) => `"${r.name}" (${r.id})`).join(", ");
    throw new Error(
      `Role name "${roleNameOrId}" is ambiguous — multiple roles match: ${names}. ` +
        `Pass the exact snowflake id to disambiguate.`,
    );
  }

  // distinctIds is guaranteed non-empty (matches.length > 0 above).
  const id = distinctIds[0];
  if (!id) throw new Error(`internal: role match produced empty id list`);
  return id;
}
