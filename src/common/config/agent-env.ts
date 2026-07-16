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
// ## HARD CONSTRAINT — this is an ALLOWLIST: deny-by-default (cortex#2133, epic #2164)
//
// The passthrough permits ONLY the exact env-var names in
// {@link ALLOWED_AGENT_ENV_KEYS}. Every other name is refused — at config load
// and again at runtime. This is a DELIBERATE inversion from the original
// reserved-prefix DENYLIST, which an adversarial review of PR #2171 proved
// UNSOUND: the set of names that can hijack a child session is open-ended and
// cannot be fully enumerated, so a denylist can never be complete. The classes
// a denylist has to chase (non-exhaustive — that is the whole point) include:
//
//   - bash startup files:      `BASH_ENV`, `ENV` — sourced before every
//     non-interactive shell, i.e. arbitrary code execution on any `bash -c`.
//   - node / bun runtime:      `NODE_OPTIONS` (e.g. `--require /evil.js`),
//     `NODE_EXTRA_CA_CERTS` (trust a MITM CA), `BUN_INSPECT`, …
//   - dynamic-loader injection: `LD_PRELOAD`, `LD_LIBRARY_PATH` (Linux),
//     `DYLD_INSERT_LIBRARIES`, `DYLD_LIBRARY_PATH` (macOS) — load attacker code
//     into every spawned process.
//   - lookup path takeover:    `PATH` — shadow `git`, `gh`, `node`, anything.
//   - git subprocess hooks:    `GIT_SSH_COMMAND`, `GIT_EXTERNAL_DIFF`,
//     `GIT_PAGER`, `GIT_*` — arbitrary commands run by routine git calls.
//   - network redirection:     `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`,
//     `*_PROXY` — route the session's traffic through an attacker.
//   - cortex / substrate control: `CLAUDE_*`, `ANTHROPIC_*`, `CORTEX_*`,
//     `GROVE_*` — re-open the cortex#701 isolation boundary, redirect auth /
//     the inference endpoint, or disable a cortex guard (`CORTEX_BASH_GUARD`).
//
// There is no reason to believe that list is closed; the next runtime, tool, or
// cortex control var adds another entry no denylist author thought of. So we
// invert: nothing passes unless it is a name we have explicitly BLESSED as a
// benign credential input. Adding a permitted variable is a DELIBERATE, REVIEWED
// change to {@link ALLOWED_AGENT_ENV_KEYS} in THIS file — a cortex PR that a
// reviewer weighs against exactly the hijack classes above — never a config-time
// or runtime decision. Deny-by-default means an omission fails CLOSED (the var
// is simply not passed), which is the only safe direction for a trust-path
// control.
//
// The allowlist is seeded with exactly one name — `GOOGLE_APPLICATION_CREDENTIALS`,
// the credential PATH the `gws` Google Drive skill needs and the sole motivating
// case today. {@link isAllowedAgentEnvKey} is the SINGLE SOURCE OF TRUTH for the
// permit, used in BOTH places that must agree:
//
//   1. Config LOAD  — {@link AgentEnvSchema} rejects any non-allowlisted key at
//      parse time, so a stack whose config declares an unblessed passthrough
//      fails to load (the daemon refuses it).
//   2. Session BUILD — `resolveAgentEnv` (session-settings.ts) re-asserts the
//      allowlist at runtime as defence-in-depth, so no code path (a test, a
//      future direct caller, a schema regression) can ever layer an
//      unblessed var onto a child session's env.
//
// Keeping ONE predicate means the two layers cannot drift.
//
// ## Case sensitivity — EXACT match, never case-folded
//
// POSIX env var names are case-SENSITIVE: `PATH` and `Path` are DIFFERENT
// variables. {@link isAllowedAgentEnvKey} therefore does an EXACT membership
// test and does NOT upper-case-fold — only the blessed spelling passes. A
// case-fold would be actively wrong here: folding could let `path` match a
// blessed `PATH`-shaped entry, or (in the mirror image of the old denylist)
// admit a spelling the reader never intended. Exact match is the only correct
// shape for an allowlist of case-sensitive names.
//
// ## Ref-source guard uses a DIFFERENT shape (a prefix DENY) — and why
//
// A value may be an `env:NAME` SECRET REFERENCE ({@link SECRET_REF_PATTERN}),
// resolved from the DAEMON env at call time. The destination KEY is allowlisted
// as above (it is a name we SET on the child session). But the ref SOURCE name
// is a READ FROM the daemon env, not a set — so its risk is different: a blessed
// destination key could otherwise surface a SENSITIVE daemon var's value under a
// clean name (`GDRIVE_TOKEN: "env:CLAUDE_CODE_OAUTH_TOKEN"` exfiltrates the OAuth
// token). For a read, a PREFIX DENY on the cortex/substrate control namespaces
// ({@link RESERVED_REF_SOURCE_PREFIXES}) is the right shape: we are protecting a
// bounded, known set of guarded daemon vars from being re-surfaced, not deciding
// which arbitrary daemon var is a legitimate credential source. `resolveAgentEnv`
// applies {@link isReservedRefSource} to the ref source (session-settings.ts).
// Two sides, two shapes: allowlist what we SET, prefix-deny the guarded
// namespaces we must never READ-AND-RE-SURFACE.
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
 * `env:` prefix. This is the SECONDARY gate: a permitted key must ALSO be a
 * valid POSIX name (every {@link ALLOWED_AGENT_ENV_KEYS} entry already is; the
 * grammar check defends a non-schema runtime caller).
 */
export const AGENT_ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * The ALLOWLIST — the exact, case-sensitive set of env-var names the per-agent
 * passthrough permits. Deny-by-default: a name not in this set is refused at
 * BOTH config load ({@link AgentEnvSchema}) and session build (`resolveAgentEnv`).
 *
 * Seeded with EXACTLY the one var a supported skill needs today:
 *   - `GOOGLE_APPLICATION_CREDENTIALS` — the service-account credential PATH the
 *     `gws` Google Drive skill reads.
 *
 * To permit a NEW variable, add its exact name here in a cortex PR and have a
 * reviewer weigh it against the session-hijack classes in the module doc. This
 * is the ONLY place the permitted set is defined — never widen it at config or
 * runtime. See the module doc for why this is an allowlist and not a denylist
 * (epic #2164 + the PR #2171 adversarial finding: the denylist was proven
 * un-completable).
 */
export const ALLOWED_AGENT_ENV_KEYS = ["GOOGLE_APPLICATION_CREDENTIALS"] as const;

/** O(1) membership backing for {@link isAllowedAgentEnvKey}. */
const ALLOWED_AGENT_ENV_KEY_SET: ReadonlySet<string> = new Set(ALLOWED_AGENT_ENV_KEYS);

/**
 * The ONE predicate deciding whether a key is PERMITTED by the per-agent env
 * passthrough. `true` ⇒ allow; anything else ⇒ deny (deny-by-default).
 *
 * The test is EXACT and case-SENSITIVE — POSIX env var names are case-sensitive
 * (`PATH` ≠ `Path`), so only the blessed spelling passes; there is NO
 * case-folding. Used by BOTH {@link AgentEnvSchema} (load-time reject) and
 * `resolveAgentEnv` (runtime drop) so they cannot diverge.
 */
export function isAllowedAgentEnvKey(key: string): boolean {
  return ALLOWED_AGENT_ENV_KEY_SET.has(key);
}

/**
 * Prefix deny for the `env:NAME` SECRET-REF SOURCE side ONLY. A ref source is a
 * READ from the daemon env, so its guard is a prefix deny over the cortex /
 * substrate control namespaces (see the module doc "Ref-source guard uses a
 * DIFFERENT shape"). NOT used for the destination key — that side is the
 * allowlist {@link isAllowedAgentEnvKey}.
 *
 *   - `CLAUDE_` / `ANTHROPIC_` — substrate auth / config / endpoint vars.
 *   - `CORTEX_` / `GROVE_`     — cortex's own control-plane + legacy alias.
 */
export const RESERVED_REF_SOURCE_PREFIXES = [
  "CLAUDE_",
  "ANTHROPIC_",
  "CORTEX_",
  "GROVE_",
] as const;

/**
 * `true` ⇒ the given `env:NAME` SOURCE name is in a guarded namespace and must
 * NOT be re-surfaced under a clean destination key. Case-INSENSITIVE on the
 * prefixes: the substrates that read these names use the upper-case spellings,
 * so a case-insensitive check is strictly SAFER (it also refuses `claude_*` /
 * `cortex_*` spelling tricks). Applies to the ref SOURCE only — see the module
 * doc for why the two sides use different shapes.
 */
export function isReservedRefSource(name: string): boolean {
  const upper = name.toUpperCase();
  return RESERVED_REF_SOURCE_PREFIXES.some((prefix) => upper.startsWith(prefix));
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
 * ({@link AGENT_ENV_KEY_PATTERN}); values are {@link AgentEnvValueSchema}. A key
 * that is NOT in the {@link ALLOWED_AGENT_ENV_KEYS} allowlist is REJECTED at
 * parse time via {@link isAllowedAgentEnvKey} (deny-by-default), so a declared
 * var can neither widen the isolation boundary, redirect auth, disable a cortex
 * guard, nor hijack the session via any of the open-ended runtime/loader/PATH
 * classes a denylist could never fully enumerate. Optional on the agent; absent
 * ⇒ no passthrough (the pre-#2133 behaviour, byte-for-byte).
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
      if (!isAllowedAgentEnvKey(key)) {
        ctx.addIssue({
          code: "custom",
          path: [key],
          message:
            `agent env key '${key}' is not allowed: the per-agent env passthrough is ` +
            `DENY-BY-DEFAULT (an allowlist, cortex#2133 / epic #2164). Only these exact, ` +
            `case-sensitive names may be set: [${ALLOWED_AGENT_ENV_KEYS.join(", ")}]. This ` +
            `replaced a reserved-prefix DENYLIST that an adversarial review proved ` +
            `un-completable — the set of session-hijacking vars (BASH_ENV, PATH, ` +
            `NODE_OPTIONS, LD_PRELOAD, DYLD_INSERT_LIBRARIES, GIT_SSH_COMMAND, *_PROXY, ` +
            `NODE_EXTRA_CA_CERTS, CLAUDE_*/ANTHROPIC_*/CORTEX_*/GROVE_*, …) is open-ended. ` +
            `To permit a new variable, add its exact name to ALLOWED_AGENT_ENV_KEYS in ` +
            `src/common/config/agent-env.ts via a cortex PR (a reviewed change). Names are ` +
            `case-sensitive: '${key}' is not the blessed spelling of any allowed key.`,
        });
      }
    }
  });

/** A validated per-agent env passthrough map (name → literal-or-`env:NAME`). */
export type AgentEnv = z.infer<typeof AgentEnvSchema>;
