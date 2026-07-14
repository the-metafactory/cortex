/**
 * cortex#2002 (C-1853) — the outbound upload ceiling is PER-SURFACE, supplied
 * by the target adapter (`PlatformAdapter.maxUploadBytes`), never a
 * platform-named constant read from platform-neutral core. When the adapter
 * does NOT declare a ceiling the host falls back to a surface-neutral default,
 * so behaviour is unchanged for any adapter bundle that hasn't adopted the
 * optional field yet.
 *
 * The defect this closes: `collectOutputFiles()` lives in `src/runner/`
 * (platform-neutral, shared by every surface) but filtered every surface's
 * outbound files against a Discord-named 8 MB constant. A Mattermost-bound
 * file of, say, 9 MB — well under Mattermost's 100 MB default — was silently
 * dropped because Discord's ceiling was applied to it.
 *
 * This is the backward-compatible, cortex-only slice (superseding the closed
 * #1890, which made the field required and edited the now-extracted in-tree
 * adapters). The field is OPTIONAL; the four adapter bundles adopt it in
 * incremental follow-ups.
 *
 * Files are created SPARSE (`truncateSync`) so an 8 MB+ `stat.size` costs no
 * real bytes on disk and the test stays fast.
 */

import { describe, test, expect, afterEach } from "bun:test";
import { z } from "zod/v4";
import { mkdirSync, rmSync, writeFileSync, truncateSync, existsSync } from "fs";
import { join, basename } from "path";

import { collectOutputFiles, getOutputDir } from "../attachments";
import { ATTACHMENT_LIMITS } from "../attachment-types";
import { MockAdapter } from "../../adapters/mock";
import { SurfacePluginRegistry, type AdapterPlugin } from "../../adapters/registry";
import type { PlatformAdapter } from "../../adapters/types";

/** The documented per-surface ceilings a bundle WOULD declare (see each adapter bundle). */
const DISCORD_MAX = 8 * 1024 * 1024; // 8 MB — held low deliberately (== the host default)
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

/** A MockAdapter that DECLARES a per-surface ceiling (a bundle that adopted the field). */
class CeilingMockAdapter extends MockAdapter {
  readonly maxUploadBytes: number;
  constructor(maxUploadBytes: number, instanceId = "mock-with-ceiling") {
    super(instanceId);
    this.maxUploadBytes = maxUploadBytes;
  }
}

/** Register an AdapterPlugin stub whose `createAdapter` yields `adapter`. */
function stubPlugin(id: string, adapter: PlatformAdapter): AdapterPlugin {
  return {
    kind: "adapter",
    id,
    platform: id,
    bindingSchema: z.unknown(),
    foldsIntoPresence: false,
    secretFields: [],
    demuxKey: () => id,
    buildGatewayConstructArgs: (_group, base) => ({ instanceId: base.instanceId }),
    createAdapter: () => adapter,
  };
}

describe("cortex#2002 — collectOutputFiles is bounded by the TARGET surface", () => {
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

describe("cortex#2002 — backward-compatible default fallback (unchanged behaviour)", () => {
  test("an adapter that does NOT declare a ceiling falls back to the host default", () => {
    const sid = "c1853-default-fallback";
    // The host default is 8 MB; a 9 MB file must be dropped, exactly as before
    // the per-surface field existed. `undefined` is what a non-adopting bundle
    // yields for `adapter.maxUploadBytes`.
    stageOutputFile(sid, "report.pdf", 9 * 1024 * 1024);
    expect(ATTACHMENT_LIMITS.defaultMaxUploadBytes).toBe(DISCORD_MAX);
    expect(collectOutputFiles(sid, undefined)).toEqual([]);
  });

  test("omitting the ceiling arg entirely uses the default (call-site safety)", () => {
    const sid = "c1853-default-omitted";
    stageOutputFile(sid, "small.bin", 4 * 1024 * 1024);
    // 4 MB < 8 MB default → kept even with no explicit ceiling passed.
    expect(collectOutputFiles(sid).length).toBe(1);
  });
});

describe("cortex#2002 — the host resolves the ceiling from the target adapter", () => {
  test("an adapter DECLARING a ceiling has its value enforced", () => {
    const sid = "c1853-adapter-declares";
    stageOutputFile(sid, "report.pdf", 9 * 1024 * 1024); // 9 MB

    // A bundle that adopted the field advertises Mattermost's 100 MB ceiling.
    const registry = new SurfacePluginRegistry();
    registry.registerAdapter(
      stubPlugin("mattermost", new CeilingMockAdapter(MATTERMOST_MAX, "mm-1")),
    );
    const adapter = registry.getAdapter("mattermost")!.createAdapter({});

    // Host reads adapter.maxUploadBytes (mirrors dispatch-handler's call site).
    const kept = collectOutputFiles(sid, adapter.maxUploadBytes);
    expect(adapter.maxUploadBytes).toBe(MATTERMOST_MAX);
    expect(kept.length).toBe(1);
  });

  test("an adapter NOT declaring a ceiling → undefined → host default enforced", () => {
    const sid = "c1853-adapter-omits";
    stageOutputFile(sid, "report.pdf", 9 * 1024 * 1024); // 9 MB > 8 MB default

    // A bundle that has NOT adopted the field (plain MockAdapter).
    const registry = new SurfacePluginRegistry();
    registry.registerAdapter(stubPlugin("legacy", new MockAdapter("legacy-1")));
    const adapter = registry.getAdapter("legacy")!.createAdapter({});

    expect(adapter.maxUploadBytes).toBeUndefined();
    // Falls back to the 8 MB default → the 9 MB file is dropped (unchanged).
    expect(collectOutputFiles(sid, adapter.maxUploadBytes)).toEqual([]);
  });
});

describe("cortex#2002 — no platform-named upload constant in neutral core", () => {
  test("ATTACHMENT_LIMITS exposes no platform-named key", () => {
    const keys = Object.keys(ATTACHMENT_LIMITS);
    const platformNamed = keys.filter((k) => /discord|mattermost|slack|web/i.test(k));
    expect(platformNamed).toEqual([]);
  });

  test("discordMaxUploadBytes is gone from core", () => {
    expect(ATTACHMENT_LIMITS).not.toHaveProperty("discordMaxUploadBytes");
  });
});

describe("cortex#2002 — the ceiling travels with the adapter (optional field)", () => {
  test("a PlatformAdapter MAY expose maxUploadBytes; omitting it is valid", () => {
    // Structural: the field is optional on the contract, so a plain MockAdapter
    // (no declaration) and a CeilingMockAdapter (declaration) are BOTH valid
    // PlatformAdapters — tsc enforces this at compile time.
    const withCeiling: PlatformAdapter = new CeilingMockAdapter(MATTERMOST_MAX);
    const without: PlatformAdapter = new MockAdapter();
    expect(withCeiling.maxUploadBytes).toBe(MATTERMOST_MAX);
    expect(without.maxUploadBytes).toBeUndefined();
  });
});
