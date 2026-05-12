#!/usr/bin/env bun
/**
 * F-3 — `cortex agents <subcommand>` CLI.
 *
 * Validation-only CLI for inspecting and validating `agents.d/` fragments
 * against the cortex schema. Wraps F-2's `loadAgentsDirectory()`. Does NOT
 * talk to a running cortex daemon in v1 — daemon-IPC is a follow-up that
 * waits for cortex.ts integration of `AgentsDirectoryWatcher`.
 *
 * Usage:
 *   bun src/cli/cortex/commands/agents.ts reload [--config <path>] [--fragment <path>] [--json]
 *   bun src/cli/cortex/commands/agents.ts list   [--config <path>] [--json]
 *   bun src/cli/cortex/commands/agents.ts --help
 *
 * Exit codes:
 *   0  — success
 *   1  — validation failure (named fragment / file)
 *   2  — usage error (bad flags, missing files, unknown subcommand)
 */

import { existsSync, statSync } from "fs";
import { dirname } from "path";

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
    reload: { flags: { "--config": "value", "--fragment": "value" } },
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
  };
}

// =============================================================================
// runAgentsReload
// =============================================================================

const DEFAULT_CONFIG_PATH = "~/.config/cortex/cortex.yaml";

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
    if (args.json) {
      return { exitCode: 0, stdout: jsonOk(agents), stderr: "" };
    }
    if (agents.length === 0) {
      return {
        exitCode: 0,
        stdout: `0 fragments in ${agentsDir} — nothing to load (OK)\n\n${VALIDATION_ONLY_NOTE}\n`,
        stderr: "",
      };
    }
    return {
      exitCode: 0,
      stdout:
        agents.map(formatAgentLine).join("\n") + "\n\n" + successFooter(agents.length),
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
      // as a usage error (operator-actionable: re-run).
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
 * Validation-only caveat appended to success output so arc lifecycle scripts
 * (and operators reading stdout) don't infer "the running daemon reloaded."
 * Echo M3 on cortex#63.
 */
const VALIDATION_ONLY_NOTE =
  "note: validation-only — this CLI does NOT signal a running cortex daemon to reload (v1).";

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

function jsonOk(agents: Agent[]): string {
  return renderJson(envelopeOk<AgentSummary>(agents.map(summarizeAgent)));
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
  const configPath = expandTilde(args.config ?? DEFAULT_CONFIG_PATH);
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
  return `cortex agents reload — validate agents.d/ fragments

Usage:
  cortex agents reload [--config <path>] [--fragment <path>] [--json]

Options:
  --config <path>      cortex.yaml path (default: ~/.config/cortex/cortex.yaml)
                       The agents.d/ directory next to this file is loaded.
  --fragment <path>    Validate a single fragment file (overrides --config dir mode)
  --json               Emit structured JSON

In v1, this command is validation-only. It does NOT signal a running cortex
daemon to reload — that wiring lands when cortex.ts integrates the
AgentsDirectoryWatcher (separate follow-up).
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
