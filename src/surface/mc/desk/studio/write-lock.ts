import { mkdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";
import { errnoIs } from "./file-error";

const OwnerSchema = z.object({ pid: z.number().int().positive() });
const TAKEOVER_MARKER = "takeover";
const ABANDONED_TAKEOVER_AFTER_MS = 30_000;
const UNREADABLE_OWNER_KEEPS_THE_LOCK = null;
const MISSING_MARKER_NEEDS_NO_CLEANUP = null;

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

async function readOwnerText(lock: string): Promise<string | null> {
  try {
    return await readFile(join(lock, "owner.json"), "utf8");
  } catch {
    return UNREADABLE_OWNER_KEEPS_THE_LOCK;
  }
}

function ownerPid(text: string): number | null {
  try {
    return OwnerSchema.parse(JSON.parse(text)).pid;
  } catch {
    return UNREADABLE_OWNER_KEEPS_THE_LOCK;
  }
}

function processIsGone(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return errnoIs(error, "ESRCH");
  }
}

async function writeOwner(lock: string, dir: string): Promise<void> {
  await writeFile(join(lock, "owner.json"), JSON.stringify({ pid: process.pid, at: new Date().toISOString(), dir: await realpath(dir) }), { mode: 0o600 });
}

async function clearAbandonedTakeover(marker: string): Promise<boolean> {
  const markerStat = await stat(marker).catch(() => MISSING_MARKER_NEEDS_NO_CLEANUP);
  if (!markerStat || Date.now() - markerStat.mtimeMs <= ABANDONED_TAKEOVER_AFTER_MS) return false;
  await rm(marker, { recursive: true, force: true });
  return true;
}

async function takeOverFromGoneOwner(lock: string, dir: string): Promise<boolean> {
  const seen = await readOwnerText(lock);
  const pid = seen === null ? null : ownerPid(seen);
  if (pid === null || !processIsGone(pid)) return false;
  const marker = join(lock, TAKEOVER_MARKER);
  try {
    await mkdir(marker, { mode: 0o700 });
  } catch {
    return await clearAbandonedTakeover(marker) && takeOverFromGoneOwner(lock, dir);
  }
  try {
    if (await readOwnerText(lock) !== seen) return false;
    await writeOwner(lock, dir);
    return true;
  } finally {
    await rm(marker, { recursive: true, force: true });
  }
}

async function claimLock(lock: string, dir: string): Promise<boolean> {
  try {
    await mkdir(lock, { mode: 0o700 });
  } catch (error) {
    if (!errnoIs(error, "EEXIST")) return false;
    return takeOverFromGoneOwner(lock, dir);
  }
  try {
    await writeOwner(lock, dir);
  } catch (error) {
    await rm(lock, { recursive: true, force: true });
    throw error;
  }
  return true;
}

export async function acquireStudioLock(dir: string): Promise<(() => Promise<void>) | null> {
  let lock: string;
  try {
    lock = await studioLockPath(dir);
  } catch {
    return null;
  }
  return await claimLock(lock, dir) ? () => rm(lock, { recursive: true }) : null;
}
