/**
 * dts-artifact.test.ts — fast sanity checks on the shippable, self-contained
 * plugin-SDK type artifact (cortex#1950).
 *
 * The artifact (`src/surface-sdk/generated/surface-sdk.d.ts`) is what out-of-tree
 * surface-plugin bundles resolve when they `import type { … } from
 * "@the-metafactory/cortex/surface-sdk"` (package.json exports["./surface-sdk"]).
 * It is GENERATED from the barrel by `bun run sdk:dts` and must never be
 * hand-edited.
 *
 * This test is deliberately FAST — it does not regenerate (that takes ~30s and
 * needs the dts-bundle-generator toolchain). It catches the cheap, common drift
 * modes (a `SURFACE_SDK_VERSION` bump, a contract symbol added/removed) so
 * `bun test src/surface-sdk` flags them locally. The exhaustive byte-for-byte
 * drift guard is the CI job `surface-sdk-dts-sync` (.github/workflows/ci.yml),
 * which runs `bun run sdk:dts:check` (regenerate + `git diff --exit-code`).
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { SURFACE_SDK_VERSION } from "../index";

const ARTIFACT = join(import.meta.dir, "..", "generated", "surface-sdk.d.ts");
const artifact = readFileSync(ARTIFACT, "utf8");

describe("surface-sdk generated .d.ts artifact", () => {
  test("carries a GENERATED-do-not-edit banner", () => {
    expect(artifact).toContain("GENERATED FILE — DO NOT EDIT BY HAND");
    expect(artifact).toContain("bun run sdk:dts");
  });

  test("inlines the SAME SURFACE_SDK_VERSION as the barrel (tracks the contract)", () => {
    // If the barrel bumps the version but the artifact is stale, this fails —
    // the version must be re-generated into the shipped types, not left behind.
    expect(artifact).toContain(`export declare const SURFACE_SDK_VERSION = "${SURFACE_SDK_VERSION}"`);
  });

  test("is self-contained — the only external import is zod (which every bundle already has)", () => {
    const importLines = artifact
      .split("\n")
      .filter((l) => /^\s*import\b/.test(l) || /^\s*export\s+.*\bfrom\s+['"]/.test(l));
    for (const line of importLines) {
      const m = /from\s+['"]([^'"]+)['"]/.exec(line);
      if (!m) continue;
      const spec = m[1]!;
      // Only bare zod (and its subpaths) may remain external; anything else
      // means a cortex-internal module leaked in and the artifact is no longer
      // resolvable standalone.
      expect(spec === "zod" || spec.startsWith("zod/")).toBe(true);
    }
  });

  test("re-exports the full plugin CONTRACT surface a bundle compiles against", () => {
    // The load-bearing contract symbols. If S5 renames/removes one, the barrel
    // changes and this list must be regenerated with it — the failure points a
    // bundle author at the breaking change.
    for (const sym of [
      "PlatformAdapter",
      "InboundMessage",
      "AccessDecision",
      "ResponseTarget",
      "OutboundFile",
      "ContextMessage",
      "Renderer",
      "RenderTarget",
      "Envelope",
      "SurfacePlugin",
      "AdapterPlugin",
      "RendererPlugin",
      "AdapterPolicyPort",
    ]) {
      expect(artifact).toContain(sym);
    }
  });
});
