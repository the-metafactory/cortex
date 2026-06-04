/**
 * Least-privilege skill/tool gate (cortex#701, Part B — TRUST-PATH/security).
 *
 * ## Problem this closes
 *
 * The legacy gate (`dispatch-handler.ts`, G-121) was binary:
 *   - `allowed_skills: []`        → the entire Skill tool was disabled.
 *   - `allowed_skills: undefined` → EVERY installed skill was exposed.
 *   - `allowed_skills: [a, b]`    → still exposed the bare `Skill` tool
 *                                   (all skills); the named list was only a
 *                                   PROMPT-level soft note, not a hard
 *                                   tool-permission boundary.
 *
 * So an agent that needed one skill (e.g. a reviewer needing `code-review`)
 * implicitly got all of them, and the only hard boundary was all-or-none.
 *
 * ## Desired posture (default-DENY)
 *
 *   - No grant            → no `Skill` tool at all.
 *   - `allowed_skills: []` → same: no `Skill` tool (explicit deny).
 *   - `allowed_skills: [code-review]` → EXACTLY `code-review`, nothing else.
 *
 * ## Mechanism
 *
 * Claude Code's `--allowedTools` / `--disallowedTools` accept rule syntax
 * with parenthesised scopes (verified against CLI 2.1.158:
 * `"Bash(git *) Edit"`). Skills scope the same way: `Skill(<name>)`.
 *
 * For a non-empty allowlist we:
 *   1. Add `Skill(<name>)` to the ALLOW list for each granted skill, and
 *   2. Add the bare `Skill` to the DENY list.
 *
 * Claude Code resolves the more-specific allow rule over the broader deny,
 * so `Skill(code-review)` is permitted while `Skill(anything-else)` falls
 * through to the bare `Skill` deny. That is the hard boundary the legacy
 * prompt-note lacked.
 *
 * ## Adversarial reasoning (cortex#701 self-check)
 *
 * - "Can an un-granted skill still be invoked?" — No. The bare `Skill`
 *   deny is the backstop; only the explicitly-listed `Skill(<name>)` allows
 *   punch through. Default-deny: an empty/absent allowlist adds the bare
 *   `Skill` deny and ZERO allows.
 * - "Does the prompt note do the gating?" — No longer. The prompt note
 *   (kept for UX — it tells the agent WHY a skill is unavailable) is now a
 *   belt over the braces of the tool-permission deny, not the boundary
 *   itself.
 * - We default to "it's exposed if uncertain → close it": when in doubt
 *   the function emits the bare `Skill` deny.
 *
 * This module is a pure function so it is unit-testable in isolation
 * (`src/bus/__tests__/skill-gate.test.ts`) without spinning a CC session.
 */

/**
 * The result of resolving a per-skill grant into Claude Code tool rules.
 * The dispatch path merges these into the `--allowedTools` /
 * `--disallowedTools` it already builds.
 */
export interface SkillGateRules {
  /** Tool ALLOW rules to add (e.g. `["Skill(code-review)"]`). */
  allow: string[];
  /** Tool DENY rules to add (e.g. `["Skill"]`). */
  deny: string[];
}

/**
 * Resolve a per-skill allowlist into Claude Code tool rules under a
 * default-deny posture.
 *
 * @param allowedSkills The principal/agent's granted skills:
 *   - `undefined` → NO grant. Default-deny: deny the bare `Skill` tool.
 *     (Hardening change vs legacy, where undefined meant "all skills".)
 *   - `[]`        → explicit empty grant. Deny the bare `Skill` tool.
 *   - `[a, b]`    → grant EXACTLY `Skill(a)`, `Skill(b)`; deny bare `Skill`.
 *
 * Skill names are passed through verbatim (they are principal-authored
 * config, matched against installed skill ids by Claude Code).
 */
export function resolveSkillGate(allowedSkills: string[] | undefined): SkillGateRules {
  const granted = allowedSkills ?? [];
  if (granted.length === 0) {
    // Default-deny: no skill is granted ⇒ the Skill tool is not available.
    return { allow: [], deny: ["Skill"] };
  }
  // Grant exactly the named skills; the bare `Skill` deny backstops any
  // un-granted skill name. De-dup defensively.
  const unique = [...new Set(granted)];
  return {
    allow: unique.map((name) => `Skill(${name})`),
    // The bare `Skill` deny stays in place so only the specific
    // `Skill(<name>)` allows above are reachable.
    deny: ["Skill"],
  };
}
