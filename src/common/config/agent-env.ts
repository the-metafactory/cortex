// cortex#2133 (epic #2164) — declarative per-agent environment passthrough.
//
// ## The gap this closes
//
// A deployment credential a CLI-based skill needs (e.g.
// `GOOGLE_APPLICATION_CREDENTIALS` for the `gws` Google Drive skill) has no
// declarative home in cortex config. The only route was hand-editing the
// launchd plist that `arc` renders — which `arc upgrade cortex` re-renders,
// silently dropping the edit and quietly killing the capability. This adds a
// per-agent `env:` map on `agents[]` (narrowest scope — only the agent that
// needs the credential gets it) that is applied at the SESSION layer, so it is
// a cortex-only change with no arc/plist dependency.
//
// ## HARD CONSTRAINT — CLAUDE_* stays default-deny (cortex#701)
//
// This passthrough must NEVER become a route to set a `CLAUDE_*` variable. A
// `CLAUDE_*` var can re-introduce hooks/plugins/settings/alternate config
// homes and thereby undo the cortex#701 session-isolation boundary
// (`scopeSessionEnv` in `src/runner/session-settings.ts`). The cortex#2132
// revert — which allowlisted `CLAUDE_CONFIG_DIR` through the scope and then
// reverted in favour of a typed `substrates:` table — is the binding
// precedent. So {@link isDeniedAgentEnvKey} is the SINGLE SOURCE OF TRUTH for
// the deny, used in BOTH places that must agree:
//
//   1. Config LOAD  — {@link AgentEnvSchema} rejects any denied key at parse
//      time, so a stack whose config declares a `CLAUDE_*` passthrough fails
//      to load (the daemon refuses it).
//   2. Session BUILD — `resolveAgentEnv` (session-settings.ts) re-asserts the
//      deny at runtime as defence-in-depth, so no code path (a test, a future
//      direct caller, a schema regression) can ever layer a `CLAUDE_*` var
//      onto a child session's env.
//
// Keeping ONE predicate means the two layers cannot drift.
//
// ## Secrets posture (design §"Secrets and egress", D6)
//
// A value is EITHER a non-secret literal (a path like
// `/Users/andreas/.config/gws/sa.json` — a path, not a secret) OR a SECRET
// REFERENCE of the form `env:NAME` ({@link SECRET_REF_PATTERN}). A reference is
// resolved from the daemon env AT CALL TIME (`resolveAgentEnv`), never at parse
// time, so a config dump shows `env:NAME` and never the secret value. This
// mirrors the `providers.*.apiKey` convention.

import { z } from "zod/v4";

/**
 * Environment-variable name grammar: a letter or underscore, then any run of
 * alphanumerics/underscores. The conventional POSIX-ish identifier shape — the
 * same one `SECRET_REF_PATTERN` (`../inference/secret-ref`) accepts after the
 * `env:` prefix.
 */
export const AGENT_ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * The default-deny prefix. Any variable whose name (case-folded) begins with
 * `CLAUDE_` is refused by the per-agent env passthrough — see the module doc.
 */
export const CLAUDE_ENV_PREFIX = "CLAUDE_";

/**
 * The ONE predicate deciding whether a key is refused by the per-agent env
 * passthrough. `true` ⇒ deny. Case-INSENSITIVE on the `CLAUDE_` prefix: env
 * var names are case-sensitive on POSIX and Claude Code only reads the
 * upper-case `CLAUDE_*` names, so a case-insensitive check is strictly SAFER
 * (it also refuses `claude_*`/`Claude_*` spelling tricks) at the cost of
 * blocking a vanishingly rare legitimate lower-case `claude_…` var — an
 * acceptable, airtight trade. Used by BOTH {@link AgentEnvSchema} (load-time
 * reject) and `resolveAgentEnv` (runtime drop) so they cannot diverge.
 */
export function isDeniedAgentEnvKey(key: string): boolean {
  return key.toUpperCase().startsWith(CLAUDE_ENV_PREFIX);
}

/**
 * A single passthrough value: a non-empty string that is either a literal or
 * an `env:NAME` secret reference. The `env:NAME` vs literal distinction is made
 * at RESOLUTION time (`resolveAgentEnv`), not here — this schema only requires
 * the value be present and non-empty, so a literal path is accepted as-is.
 */
export const AgentEnvValueSchema = z
  .string()
  .min(
    1,
    "agent env value must be a non-empty string — a literal (e.g. a credential path) " +
      "or an `env:NAME` secret reference",
  );

/**
 * cortex#2133 — the per-agent `env:` map schema. Keys are env-var names
 * ({@link AGENT_ENV_KEY_PATTERN}); values are {@link AgentEnvValueSchema}. A
 * `CLAUDE_*` key (case-insensitive) is REJECTED at parse time via
 * {@link isDeniedAgentEnvKey}, so the isolation boundary cannot be widened
 * through this surface. Optional on the agent; absent ⇒ no passthrough (the
 * pre-#2133 behaviour, byte-for-byte).
 */
export const AgentEnvSchema = z
  .record(
    z
      .string()
      .regex(
        AGENT_ENV_KEY_PATTERN,
        "agent env var name must be a POSIX identifier — a letter or underscore " +
          "followed by letters, digits, or underscores (e.g. 'GOOGLE_APPLICATION_CREDENTIALS')",
      ),
    AgentEnvValueSchema,
  )
  .superRefine((map, ctx) => {
    for (const key of Object.keys(map)) {
      if (isDeniedAgentEnvKey(key)) {
        ctx.addIssue({
          code: "custom",
          path: [key],
          message:
            `agent env key '${key}' is not allowed: CLAUDE_* variables are default-deny ` +
            `(cortex#701 session isolation). A per-agent env passthrough must never set a ` +
            `CLAUDE_* var — that would re-introduce hooks/plugins/settings and undo the ` +
            `isolation boundary. Use the substrates: configHome seam (cortex#2132) to relocate ` +
            `a substrate config home; this map is for everything that is NOT a substrate config var.`,
        });
      }
    }
  });

/** A validated per-agent env passthrough map (name → literal-or-`env:NAME`). */
export type AgentEnv = z.infer<typeof AgentEnvSchema>;
