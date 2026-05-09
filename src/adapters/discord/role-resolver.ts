/**
 * Resolves user IDs to their configured role and effective permissions.
 * Platform-agnostic — works with any role config (Discord, Mattermost, etc.)
 */

import type { BotConfig, DiscordRole } from "../../common/types/config";

export interface ResolvedRole {
  name: string;
  features: Set<string>;
  disallowedTools: string[];
  allowedDirs: string[] | undefined;
  /** G-121: Skills this role may invoke. undefined → all; [] → none; [...] → only listed. */
  allowedSkills: string[] | undefined;
  denied: boolean;
}

/** The "allow-all" role — no restrictions, all features */
const ALLOW_ALL_ROLE: ResolvedRole = {
  name: "allow-all",
  features: new Set(["chat", "async", "team"]),
  disallowedTools: [],
  allowedDirs: undefined,
  allowedSkills: undefined,
  denied: false,
};

const DENIED_ROLE: ResolvedRole = {
  name: "denied",
  features: new Set(),
  disallowedTools: [],
  allowedDirs: [],
  allowedSkills: [],
  denied: true,
};

/** Role resolution config — can come from any platform instance */
export interface RoleConfig {
  roles: DiscordRole[];
  defaultRole: string;
}

/**
 * Resolve a user ID to their effective role.
 *
 * Accepts either:
 * - RoleConfig (from an adapter's instance config) — preferred
 * - BotConfig (legacy — reads from first discord instance)
 *
 * If no roles are configured, returns allow-all (backward compat).
 * If roles are configured but user isn't in any, uses defaultRole.
 */
export function resolveRole(userId: string, config: BotConfig | RoleConfig): ResolvedRole {
  let roles: DiscordRole[];
  let defaultRoleName: string;
  let globalDisallowed: string[];
  let globalAllowedDirs: string[];

  if ("roles" in config && "defaultRole" in config && !("agent" in config)) {
    // RoleConfig passed directly (new adapter path)
    const rc = config as RoleConfig;
    roles = rc.roles;
    defaultRoleName = rc.defaultRole;
    globalDisallowed = [];
    globalAllowedDirs = [];
  } else {
    // BotConfig passed (legacy path) — read from first discord instance
    const bc = config as BotConfig;
    const instance = bc.discord[0];
    roles = instance?.roles ?? [];
    defaultRoleName = instance?.defaultRole ?? "allow-all";
    globalDisallowed = bc.claude.disallowedTools ?? [];
    globalAllowedDirs = bc.claude.allowedDirs ?? [];
  }

  // No roles configured = everyone gets full access (backward compat)
  if (roles.length === 0) {
    return ALLOW_ALL_ROLE;
  }

  // Find the user's role
  const role = roles.find((r) => r.users.includes(userId));

  if (role) {
    return roleToResolved(role, globalDisallowed, globalAllowedDirs);
  }

  // User not in any role — check defaultRole
  if (defaultRoleName === "allow-all") {
    return ALLOW_ALL_ROLE;
  }

  if (defaultRoleName === "denied") {
    return DENIED_ROLE;
  }

  // defaultRole references a named role definition (use its permissions without the user list)
  const namedDefault = roles.find((r) => r.name === defaultRoleName);
  if (namedDefault) {
    return roleToResolved(namedDefault, globalDisallowed, globalAllowedDirs);
  }

  // Unknown defaultRole name — deny for safety
  return DENIED_ROLE;
}

function roleToResolved(
  role: DiscordRole,
  globalDisallowed: string[],
  globalAllowedDirs: string[],
): ResolvedRole {
  // Merge role disallowedTools with global claude.disallowedTools
  const roleDisallowed = role.disallowedTools ?? [];
  const mergedDisallowed = [...new Set([...globalDisallowed, ...roleDisallowed])];

  return {
    name: role.name,
    features: new Set(role.features),
    disallowedTools: mergedDisallowed,
    allowedDirs: role.allowedDirs !== undefined ? role.allowedDirs : (globalAllowedDirs.length > 0 ? globalAllowedDirs : undefined),
    allowedSkills: role.allowedSkills,
    denied: false,
  };
}
