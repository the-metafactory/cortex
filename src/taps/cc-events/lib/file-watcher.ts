/**
 * T-4.1: File Watcher
 * Watch for new and modified JSONL files in the raw events directory.
 */

import { watch, readdirSync, existsSync } from "fs";
import { join } from "path";

export function watchRawEvents(
  dir: string,
  onFile: (path: string) => void
): () => void {
  if (!existsSync(dir)) {
    throw new Error(`Raw events directory does not exist: ${dir}`);
  }

  // Process existing files first
  const existing = readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
  for (const file of existing) {
    onFile(join(dir, file));
  }

  // Watch for new/modified files
  const watcher = watch(dir, { recursive: false }, (_event, filename) => {
    if (filename?.endsWith(".jsonl")) {
      onFile(join(dir, filename));
    }
  });

  return () => {
    watcher.close();
  };
}
