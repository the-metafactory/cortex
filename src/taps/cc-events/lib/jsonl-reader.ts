/**
 * T-4.2: JSONL Tail Reader
 * Reads new lines from a JSONL file, tracking position for incremental reads.
 */

import { readFileSync, statSync, existsSync } from "fs";
import type { RawEvent } from "../hooks/lib/event-types";

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
    const { readdirSync } = require("fs");
    const { join } = require("path");
    const files = readdirSync(dir).filter((f: string) => f.endsWith(".jsonl"));
    for (const file of files) {
      this.skipToEnd(join(dir, file));
    }
  }

  /**
   * Read new lines from a JSONL file since last read.
   * Returns parsed events.
   */
  readNew(path: string): RawEvent[] {
    if (!existsSync(path)) return [];

    const stat = statSync(path);
    const offset = this.offsets.get(path) ?? 0;

    if (stat.size <= offset) return [];

    const content = readFileSync(path, "utf-8");
    const newContent = content.slice(offset);
    this.offsets.set(path, content.length);

    const events: RawEvent[] = [];
    for (const line of newContent.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        events.push(JSON.parse(trimmed) as RawEvent);
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
