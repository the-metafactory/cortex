import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireStudioLock } from "../desk/studio/write-lock";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function studioDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "studio-write-lock-"));
  roots.push(root);
  await mkdir(join(root, ".git"));
  return root;
}
const lockOf = (dir: string) => join(dir, ".git", "studio-write.lock");
const ownerOf = async (dir: string) => JSON.parse(await readFile(join(lockOf(dir), "owner.json"), "utf8")) as { pid: number };

async function goneProcessPid(): Promise<number> {
  const child = Bun.spawn(["true"]);
  await child.exited;
  return child.pid;
}
async function leaveLock(dir: string, pid: number): Promise<void> {
  await mkdir(lockOf(dir));
  await writeFile(join(lockOf(dir), "owner.json"), JSON.stringify({ pid, at: "2026-11-15T00:11:00.000Z", dir }));
}

describe("Studio write lock", () => {
  test("takes over a lock whose owner process is gone", async () => {
    const dir = await studioDir();
    await leaveLock(dir, await goneProcessPid());
    const release = await acquireStudioLock(dir);
    expect(release).not.toBeNull();
    expect((await ownerOf(dir)).pid).toBe(process.pid);
    await release?.();
    expect(await stat(lockOf(dir)).catch(() => "released")).toBe("released");
  });

  test("leaves a lock whose owner process is alive", async () => {
    const dir = await studioDir();
    const owner = Bun.spawn(["sleep", "30"]);
    try {
      await leaveLock(dir, owner.pid);
      expect(await acquireStudioLock(dir)).toBeNull();
      expect((await ownerOf(dir)).pid).toBe(owner.pid);
    } finally { owner.kill(); await owner.exited; }
  });

  test("leaves a lock whose owner file is not written yet", async () => {
    const dir = await studioDir();
    await mkdir(lockOf(dir));
    expect(await acquireStudioLock(dir)).toBeNull();
  });

  test("takes over a lock whose owner file was never written once it is old", async () => {
    const dir = await studioDir();
    await mkdir(lockOf(dir));
    const longAgo = new Date(Date.now() - 60_000);
    await utimes(lockOf(dir), longAgo, longAgo);
    const release = await acquireStudioLock(dir);
    expect(release).not.toBeNull();
    expect((await ownerOf(dir)).pid).toBe(process.pid);
    await release?.();
  });

  test("lets exactly one of many contenders take over a gone owner's lock", async () => {
    const dir = await studioDir();
    await leaveLock(dir, await goneProcessPid());
    const results = await Promise.all(Array.from({ length: 12 }, () => acquireStudioLock(dir)));
    expect(results.filter(release => release !== null)).toHaveLength(1);
    await results.find(release => release !== null)?.();
  });

  test("clears a takeover that a crashed contender abandoned", async () => {
    const dir = await studioDir();
    await leaveLock(dir, await goneProcessPid());
    const marker = join(lockOf(dir), "takeover");
    await mkdir(marker);
    const longAgo = new Date(Date.now() - 60_000);
    await utimes(marker, longAgo, longAgo);
    const release = await acquireStudioLock(dir);
    expect(release).not.toBeNull();
    await release?.();
  });

  test("waits out a takeover another contender has just started", async () => {
    const dir = await studioDir();
    await leaveLock(dir, await goneProcessPid());
    await mkdir(join(lockOf(dir), "takeover"));
    expect(await acquireStudioLock(dir)).toBeNull();
  });
});
