/**
 * cortex#1796 (S11, ADR-0024 D5 extraction lane) — proves the mattermost
 * plugin directory is boundary-clean: every relative import in
 * `src/adapters/mattermost/*.ts` resolves either inside this directory or
 * into `surface-sdk` — the precondition `crossBoundaryImports` (cortex#1949)
 * checks before a plugin is ready to extract to its own bundle (mirrors
 * `metafactory-cortex-adapter-web`'s S9b inversion, cortex#1794).
 */

import { describe, expect, test } from "bun:test";
import { resolve } from "path";
import { crossBoundaryImports } from "../../../surface-sdk/__tests__/extraction-boundary";

describe("mattermost plugin directory is extraction-ready (cortex#1796 S11)", () => {
  test("crossBoundaryImports(mattermost dir, surface-sdk dir) === []", () => {
    const pluginDir = resolve(import.meta.dir, "..");
    const sdkDir = resolve(import.meta.dir, "../../../surface-sdk");
    expect(crossBoundaryImports(pluginDir, sdkDir)).toEqual([]);
  });
});
