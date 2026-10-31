import { mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

export async function acquireStudioLock(dir: string): Promise<(() => Promise<void>) | null> {
  let lock: string;
  try {
    const root = await realpath(dir);
    let gitDir = join(root, ".git");
    try {
      const pointer = await readFile(gitDir, "utf8");
      const match = /^gitdir: (.+)\s*$/.exec(pointer);
      if (!match?.[1]) return null;
      gitDir = resolve(root, match[1]);
    } catch (error) {
      if (!(error && typeof error === "object" && "code" in error && error.code === "EISDIR")) return null;
    }
    lock = join(gitDir, "studio-write.lock");
    await mkdir(lock, { mode: 0o700 });
  } catch {
    return null;
  }
  try {
    await writeFile(join(lock, "owner.json"), JSON.stringify({ pid: process.pid, at: new Date().toISOString(), dir: await realpath(dir) }), { mode: 0o600 });
  } catch (error) {
    await rm(lock, { recursive: true, force: true });
    throw error;
  }
  return () => rm(lock, { recursive: true });
}
