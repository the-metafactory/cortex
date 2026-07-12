/**
 * cortex#1949 — self-test for the extraction boundary helper.
 *
 * Proves {@link crossBoundaryImports} catches the class of import that the S9b
 * (web) dependency-inversion's own `../../`-only guard MISSED — a ONE-level
 * `../plugin-support` cross-boundary import — as well as two-level, while
 * allowing same-dir and `surface-sdk` imports. cortex#1896 uses this helper to
 * assert each adapter is boundary-clean as it's inverted, before extraction.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { crossBoundaryImports } from "./extraction-boundary";

const roots: string[] = [];

/** Build a throwaway {plugin dir, sibling dirs, sdk dir} layout under tmp. */
function scaffold(files: Record<string, string>): { pluginDir: string; sdkDir: string } {
  const root = mkdtempSync(join(tmpdir(), "extraction-boundary-"));
  roots.push(root);
  const pluginDir = join(root, "src", "adapters", "acme");
  const sdkDir = join(root, "src", "surface-sdk");
  mkdirSync(pluginDir, { recursive: true });
  mkdirSync(sdkDir, { recursive: true });
  mkdirSync(join(root, "src", "adapters"), { recursive: true });
  writeFileSync(join(sdkDir, "index.ts"), "export type Marker = 1;\n");
  for (const [rel, content] of Object.entries(files)) {
    const abs = resolve(root, rel);
    mkdirSync(resolve(abs, ".."), { recursive: true });
    writeFileSync(abs, content);
  }
  return { pluginDir, sdkDir };
}

afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

describe("crossBoundaryImports (cortex#1949)", () => {
  test("catches a ONE-level `../` cross-boundary import (the web-move gap)", () => {
    const { pluginDir, sdkDir } = scaffold({
      "src/adapters/acme/index.ts": `import { helper } from "../plugin-support";\nexport const x = helper;\n`,
      "src/adapters/plugin-support.ts": `export const helper = 1;\n`,
    });
    const v = crossBoundaryImports(pluginDir, sdkDir);
    expect(v).toHaveLength(1);
    expect(v[0]!.specifier).toBe("../plugin-support");
  });

  test("catches a two-level `../../` cross-boundary import", () => {
    const { pluginDir, sdkDir } = scaffold({
      "src/adapters/acme/index.ts": `import type { E } from "../../common/policy";\nexport type T = E;\n`,
      "src/common/policy.ts": `export type E = 1;\n`,
    });
    const v = crossBoundaryImports(pluginDir, sdkDir);
    expect(v.map((x) => x.specifier)).toContain("../../common/policy");
  });

  test("allows same-directory and surface-sdk imports (clean, ready-to-extract)", () => {
    const { pluginDir, sdkDir } = scaffold({
      "src/adapters/acme/index.ts":
        `import type { Marker } from "../../surface-sdk";\nimport { local } from "./schema";\nexport const y: Marker = local;\n`,
      "src/adapters/acme/schema.ts": `export const local = 1 as const;\n`,
    });
    expect(crossBoundaryImports(pluginDir, sdkDir)).toEqual([]);
  });

  test("catches a DYNAMIC `import(\"../x\")` crossing the boundary (#1953 review blocker)", () => {
    const { pluginDir, sdkDir } = scaffold({
      "src/adapters/acme/index.ts":
        `export async function load() { const m = await import("../plugin-support"); return m; }\n`,
      "src/adapters/plugin-support.ts": `export const helper = 1;\n`,
    });
    const v = crossBoundaryImports(pluginDir, sdkDir);
    expect(v.map((x) => x.specifier)).toContain("../plugin-support");
  });

  test("ignores bare/package imports (e.g. zod)", () => {
    const { pluginDir, sdkDir } = scaffold({
      "src/adapters/acme/index.ts": `import { z } from "zod";\nexport const s = z;\n`,
    });
    expect(crossBoundaryImports(pluginDir, sdkDir)).toEqual([]);
  });

  test("catches a bare side-effect `import \"...\"` that crosses the boundary", () => {
    const { pluginDir, sdkDir } = scaffold({
      "src/adapters/acme/index.ts": `import "../side-effect";\nexport const z = 1;\n`,
      "src/adapters/side-effect.ts": `globalThis;\n`,
    });
    expect(crossBoundaryImports(pluginDir, sdkDir).map((x) => x.specifier)).toContain("../side-effect");
  });
});
