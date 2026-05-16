/**
 * v2.0.0 policy cutover — slice I-243B (cortex#294).
 *
 * Canonical inventory of Claude Code tool names that cortex knows
 * about at this version. Used by `migrate-config` (cortex#295, slice
 * I-243C) to invert legacy presence-side
 * `presence.<platform>.roles[].disallowedTools[]` lists into the
 * positive `tool.<lowercase-name>` capability grants the new
 * top-level `policy:` block carries on roles.
 *
 * Source of truth for the list: `docs/persona-format.md` §"Frontmatter
 * — optional fields (v1.0)" → the `allowedTools` row, which is the
 * documented canonical v1.0 tool set cortex recognises. That table is
 * the cross-referenced authoritative list operators read; pinning
 * here keeps the migrator inversion grounded in something a human
 * can audit rather than something fabricated at coding time.
 *
 * Adding a new Claude tool means BOTH:
 *   1. Append the canonical CamelCase name to {@link CLAUDE_TOOL_INVENTORY},
 *      AND
 *   2. Update the corresponding pin in `tool-inventory.test.ts`.
 *
 * Without (2), the test fails — which is intentional. The migrator
 * is destructive (legacy `disallowedTools[]` becomes a positive
 * grant set) and silently dropping a capability for a newly-added
 * tool would mean every operator's role suddenly under-grants
 * relative to legacy behaviour. The pin test forces a deliberate
 * sign-off on inventory churn.
 *
 * Cross-references:
 *   - `docs/design-policy-cutover.md` §5.2 — `tool.<lowercase>`
 *     capability namespace convention this module emits.
 *   - `docs/design-policy-cutover.md` §3 — `disallowedTools` →
 *     capabilities migration semantics (deny-by-omission of the
 *     `tool.<name>` capability).
 *   - `docs/persona-format.md` §"Frontmatter (v1.0)" — the table
 *     this inventory was lifted from.
 *
 * NOTE on completeness: the persona-format table is documented as
 * a non-closed enum ("Free-form string list in v1") — operators
 * MAY reference tool names outside this list (e.g. third-party
 * substrate tools), and v1 cortex does not reject them. The
 * migrator MUST treat any name in a legacy `disallowedTools[]`
 * that is NOT in this inventory as an inert reference (no
 * capability is granted or denied for it on the new role) and log
 * a warning rather than failing the migration. The inversion in
 * {@link invertDisallowedTools} below mirrors that semantic:
 * unknown names in the input set drop out, the known inventory is
 * what's projected onto `tool.<name>` capabilities.
 */
export const CLAUDE_TOOL_INVENTORY = [
  "Read",
  "Edit",
  "Write",
  "Grep",
  "Bash",
  "Glob",
  "Agent",
  "Skill",
  "WebFetch",
  "WebSearch",
  "NotebookEdit",
  "TodoWrite",
  "BashOutput",
  "KillShell",
] as const;

/**
 * Compile-time union of canonical tool names. Callers that want to
 * constrain a string to a known tool can type against this; the
 * migrator itself takes `string[]` for the legacy input because
 * legacy configs are not type-checked.
 */
export type ClaudeToolName = (typeof CLAUDE_TOOL_INVENTORY)[number];

/**
 * Convert a single Claude tool name to its policy capability id.
 *
 * Per `docs/design-policy-cutover.md` §5.2, the namespace is
 * `tool.<lowercase-tool-name>` — the tool name is lower-cased
 * exactly once at this boundary so callers building capability
 * strings don't have to remember the casing rule.
 *
 * No validation: `toolName` outside {@link CLAUDE_TOOL_INVENTORY}
 * still produces a syntactically valid capability id (the policy
 * schema rejects malformed ids at parse time, not here). This
 * makes the helper safe to call on legacy strings whose canonical
 * casing operators got wrong.
 */
export function toolCapability(toolName: string): string {
  return `tool.${toolName.toLowerCase()}`;
}

/**
 * Invert a legacy `disallowedTools[]` list into the positive set of
 * `tool.<lowercase>` capabilities a role should be granted.
 *
 * The semantics mirror legacy presence-side enforcement:
 *   legacy: "role has access to every tool EXCEPT these"
 *   v2:     "role has the capability `tool.X` for every tool not denied"
 *
 * Matching is case-insensitive on the input side — operators have
 * historically written `Bash` and `bash` interchangeably in YAML,
 * and silently keeping a tool because the casing didn't match the
 * inventory would be a security regression at migration time.
 *
 * Unknown names in `disallowed` (not in {@link CLAUDE_TOOL_INVENTORY})
 * are ignored — they couldn't have denied any inventory tool, so
 * they have no effect on the inversion. This is intentionally
 * permissive: the migrator runs once per operator config and
 * should not refuse to migrate because of a legacy typo. Surfacing
 * the warning is the migrator's job (cortex#295), not this helper.
 *
 * Example:
 *   invertDisallowedTools(["Bash", "Edit"])
 *   → ["tool.read", "tool.write", "tool.grep", "tool.glob",
 *      "tool.agent", "tool.skill", "tool.webfetch",
 *      "tool.websearch", "tool.notebookedit", "tool.todowrite",
 *      "tool.bashoutput", "tool.killshell"]
 *
 * Order matches {@link CLAUDE_TOOL_INVENTORY} declaration order so
 * the migrator's output diff is stable across runs (operators
 * eyeballing the generated config see a deterministic list, not a
 * Set-iteration-order shuffle).
 */
export function invertDisallowedTools(disallowed: string[]): string[] {
  const denySet = new Set(disallowed.map((t) => t.toLowerCase()));
  return CLAUDE_TOOL_INVENTORY.filter(
    (t) => !denySet.has(t.toLowerCase()),
  ).map(toolCapability);
}
