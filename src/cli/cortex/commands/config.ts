#!/usr/bin/env bun
/**
 * `cortex config validate` — pre-flight config check.
 *
 * WHY: `CortexConfigSchema` + the compose step (`composeRawConfig`) only run at
 * daemon BOOT (in `src/cortex.ts` → `loadConfigWithAgents`). An invalid edit —
 * e.g. a bad `policy.federated.networks[0].accept_subjects[1]` that doesn't
 * begin with `federated.<network>.` — isn't caught until the next restart, at
 * which point the daemon FATAL-boots and launchd crash-loops it (`last exit
 * code = 1`). This subcommand runs the SAME validation the daemon runs at boot,
 * standalone and side-effect-free, so a bad edit is caught BEFORE the restart.
 *
 * It reuses the daemon's real load path verbatim:
 *
 *   resolve path → `loadConfigWithAgents` (which calls `composeRawConfig` to
 *   deep-merge the config-split layers, then `CortexConfigSchema.parse` to
 *   validate) → report.
 *
 * It does NOT reimplement any validation. It does NOT start NATS, MC, adapters,
 * the bus, or the daemon. It never writes. It is a pure read of the config file
 * (the loader's `enforceChmod600` stat + `readFileSync` are the only disk
 * touches — the same reads the boot path already performs).
 *
 * Subcommand:
 *   validate [--config <path>] [--json]
 *       --config <path>   Config to validate. Default = the SAME default the
 *                         daemon uses (`DEFAULT_CONFIG` from `pidfile.ts`, or a
 *                         config-split pointer). Whatever the daemon would load,
 *                         this validates.
 *       --json            Machine-readable output.
 *
 * On success:
 *   text → `✓ config valid: <resolved path>` + a one-line summary
 *          (`N stacks, N networks`), exit 0.
 *   json → `{"ok":true,"path":"…","stacks":N,"networks":N}`, exit 0.
 *
 * On failure:
 *   text → the SAME precise validation error the boot path emits (the Zod issue
 *          path + message, e.g.
 *          `policy.federated.networks[0].accept_subjects[1] "…" must begin with
 *          "federated.<principal>.<stack>."`), exit 1.
 *   json → `{"ok":false,"errors":[…]}`, exit 1.
 *
 * Exit codes: 0 valid · 1 invalid config (validation failure / unreadable file)
 *             · 2 CLI usage error (bad subcommand / unknown flag).
 */

import { loadConfigWithAgents, expandTilde } from "../../../common/config/loader";
import { formatConfigLoadError } from "../../../common/config/validate-on-write";
import { loadConfig as loadMcConfig } from "../../../surface/mc/config";
import { DEFAULT_CONFIG } from "../../../common/pidfile";

import { CliArgsError } from "./_shared/arg-error";
import { type ExitResult } from "./_shared/exit-result";
import {
  parseSubcommandArgs,
  type FlagMap,
  type SubcommandSpec,
} from "./_shared/parser";

export { type ExitResult } from "./_shared/exit-result";

// =============================================================================
// Grammar
// =============================================================================

type ConfigSubcommand = "validate";

const SPEC: SubcommandSpec<ConfigSubcommand> = {
  cliName: "config",
  subcommands: {
    validate: {
      positionals: [],
      flags: {
        "--config": "value",
        "--json": "bool",
      },
    },
  },
  universal: {},
};

// =============================================================================
// Summary shape
// =============================================================================

interface ValidateSummary {
  /** The resolved (tilde-expanded) config path that was validated. */
  path: string;
  /** Number of merged stacks the loaded config resolves to (0 or 1 — a single
   *  loaded config resolves to exactly one merged stack identity, or none for a
   *  legacy shape with no `stack:` block). */
  stacks: number;
  /** Number of federated networks the config declares
   *  (`policy.federated.networks[]`). 0 when not federated. */
  networks: number;
}

// FS-7 (cortex#1839) — the precise per-issue error formatter that was local here
// now lives in `validate-on-write.ts` as `formatConfigLoadError`, so `cortex
// config validate` (this file) and the write-time validators share ONE formatter
// and surface byte-identical errors. `runValidate` calls it directly below.

// =============================================================================
// validate
// =============================================================================

function runValidate(flags: FlagMap, json: boolean): ExitResult {
  // Resolve the config path exactly as the daemon does: the `--config` flag if
  // given, else `DEFAULT_CONFIG` — the identical default `cortex start` uses.
  const rawPath =
    typeof flags["--config"] === "string" ? flags["--config"] : DEFAULT_CONFIG;
  const resolvedPath = expandTilde(rawPath);

  try {
    // THE boot validation: compose the config-split layers + schema-parse via
    // `CortexConfigSchema`. No NATS, no adapters, no MC, no daemon — this is a
    // pure parse+validate of the same object the daemon would load.
    const loaded = loadConfigWithAgents(resolvedPath);

    // A single loaded config resolves to exactly one merged stack identity when
    // a `stack:` block is present (cortex-shape). Legacy bot.yaml input yields
    // no `stack` block → 0.
    const stacks = loaded.stack !== undefined ? 1 : 0;
    const networks = loaded.policy?.federated?.networks.length ?? 0;
    const summary: ValidateSummary = { path: resolvedPath, stacks, networks };

    // FND-6 posture A — surface the mc.governance local_principal drift pre-write
    // (the misconfig that silently 403s the headerless local dashboard). The
    // governance block lives in the Mission Control yaml (`mc.configPath`), NOT
    // the cortex schema, so we load that file and reuse the SAME pure detector
    // the daemon runs at boot. Only when `mc.configPath` is explicitly set — an
    // empty path resolves to the daemon's default MC yaml, which we must not read
    // for an unrelated `validate` (it would make the finding environment-
    // dependent). Warning-level: it never flips exit code (the cortex config is
    // valid); it is a heads-up, not a rejection.
    const warnings: string[] = [];
    const mcConfigPath = loaded.config.mc.configPath.trim();
    if (loaded.config.mc.enabled && mcConfigPath !== "") {
      try {
        loadMcConfig(expandTilde(mcConfigPath), {
          onWarning: (m) => warnings.push(m),
        });
      } catch (err) {
        // The MC yaml itself is malformed/unreadable — surfaced at daemon boot
        // (MC loadConfig throws there too); `cortex config validate`'s contract
        // is the cortex config, so we note it without failing validation.
        warnings.push(
          `NOTE mc: could not read the Mission Control config at ${mcConfigPath} to check governance ` +
            `(${err instanceof Error ? err.message : String(err)})`,
        );
      }
    }
    const warnStderr = warnings.length > 0 ? warnings.map((w) => `${w}\n`).join("") : "";

    if (json) {
      const payload = {
        ok: true,
        path: summary.path,
        stacks: summary.stacks,
        networks: summary.networks,
        ...(warnings.length > 0 ? { warnings } : {}),
      };
      return { exitCode: 0, stdout: JSON.stringify(payload) + "\n", stderr: warnStderr };
    }

    const stackWord = stacks === 1 ? "stack" : "stacks";
    const networkWord = networks === 1 ? "network" : "networks";
    return {
      exitCode: 0,
      stdout:
        `✓ config valid: ${summary.path}\n` +
        `  ${stacks} ${stackWord}, ${networks} ${networkWord}\n`,
      stderr: warnStderr,
    };
  } catch (err) {
    const errors = formatConfigLoadError(err);
    if (json) {
      const payload = { ok: false, path: resolvedPath, errors };
      return { exitCode: 1, stdout: "", stderr: JSON.stringify(payload) + "\n" };
    }
    const body = errors.map((e) => `  ${e}`).join("\n");
    return {
      exitCode: 1,
      stdout: "",
      stderr: `✗ config invalid: ${resolvedPath}\n${body}\n`,
    };
  }
}

// =============================================================================
// Dispatcher
// =============================================================================

// Returns a Promise to match the passthrough contract in `src/cortex.ts` (and
// the `dispatchStack` / `dispatchNetwork` siblings), even though the handler is
// synchronous (no I/O is awaited — the loader's reads are sync). Declared
// non-`async` so the require-await lint rule is satisfied; `Promise.resolve`
// wrapping keeps the awaited shape.
export function dispatchConfig(argv: string[]): Promise<ExitResult> {
  let parsed;
  try {
    parsed = parseSubcommandArgs(SPEC, argv);
  } catch (err) {
    if (err instanceof CliArgsError) {
      return Promise.resolve({
        exitCode: 2 as const,
        stdout: "",
        stderr: `cortex config: ${err.message}\n${topLevelHelp()}`,
      });
    }
    throw err;
  }

  const json = parsed.flags["--json"] === true;

  if (parsed.subcommand === "help" || parsed.help) {
    return Promise.resolve({ exitCode: 0 as const, stdout: topLevelHelp(), stderr: "" });
  }
  if (parsed.subcommand === "unknown") {
    const msg =
      parsed.rawSubcommand === ""
        ? "usage error — no subcommand specified."
        : `unknown subcommand "${parsed.rawSubcommand}".`;
    return Promise.resolve({
      exitCode: 2 as const,
      stdout: "",
      stderr: `cortex config: ${msg}\n${topLevelHelp()}`,
    });
  }

  // Only `validate` remains after the help / unknown guards above.
  return Promise.resolve(runValidate(parsed.flags, json));
}

// =============================================================================
// Help
// =============================================================================

function topLevelHelp(): string {
  return `cortex config — inspect + validate cortex config

Usage:
  cortex config validate [--config <path>] [--json]

validate:
  Runs the daemon's boot-time config validation (compose config-split layers +
  CortexConfigSchema) standalone — WITHOUT starting NATS, MC, adapters, or the
  daemon. Catches a bad edit BEFORE a restart crash-loops the daemon.

  --config <path>   Config to validate. Default: the daemon's default config.
  --json            Machine-readable output.

Exit codes: 0 valid · 1 invalid config · 2 CLI usage error.
`;
}
