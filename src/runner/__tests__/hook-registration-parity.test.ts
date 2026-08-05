// cortex#2482 (EBH-1 / R1-F1-A) — hook registration parity.
//
// Every hook `arc-manifest.yaml`'s `provides.hooks` registers UNCONDITIONALLY
// (Bash guard, Path guard, EventLogger, Context) is meant to be session-scoped
// too — but the manifest only reaches the PRINCIPAL's global, interactive
// `~/.claude/settings.json`. A dispatched cortex session spawns with an EMPTY
// `--setting-sources` (session-settings.ts) and loads ONLY the curated file
// `buildCuratedSettings()` produces. A hook that is manifest-registered but
// curated-file-absent therefore NEVER RUNS in a dispatched session, even
// though every doc in the repo said it was live — exactly the R1-F1-A defect
// this issue closed (`CortexPathGuard` was registered in the manifest and
// nowhere else for ~1 release). This test makes that class of gap fail CI
// instead of shipping silently.
//
// Pattern copied from scripts/__tests__/manifest-hooks-casing.test.ts: yaml-
// parse the manifest, sanity-check non-empty BEFORE asserting (guards against
// a parse regression silently passing everything), and throw a diagnostic
// Error carrying the concrete mismatch rather than a bare `expect` failure —
// same style as that file's `:60-72`.
//
// Rationale for a DEDICATED test, not folded into manifest-hooks-casing.test.ts:
// that test only diffs `provides.hooks` against `provides.files` basenames (a
// filesystem-casing guard). Nothing anywhere compared `provides.hooks` against
// the curated settings a dispatched session actually loads. Same argument one
// layer up — `provides.files` vs the repo checkout — in
// src/taps/cc-events/__tests__/hook-compat-symlinks.test.ts:13-15.
//
// Do NOT assert against src/settings/cortex-hooks.json. Its own `_comment`
// says arc auto-DERIVES it from provides.hooks at install time and that it
// must never be manually merged into settings.json — it writes nothing to a
// live session and is not a source of truth for what a dispatched session
// loads.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { parse } from "yaml";
import { buildCuratedSettings } from "../session-settings";

const MANIFEST_PATH = join(import.meta.dir, "..", "..", "..", "arc-manifest.yaml");

interface ManifestHook {
  event: string;
  command: string;
  matcher?: string;
}

interface Manifest {
  provides: {
    files: { source: string; target: string }[];
    hooks: ManifestHook[];
  };
}

interface CuratedHookEntry {
  matcher?: string;
  hooks: { type: string; command: string }[];
}

interface CuratedSettings {
  hooks: Record<string, CuratedHookEntry[]>;
}

function basename(p: string): string {
  return p.split("/").pop() ?? p;
}

/**
 * Hooks that are DELIBERATELY absent from provides.hooks — per-session grant
 * hooks that would gate the PRINCIPAL's own tool use if registered globally
 * in the manifest/settings.json. See arc-manifest.yaml:134-140 (Skill Guard,
 * cortex#710) and :143-148 (MCP Guard, cortex#2111) for the rationale each
 * carries inline. This set is the closed allowlist step 3 of cortex#2482
 * requires: a THIRD per-session-only hook added later has to be declared
 * here explicitly, or this test fails.
 */
const DELIBERATELY_MANIFEST_ABSENT = new Set<string>([
  "CortexSkillGuard.hook.ts",
  "CortexMcpGuard.hook.ts",
]);

describe("hook registration parity — arc-manifest.yaml provides.hooks vs buildCuratedSettings (cortex#2482)", () => {
  const manifest = parse(readFileSync(MANIFEST_PATH, "utf-8")) as Manifest;

  test("sanity — manifest declares at least one hook (guards against a parse regression silently passing everything)", () => {
    expect(manifest.provides.hooks.length).toBeGreaterThan(0);
  });

  test("every provides.hooks[] entry is registered in buildCuratedSettings under the same event, with a byte-identical PreToolUse matcher", () => {
    // No skill/mcp grants — this is the FLOOR every dispatched session gets.
    // The manifest-registered (unconditional) hooks must be a subset of it.
    const curated = buildCuratedSettings("/fake/.claude") as unknown as CuratedSettings;

    for (const manifestHook of manifest.provides.hooks) {
      const wantBasename = basename(manifestHook.command);
      const eventEntries = curated.hooks[manifestHook.event];
      if (eventEntries === undefined) {
        throw new Error(
          `provides.hooks entry for event "${manifestHook.event}" (command ` +
            `"${manifestHook.command}") has NO corresponding event key in ` +
            `buildCuratedSettings' output at all. Curated events present: ` +
            `[${Object.keys(curated.hooks).join(", ")}].`,
        );
      }

      const matchingEntry = eventEntries.find((entry) =>
        entry.hooks.some((h) => basename(h.command) === wantBasename),
      );
      if (matchingEntry === undefined) {
        const curatedCommands = eventEntries
          .flatMap((e) => e.hooks.map((h) => basename(h.command)))
          .join(", ");
        throw new Error(
          `provides.hooks[] declares "${manifestHook.command}" (basename ` +
            `"${wantBasename}") under event "${manifestHook.event}", but ` +
            `buildCuratedSettings("/fake/.claude") registers NO hook with that ` +
            `basename under "${manifestHook.event}" — curated commands there: ` +
            `[${curatedCommands || "(none)"}]. A hook registered in the manifest ` +
            `but absent from the curated settings NEVER RUNS in a dispatched ` +
            `session — the manifest only reaches the principal's global, ` +
            `interactive settings.json (cortex#2482 / R1-F1-A).`,
        );
      }

      if (manifestHook.event === "PreToolUse") {
        const curatedMatcher = matchingEntry.matcher;
        if (curatedMatcher !== manifestHook.matcher) {
          throw new Error(
            `PreToolUse matcher mismatch for "${wantBasename}": arc-manifest.yaml ` +
              `matcher is "${manifestHook.matcher}", buildCuratedSettings' matcher ` +
              `is "${curatedMatcher}" — these must be byte-identical (cortex#2482 ` +
              `acceptance criteria).`,
          );
        }
      }
    }
  });

  test("the curated-only hook set (present in buildCuratedSettings, absent from provides.hooks) is EXACTLY the deliberate per-session grant hooks", () => {
    // Grant BOTH conditional hooks so the full curated surface is visible.
    const curated = buildCuratedSettings(
      "/fake/.claude",
      ["some-skill"],
      [],
    ) as unknown as CuratedSettings;

    const curatedBasenames = new Set(
      Object.values(curated.hooks)
        .flat()
        .flatMap((entry) => entry.hooks.map((h) => basename(h.command))),
    );
    const manifestBasenames = new Set(manifest.provides.hooks.map((h) => basename(h.command)));

    const curatedOnly = [...curatedBasenames].filter((b) => !manifestBasenames.has(b));
    const missing = [...DELIBERATELY_MANIFEST_ABSENT].filter((b) => !curatedOnly.includes(b));
    const unexpected = curatedOnly.filter((b) => !DELIBERATELY_MANIFEST_ABSENT.has(b));

    if (missing.length > 0 || unexpected.length > 0) {
      throw new Error(
        `Curated-only hook set (registered in buildCuratedSettings, absent from ` +
          `arc-manifest.yaml's provides.hooks) must equal EXACTLY ` +
          `{${[...DELIBERATELY_MANIFEST_ABSENT].join(", ")}} — the two per-session ` +
          `grant hooks that are deliberately manifest-absent (arc-manifest.yaml` +
          `:134-140 Skill Guard, :143-148 MCP Guard; registering either globally ` +
          `would gate the principal's OWN Skill/MCP tool use). Found instead: ` +
          `[${curatedOnly.join(", ") || "(none)"}].` +
          (missing.length > 0 ? ` Missing (expected but not found): [${missing.join(", ")}].` : "") +
          (unexpected.length > 0
            ? ` Unexpected (found but not declared deliberate): [${unexpected.join(", ")}] — ` +
              `if this is a genuine new per-session-only hook, add it to ` +
              `DELIBERATELY_MANIFEST_ABSENT in this test with a comment explaining why ` +
              `it must never be manifest-registered; otherwise it belongs in ` +
              `arc-manifest.yaml's provides.hooks instead.`
            : ""),
      );
    }

    expect(curatedOnly.sort()).toEqual([...DELIBERATELY_MANIFEST_ABSENT].sort());
  });
});
