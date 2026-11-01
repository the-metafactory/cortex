import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function scratchDirs(prefix: string): { make: () => Promise<string>; clean: () => Promise<void> } {
  const dirs: string[] = [];
  return {
    make: async () => {
      const dir = await mkdtemp(join(tmpdir(), prefix));
      dirs.push(dir);
      return dir;
    },
    clean: async () => {
      for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
    },
  };
}
