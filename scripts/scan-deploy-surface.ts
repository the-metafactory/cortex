#!/usr/bin/env bun
/**
 * scan-deploy-surface.ts — L6 deploy-surface confidentiality scan
 * (design doc §4 L6, compass#93, cortex feat/c-conf-deploy-gates).
 *
 * Scans the file SET a cortex deploy actually SHIPS — the CF Pages dashboard
 * build output, the worker's own source tree, and the D1 schema/migration
 * files — through the shared confidentiality-scan engine's `text` mode
 * (`metafactory-actions/scan/confidentiality-scan.ts`). Text mode runs tiers
 * 2+3 only (public shape patterns + the hashed denylist); tier 1 (gitleaks)
 * is git-only and never runs here — there is no git range to scan, only a
 * deploy-shaped set of files on disk (design doc §4 L6 / metafactory-actions
 * README "text mode — scanning a string, not a git range").
 *
 * This module is a THIN orchestrator: it resolves the file set per surface,
 * shells out to the installed engine once per file, and re-prints the
 * engine's OWN masked output verbatim. It never re-renders a finding itself,
 * so it can't become a second leak surface (the engine's masking guarantee
 * is the only one that matters).
 *
 * Consumed by the OPT-IN package.json wrappers — `deploy:dashboard`,
 * `deploy:worker`, `db:migrate:safe` (docs/agents-md/dashboard-deployment.md).
 * These are NET-NEW additive scripts; the MANUAL deploy commands documented
 * in CLAUDE.md / dashboard-deployment.md are unchanged and still work.
 *
 * Surfaces:
 *   dashboard   <root>/dist/dashboard-v2/**            (CF Pages build output;
 *               text-scannable files only — binary/font assets are skipped,
 *               not exempted from anything else)
 *   worker      <root>/src/surface/mc/worker/src/**\/*.ts   (the code
 *               `wrangler deploy` ships for the cortex-api worker)
 *   d1          <root>/src/surface/mc/worker/schema.sql +
 *               <root>/src/surface/mc/worker/migrations/*.sql   (what
 *               `db:migrate` ships, plus the migrations/ tree — the exact
 *               path class the design doc cites as "the paths that
 *               actually ship seed SQL")
 *
 * Exit codes (mirrors the underlying engine's contract):
 *   0  clean
 *   1  one or more BLOCK finding(s) (non-advisory mode only)
 *   2  usage error (unknown surface / missing argument)
 *   3  engine/config error — fail-closed (e.g. engine not installed)
 *
 * Usage:
 *   bun scripts/scan-deploy-surface.ts dashboard [--advisory]
 *   bun scripts/scan-deploy-surface.ts worker
 *   bun scripts/scan-deploy-surface.ts d1 [--advisory]
 *   bun scripts/scan-deploy-surface.ts <surface> --root <path>   # test override
 *
 * --advisory: print findings but ALWAYS exit 0.
 *
 * `d1` (`db:migrate:safe`): the design doc's sequencing constraint says this PR
 * must not brick the canonical `db:migrate` command if the scan trips
 * block-tier on schema.sql / migrations/*.sql. `0002_seed_data.sql` was
 * verified clean at authoring time (placeholder `operator@example.com`,
 * cortex#1344) — advisory mode here is a safety margin against a FUTURE false
 * positive or a future non-placeholder seed landing unnoticed, not evidence a
 * known finding exists today.
 *
 * `dashboard` (`deploy:dashboard`): advisory for a DIFFERENT, EMPIRICAL reason
 * — the production dashboard build bundles third-party graph-layout code
 * (elkjs, lazily chunked into `network-canvas-*.js` per G-1114.D) whose
 * minified output contains large numeric constants that coincidentally match
 * the 17–20-digit platform-id shape (tier2:platform-snowflake). Verified at
 * authoring time: a real `bun run build:dashboard` trips 8 such findings, all
 * inside vendor code, none of them a real platform id. Hard-blocking would
 * brick `deploy:dashboard` on every run today. Fixing this properly means an
 * upstream allow-rule in metafactory-actions' public-patterns.yaml (or a
 * vendor-chunk exclusion) — out of scope for this PR (that repo isn't ours to
 * change here) and explicitly parked alongside "rewiring the canonical
 * production deploy through the blocking scan." `worker` stays BLOCKING: the
 * worker ships unbundled first-party TypeScript (verified clean, 0 findings)
 * and has no equivalent vendor-minification false-positive surface.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative, resolve } from "node:path";

export const DEFAULT_ENGINE_PATH = join(
  homedir(),
  ".config/metafactory/pkg/repos/metafactory-actions/scan/confidentiality-scan.ts",
);

// Text-scannable extensions for the dashboard build output. Bun's build emits
// js/css/html/map/json (and any inlined svg); fonts/images are skipped — not
// because they're exempt, but because the engine scans TEXT content and a
// binary asset has none to scan (the analogous git-mode "new binary" rule is
// L1's concern, not this text-mode wrapper's).
const DASHBOARD_SCAN_EXT = new Set([
  ".js",
  ".mjs",
  ".cjs",
  ".html",
  ".css",
  ".map",
  ".json",
  ".txt",
  ".svg",
]);
const WORKER_SCAN_EXT = new Set([".ts", ".tsx"]);
const D1_SCAN_EXT = new Set([".sql"]);

export type Surface = "dashboard" | "worker" | "d1";

function extOf(name: string): string {
  const i = name.lastIndexOf(".");
  return i === -1 ? "" : name.slice(i).toLowerCase();
}

function listFilesRecursive(dir: string, allowExt: Set<string>): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const abs = join(d, entry.name);
      if (entry.isDirectory()) walk(abs);
      else if (entry.isFile() && allowExt.has(extOf(entry.name))) out.push(abs);
    }
  };
  walk(dir);
  return out.sort();
}

/** Resolve the file set a deploy of `surface` would ship, rooted at `root`
 *  (defaults to the repo root — two levels up from this script). Exported
 *  for direct unit testing without shelling out to the engine. */
export function resolveSurfaceFiles(surface: Surface, root: string): string[] {
  switch (surface) {
    case "dashboard":
      return listFilesRecursive(join(root, "dist/dashboard-v2"), DASHBOARD_SCAN_EXT);
    case "worker":
      return listFilesRecursive(join(root, "src/surface/mc/worker/src"), WORKER_SCAN_EXT);
    case "d1": {
      const workerDir = join(root, "src/surface/mc/worker");
      const files = [
        join(workerDir, "schema.sql"),
        ...listFilesRecursive(join(workerDir, "migrations"), D1_SCAN_EXT),
      ].filter(existsSync);
      return files.sort();
    }
    default: {
      const _exhaustive: never = surface;
      throw new Error(`unknown surface: ${_exhaustive as string}`);
    }
  }
}

function isSurface(v: string): v is Surface {
  return v === "dashboard" || v === "worker" || v === "d1";
}

interface ScanOutcome {
  code: number; // 0 clean · 1 block · 3 engine error
  output: string;
}

/** Shell to the installed engine's `text` mode for a single file. Exported
 *  so callers/tests can stub the engine path without touching argv parsing. */
export function scanFile(enginePath: string, file: string, cwd: string): ScanOutcome {
  const res = spawnSync("bun", [enginePath, "text", "--file", file], {
    encoding: "utf8",
    cwd,
  });
  if (res.error) {
    return { code: 3, output: `engine spawn failed: ${res.error.message}` };
  }
  const output = [res.stdout, res.stderr].filter((s) => s && s.trim().length > 0).join("\n");
  return { code: res.status ?? 3, output };
}

export function main(argv: string[]): number {
  const positional = argv.filter((a) => !a.startsWith("--"));
  const surfaceArg = positional[0];
  const advisory = argv.includes("--advisory");
  const rootIdx = argv.indexOf("--root");
  const root = rootIdx !== -1 ? (argv[rootIdx + 1] ?? "") : resolve(import.meta.dir, "..");
  const engineIdx = argv.indexOf("--engine");
  const enginePath = engineIdx !== -1 ? (argv[engineIdx + 1] ?? "") : DEFAULT_ENGINE_PATH;

  if (!surfaceArg || argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(
      "usage: bun scripts/scan-deploy-surface.ts <dashboard|worker|d1> [--advisory] [--root <path>]\n",
    );
    return surfaceArg ? 0 : 2;
  }
  if (!isSurface(surfaceArg)) {
    process.stderr.write(
      `scan-deploy-surface: unknown surface "${surfaceArg}" — expected dashboard|worker|d1\n`,
    );
    return 2;
  }
  if (!root) {
    process.stderr.write("scan-deploy-surface: --root requires a path\n");
    return 2;
  }

  if (!existsSync(enginePath)) {
    const msg = `scan-deploy-surface: confidentiality-scan engine not found at ${enginePath} — fail-closed (install/refresh via arc upgrade compass).`;
    if (advisory) {
      process.stdout.write(`${msg} (advisory mode — not blocking)\n`);
      return 0;
    }
    process.stderr.write(`${msg}\n`);
    return 3;
  }

  const files = resolveSurfaceFiles(surfaceArg, root);
  if (files.length === 0) {
    process.stdout.write(
      `scan-deploy-surface: ${surfaceArg} — no files to scan (build output missing? run the build step first) — treating as clean.\n`,
    );
    return 0;
  }

  const codes: number[] = [];
  for (const abs of files) {
    const rel = relative(root, abs);
    const { code, output } = scanFile(enginePath, abs, root);
    codes.push(code);
    if (code !== 0) {
      process.stdout.write(`--- ${rel} ---\n${output}\n`);
    }
  }

  // Fail-closed priority: an engine/config error (3) on ANY file means the
  // scan is incomplete/untrustworthy for the whole surface, so it outranks
  // a clean block-finding tally even if other files came back 1 or 0.
  const finalCode = codes.includes(3) ? 3 : codes.includes(1) ? 1 : 0;

  if (finalCode === 0) {
    process.stdout.write(`scan-deploy-surface: ${surfaceArg} — clean (${files.length} file(s) scanned).\n`);
    return 0;
  }

  if (advisory) {
    process.stdout.write(
      `scan-deploy-surface: ${surfaceArg} — findings above (advisory mode — NOT blocking; review before shipping).\n`,
    );
    return 0;
  }

  process.stderr.write(
    `scan-deploy-surface: ${surfaceArg} — BLOCKED (exit ${finalCode}). Fix the findings above before deploying.\n`,
  );
  return finalCode;
}

if (import.meta.main) {
  process.exit(main(process.argv.slice(2)));
}
