#!/usr/bin/env bun
/**
 * F-3 — `cortex agents <subcommand>` CLI.
 *
 * Inspects + validates `agents.d/` fragments against the cortex schema (wraps
 * F-2's `loadAgentsDirectory()`), and — B-0 (cortex#1021) — SIGNALS the running
 * cortex runtime to reload after a successful validation. `reload` resolves the
 * runtime's PID file from `--config` and sends SIGHUP, which the runtime routes
 * to the same agents.d/ reconcile its fs.watch watcher uses (registry swap +
 * review-consumer reconcile + capability re-publish). The signal is delivered
 * synchronously; the reload is applied asynchronously (Sage cortex#1027 — the CLI
 * reports "signal delivered", not "reload applied"). `--validate-only` keeps the
 * legacy validation-only behaviour; `--fragment` (single-file) is always
 * validation-only. Presence adapters are restart-only (documented limitation).
 *
 * Usage:
 *   bun src/cli/cortex/commands/agents.ts reload [--config <path>] [--fragment <path>] [--validate-only] [--json]
 *   bun src/cli/cortex/commands/agents.ts list   [--config <path>] [--json]
 *   bun src/cli/cortex/commands/agents.ts --help
 *
 * Exit codes:
 *   0  — success
 *   1  — validation failure (named fragment / file)
 *   2  — usage error (bad flags, missing files, unknown subcommand)
 */

import { existsSync, statSync, readFileSync } from "fs";
import { dirname } from "path";

import { pidFileFor } from "../../../common/pidfile";
import { CliArgsError } from "./_shared/arg-error";
import { envelopeError, envelopeOk, renderJson } from "./_shared/envelope";
import { type ExitResult } from "./_shared/exit-result";
import { parseSubcommandArgs, type SubcommandSpec } from "./_shared/parser";
import { boolFlag, valueFlag } from "./_shared/hydrate";
import {
  loadAgentsDirectory,
  loadAgentFromFile,
  FragmentLoadError,
  expandTilde,
} from "../../../common/config/loader";
import { resolveConfigFilePath } from "../../../common/config/config-path";
import { type Agent } from "../../../common/types/cortex-config";

// =============================================================================
// Types
// =============================================================================

export interface ParsedAgentsArgs {
  subcommand: "reload" | "list" | "help" | "unknown";
  rawSubcommand: string;
  config: string | undefined;
  fragment: string | undefined;
  json: boolean;
  help: boolean;
  /**
   * B-0 (cortex#1021) — when set, `reload` only VALIDATES the fragments and
   * does NOT signal the running cortex runtime. Default behaviour now validates
   * AND sends SIGHUP to the runtime (resolved from the `--config` PID file) so
   * the live registry / review consumers / capability registry reload — the same
   * path the runtime's fs.watch + `reloadAgents()` use.
   */
  validateOnly: boolean;
}

// ExitResult moved to `_shared/exit-result.ts` (cortex#65). Importing
// above; re-exporting for backward compat with external imports of
// `ExitResult` via `agents.ts`.
export { type ExitResult } from "./_shared/exit-result";

// =============================================================================
// parseAgentsArgs
// =============================================================================

/**
 * @deprecated cortex#65 — use `CliArgsError` from `./_shared/arg-error`.
 * Aliased here so external imports of `AgentsArgsError` (e.g. cortex#63 test
 * patterns) continue working through the rename. Future PRs should switch
 * to the shared class directly.
 */
export const AgentsArgsError = CliArgsError;

/**
 * Grammar spec for `cortex agents`. Consumed by `parseSubcommandArgs`
 * (cortex#66 generic parser extract).
 */
const AGENTS_SPEC: SubcommandSpec<"reload" | "list"> = {
  cliName: "agents",
  subcommands: {
    reload: {
      flags: {
        "--config": "value",
        "--fragment": "value",
        "--validate-only": "bool",
      },
    },
    list: { flags: { "--config": "value" } },
  },
  universal: { "--help": "bool", "-h": "bool", "--json": "bool" },
};

/**
 * Parses `cortex agents` CLI arguments via the generic
 * `parseSubcommandArgs` helper from `_shared/parser.ts`. Throws
 * `CliArgsError` on bad flag / missing value / extra positional /
 * flag-scoping violation.
 *
 * Returns the typed `ParsedAgentsArgs` shape this file already exports
 * (kept for backward compat with `runAgentsReload(args)` /
 * `runAgentsList(args)` signatures); the shape is hydrated from the
 * generic parser's `flags` map.
 */
export function parseAgentsArgs(argv: string[]): ParsedAgentsArgs {
  const parsed = parseSubcommandArgs(AGENTS_SPEC, argv);
  return {
    subcommand: parsed.subcommand,
    rawSubcommand: parsed.rawSubcommand,
    config: valueFlag(parsed.flags, "--config"),
    fragment: valueFlag(parsed.flags, "--fragment"),
    json: boolFlag(parsed.flags, "--json"),
    help: parsed.help,
    validateOnly: boolFlag(parsed.flags, "--validate-only"),
  };
}

// =============================================================================
// runAgentsReload
// =============================================================================

/** The default cortex.yaml (shown in help as `~/.config/metafactory/cortex/
 *  cortex.yaml`) resolved at CALL time — fallback-aware canonical → legacy
 *  cortex → grove so an un-migrated host reads the legacy tree (cortex#1869). */
function defaultCortexConfigPath(): string {
  return resolveConfigFilePath("cortex.yaml");
}

export function runAgentsReload(args: ParsedAgentsArgs): ExitResult {
  if (args.help) {
    return { exitCode: 0, stdout: reloadHelp(), stderr: "" };
  }

  if (args.fragment) {
    return reloadFragment(args.fragment, args.json);
  }

  const resolved = resolveAgentsDir(args, "reload");
  if ("exit" in resolved) return resolved.exit;
  const agentsDir = resolved.agentsDir;

  try {
    const agents = loadAgentsDirectory(agentsDir);
    // B-0 (cortex#1021) — validation succeeded. Unless `--validate-only`, signal
    // the running runtime (SIGHUP) so it reloads the live registry / review
    // consumers / capability registry via the SAME reconcile path its fs.watch
    // and `reloadAgents()` use. Sage cortex#1027 — three outcomes, handled below:
    // a missing PID file is benign (no runtime; exit 0); a DELIVERED signal is
    // reported as "delivered", NOT "reload applied" (we can't prove the async
    // reload finished); an ATTEMPTED-but-FAILED signal (stale/malformed PID,
    // ESRCH/EPERM) is an error → non-zero exit + JSON error.
    const signal = args.validateOnly ? null : signalDaemonReload(args.config);

    // Sage cortex#1027 — a signal that was ATTEMPTED but FAILED is an error for
    // machine consumers: the reload the caller asked for did NOT happen. Exit
    // non-zero and emit a JSON error (validation passed, but the operation as a
    // whole did not). A BENIGN miss (no runtime to signal) or a delivered signal
    // stays exit 0.
    const signalFailed = signal !== null && !signal.signalled && !signal.benign;

    if (args.json) {
      if (signalFailed) {
        return {
          exitCode: 1,
          stdout: renderJson(
            envelopeError<AgentSummary>(
              `reload signal failed: ${signal.reason}`,
              { signalled: "false", validation: "ok" },
            ),
          ),
          stderr: "",
        };
      }
      // Success: carry the signal outcome in `data` so machine consumers can
      // distinguish "signal delivered" from "no runtime to signal" — and so they
      // never mistake validation-only success for a completed reload.
      return {
        exitCode: 0,
        stdout: jsonOk(agents, signalData(signal)),
        stderr: "",
      };
    }

    const footer = reloadFooter(agents.length, signal);
    const exitCode = signalFailed ? 1 : 0;
    if (agents.length === 0) {
      return {
        exitCode,
        stdout: `0 fragments in ${agentsDir} — nothing to load (OK)\n\n${footer}\n`,
        stderr: "",
      };
    }
    return {
      exitCode,
      stdout: agents.map(formatAgentLine).join("\n") + "\n\n" + footer + "\n",
      stderr: "",
    };
  } catch (err) {
    if (err instanceof FragmentLoadError) {
      return jsonOrTextError(err, args.json);
    }
    return {
      exitCode: 1,
      stdout: "",
      stderr: `cortex agents reload: unexpected error: ${err instanceof Error ? err.message : String(err)}\n`,
    };
  }
}

/**
 * B-0 (cortex#1021; Sage cortex#1027 honesty fix) — outcome of attempting to
 * signal the running runtime.
 *
 * Three distinct states (the middle two are NOT the same — Sage cortex#1027):
 *   - `signalled: true`            — SIGHUP DELIVERED to a live PID. This proves
 *                                    the signal was SENT, NOT that the runtime
 *                                    finished (or even began) reloading. We never
 *                                    claim "reload applied" — only "signal
 *                                    delivered; reload happens asynchronously".
 *   - `signalled: false, benign`   — no runtime to signal (no PID file). Nothing
 *                                    was attempted; validation passed → exit 0.
 *   - `signalled: false, failed`   — we ATTEMPTED to signal but it failed (stale
 *                                    PID file vanished mid-read, malformed PID,
 *                                    ESRCH/EPERM from kill). This is an ERROR for
 *                                    machine consumers → non-zero exit + JSON
 *                                    error. The validation still passed, but the
 *                                    reload the caller asked for did NOT happen.
 */
type SignalOutcome =
  | { signalled: true; pid: number }
  | { signalled: false; benign: true; reason: string }
  | { signalled: false; benign: false; reason: string };

/**
 * Resolve the runtime PID file for `configPath` and send SIGHUP, which the
 * running cortex runtime routes to its agents.d/ reload reconcile. The agents
 * CLI's default config is `~/.config/cortex/cortex.yaml` (NOT the legacy grove
 * default `pidFileFor` collapses to), so when `--config` is absent we resolve the
 * PID file against the explicit cortex default path rather than the unspecified
 * branch — this keeps the CLI pointed at the cortex-shaped runtime.
 *
 * Sage cortex#1027 — the PID-file READ is inside the same non-fatal outcome path
 * as the signal: if the file disappears or becomes unreadable between the
 * existence check and the read, we report `signalled: false, failed` rather than
 * letting `readFileSync` throw out of the reload command as an unexpected error.
 */
function signalDaemonReload(configPath: string | undefined): SignalOutcome {
  const resolvedConfig = expandTilde(configPath ?? defaultCortexConfigPath());
  const pidFile = pidFileFor(resolvedConfig);
  if (!existsSync(pidFile)) {
    // No runtime to signal — benign. Validation passed; nothing to reload.
    return {
      signalled: false,
      benign: true,
      reason: `no running cortex runtime (no PID file at ${pidFile})`,
    };
  }
  let raw: string;
  try {
    raw = readFileSync(pidFile, "utf-8").trim();
  } catch (err) {
    // Sage cortex#1027 — the PID file vanished or became unreadable between the
    // existsSync check and this read (a stale/racing runtime shutdown). Treat as
    // an ATTEMPTED-but-FAILED signal, not an unexpected crash of the command.
    return {
      signalled: false,
      benign: false,
      reason: `could not read PID file ${pidFile}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  // Full-string numeric check (sage round 2): parseInt("123abc") === 123
  // would SIGHUP an unintended process instead of flagging the file.
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) {
    return {
      signalled: false,
      benign: false,
      reason: `PID file ${pidFile} is malformed ("${raw}")`,
    };
  }
  const pid = Number(trimmed);
  if (pid <= 0) {
    return {
      signalled: false,
      benign: false,
      reason: `PID file ${pidFile} is malformed ("${raw}")`,
    };
  }
  try {
    process.kill(pid, "SIGHUP");
    return { signalled: true, pid };
  } catch (err) {
    // ESRCH (process gone — stale PID) or EPERM (not ours). We attempted the
    // signal and it failed → non-benign. The reload did NOT happen.
    return {
      signalled: false,
      benign: false,
      reason: `could not signal PID ${pid}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Compose the reload footer reflecting validation + the runtime-signal result.
 *
 * Sage cortex#1027 — HONEST wording. A delivered SIGHUP proves the signal was
 * SENT, not that the runtime reloaded. We say "reload signal delivered" and tell
 * the principal where to confirm the reload actually applied (runtime logs /
 * generation bump), instead of asserting "reload live".
 */
function reloadFooter(n: number, signal: SignalOutcome | null): string {
  const summary = `${n} fragment${n === 1 ? "" : "s"} loaded OK`;
  if (signal === null) {
    // --validate-only
    return `${summary}\n${VALIDATION_ONLY_NOTE}`;
  }
  if (signal.signalled) {
    return (
      `${summary}\n` +
      `reload signal delivered to running cortex runtime (PID ${signal.pid}, SIGHUP). ` +
      `The runtime applies the reload asynchronously — confirm via the runtime logs ` +
      `(look for "agents-reload … generation N").\n` +
      `note: presence (Discord/Mattermost/Slack) changes for added/removed agents require a runtime restart.`
    );
  }
  if (signal.benign) {
    // No runtime present — nothing to signal. Validation still passed.
    return `${summary}\nvalidation OK; no reload signal sent — ${signal.reason}`;
  }
  // Attempted-but-failed signal — surface as a problem the principal must act on.
  return `${summary}\nvalidation OK, but the reload signal FAILED — ${signal.reason}`;
}

/**
 * Validate a single fragment file (no directory traversal). Echo M2 on
 * cortex#63 — now delegates to shared `loadAgentFromFile` so the
 * single-file path gets the same hardening as the directory path: 1 MiB
 * size cap, ENOENT race, schema validation, persona-path resolution + ~
 * expansion (Echo B1 fix). Caller-only logic: file-existence check,
 * vanished-mid-call mapping, exit code mapping.
 */
function reloadFragment(fragmentPath: string, json: boolean): ExitResult {
  const expanded = expandTilde(fragmentPath);

  if (!existsSync(expanded)) {
    return {
      exitCode: 2,
      stdout: "",
      stderr: `cortex agents reload: fragment file "${expanded}" does not exist\n`,
    };
  }

  // Echo round-1 nit — pointing --fragment at a directory is a usage error,
  // not a validation failure. Catch with statSync before the loader hits
  // readFileSync and throws EISDIR (which we'd otherwise wrap as exit 1).
  try {
    if (statSync(expanded).isDirectory()) {
      return {
        exitCode: 2,
        stdout: "",
        stderr: `cortex agents reload: --fragment expects a file, got a directory: "${expanded}"\n`,
      };
    }
  } catch (err) {
    // statSync failed (e.g. permission denied) — let the loader surface a
    // clearer error.
    void err;
  }

  try {
    const agent = loadAgentFromFile(expanded, dirname(expanded));
    if (agent === null) {
      // File vanished between existsSync above and the loader's stat. Treat
      // as a usage error (principal-actionable: re-run).
      return {
        exitCode: 2,
        stdout: "",
        stderr: `cortex agents reload: fragment "${expanded}" disappeared between check and read; retry\n`,
      };
    }
    if (json) {
      return {
        exitCode: 0,
        stdout: jsonOk([agent]),
        stderr: "",
      };
    }
    return {
      exitCode: 0,
      stdout:
        formatAgentLine(agent) + "\n\n" + successFooter(1),
      stderr: "",
    };
  } catch (err) {
    if (err instanceof FragmentLoadError) {
      return jsonOrTextError(err, json);
    }
    return {
      exitCode: 1,
      stdout: "",
      stderr: `cortex agents reload: unexpected error: ${err instanceof Error ? err.message : String(err)}\n`,
    };
  }
}

// =============================================================================
// runAgentsList
// =============================================================================

export function runAgentsList(args: ParsedAgentsArgs): ExitResult {
  if (args.help) {
    return { exitCode: 0, stdout: listHelp(), stderr: "" };
  }

  const resolved = resolveAgentsDir(args, "list");
  if ("exit" in resolved) return resolved.exit;
  const agentsDir = resolved.agentsDir;

  try {
    const agents = loadAgentsDirectory(agentsDir);
    const sorted = [...agents].sort((a, b) => a.id.localeCompare(b.id));
    if (args.json) {
      // Echo M4 — JSON envelope is `{status, agents, error?}` everywhere.
      return { exitCode: 0, stdout: jsonOk(sorted), stderr: "" };
    }
    if (sorted.length === 0) {
      // Echo m2 — align with `reload` empty-dir text output for consistency.
      return {
        exitCode: 0,
        stdout: `0 agents in ${agentsDir}\n`,
        stderr: "",
      };
    }
    return {
      exitCode: 0,
      stdout: sorted.map(formatAgentLine).join("\n") + "\n",
      stderr: "",
    };
  } catch (err) {
    if (err instanceof FragmentLoadError) {
      return jsonOrTextError(err, args.json, "list");
    }
    return {
      exitCode: 1,
      stdout: "",
      stderr: `cortex agents list: unexpected error: ${err instanceof Error ? err.message : String(err)}\n`,
    };
  }
}

// =============================================================================
// dispatchAgents
// =============================================================================

export function dispatchAgents(argv: string[]): ExitResult {
  let args: ParsedAgentsArgs;
  try {
    args = parseAgentsArgs(argv);
  } catch (err) {
    // Echo M1 — parser throws CliArgsError on bad flags. Map to exit 2.
    if (err instanceof CliArgsError) {
      return {
        exitCode: 2,
        stdout: "",
        stderr: `cortex agents: ${err.message}\n${topLevelHelp()}`,
      };
    }
    throw err;
  }

  switch (args.subcommand) {
    case "reload":
      return runAgentsReload(args);
    case "list":
      return runAgentsList(args);
    case "help":
      return { exitCode: 0, stdout: topLevelHelp(), stderr: "" };
    case "unknown":
      if (args.rawSubcommand === "") {
        return {
          exitCode: 2,
          stdout: "",
          stderr: `cortex agents: usage error — no subcommand specified.\n${topLevelHelp()}`,
        };
      }
      return {
        exitCode: 2,
        stdout: "",
        stderr: `cortex agents: unknown subcommand "${args.rawSubcommand}".\n${topLevelHelp()}`,
      };
  }
}

// =============================================================================
// Output helpers — Echo M3 + M4 on cortex#63
// =============================================================================

/**
 * Validation-only caveat appended to success output for paths that do NOT
 * signal the cortex runtime — `--validate-only` and the single-file `--fragment`
 * check. The default `reload` path DOES signal (SIGHUP) and uses `reloadFooter`.
 */
const VALIDATION_ONLY_NOTE =
  "note: validation-only — the running cortex runtime was NOT signalled to reload.";

function successFooter(n: number): string {
  const summary = `${n} fragment${n === 1 ? "" : "s"} loaded OK`;
  return `${summary}\n${VALIDATION_ONLY_NOTE}\n`;
}

/**
 * Per-agent metadata returned in the JSON envelope's `items` array.
 * cortex#65 — F-3 retrofit to the shared `CliJsonEnvelope<T>` shape
 * introduced in F-4 (cortex#64). Scripting consumers now see structurally
 * identical envelopes across `cortex agents` and `cortex creds`:
 *
 * ```ts
 * { status: "ok" | "error", items: T[], error?: { reason, context? } }
 * ```
 *
 * **Breaking change vs F-3 cycle 2:** the OLD F-3 envelope was
 * `{status, agents: [], error?: {file, reason}}`. New shape uses `items`
 * (not `agents`) and `error.context.file` (not `error.file`). F-3 only
 * just merged (cortex#63), so this contract change is acceptable in the
 * "no-external-consumers-yet" window per Echo M2 framing on cortex#64.
 */
export type AgentSummary = ReturnType<typeof summarizeAgent>;

function jsonOk(agents: Agent[], data?: Record<string, string>): string {
  return renderJson(envelopeOk<AgentSummary>(agents.map(summarizeAgent), data));
}

/**
 * Sage cortex#1027 — success-side `data` describing the runtime-signal outcome,
 * so JSON consumers can tell apart "reload signal delivered" from "no runtime to
 * signal" from "validation-only". For `--validate-only` (signal === null, no
 * signal attempted) returns `{ signalled: "false", reason: "validate-only" }`
 * so the JSON contract always carries an explicit signal outcome.
 */
function signalData(
  signal: SignalOutcome | null,
): Record<string, string> | undefined {
  if (signal === null) {
    return { signalled: "false", reason: "validate-only" };
  }
  if (signal.signalled) {
    // "signalled" — the SIGHUP was delivered. NOT a reload-applied claim.
    return { signalled: "true", pid: String(signal.pid) };
  }
  // benign miss (no runtime present)
  return { signalled: "false", reason: signal.reason };
}

function jsonOrTextError(
  err: FragmentLoadError,
  json: boolean,
  command: "reload" | "list" = "reload",
): ExitResult {
  if (json) {
    return {
      exitCode: 1,
      stdout: renderJson(
        envelopeError<AgentSummary>(err.reason, { file: err.file }),
      ),
      stderr: "",
    };
  }
  return {
    exitCode: 1,
    stdout: "",
    stderr: `cortex agents ${command}: ${err.message}\n`,
  };
}

/**
 * Shared config-dir resolution + missing-dir bailout. Echo round-1 nit-
 * duplication on cortex#63 — both `runAgentsReload` and `runAgentsList`
 * had this block. Now both call this helper.
 *
 * Returns either the resolved `agentsDir` path, or an `ExitResult` with
 * exit code 2 if the config directory is missing.
 */
function resolveAgentsDir(
  args: ParsedAgentsArgs,
  command: "reload" | "list",
): { agentsDir: string } | { exit: ExitResult } {
  const configPath = expandTilde(args.config ?? defaultCortexConfigPath());
  const configDir = dirname(configPath);
  if (!existsSync(configDir)) {
    return {
      exit: {
        exitCode: 2,
        stdout: "",
        stderr: `cortex agents ${command}: config directory "${configDir}" does not exist\n`,
      },
    };
  }
  return { agentsDir: `${configDir}/agents.d` };
}

// =============================================================================
// Formatters
// =============================================================================

function summarizeAgent(a: Agent): {
  id: string;
  displayName: string;
  substrate: string;
  mode: string;
  capabilities: string[];
} {
  return {
    id: a.id,
    displayName: a.displayName,
    substrate: a.runtime?.substrate ?? "claude-code",
    mode: a.runtime?.mode ?? "in-process",
    capabilities: a.runtime?.capabilities ?? [],
  };
}

function formatAgentLine(a: Agent): string {
  const substrate = a.runtime?.substrate ?? "claude-code";
  const mode = a.runtime?.mode ?? "in-process";
  const capCount = a.runtime?.capabilities.length ?? 0;
  return `${a.id.padEnd(20)} — ${substrate} / ${mode} / ${capCount} capabilit${capCount === 1 ? "y" : "ies"}`;
}

// =============================================================================
// Help text
// =============================================================================

function topLevelHelp(): string {
  return `cortex agents — inspect + validate agent fragments

Usage:
  cortex agents reload [options]
  cortex agents list   [options]
  cortex agents --help

Subcommands:
  reload   Validate fragments in ~/.config/cortex/agents.d/ (or --fragment <path>)
  list     List loaded agents with substrate / mode / capabilities

Common options:
  --config <path>     cortex.yaml path (default: ~/.config/cortex/cortex.yaml)
  --json              emit structured JSON (machine-readable)
  --help, -h          show help

Exit codes:
  0    success
  1    validation failure
  2    usage error (bad flag, missing config, unknown subcommand)
`;
}

function reloadHelp(): string {
  return `cortex agents reload — validate agents.d/ fragments + reload the cortex runtime

Usage:
  cortex agents reload [--config <path>] [--fragment <path>] [--validate-only] [--json]

Options:
  --config <path>      cortex.yaml path (default: ~/.config/cortex/cortex.yaml)
                       The agents.d/ directory next to this file is loaded; the
                       runtime's PID file is resolved from the same path.
  --fragment <path>    Validate a single fragment file (overrides --config dir mode).
                       Validation-only — does not signal the cortex runtime.
  --validate-only      Validate the agents.d/ directory but do NOT signal the cortex runtime.
  --json               Emit structured JSON

By default this validates the agents.d/ fragments and then sends SIGHUP to the
running cortex runtime (resolved from the --config PID file). The runtime then
reloads its live agent registry, review consumers, and capability registry via
the same reconcile path its fs.watch + 'reloadAgents()' use. The signal is
delivered synchronously; the reload itself is applied asynchronously — confirm
it landed via the runtime logs. Presence adapter (Discord/Mattermost/Slack)
changes for added/removed agents require a runtime restart (registry + review +
capabilities reload live; presence is restart-only).
`;
}

function listHelp(): string {
  return `cortex agents list — list loaded agents

Usage:
  cortex agents list [--config <path>] [--json]

Options:
  --config <path>      cortex.yaml path (default: ~/.config/cortex/cortex.yaml)
  --json               Emit array of agent summary objects
`;
}

// =============================================================================
// Main
// =============================================================================

if (import.meta.main) {
  const result = dispatchAgents(process.argv.slice(2));
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exit(result.exitCode);
}
