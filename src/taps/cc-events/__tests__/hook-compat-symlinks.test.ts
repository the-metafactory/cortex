// #1749 — installed hook symlinks dangle when a hook source file is renamed.
//
// arc materializes arc-manifest.yaml provides.files as symlinks into the serving
// tree AT INSTALL TIME; upgrades are a plain serving-tree ff that never re-reads
// the manifest. So a rename of a hook source (as in #1739, PascalCase → kebab-case)
// silently breaks every pre-existing install: hook error spam on each event and a
// full stop of cc-events ingestion until the principal re-links by hand.
//
// Two guards:
//  1. The compat symlinks committed at the OLD names must keep resolving, so
//     installs created before v6.3.9 heal on their next serving-tree ff.
//  2. Every provides.files `source:` in arc-manifest.yaml must exist in the repo,
//     so any future rename that forgets the manifest (or drops a compat link)
//     fails CI here instead of dangling installs in the field.
import { describe, expect, test } from "bun:test";
import { existsSync, lstatSync, realpathSync, readFileSync } from "fs";
import { join, resolve, basename } from "path";

const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..", "..");
const HOOKS_DIR = resolve(import.meta.dir, "..", "hooks");

const COMPAT_LINKS: Array<{ legacy: string; current: string }> = [
  { legacy: "EventLogger.hook.ts", current: "event-logger.hook.ts" },
  { legacy: "SurfaceContext.hook.ts", current: "surface-context.hook.ts" },
];

describe("hook compat symlinks (#1749)", () => {
  for (const { legacy, current } of COMPAT_LINKS) {
    test(`${legacy} is a symlink resolving to ${current}`, () => {
      const legacyPath = join(HOOKS_DIR, legacy);
      expect(lstatSync(legacyPath).isSymbolicLink()).toBe(true);
      expect(existsSync(legacyPath)).toBe(true); // not dangling
      expect(basename(realpathSync(legacyPath))).toBe(current);
    });
  }

  test("every arc-manifest provides.files source exists in the repo", () => {
    const manifest = readFileSync(join(REPO_ROOT, "arc-manifest.yaml"), "utf8");
    const sources = [...manifest.matchAll(/^\s*-\s*source:\s*(\S+)\s*$/gm)].map((m) => m[1]);
    expect(sources.length).toBeGreaterThan(0);
    const missing = sources.filter((s) => !existsSync(join(REPO_ROOT, s)));
    expect(missing).toEqual([]);
  });
});
