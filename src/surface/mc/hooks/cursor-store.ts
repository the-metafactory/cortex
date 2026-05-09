/**
 * Grove Mission Control v2 — Cursor store.
 *
 * Persists per-file byte offsets to a JSON file.
 * Allows the hook-stream reader to resume after restart.
 */

import {
  readFileSync,
  writeFileSync,
  renameSync,
  mkdirSync,
  existsSync,
} from "fs";
import { dirname } from "path";

export class CursorStore {
  constructor(private readonly path: string) {}

  /**
   * Persist offsets atomically: write to a temp file then rename into place.
   * rename() is atomic on POSIX (same filesystem) so a crash mid-write
   * leaves either the old cursor or the new one — never a corrupt partial.
   */
  save(offsets: Map<string, number>): void {
    const dir = dirname(this.path);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    const obj: Record<string, number> = {};
    for (const [key, value] of offsets) {
      obj[key] = value;
    }

    const tmp = this.path + ".tmp";
    writeFileSync(tmp, JSON.stringify(obj, null, 2) + "\n");
    renameSync(tmp, this.path);
  }

  load(): Map<string, number> {
    if (!existsSync(this.path)) {
      return new Map();
    }

    try {
      const content = readFileSync(this.path, "utf-8");
      const obj = JSON.parse(content) as Record<string, number>;
      return new Map(Object.entries(obj));
    } catch (_err) {
      process.stderr.write(
        `[mission-control] cursor-store: corrupt cursor file, starting fresh\n`
      );
      return new Map();
    }
  }
}
