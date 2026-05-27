/**
 * GA-1: Auth types shared across middleware and consumers.
 * Design: docs/design-auth-aaa.md v2
 */

export type Role = "viewer" | "operator" | "admin";
export type AgentClass = "pet" | "cattle";
export type GrantScope = "read" | "review" | "control";

export const ROLE_HIERARCHY: Record<Role, number> = { viewer: 0, operator: 1, admin: 2 };
export const SCOPE_HIERARCHY: Record<GrantScope, number> = { read: 0, review: 1, control: 2 };

export interface UserRecord {
  id: string;
  email: string;
  display_name: string | null;
  role: Role;
  created_at: string;
  updated_at: string;
}

export interface AgentRecord {
  id: string;
  display_name: string;
  owner_id: string;
  class: AgentClass;
  backend: string | null;
  spawn_profile: string | null;
  created_at: string;
}

export interface GrantRecord {
  id: string;
  agent_id: string;
  owner_id: string;
  grantee_id: string;
  scope: GrantScope;
  requires_stepup: number;
  expires_at: string | null;
  created_at: string;
  revoked_at: string | null;
}

/**
 * Bindings required by grove-auth middleware.
 * The consuming Worker's Env must extend this.
 */
export interface AuthBindings {
  GROVE_DB: D1Database;
  CF_ACCESS_AUD: string;
}
