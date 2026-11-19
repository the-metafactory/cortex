import { mkdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";
import { errnoIs } from "./file-error";

const OwnerSchema = z.object({ pid: z.number().int().positive(), host: z.string().optional() });
const TAKEOVER_MARKER = "takeover";
const ABANDONED_AFTER_MS = 30_000;
const UNREADABLE_OWNER = null;
const MISSING_PATH_IS_NOT_ABANDONED = null;
const ANOTHER_CONTENDER_SWEPT_IT = false;

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

type Owner = z.infer<typeof OwnerSchema>;

async function readOwnerText(lock: string): Promise<string | null> {
  try {
    return await readFile(join(lock, "owner.json"), "utf8");
  } catch {
    return UNREADABLE_OWNER;
  }
}

function parseOwner(text: string | null): Owner | null {
  try {
    return text === null ? UNREADABLE_OWNER : OwnerSchema.parse(JSON.parse(text));
  } catch {
    return UNREADABLE_OWNER;
  }
}

function ownerIsGone(owner: Owner): boolean {
  if (owner.host !== undefined && owner.host !== hostname()) return false;
  try {
    process.kill(owner.pid, 0);
    return false;
  } catch (error) {
    return errnoIs(error, "ESRCH");
  }
}

export async function studioLockOwnerIsAlive(dir: string): Promise<boolean> {
  try {
    const owner = parseOwner(await readOwnerText(await studioLockPath(dir)));
    return owner !== null && !ownerIsGone(owner);
  } catch {
    return false;
  }
}

async function olderThanAbandonment(path: string): Promise<boolean> {
  const found = await stat(path).catch(() => MISSING_PATH_IS_NOT_ABANDONED);
  return found !== null && Date.now() - found.mtimeMs > ABANDONED_AFTER_MS;
}

async function lockIsAbandoned(lock: string, seen: string | null): Promise<boolean> {
  const owner = parseOwner(seen);
  return owner === null ? olderThanAbandonment(lock) : ownerIsGone(owner);
}

async function writeOwner(lock: string, dir: string): Promise<void> {
  await writeFile(join(lock, "owner.json"), JSON.stringify({ pid: process.pid, host: hostname(), at: new Date().toISOString(), dir: await realpath(dir) }), { mode: 0o600 });
}

async function clearAbandonedTakeover(marker: string): Promise<boolean> {
  if (!await olderThanAbandonment(marker)) return false;
  const swept = `${marker}.abandoned-${process.pid}-${crypto.randomUUID()}`;
  try {
    await rename(marker, swept);
  } catch {
    return ANOTHER_CONTENDER_SWEPT_IT;
  }
  await rm(swept, { recursive: true, force: true });
  return true;
}

async function takeOverAbandonedLock(lock: string, dir: string): Promise<boolean> {
  const seen = await readOwnerText(lock);
  if (!await lockIsAbandoned(lock, seen)) return false;
  const marker = join(lock, TAKEOVER_MARKER);
  try {
    await mkdir(marker, { mode: 0o700 });
  } catch {
    return await clearAbandonedTakeover(marker) && takeOverAbandonedLock(lock, dir);
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
    return takeOverAbandonedLock(lock, dir);
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
