// Linux case-sensitivity guard for arc-manifest.yaml (cortex#1676 addendum,
// 2026-07-08 — Vincent's fresh-Linux-install thread).
//
// macOS's default filesystem is case-INSENSITIVE, so a `provides.hooks[].command`
// path that's cased differently from its `provides.files[].target` counterpart
// still resolves there — the drift is invisible. Linux hosts are case-sensitive:
// the same drift means Claude Code's hook invocation 404s on a symlink that
// "should" exist by macOS-eyeball but doesn't by exact-string comparison.
//
// This asserts, for every registered hook, that its command basename EXACTLY
// (case-sensitively) matches the basename of some installed `provides.files[]`
// target. Verified true as of 2026-07-08 (one spelling per hook across the
// manifest, src/runner/session-settings.ts:208, and the existing test suite) —
// this test keeps it true going forward.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { parse } from "yaml";

const MANIFEST_PATH = join(import.meta.dir, "..", "..", "arc-manifest.yaml");

interface ManifestFile {
  source: string;
  target: string;
}

interface ManifestHook {
  event: string;
  command: string;
  matcher?: string;
}

interface Manifest {
  provides: {
    files: ManifestFile[];
    hooks: ManifestHook[];
  };
}

function basename(p: string): string {
  return p.split("/").pop() ?? p;
}

describe("arc-manifest.yaml — provides.hooks/provides.files casing guard", () => {
  const manifest = parse(readFileSync(MANIFEST_PATH, "utf-8")) as Manifest;

  test("manifest declares at least one hook and one file (sanity — guards against a parse regression silently passing everything)", () => {
    expect(manifest.provides.hooks.length).toBeGreaterThan(0);
    expect(manifest.provides.files.length).toBeGreaterThan(0);
  });

  test("every provides.hooks[].command basename exactly (case-sensitively) matches a provides.files[].target basename", () => {
    const fileTargetBasenames = manifest.provides.files.map((f) => basename(f.target));
    const fileTargetBasenameSet = new Set(fileTargetBasenames);

    for (const hook of manifest.provides.hooks) {
      const hookBasename = basename(hook.command);
      const exactMatch = fileTargetBasenameSet.has(hookBasename);

      if (!exactMatch) {
        const nearMiss = fileTargetBasenames.find(
          (b) => b.toLowerCase() === hookBasename.toLowerCase(),
        );
        const detail = nearMiss
          ? `only a differently-cased target exists: "${nearMiss}". This would install ` +
            `cleanly on case-insensitive filesystems (macOS) but the hook would silently ` +
            `fail to resolve on case-sensitive ones (Linux).`
          : `no provides.files[].target has a matching basename at all.`;
        throw new Error(
          `provides.hooks[].command "${hook.command}" (basename "${hookBasename}") does ` +
            `not exactly match any provides.files[].target basename — ${detail}`,
        );
      }

      expect(exactMatch).toBe(true);
    }
  });
});
