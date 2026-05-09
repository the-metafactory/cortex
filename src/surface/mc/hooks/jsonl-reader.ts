/**
 * Grove Mission Control v2 — JSONL tail reader.
 *
 * Cursor-based reader that tracks byte offsets per file.
 * Reads only new lines since last read — no full-file replay.
 */

import { statSync, existsSync, openSync, readSync, closeSync } from "fs";
import type { RawHookEvent } from "./types";

export class JsonlTailReader {
  private offsets = new Map<string, number>();

  getOffset(path: string): number {
    return this.offsets.get(path) ?? 0;
  }

  setOffset(path: string, offset: number): void {
    this.offsets.set(path, offset);
  }

  reset(path: string): void {
    this.offsets.delete(path);
  }

  /**
   * Export all offsets (for cursor persistence).
   */
  exportOffsets(): Map<string, number> {
    return new Map(this.offsets);
  }

  /**
   * Import offsets (from cursor persistence).
   */
  importOffsets(offsets: Map<string, number>): void {
    for (const [path, offset] of offsets) {
      this.offsets.set(path, offset);
    }
  }

  /**
   * Skip to end of a file (avoid replaying old events on first run).
   */
  skipToEnd(path: string): void {
    if (!existsSync(path)) return;
    const stat = statSync(path);
    this.offsets.set(path, stat.size);
  }

  /**
   * Read new lines from a JSONL file since last read.
   * Returns parsed events. Malformed lines are skipped.
   *
   * Truncation/rotation detection: if the file is smaller than the stored
   * offset, we assume it was truncated or rotated. The cursor resets to 0
   * and we re-read the (now smaller) file from the start. This is correct
   * for both cases:
   *   - Rotation: the old file was replaced by a new one — re-reading from 0
   *     picks up the new file's contents.
   *   - Truncation: the existing file was shrunk — stale bytes are gone,
   *     re-reading from 0 picks up whatever remains.
   * The ingestor's cc_session_id lookup handles deduplication naturally — if
   * re-ingested events have already been inserted, the worst case is duplicate
   * event rows (not data loss or stalling).
   */
  readNew(path: string): RawHookEvent[] {
    if (!existsSync(path)) return [];

    const stat = statSync(path);
    const offset = this.offsets.get(path) ?? 0;

    // Truncation/rotation: file shrank since last read. Reset cursor and
    // re-read from the beginning of the (new/smaller) file.
    if (stat.size < offset) {
      process.stderr.write(
        `[mission-control] hook-reader: file truncated or rotated (${stat.size} < ${offset}), resetting cursor for ${path}\n`
      );
      this.offsets.set(path, 0);
      return this.readNew(path);
    }

    if (stat.size === offset) return [];

    // Read the new bytes
    const buf = Buffer.alloc(stat.size - offset);
    const fd = openSync(path, "r");
    try {
      readSync(fd, buf, 0, buf.length, offset);
    } finally {
      closeSync(fd);
    }

    const newContent = buf.toString("utf-8");

    // Find the last complete line (ends with \n)
    const lastNewline = newContent.lastIndexOf("\n");
    if (lastNewline === -1) {
      // No complete line yet — don't advance cursor
      return [];
    }

    // Only process up to the last complete line
    const completeContent = newContent.slice(0, lastNewline + 1);
    this.offsets.set(path, offset + Buffer.byteLength(completeContent, "utf-8"));

    const events: RawHookEvent[] = [];
    for (const line of completeContent.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        events.push(JSON.parse(trimmed) as RawHookEvent);
      } catch (_err) {
        process.stderr.write(
          `[mission-control] hook-reader: skipping malformed line in ${path}\n`
        );
      }
    }

    return events;
  }
}
