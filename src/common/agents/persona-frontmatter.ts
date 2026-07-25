/**
 * cortex#2386 (EBH-7a) — read the structured `allowedTools` declaration out
 * of a persona file's YAML frontmatter.
 *
 * Before this module, `allowedTools` in a persona `.md` file
 * (`docs/persona-format.md` "Frontmatter — optional fields") was pure prose:
 * `dispatch-handler.ts`'s `targetAgentPersonaPreamble()` reads the whole
 * persona file (frontmatter included) as raw text and folds it into the
 * system prompt — nothing ever parsed the YAML block into a structured
 * value, so a persona declaring `allowedTools: [Read]` had that intent
 * enforced by NOTHING. The spec was honest about this ("advisory in v1"),
 * but a shipped persona (`personas/pier.md`) relied on it as if it were a
 * real boundary. This module is step one of closing that gap: give
 * `dispatch-handler.ts` a structured value to merge into the SAME
 * `effectiveDisallowed` seam `agentDisallowedTools` already uses (WEB-2/B1).
 *
 * Deliberately narrow: extracts ONLY `allowedTools`. This is NOT a general
 * persona-frontmatter parser and NOT the authoritative source for the field
 * — per the epic #2341 decision, enforcement lives at the dispatch seam, not
 * the loader. A caller merges the derived deny-list into its own
 * `effectiveDisallowed` computation; this module has no opinion on that.
 */

import { readFileSync } from "fs";
import { parse as parseYaml } from "yaml";

/** Matches the YAML frontmatter block: everything between the first `---` pair. */
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---/;

/**
 * Parse the persona file at `path` and return its `allowedTools` field.
 *
 * Returns `undefined` — "no declaration" — when:
 *   - the file can't be read (missing, permissions, …)
 *   - the file has no `---`-delimited frontmatter block
 *   - the frontmatter doesn't parse as YAML
 *   - the frontmatter parses but has no `allowedTools` key
 *   - `allowedTools` is present but isn't an array of strings
 *
 * Every failure mode is logged to stderr (never an empty catch, repo rule)
 * so a malformed persona is visible to whoever runs the stack, but never
 * throws and never crashes dispatch — a corrupt/unreadable persona file
 * degrades to "no persona-derived restriction", the same posture the field
 * had before this module existed. Callers combine this with whatever agent-level
 * config already governs the session, so failing open here does not leave
 * a session with no confinement at all.
 *
 * Not cached — callers that dispatch per-message should cache by `path`
 * themselves (mirrors `dispatch-handler.ts`'s existing `personaPromptCache`
 * pattern for the persona body text).
 */
export function loadPersonaAllowedTools(path: string): string[] | undefined {
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    process.stderr.write(
      `[persona-frontmatter] could not read persona file at ${path}: ${detail}\n`,
    );
    return undefined;
  }

  const match = FRONTMATTER_RE.exec(raw);
  if (match?.[1] === undefined) return undefined;

  let parsed: unknown;
  try {
    parsed = parseYaml(match[1]);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    process.stderr.write(
      `[persona-frontmatter] could not parse YAML frontmatter at ${path}: ${detail}\n`,
    );
    return undefined;
  }

  if (typeof parsed !== "object" || parsed === null) return undefined;
  const allowedTools = (parsed as Record<string, unknown>).allowedTools;
  if (allowedTools === undefined) return undefined;

  if (
    !Array.isArray(allowedTools) ||
    !allowedTools.every((t): t is string => typeof t === "string")
  ) {
    process.stderr.write(
      `[persona-frontmatter] persona at ${path} declares allowedTools but it is not ` +
        `an array of strings — ignoring (treated as no declaration)\n`,
    );
    return undefined;
  }

  return allowedTools;
}
