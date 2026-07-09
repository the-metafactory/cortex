// #1749 — installed hook symlinks dangle when a hook source file is renamed.
//
// arc materializes arc-manifest.yaml provides.files as symlinks into the serving
// tree AT INSTALL TIME; upgrades are a plain serving-tree ff that never re-reads
// the manifest. So a rename of a hook source (as in #1739, PascalCase → kebab-case)
// silently breaks every pre-existing install: hook error spam on each event and a
// full stop of cc-events ingestion until the principal re-links by hand.
//
// Two guards:
//  1. The compat shims committed at the OLD names must exist, stay executable,
//     and import the current hook module, so installs created before v6.3.9
//     heal on their next serving-tree ff.
//  2. Every provides.files `source:` in arc-manifest.yaml must exist in the repo,
//     so any future rename that forgets the manifest (or drops a compat shim)
//     fails CI here instead of dangling installs in the field.
import { describe, expect, test } from "bun:test";
import { existsSync, statSync, readFileSync } from "fs";
import { join, resolve } from "path";

const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..", "..");
const HOOKS_DIR = resolve(import.meta.dir, "..", "hooks");

const COMPAT_SHIMS: { legacy: string; currentModule: string }[] = [
  { legacy: "EventLogger.hook.ts", currentModule: "./event-logger.hook" },
  { legacy: "SurfaceContext.hook.ts", currentModule: "./surface-context.hook" },
];

describe("hook compat shims (#1749)", () => {
  for (const { legacy, currentModule } of COMPAT_SHIMS) {
    test(`${legacy} is an executable shim importing ${currentModule}`, () => {
      const legacyPath = join(HOOKS_DIR, legacy);
      expect(existsSync(legacyPath)).toBe(true);
      expect(statSync(legacyPath).mode & 0o111).not.toBe(0); // exec bit survives
      const body = readFileSync(legacyPath, "utf8");
      expect(body.startsWith("#!/usr/bin/env bun")).toBe(true);
      expect(body).toContain(`import "${currentModule}"`);
    });
  }

  test("every arc-manifest provides.files source exists in the repo", () => {
    const manifest = readFileSync(join(REPO_ROOT, "arc-manifest.yaml"), "utf8");
    const sources = [...manifest.matchAll(/^\s*-\s*source:\s*(\S+)\s*$/gm)]
      .map((m) => m[1])
      .filter((s): s is string => typeof s === "string");
    expect(sources.length).toBeGreaterThan(0);
    const missing = sources.filter((s) => !existsSync(join(REPO_ROOT, s)));
    expect(missing).toEqual([]);
  });
});
