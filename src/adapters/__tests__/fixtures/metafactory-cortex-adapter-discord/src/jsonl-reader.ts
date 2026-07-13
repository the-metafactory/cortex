/**
 * cortex#1797 (S12, ADR-0024 D5 extraction lane) — relocated verbatim from
 * cortex's `src/taps/cc-events/lib/jsonl-reader.ts`, retyped so
 * `outbound-log.ts`'s legacy JSONL→Discord bridge compiles without a
 * cross-boundary import. The upstream version typed `readNew`'s return as
 * `RawEvent[]` (`taps/cc-events/hooks/lib/event-types.ts`) purely for shape
 * documentation — every real call site immediately re-validates each entry
 * through `PublishedEventSchema.parse()` (`./events.ts`) before touching a
 * field, so the raw JSON.parse result is never actually trusted as
 * `RawEvent`-shaped here. Returning `unknown[]` is behaviourally identical
 * (the parse/validate step downstream is unchanged) and drops the need to
 * duplicate `RawEventSchema` too.
 */

import { readFileSync, readdirSync, statSync, existsSync } from "fs";
import { join } from "path";

export class JsonlReader {
  private offsets = new Map<string, number>();

  /**
   * Skip to end of a file (call on startup to avoid replaying old events).
   */
  skipToEnd(path: string): void {
    if (!existsSync(path)) return;
    const stat = statSync(path);
    this.offsets.set(path, stat.size);
  }

  /**
   * Skip to end of all JSONL files in a directory.
   */
  skipAllToEnd(dir: string): void {
    if (!existsSync(dir)) return;
    const files = readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
    for (const file of files) {
      this.skipToEnd(join(dir, file));
    }
  }

  /**
   * Read new lines from a JSONL file since last read. Returns raw parsed
   * JSON values — callers validate/narrow via a schema (`PublishedEventSchema`).
   */
  readNew(path: string): unknown[] {
    if (!existsSync(path)) return [];

    const stat = statSync(path);
    const offset = this.offsets.get(path) ?? 0;

    if (stat.size <= offset) return [];

    const content = readFileSync(path, "utf-8");
    const newContent = content.slice(offset);
    this.offsets.set(path, content.length);

    const events: unknown[] = [];
    for (const line of newContent.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        events.push(JSON.parse(trimmed));
      } catch (err) {
        console.warn("cortex-relay: jsonl-reader: skipping malformed line:", err instanceof Error ? err.message : err);
      }
    }

    return events;
  }

  /** Reset tracking for a file (e.g., on rotation) */
  reset(path: string): void {
    this.offsets.delete(path);
  }
}
