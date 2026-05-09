/**
 * Prompt injection filter for inbound chat messages.
 * Uses @metafactory/content-filter library to scan user prompts before they reach Claude.
 *
 * Implementation note: we use top-level `await import()` rather than `require()`
 * because content-filter embeds its pattern YAML via Bun's `with { type: "text" }`
 * import attribute. Under `require()`, Bun's CJS interop auto-parses the .yaml
 * file to an object (ignoring the attribute), which crashes pattern-matcher's
 * `text.split("\n")` call and fails-closed silently. Dynamic ESM import honors
 * the attribute and loads the yaml as a raw string. See grove#173.
 */

// Pull in the real library types so any upstream API drift is a compile
// error rather than a silent runtime surprise (grove#176 S1).
import type { FilterResult, FileFormat } from "@metafactory/content-filter";

type FilterContentString = (
  content: string,
  filePath: string,
  format: FileFormat,
) => FilterResult;

let filterContentString: FilterContentString | null = null;

// Load @metafactory/content-filter at module init. This is a required security
// control — if the package fails to load we log loudly so operators notice.
// Previously this was silently fail-open (grove#173).
try {
  const mod = await import("@metafactory/content-filter");
  filterContentString = mod.filterContentString;
  console.log(
    "prompt-filter: @metafactory/content-filter loaded — inbound prompts will be scanned",
  );
} catch (err) {
  console.error(
    "prompt-filter: WARN @metafactory/content-filter failed to load — " +
      "inbound prompts are NOT being scanned for prompt injection:",
    err instanceof Error ? err.message : err,
  );
}

export interface PromptFilterResult {
  allowed: boolean;
  reason?: string;
  score?: number;
}

/**
 * Scan an inbound chat prompt for prompt injection patterns.
 * Returns allowed: true if the prompt is safe, or allowed: false with a reason.
 *
 * If @metafactory/content-filter failed to load at startup, allows the prompt
 * (fail-open). Operators are warned loudly at startup in that case — see the
 * import block above.
 *
 * Format note: we pass "mixed" (free-text) because chat prompts aren't
 * structured. "mixed" format returns HUMAN_REVIEW for clean content and
 * BLOCKED for content matching a block-severity pattern. We only reject on
 * BLOCKED — HUMAN_REVIEW is treated as allowed because there's no operator
 * in the loop on every Discord/Mattermost message.
 */
export function scanPrompt(prompt: string, source: string): PromptFilterResult {
  if (!filterContentString) {
    return { allowed: true };
  }

  try {
    const result = filterContentString(
      prompt,
      `inbound-${source}-prompt`,
      "mixed",
    );

    if (result.decision === "BLOCKED") {
      // Surface pattern matches (e.g. "PI-001") and/or encoding hits (e.g. "base64")
      const patternIds = result.matches?.map((m) => m.pattern_id).filter(Boolean) ?? [];
      const encodingTypes = result.encodings?.map((e) => e.type).filter(Boolean) ?? [];
      const reasons = [...patternIds, ...encodingTypes];
      const reasonStr = reasons.length > 0 ? reasons.join(", ") : "unspecified";
      console.log(
        `prompt-filter: prompt blocked by content filter (${reasonStr}): ${prompt.slice(0, 100)}`,
      );
      return {
        allowed: false,
        reason: `Content filter blocked this message (matched: ${reasonStr})`,
        score: result.overall_confidence,
      };
    }

    return { allowed: true, score: result.overall_confidence };
  } catch (error) {
    // Fail-open on filter errors — don't block legitimate messages
    console.error("prompt-filter: content filter error:", error);
    return { allowed: true };
  }
}
