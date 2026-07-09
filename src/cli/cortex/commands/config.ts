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

import { ZodError } from "zod";

import { loadConfigWithAgents, expandTilde } from "../../../common/config/loader";
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

/**
 * Format a Zod issue the way the boot path surfaces it: dotted/bracketed path +
 * message. `policy.federated.networks[0].accept_subjects[1]: <message>`. Array
 * indices render as `[n]`, object keys as `.key`. Matches the field-pathed
 * shape principals already see when the daemon rejects a bad config at boot.
 */
function formatZodIssue(issue: ZodError["issues"][number]): string {
  let path = "";
  for (const seg of issue.path) {
    if (typeof seg === "number") {
      path += `[${seg}]`;
    } else {
      path += path === "" ? String(seg) : `.${String(seg)}`;
    }
  }
  if (path === "") return issue.message;
  // Some schema `custom` issues (e.g. the ADR-0001 accept_subjects scope check)
  // already lead their message with the same field path. Don't prepend it twice
  // — surface the message verbatim when it already begins with the path.
  if (issue.message.startsWith(path)) return issue.message;
  return `${path}: ${issue.message}`;
}

/**
 * Extract the list of precise validation error strings from any error the boot
 * load path can throw. A `ZodError` (the schema-validation failure — the common
 * case, including the `accept_subjects` cross-check) yields one string per
 * issue, each field-pathed. Any other error (unreadable file, malformed YAML,
 * chmod gate) yields its single message.
 */
function errorsFrom(err: unknown): string[] {
  if (err instanceof ZodError) {
    return err.issues.map(formatZodIssue);
  }
  if (err instanceof Error) {
    // A schema failure may be wrapped: unwrap a nested ZodError cause so the
    // precise per-issue paths still surface rather than an opaque wrapper.
    const cause = (err as { cause?: unknown }).cause;
    if (cause instanceof ZodError) {
      return cause.issues.map(formatZodIssue);
    }
    return [err.message];
  }
  return [String(err)];
}

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

    if (json) {
      const payload = {
        ok: true,
        path: summary.path,
        stacks: summary.stacks,
        networks: summary.networks,
      };
      return { exitCode: 0, stdout: JSON.stringify(payload) + "\n", stderr: "" };
    }

    const stackWord = stacks === 1 ? "stack" : "stacks";
    const networkWord = networks === 1 ? "network" : "networks";
    return {
      exitCode: 0,
      stdout:
        `✓ config valid: ${summary.path}\n` +
        `  ${stacks} ${stackWord}, ${networks} ${networkWord}\n`,
      stderr: "",
    };
  } catch (err) {
    const errors = errorsFrom(err);
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
