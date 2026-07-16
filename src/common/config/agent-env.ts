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
// ## HARD CONSTRAINT — a RESERVED-PREFIX denylist stays default-deny (cortex#701, #2133)
//
// This passthrough must NEVER become a route to disable a cortex guard or
// redirect auth. A declared variable that lands in one of four reserved
// prefixes can do exactly that, so {@link isDeniedAgentEnvKey} refuses ANY key
// whose upper-cased name starts with one of:
//
//   - `CLAUDE_`    — a `CLAUDE_*` var can re-introduce hooks/plugins/settings/
//     alternate config homes and thereby undo the cortex#701 session-isolation
//     boundary (`scopeSessionEnv` in `src/runner/session-settings.ts`). The
//     cortex#2132 revert — which allowlisted `CLAUDE_CONFIG_DIR` through the
//     scope and then reverted in favour of a typed `substrates:` table — is the
//     binding precedent.
//   - `ANTHROPIC_` — Claude Code ALSO honours `ANTHROPIC_BASE_URL`,
//     `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, and `ANTHROPIC_MODEL`. (The
//     old comment here claiming "Claude Code only reads the upper-case CLAUDE_*
//     names" was FALSE.) A declared `ANTHROPIC_BASE_URL` would REDIRECT the
//     session's inference endpoint (exfil / MITM), and `ANTHROPIC_API_KEY` /
//     `_AUTH_TOKEN` would swap the credential the session authenticates with —
//     both are auth-redirect vectors this map must never open.
//   - `CORTEX_` — cortex's OWN control-plane vars live here: `CORTEX_BASH_GUARD`
//     (the bash-guard config — a declared value could DISABLE the guard or widen
//     it to `.*`), `CORTEX_SKILL_GRANTS` / `CORTEX_MCP_GRANTS` (the per-session
//     capability grant lists the guards read), plus the `CORTEX_CHANNEL` /
//     `CORTEX_AGENT_*` / `CORTEX_PRINCIPAL` instrumentation identity. None may be
//     settable by a declared var — that would let an agent rewrite its own
//     guard config or identity.
//   - `GROVE_` — the legacy alias namespace for the same `CORTEX_*` control vars
//     (still read as a transition fallback, cortex#767/#774). Denied for the
//     identical reason; leaving it open would be a trivial bypass of the
//     `CORTEX_` deny via the legacy name.
//
// {@link isDeniedAgentEnvKey} is the SINGLE SOURCE OF TRUTH for the deny, used
// in BOTH places that must agree:
//
//   1. Config LOAD  — {@link AgentEnvSchema} rejects any denied key at parse
//      time, so a stack whose config declares a reserved-prefix passthrough
//      fails to load (the daemon refuses it).
//   2. Session BUILD — `resolveAgentEnv` (session-settings.ts) re-asserts the
//      deny at runtime as defence-in-depth, so no code path (a test, a future
//      direct caller, a schema regression) can ever layer a reserved-prefix var
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
 * The default-deny prefixes. Any variable whose name (case-folded) begins with
 * one of these is refused by the per-agent env passthrough — see the module doc
 * for the per-prefix rationale. Each prefix names a namespace where a declared
 * var could disable a cortex guard (`CORTEX_`/`GROVE_`), redirect auth or the
 * inference endpoint (`ANTHROPIC_`), or re-open the session-isolation boundary
 * (`CLAUDE_`).
 */
export const RESERVED_ENV_PREFIXES = [
  "CLAUDE_",
  "ANTHROPIC_",
  "CORTEX_",
  "GROVE_",
] as const;

/**
 * The default-deny `CLAUDE_` prefix. Retained as a named export (it is the
 * historically-referenced one) even though the deny now spans
 * {@link RESERVED_ENV_PREFIXES}.
 */
export const CLAUDE_ENV_PREFIX = "CLAUDE_";

/**
 * The ONE predicate deciding whether a key is refused by the per-agent env
 * passthrough. `true` ⇒ deny. Case-INSENSITIVE on the reserved prefixes: env
 * var names are case-sensitive on POSIX but the substrates that read these
 * names (Claude Code, cortex's own hooks) read the upper-case spellings, so a
 * case-insensitive check is strictly SAFER — it also refuses `claude_*` /
 * `Cortex_*` spelling tricks — at the cost of blocking a vanishingly rare
 * legitimate lower-case `claude_…`/`cortex_…`/etc. var, an acceptable, airtight
 * trade. Used by BOTH {@link AgentEnvSchema} (load-time reject) and
 * `resolveAgentEnv` (runtime drop) so they cannot diverge.
 */
export function isDeniedAgentEnvKey(key: string): boolean {
  const upper = key.toUpperCase();
  return RESERVED_ENV_PREFIXES.some((prefix) => upper.startsWith(prefix));
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
 * reserved-prefix key ({@link RESERVED_ENV_PREFIXES}, case-insensitive) is
 * REJECTED at parse time via {@link isDeniedAgentEnvKey}, so a declared var can
 * neither widen the isolation boundary nor disable a cortex guard / redirect
 * auth. Optional on the agent; absent ⇒ no passthrough (the pre-#2133
 * behaviour, byte-for-byte).
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
            `agent env key '${key}' is not allowed: variables in the reserved prefixes ` +
            `[${RESERVED_ENV_PREFIXES.join(", ")}] are default-deny (cortex#701 / #2133). A ` +
            `per-agent env passthrough must never set one — CLAUDE_*/ANTHROPIC_* would ` +
            `re-introduce hooks/plugins/settings or redirect auth and the inference endpoint, ` +
            `and CORTEX_*/GROVE_* would disable a cortex guard (e.g. CORTEX_BASH_GUARD) or ` +
            `rewrite the session's grants/identity. Use the substrates: configHome seam ` +
            `(cortex#2132) to relocate a substrate config home; this map is for everything ` +
            `that is NOT a substrate config or cortex control var.`,
        });
      }
    }
  });

/** A validated per-agent env passthrough map (name → literal-or-`env:NAME`). */
export type AgentEnv = z.infer<typeof AgentEnvSchema>;
