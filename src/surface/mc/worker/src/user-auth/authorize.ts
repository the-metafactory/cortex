/**
 * GA-1: Pure authorization logic — no Hono, no D1, no side effects.
 * Both middleware and tests call these functions, ensuring tests exercise
 * the same code paths as production.
 */

import type { Role, GrantScope, AgentClass } from "./types";
import { ROLE_HIERARCHY, SCOPE_HIERARCHY } from "./types";

// =============================================================================
// Role check
// =============================================================================

export type RoleCheckResult =
  | { allowed: true }
  | { allowed: false; error: "insufficient_role"; required: Role; current: Role };

/** Check if a user's role meets the minimum required level. */
export function checkRole(userRole: Role, minRole: Role): RoleCheckResult {
  if (ROLE_HIERARCHY[userRole] >= ROLE_HIERARCHY[minRole]) {
    return { allowed: true };
  }
  return { allowed: false, error: "insufficient_role", required: minRole, current: userRole };
}

// =============================================================================
// Agent access check
// =============================================================================

export interface AgentAccessInput {
  userId: string;
  userRole: Role;
  agentOwnerId: string;
  agentClass: AgentClass;
  grantScope: GrantScope | null;
  requiredScope: GrantScope;
}

export type AgentAccessResult =
  | { allowed: true; resolution: "owner" | "grant" | "admin" | "cattle"; availableScope: GrantScope }
  | { allowed: false; error: "no_agent_access"; availableScope: GrantScope | null };

/**
 * Determine if a user can access an agent at the required scope level.
 * Resolution order: owner → active grant → admin bypass → cattle open access.
 */
export function checkAgentAccess(input: AgentAccessInput): AgentAccessResult {
  const { userId, userRole, agentOwnerId, agentClass, grantScope, requiredScope } = input;

  // 1. Owner → full access
  if (agentOwnerId === userId) {
    return { allowed: true, resolution: "owner", availableScope: "control" };
  }

  // 2. Active grant with sufficient scope
  if (grantScope && SCOPE_HIERARCHY[grantScope] >= SCOPE_HIERARCHY[requiredScope]) {
    return { allowed: true, resolution: "grant", availableScope: grantScope };
  }

  // 3. Admin bypass
  if (userRole === "admin") {
    return { allowed: true, resolution: "admin", availableScope: "control" };
  }

  // 4. Cattle open access (any principal)
  if (agentClass === "cattle" && ROLE_HIERARCHY[userRole] >= ROLE_HIERARCHY["operator"]) {
    return { allowed: true, resolution: "cattle", availableScope: "control" };
  }

  return { allowed: false, error: "no_agent_access", availableScope: grantScope };
}
