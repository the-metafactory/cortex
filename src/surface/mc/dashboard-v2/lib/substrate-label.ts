/**
 * ST-P5 — substrate-projection DISPLAY label (refactor §7, CONTEXT.md §Sessions).
 *
 * THE DOMAIN RULE: Mission Control's model + schema speak **session** /
 * **child session**. The word **"sub-agent"** is NOT a domain entity — it is the
 * *Claude-Code-lens* display label for a `claude-code` child session (a session
 * with a `parent_session_id`). It is derived here, at render time, and appears
 * nowhere in the model. Any other substrate (Codex, Gemini, …) projects its own
 * word: we render the substrate string itself ("codex session").
 *
 * This is a PURE function (no React, no I/O) so the matrix is unit-testable in
 * isolation — see `__tests__/substrate-label.test.ts`.
 *
 * Matrix:
 *   claude-code + hasParent → "sub-agent"           (CC lens for a child session)
 *   claude-code + root      → "session"
 *   <other>     + (either)  → "<other> session"      (substrate-neutral)
 *   missing/blank substrate → "session"              (defensive fallback)
 */

/** The substrate this label is the Claude-Code lens word for. */
const CLAUDE_CODE = "claude-code";

/**
 * Derive the display label for a session row.
 *
 * @param substrate  the session's substrate (`claude-code` | `codex` | …)
 * @param hasParent  true iff the session has a `parent_session_id` (a child)
 */
export function substrateLabel(substrate: string, hasParent: boolean): string {
  const s = substrate.trim();

  // Missing/blank substrate: render a bare "session" rather than " session".
  if (s.length === 0) return "session";

  if (s === CLAUDE_CODE) {
    // The ONLY place "sub-agent" appears: the CC-lens label for a child session.
    return hasParent ? "sub-agent" : "session";
  }

  // Every other substrate is substrate-neutral: the substrate string + "session"
  // ("codex session"). No per-substrate child word — only Claude Code has one.
  return `${s} session`;
}
