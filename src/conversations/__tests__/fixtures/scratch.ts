import { afterEach } from "bun:test";
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

export function scratchHosts(prefix: string): { dirs: ReturnType<typeof scratchDirs>; hosts: { close: () => Promise<void> }[] } {
  const dirs = scratchDirs(prefix);
  const hosts: { close: () => Promise<void> }[] = [];
  afterEach(async () => {
    for (const host of hosts.splice(0)) await host.close().catch(() => undefined);
    await dirs.clean();
  });
  return { dirs, hosts };
}
