#!/usr/bin/env bun
/**
 * `cortex release` — G4 (#1120, audit epic #1116).
 *
 * A thin checklist + version-skew guard for the 4 independent cortex deploy
 * surfaces. It PRINTS an ordered deploy plan and runs the exact commands
 * when invoked with `--apply`. Production surfaces (MC API worker, network
 * registry — both `wrangler --env production`) are additionally gated behind
 * `--include-prod` so a bare `cortex release --apply` never auto-deploys prod.
 *
 * The 4 surfaces, in deploy order:
 *   1. bot        — `arc upgrade cortex`             (per-host, non-prod)
 *   2. dashboard  — `bun build … + bunx wrangler pages deploy …` (CF Pages, non-prod)
 *   3. api        — `wrangler deploy --env production` from src/surface/mc/worker/
 *   4. registry   — `wrangler deploy --env production` from src/services/network-registry/
 *
 * Version source of truth: arc-manifest.yaml (`version:` field).
 * Health probes: GET /api/health on cortex.meta-factory.ai and network.meta-factory.ai.
 * Both probes look for a `deployed_version` field; if absent or unreachable → "unknown".
 *
 * HARD constraints:
 * - No daemon / no long-running process.
 * - No real deploy without `--apply`.
 * - Prod wrangler runs need both `--apply` AND `--include-prod`.
 * - All shell invocations are injected via `__setShellRunnerForTests` (hermetic tests).
 * - All HTTP fetches are injected via `__setFetcherForTests` (hermetic tests).
 *
 * Exit codes: 0 success · 1 surface failure · 2 usage error.
 */

import { existsSync, readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

import { CliArgsError } from "./_shared/arg-error";
import { envelopeError, envelopeOk, renderJson } from "./_shared/envelope";
import type { ExitResult } from "./_shared/exit-result";

export type { ExitResult } from "./_shared/exit-result";

// =============================================================================
// Types
// =============================================================================

/** The 4 cortex deploy surfaces in deploy order. */
export type Surface = "bot" | "dashboard" | "api" | "registry";
const ALL_SURFACES: Surface[] = ["bot", "dashboard", "api", "registry"];

/** Whether a surface requires --include-prod to run in apply mode. */
const PROD_REQUIRED: Record<Surface, boolean> = {
  bot: false,
  dashboard: false,
  api: true,
  registry: true,
};

export interface ParsedReleaseArgs {
  apply: boolean;
  includeProd: boolean;
  json: boolean;
  surfaces: Surface[];
}

export interface ShellRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** Injectable shell runner — takes argv array, returns run result. */
export type ReleaseShellRunner = (argv: readonly string[]) => Promise<ShellRunResult>;

/** Injectable HTTP fetcher — returns {ok, json} or {ok: false, json: null} on error. */
export type ReleaseFetcher = (url: string) => Promise<{ ok: boolean; json: unknown }>;

/** Per-surface result in the summary. */
export interface SurfaceResult {
  surface: Surface;
  status: "ran" | "skipped" | "dry-run" | "failed";
  /** Exit code if the surface ran; undefined if skipped/dry-run. */
  exitCode?: number;
  /** Failure message if failed. */
  error?: string;
  /** The command(s) that were (or would be) run. */
  commands: string[][];
}

/** Per-surface version skew report. */
export interface SkewReport {
  surface: Surface;
  intended: string;
  deployed: string;
  /** "ok" | "skew" | "unknown" */
  verdict: "ok" | "skew" | "unknown";
}

// =============================================================================
// Injection seam (test-only)
// =============================================================================

let _shellRunner: ReleaseShellRunner | null = null;
let _fetcher: ReleaseFetcher | null = null;

/** Replace the shell runner for hermetic tests. Pass null to restore default. */
export function __setShellRunnerForTests(runner: ReleaseShellRunner | null): void {
  _shellRunner = runner;
}

/** Replace the HTTP fetcher for hermetic tests. Pass null to restore default. */
export function __setFetcherForTests(fetcher: ReleaseFetcher | null): void {
  _fetcher = fetcher;
}

// =============================================================================
// Default implementations (real shell + real fetch)
// =============================================================================

async function defaultShellRunner(argv: readonly string[]): Promise<ShellRunResult> {
  const { spawn } = await import("bun");
  const [cmd, ...args] = argv as string[];
  if (!cmd) return { exitCode: 1, stdout: "", stderr: "empty command" };
  const proc = spawn([cmd, ...args], { stdout: "pipe", stderr: "pipe" });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  return { exitCode, stdout, stderr };
}

async function defaultFetcher(url: string): Promise<{ ok: boolean; json: unknown }> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return { ok: false, json: null };
    const json: unknown = await res.json();
    return { ok: true, json };
  } catch {
    return { ok: false, json: null };
  }
}

function shellRunner(): ReleaseShellRunner {
  return _shellRunner ?? defaultShellRunner;
}

function fetcher(): ReleaseFetcher {
  return _fetcher ?? defaultFetcher;
}

// =============================================================================
// Arc-manifest version reader
// =============================================================================

/** Resolve the project root from this file's location (src/cli/cortex/commands/). */
function projectRoot(): string {
  // __dirname for TS in Bun; fall back via import.meta.url
  try {
    return join(dirname(fileURLToPath(import.meta.url)), "../../../..");
  } catch {
    // During tests, import.meta.url may not be file://; walk up from __dirname
    return join(__dirname, "../../../..");
  }
}

/** Read the `version:` field from arc-manifest.yaml. */
export function readIntendedVersion(): string {
  const manifestPath = join(projectRoot(), "arc-manifest.yaml");
  if (!existsSync(manifestPath)) {
    return "unknown";
  }
  const raw = readFileSync(manifestPath, "utf8");
  const m = /^version:\s+"?([^"\n]+)"?/m.exec(raw);
  return m?.[1]?.trim() ?? "unknown";
}

// =============================================================================
// Surface command definitions
// =============================================================================

/** The repo root relative to this file (src/cli/cortex/commands → project root). */
function repoRoot(): string {
  return projectRoot();
}

/** Exact commands for each surface, as argv arrays. */
function surfaceCommands(surface: Surface): string[][] {
  const root = repoRoot();
  switch (surface) {
    case "bot":
      return [["arc", "upgrade", "Cortex"]];
    case "dashboard":
      return [
        [
          "bun",
          "build",
          join(root, "src/surface/mc/dashboard-v2/index.html"),
          "--outdir",
          join(root, "dist/dashboard-v2"),
          "--target",
          "browser",
          "--splitting",
        ],
        [
          "bunx",
          "wrangler",
          "pages",
          "deploy",
          join(root, "dist/dashboard-v2"),
          "--project-name",
          "grove-dashboard",
        ],
      ];
    case "api":
      return [
        [
          "wrangler",
          "deploy",
          "--env",
          "production",
          "--config",
          join(root, "src/surface/mc/worker/wrangler.toml"),
        ],
      ];
    case "registry":
      return [
        [
          "wrangler",
          "deploy",
          "--env",
          "production",
          "--config",
          join(root, "src/services/network-registry/wrangler.toml"),
        ],
      ];
  }
}

/** Display label for each surface command (for plan output). */
function surfaceLabel(surface: Surface): string {
  switch (surface) {
    case "bot":
      return "Bot binary (arc upgrade cortex — per-host)";
    case "dashboard":
      return "Dashboard (bun build + wrangler pages deploy grove-dashboard)";
    case "api":
      return "MC API worker (wrangler deploy --env production) [PROD]";
    case "registry":
      return "Network registry (wrangler deploy --env production) [PROD]";
  }
}

// =============================================================================
// Health endpoints for version-skew detection
// =============================================================================

/**
 * Surfaces that expose a health endpoint. Bot + dashboard have no queryable
 * deployed version; we can only probe api and registry.
 */
const HEALTH_URLS: Partial<Record<Surface, string>> = {
  api: "https://cortex.meta-factory.ai/api/health",
  registry: "https://network.meta-factory.ai/api/health",
};

async function probeSurface(
  surface: Surface,
  intended: string,
): Promise<SkewReport> {
  const url = HEALTH_URLS[surface];
  if (!url) {
    // Bot and dashboard have no machine-queryable version endpoint.
    return { surface, intended, deployed: "unknown", verdict: "unknown" };
  }

  const fetch = fetcher();
  const { ok, json } = await fetch(url);
  if (!ok || json === null) {
    return { surface, intended, deployed: "unknown", verdict: "unknown" };
  }

  const j = json as Record<string, unknown>;
  // eslint-disable-next-line @typescript-eslint/dot-notation -- key is snake_case, dot notation not available
  const rawDeployed = j["deployed_version"];
  const deployed = typeof rawDeployed === "string" ? rawDeployed : null;
  if (!deployed) {
    return { surface, intended, deployed: "unknown", verdict: "unknown" };
  }

  const verdict = deployed === intended ? "ok" : "skew";
  return { surface, intended, deployed, verdict };
}

async function buildSkewReport(surfaces: Surface[], intended: string): Promise<SkewReport[]> {
  return Promise.all(surfaces.map((s) => probeSurface(s, intended)));
}

// =============================================================================
// Argument parsing
// =============================================================================

export function parseReleaseArgs(argv: string[]): ParsedReleaseArgs {
  let apply = false;
  let includeProd = false;
  let json = false;
  let surfaces: Surface[] = [...ALL_SURFACES];

  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];
    switch (arg) {
      case "--apply":
        apply = true;
        break;
      case "--include-prod":
        includeProd = true;
        break;
      case "--json":
        json = true;
        break;
      case "--surfaces": {
        i++;
        const raw = argv[i];
        if (!raw) throw new CliArgsError("release", "--surfaces requires a comma-separated list of surface names");
        const parts = raw.split(",").map((s) => s.trim());
        for (const p of parts) {
          if (!ALL_SURFACES.includes(p as Surface)) {
            throw new CliArgsError(
              "release",
              `Unknown surface '${p}'. Valid surfaces: ${ALL_SURFACES.join(", ")}`,
            );
          }
        }
        surfaces = parts as Surface[];
        break;
      }
      case "--help":
      case "-h":
        // Help is handled by the caller; ignored here.
        break;
      default:
        throw new CliArgsError("release", `Unknown flag '${arg ?? ""}'. Use --help for usage.`);
    }
    i++;
  }

  // --include-prod without --apply is a usage error: it implies deploying prod
  // but without actually running anything, which is confusing and likely a mistake.
  if (includeProd && !apply) {
    throw new CliArgsError("release", "--include-prod requires --apply (it enables prod deploy execution)");
  }

  return { apply, includeProd, json, surfaces };
}

// =============================================================================
// Plan renderer (human-readable)
// =============================================================================

function renderPlan(
  surfaces: Surface[],
  intended: string,
  skew: SkewReport[],
  includeProd: boolean,
  apply: boolean,
): string {
  const lines: string[] = [];

  lines.push(`cortex release — deploy plan`);
  lines.push(`  Intended version: ${intended}`);
  lines.push("");

  // Version-skew report
  if (skew.length > 0) {
    lines.push("Version-skew report:");
    for (const r of skew) {
      if (r.verdict === "unknown") {
        lines.push(`  ${r.surface.padEnd(12)} deployed: unknown — endpoint unreachable, can't verify`);
      } else if (r.verdict === "skew") {
        lines.push(`  ${r.surface.padEnd(12)} SKEW — deployed: ${r.deployed}, intended: ${r.intended}`);
      } else {
        lines.push(`  ${r.surface.padEnd(12)} ok     — deployed: ${r.deployed}`);
      }
    }
    lines.push("");
  }

  // Ordered deploy plan
  lines.push("Deploy order:");
  let idx = 1;
  for (const surface of surfaces) {
    const isProd = PROD_REQUIRED[surface];
    const label = surfaceLabel(surface);
    const cmds = surfaceCommands(surface);
    lines.push(`  ${idx}. ${label}`);
    for (const cmd of cmds) {
      lines.push(`       $ ${cmd.join(" ")}`);
    }
    if (isProd && !includeProd) {
      lines.push(
        `       (SKIPPED — production surface; pass --apply --include-prod to deploy)`,
      );
    }
    idx++;
  }
  lines.push("");

  if (!apply) {
    lines.push("Dry-run: no commands executed. Pass --apply to run non-prod surfaces.");
    lines.push(
      "         Pass --apply --include-prod to also deploy the two production surfaces (api, registry).",
    );
  }

  return lines.join("\n") + "\n";
}

// =============================================================================
// Apply executor
// =============================================================================

async function runSurface(
  surface: Surface,
  apply: boolean,
  includeProd: boolean,
): Promise<SurfaceResult> {
  const cmds = surfaceCommands(surface);
  const isProd = PROD_REQUIRED[surface];

  if (!apply) {
    return { surface, status: "dry-run", commands: cmds };
  }

  if (isProd && !includeProd) {
    return { surface, status: "skipped", commands: cmds };
  }

  const run = shellRunner();

  for (const cmd of cmds) {
    const res = await run(cmd);
    if (res.exitCode !== 0) {
      return {
        surface,
        status: "failed",
        exitCode: res.exitCode,
        error: res.stderr || `command exited with code ${res.exitCode}`,
        commands: cmds,
      };
    }
  }

  return { surface, status: "ran", exitCode: 0, commands: cmds };
}

// =============================================================================
// Summary renderer
// =============================================================================

function renderSummary(results: SurfaceResult[], skew: SkewReport[]): string {
  const lines: string[] = ["", "Summary:"];

  for (const r of results) {
    const tag =
      r.status === "ran"
        ? "ran    "
        : r.status === "failed"
          ? "FAILED "
          : r.status === "skipped"
            ? "skipped"
            : "dry-run";
    const extra = r.error ? ` — ${r.error}` : "";
    lines.push(`  ${tag}  ${r.surface}${extra}`);
  }

  const hasSkew = skew.some((s) => s.verdict === "skew");
  const hasUnknown = skew.some((s) => s.verdict === "unknown");

  if (hasSkew) {
    lines.push("");
    lines.push("WARNING: version skew detected — some surfaces are running an older version.");
  }
  if (hasUnknown) {
    lines.push("");
    lines.push(
      "NOTE: version unknown for some surfaces — health endpoint unreachable, could not verify deployed version.",
    );
  }

  const skipped = results.filter((r) => r.status === "skipped");
  if (skipped.length > 0) {
    lines.push("");
    lines.push(
      `${skipped.map((r) => r.surface).join(", ")} skipped — production surfaces require --include-prod.`,
    );
  }

  return lines.join("\n") + "\n";
}

// =============================================================================
// JSON renderer
// =============================================================================

interface ReleaseJsonItem {
  surface: Surface;
  status: SurfaceResult["status"];
  commands: string[][];
  exitCode?: number;
  error?: string;
  skew?: SkewReport;
}

function renderJsonOutput(
  results: SurfaceResult[],
  skew: SkewReport[],
  intended: string,
  overallFailed: boolean,
): string {
  const skewBySurface = new Map(skew.map((s) => [s.surface, s]));
  const items: ReleaseJsonItem[] = results.map((r) => ({
    surface: r.surface,
    status: r.status,
    commands: r.commands,
    ...(r.exitCode !== undefined ? { exitCode: r.exitCode } : {}),
    ...(r.error ? { error: r.error } : {}),
    ...(skewBySurface.get(r.surface) ? { skew: skewBySurface.get(r.surface) } : {}),
  }));

  if (overallFailed) {
    const failed = results.find((r) => r.status === "failed");
    const env = envelopeError<ReleaseJsonItem>(
      failed?.error ?? "one or more surfaces failed",
      { intended_version: intended },
    );
    // Attach items even on error (non-standard but useful for scripting)
    return JSON.stringify({ ...env, items }, null, 2) + "\n";
  }

  return renderJson(envelopeOk(items, { intended_version: intended }));
}

// =============================================================================
// Main dispatch
// =============================================================================

export async function dispatchRelease(argv: string[]): Promise<ExitResult> {
  let parsed: ParsedReleaseArgs;
  try {
    parsed = parseReleaseArgs(argv);
  } catch (err) {
    const msg = err instanceof CliArgsError ? err.message : String(err);
    const stderr = `cortex release: ${msg}\n`;
    return { exitCode: 2, stdout: "", stderr };
  }

  const { apply, includeProd, json, surfaces } = parsed;
  const intended = readIntendedVersion();

  // Version-skew probe (async, non-blocking — we run it while building the plan)
  const skewReportPromise = buildSkewReport(surfaces, intended);

  // In non-apply (dry-run) mode, just print the plan with the skew report.
  if (!apply) {
    const skew = await skewReportPromise;
    const plan = renderPlan(surfaces, intended, skew, includeProd, apply);

    if (json) {
      // Build dry-run results
      const results: SurfaceResult[] = surfaces.map((s) => ({
        surface: s,
        status: "dry-run",
        commands: surfaceCommands(s),
      }));
      return {
        exitCode: 0,
        stdout: renderJsonOutput(results, skew, intended, false),
        stderr: "",
      };
    }

    return { exitCode: 0, stdout: plan, stderr: "" };
  }

  // Apply mode: run surfaces in order.
  const skew = await skewReportPromise;

  // Accumulate all output in a buffer so dispatchRelease is testable (no side-channel writes).
  const outLines: string[] = [];

  // apply is guaranteed true here (we returned early above if !apply)
  if (includeProd) {
    outLines.push(
      "cortex release: DEPLOYING TO PRODUCTION — api worker and registry will be updated.\n",
    );
  }

  if (!json) {
    // Print plan up front so the principal sees what's about to run
    outLines.push(renderPlan(surfaces, intended, skew, includeProd, apply));

    if (includeProd) {
      outLines.push("DEPLOYING TO PRODUCTION — proceeding with all requested surfaces.\n\n");
    }
  }

  const results: SurfaceResult[] = [];
  for (const surface of surfaces) {
    const result = await runSurface(surface, apply, includeProd);
    results.push(result);
    if (!json) {
      const statusTag =
        result.status === "ran"
          ? "  ran"
          : result.status === "failed"
            ? "  FAILED"
            : result.status === "skipped"
              ? "  skipped (prod — pass --include-prod)"
              : "  dry-run";
      outLines.push(`${statusTag}  ${surface}\n`);
    }
    // Fail-fast on first surface failure
    if (result.status === "failed") break;
  }

  const overallFailed = results.some((r) => r.status === "failed");
  const exitCode = overallFailed ? 1 : 0;

  const summary = renderSummary(results, skew);

  if (json) {
    return {
      exitCode,
      stdout: renderJsonOutput(results, skew, intended, overallFailed),
      stderr: "",
    };
  }

  outLines.push(summary);

  return {
    exitCode,
    stdout: outLines.join(""),
    stderr: overallFailed
      ? `cortex release: one or more surfaces failed — see above for details\n`
      : "",
  };
}
