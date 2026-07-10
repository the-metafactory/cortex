/**
 * cortex#1853 — the outbound upload ceiling is PER-SURFACE, supplied by the
 * target adapter, never a platform-named constant read from platform-neutral core.
 *
 * The defect: `collectOutputFiles()` lives in `src/runner/` (platform-neutral,
 * shared by Discord / Mattermost / Slack / Web) but filtered every surface's
 * outbound files against `ATTACHMENT_LIMITS.discordMaxUploadBytes` (8 MB). A
 * Mattermost-bound file of, say, 9 MB — well under Mattermost's 100 MB default —
 * was silently dropped because Discord's ceiling was applied to it.
 *
 * Files are created SPARSE (`truncateSync`) so an 8 MB+ `stat.size` costs no
 * real bytes on disk and the test stays fast.
 */

import { describe, test, expect, afterEach } from "bun:test";
import { mkdirSync, rmSync, writeFileSync, truncateSync, existsSync } from "fs";
import { join, basename } from "path";

import { collectOutputFiles, getOutputDir } from "../attachments";
import { ATTACHMENT_LIMITS } from "../attachment-types";
import { MockAdapter } from "../../adapters/mock";

/** The documented per-surface ceilings the adapters declare (see each adapter). */
const DISCORD_MAX = 8 * 1024 * 1024; // 8 MB — held low deliberately
const MATTERMOST_MAX = 100 * 1024 * 1024; // 100 MB — FileSettings.MaxFileSize default
const SLACK_MAX = 1024 * 1024 * 1024; // 1 GB

const sessions: string[] = [];

/** Stage a session output dir containing one sparse file of exactly `size` bytes. */
function stageOutputFile(sessionId: string, name: string, size: number): string {
  sessions.push(sessionId);
  const dir = getOutputDir(sessionId);
  mkdirSync(dir, { recursive: true });
  const p = join(dir, name);
  writeFileSync(p, "");
  truncateSync(p, size); // sparse — stat.size === size, ~0 bytes written
  return p;
}

afterEach(() => {
  while (sessions.length > 0) {
    const sid = sessions.pop()!;
    const dir = getOutputDir(sid);
    if (existsSync(dir)) rmSync(join(dir, ".."), { recursive: true, force: true });
  }
});

describe("cortex#1853 — collectOutputFiles is bounded by the TARGET surface", () => {
  test("a 9 MB file is DROPPED under Discord's ceiling but KEPT under Mattermost's", () => {
    const sid = "c1853-cross-surface";
    const nineMB = 9 * 1024 * 1024;
    const p = stageOutputFile(sid, "report.pdf", nineMB);

    // The regression this issue names: Discord's 8 MB ceiling drops it…
    expect(collectOutputFiles(sid, DISCORD_MAX)).toEqual([]);

    // …but the SAME file is within Mattermost's 100 MB default and must survive.
    const kept = collectOutputFiles(sid, MATTERMOST_MAX);
    expect(kept.length).toBe(1);
    expect(basename(kept[0]!)).toBe(basename(p));
  });

  test("the boundary is inclusive: size === limit is kept, limit + 1 is dropped", () => {
    const sid = "c1853-boundary";
    stageOutputFile(sid, "exact.bin", DISCORD_MAX);
    expect(collectOutputFiles(sid, DISCORD_MAX).length).toBe(1);
    expect(collectOutputFiles(sid, DISCORD_MAX - 1)).toEqual([]);
  });

  test("a file over EVERY ceiling is dropped on every surface", () => {
    const sid = "c1853-oversize";
    stageOutputFile(sid, "huge.bin", SLACK_MAX + 1);
    for (const limit of [DISCORD_MAX, MATTERMOST_MAX, SLACK_MAX]) {
      expect(collectOutputFiles(sid, limit)).toEqual([]);
    }
  });

  test("a missing output dir is empty, not a throw (unchanged)", () => {
    expect(collectOutputFiles("c1853-does-not-exist", DISCORD_MAX)).toEqual([]);
  });
});

describe("cortex#1853 — no platform-named upload constant in neutral core", () => {
  test("ATTACHMENT_LIMITS exposes no platform-named key", () => {
    const keys = Object.keys(ATTACHMENT_LIMITS);
    const platformNamed = keys.filter((k) => /discord|mattermost|slack|web/i.test(k));
    expect(platformNamed).toEqual([]);
  });

  test("discordMaxUploadBytes is gone from core", () => {
    expect(ATTACHMENT_LIMITS).not.toHaveProperty("discordMaxUploadBytes");
  });
});

describe("cortex#1853 — the ceiling travels with the adapter", () => {
  test("a PlatformAdapter exposes maxUploadBytes (survives S12 extraction)", () => {
    // The interface makes this structural: every implementer is checked by tsc.
    // MockAdapter stands in for the real adapters (importing Discord would pull
    // discord.js into a unit test).
    const adapter = new MockAdapter("mock-1");
    expect(typeof adapter.maxUploadBytes).toBe("number");
    expect(adapter.maxUploadBytes).toBeGreaterThan(0);
  });

  test("collectOutputFiles honours whatever ceiling the adapter supplies", () => {
    const sid = "c1853-adapter-supplied";
    stageOutputFile(sid, "small.txt", 1024);

    const adapter = new MockAdapter("mock-2");
    adapter.maxUploadBytes = 512; // adapter says: too big
    expect(collectOutputFiles(sid, adapter.maxUploadBytes)).toEqual([]);

    adapter.maxUploadBytes = 2048; // adapter says: fine
    expect(collectOutputFiles(sid, adapter.maxUploadBytes).length).toBe(1);
  });
});
