/**
 * cortex#1790 (S5, ADR-0024 D5) — plugin SDK boundary-guard test.
 *
 * Walks every in-tree platform-adapter file (`src/adapters/{discord,slack,
 * mattermost,web}/*.ts`, excluding `__tests__`) and both registered renderer
 * implementations (`src/renderers/{dashboard,pagerduty}.ts`) — deliberately
 * EXCLUDING the contract-owning files themselves (`adapters/types.ts`,
 * `adapters/registry.ts`, `renderers/types.ts`, `renderers/index.ts` — the
 * renderer-factory/registry-glue twin of `adapters/registry.ts` — and
 * `surface-sdk/` itself) — and fails if any of them imports one of the
 * PLUGIN-CONTRACT symbols the SDK barrel (`src/surface-sdk/index.ts`)
 * re-exports from its ORIGINAL location instead of from `../surface-sdk`.
 *
 * ## What this test does NOT check
 *
 * It does not forbid every cross-boundary (`../../`) import — the four
 * in-tree adapters and two in-tree renderers still reach into cortex
 * internals the SDK deliberately does NOT re-export (`MyelinRuntime`,
 * `PolicyEngine`, `SystemEventSource`, `AgentConfig`/presence types,
 * per-kind renderer config schemas, tap readers, formatting helpers, …) —
 * see `src/surface-sdk/index.ts`'s module doc for why those are excluded
 * from the contract, and `docs/plugin-sdk.md` for the full audit. Those
 * remain genuine residual couplings (ADR-0024 blockers #5–#8/#13) that the
 * later S9–S12 extraction slices resolve one plugin at a time — this test
 * guards the CONTRACT surface only: once the barrel exists, nothing in
 * cortex may silently drift back to importing `PlatformAdapter`, `Renderer`,
 * the render-target contract, `Envelope`, or a `SurfacePlugin` descriptor
 * type from its pre-SDK location.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "fs";
import { dirname, join, resolve } from "path";

const SRC_ROOT = resolve(import.meta.dir, "..", "..");

/**
 * Contract modules the SDK barrel re-exports from, keyed by their absolute
 * path, mapped to the exact symbol names that must be consumed via
 * `surface-sdk` instead of this original location. A module not listed
 * here (e.g. `common/policy`, `bus/myelin/runtime`) is intentionally out of
 * the guard's scope — see the module doc above.
 */
const GUARDED_MODULES: readonly { absPath: string; symbols: readonly string[] }[] = [
  {
    absPath: resolve(SRC_ROOT, "adapters", "types.ts"),
    symbols: [
      "PlatformAdapter",
      "InboundMessage",
      "InboundAttachment",
      "AccessDecision",
      "ResponseTarget",
      "OutboundFile",
      "ContextMessage",
    ],
  },
  // NOTE: `Renderer` (renderers/types.ts) is deliberately NOT in this list.
  // Its only in-tree consumers (dashboard.ts, pagerduty.ts, renderers/index.ts)
  // import it via the intra-directory `./types` relative path, which the
  // slice's scope explicitly leaves alone ("their own intra-directory
  // relative imports stay") — there is no adapter-side consumer for it to
  // guard against drifting from.
  {
    absPath: resolve(SRC_ROOT, "bus", "surface-router.ts"),
    symbols: ["SurfaceAdapter"],
  },
  {
    absPath: resolve(SRC_ROOT, "bus", "myelin", "envelope-validator.ts"),
    symbols: ["Envelope"],
  },
  {
    absPath: resolve(SRC_ROOT, "adapters", "registry.ts"),
    symbols: [
      "PluginKind",
      "SurfacePlugin",
      "AdapterPlugin",
      "RendererPlugin",
      "SurfaceBindingEntry",
      "BindingGroup",
      "GatewayConstructBase",
    ],
  },
  {
    absPath: resolve(SRC_ROOT, "common", "types", "cortex-config.ts"),
    symbols: ["RendererKind"],
  },
  {
    absPath: resolve(SRC_ROOT, "common", "types", "context.ts"),
    symbols: ["ContextAttachment", "ContextMessage"],
  },
];

const SURFACE_SDK_PATH = resolve(SRC_ROOT, "surface-sdk", "index.ts");

/** Files that OWN a contract (or are the SDK itself) are exempt — they are
 *  where the guarded symbols are legitimately DEFINED or re-exported, not
 *  "a plugin importing the contract from the wrong place". Mirrors the
 *  issue's "excluding registry/types/sdk". `renderers/index.ts` is the
 *  renderer-side registry glue (resolves `(kind) -> plugin`), the direct
 *  structural analogue of `adapters/registry.ts` — same exemption. */
const EXEMPT_ABS_PATHS = new Set<string>([
  resolve(SRC_ROOT, "adapters", "types.ts"),
  resolve(SRC_ROOT, "adapters", "registry.ts"),
  resolve(SRC_ROOT, "renderers", "types.ts"),
  resolve(SRC_ROOT, "renderers", "index.ts"),
  SURFACE_SDK_PATH,
]);

function listPlatformAdapterFiles(): string[] {
  const platforms = ["discord", "slack", "mattermost", "web"];
  const files: string[] = [];
  for (const platform of platforms) {
    const dir = resolve(SRC_ROOT, "adapters", platform);
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith(".ts")) {
        files.push(join(dir, entry.name));
      }
    }
  }
  return files;
}

function listRendererFiles(): string[] {
  const dir = resolve(SRC_ROOT, "renderers");
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (
      entry.isFile() &&
      entry.name.endsWith(".ts") &&
      !EXEMPT_ABS_PATHS.has(join(dir, entry.name))
    ) {
      files.push(join(dir, entry.name));
    }
  }
  return files;
}

interface ImportStatement {
  clause: string;
  specifier: string;
}

/** Minimal import-statement extraction — good enough for this repo's
 *  consistent `import type? {...} from "...";` / `import type X from "...";`
 *  style (matches the pattern `docs/plugin-sdk.md`'s audit command uses).
 *  Deliberately not a full TS parser: a false negative here just means a
 *  drift slips through until the next hand audit, not a build break. */
function extractImports(source: string): ImportStatement[] {
  const results: ImportStatement[] = [];
  const importRe = /import\s+(?:type\s+)?([^;]*?)\s+from\s+["']([^"']+)["'];/g;
  let match: RegExpExecArray | null;
  while ((match = importRe.exec(source)) !== null) {
    results.push({ clause: match[1] ?? "", specifier: match[2] ?? "" });
  }
  return results;
}

/** Resolve a relative import specifier against the importing file's
 *  directory to an absolute `.ts` path (or `null` for a bare/package
 *  specifier, which is never one of the guarded in-tree modules). */
function resolveSpecifier(fromFile: string, specifier: string): string | null {
  if (!specifier.startsWith(".")) return null;
  const resolved = resolve(dirname(fromFile), specifier);
  return resolved.endsWith(".ts") ? resolved : `${resolved}.ts`;
}

function violationsForFile(absPath: string): string[] {
  const source = readFileSync(absPath, "utf-8");
  const violations: string[] = [];
  for (const { clause, specifier } of extractImports(source)) {
    const resolved = resolveSpecifier(absPath, specifier);
    if (!resolved || resolved === SURFACE_SDK_PATH) continue;
    const guarded = GUARDED_MODULES.find((m) => m.absPath === resolved);
    if (!guarded) continue;
    const hit = guarded.symbols.filter((symbol) => new RegExp(`\\b${symbol}\\b`).test(clause));
    if (hit.length > 0) {
      violations.push(
        `${absPath}: imports [${hit.join(", ")}] from "${specifier}" — ` +
          `must import from "../surface-sdk" (or "../../surface-sdk") instead`,
      );
    }
  }
  return violations;
}

describe("plugin SDK boundary guard (cortex#1790, ADR-0024 D5)", () => {
  test("no in-tree adapter or renderer imports a plugin-contract symbol from its pre-SDK location", () => {
    const targets = [
      ...listPlatformAdapterFiles().filter((f) => !EXEMPT_ABS_PATHS.has(f)),
      ...listRendererFiles(),
    ];
    expect(targets.length).toBeGreaterThan(0);

    const allViolations = targets.flatMap((f) => violationsForFile(f));
    expect(allViolations).toEqual([]);
  });

  test("the guarded-module list resolves to real files (catches a stale path before it silently no-ops)", () => {
    for (const { absPath } of GUARDED_MODULES) {
      expect(() => readFileSync(absPath, "utf-8")).not.toThrow();
    }
  });
});

/**
 * cortex#1794 (S9b) — the web adapter's dependency-inversion pass. Stricter
 * than the guard above: rather than checking a fixed symbol allowlist, this
 * asserts NO `../../` (cross-`src/adapters/`-boundary) import survives in
 * `src/adapters/web/*.ts` UNLESS its specifier resolves to `surface-sdk`.
 * `src/adapters/web/` is the one adapter directory (of the four) that no
 * longer needs `common/policy`, `common/types/surfaces`, or
 * `common/types/cortex-config` at all — everything it needs crosses the
 * boundary through the SDK barrel or a same-directory sibling (`./schema`,
 * `./index`). Discord/Slack/Mattermost are NOT held to this bar yet (their
 * dependency-inversion pass is cortex#1896) — this test is scoped to `web/`
 * only, on purpose.
 */
describe("web adapter dependency inversion (cortex#1794, S9b)", () => {
  test("src/adapters/web/*.ts's only cross-boundary (../../) imports are surface-sdk", () => {
    const webDir = resolve(SRC_ROOT, "adapters", "web");
    const files = readdirSync(webDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
      .map((entry) => join(webDir, entry.name));
    expect(files.length).toBeGreaterThan(0);

    const violations: string[] = [];
    for (const file of files) {
      const source = readFileSync(file, "utf-8");
      for (const { specifier } of extractImports(source)) {
        if (!specifier.startsWith("../../")) continue;
        if (specifier === "../../surface-sdk" || specifier.startsWith("../../surface-sdk/")) continue;
        violations.push(`${file}: cross-boundary import "${specifier}" is not surface-sdk`);
      }
    }
    expect(violations).toEqual([]);
  });
});
