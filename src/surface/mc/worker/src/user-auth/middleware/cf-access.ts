/**
 * GA-1: CF Access JWT validation helpers.
 * Extracted for reuse by requireRole() — the JWT validation logic itself.
 *
 * cortex#1410: the signature/claims verification now lives in the shared,
 * runtime-agnostic verifier (`src/common/auth/cf-access-jwt.ts`); this module
 * keeps the worker-shaped helpers (`env`/cookie plumbing) and delegates the
 * crypto to it. The team domain is a fixed CF constant for this deployment.
 */

import type { AuthBindings } from "../types";
import { verifyCfAccessJwt } from "../../../../../../common/auth/cf-access-jwt";

const CF_ACCESS_TEAM = "metafactory";

/**
 * Validate a CF Access JWT.
 * Returns the decoded payload on success, or null on failure.
 */
export async function validateCfAccessJwt(
  token: string,
  audience: string,
): Promise<Record<string, unknown> | null> {
  return verifyCfAccessJwt(token, { aud: audience, teamDomain: CF_ACCESS_TEAM });
}

/**
 * Extract CF Access email from JWT cookie.
 * Returns null if no audience configured (local dev), no cookie, or invalid JWT.
 */
export async function getCfAccessEmail(
  env: AuthBindings,
  req: { header(name: string): string | undefined },
): Promise<string | null> {
  const audience = env.CF_ACCESS_AUD;
  if (!audience) return null;

  const cookie = req.header("Cookie") ?? "";
  const match = cookie.match(/CF_Authorization=([^;]+)/);
  const token = match?.[1];
  if (!token) return null;

  const payload = await validateCfAccessJwt(token, audience);
  return payload ? (payload.email as string) ?? null : null;
}
