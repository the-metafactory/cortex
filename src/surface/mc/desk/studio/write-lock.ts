import { mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";
import { errnoIs } from "./file-error";

const OwnerSchema = z.object({ pid: z.number().int().positive() });

async function studioLockPath(dir: string): Promise<string> {
  const root = await realpath(dir);
  let gitDir = join(root, ".git");
  try {
    const pointer = await readFile(gitDir, "utf8");
    const match = /^gitdir: (.+)\s*$/.exec(pointer);
    if (!match?.[1]) throw new Error("The Studio Git directory pointer is invalid.");
    gitDir = resolve(root, match[1]);
  } catch (error) {
    if (!errnoIs(error, "EISDIR")) throw error;
  }
  return join(gitDir, "studio-write.lock");
}

export async function studioLockOwnerIsAlive(dir: string): Promise<boolean> {
  try {
    const owner = OwnerSchema.parse(JSON.parse(await readFile(join(await studioLockPath(dir), "owner.json"), "utf8")));
    process.kill(owner.pid, 0);
    return true;
  } catch (error) {
    return errnoIs(error, "EPERM");
  }
}

export async function acquireStudioLock(dir: string): Promise<(() => Promise<void>) | null> {
  let lock: string;
  try {
    lock = await studioLockPath(dir);
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
