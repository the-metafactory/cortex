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

import { existsSync, readFileSync } from "fs";
import { dirname, basename, isAbsolute } from "path";
import { parse as parseYaml } from "yaml";

import {
  loadAgentsDirectory,
  FragmentLoadError,
  expandTilde,
} from "../../../common/config/loader";
import { AgentSchema, type Agent } from "../../../common/types/cortex-config";

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

export interface ExitResult {
  exitCode: 0 | 1 | 2;
  stdout: string;
  stderr: string;
}

// =============================================================================
// parseAgentsArgs
// =============================================================================

/**
 * Hand-rolled arg parser matching the migrate-config.ts convention. Returns
 * `subcommand = "unknown"` for both empty input and unrecognized first
 * positional — the caller decides whether to print help vs error.
 */
export function parseAgentsArgs(argv: string[]): ParsedAgentsArgs {
  const out: ParsedAgentsArgs = {
    subcommand: "unknown",
    rawSubcommand: "",
    config: undefined,
    fragment: undefined,
    json: false,
    help: false,
  };

  if (argv.length === 0) {
    return out;
  }

  // First positional or help-flag determines the subcommand.
  let i = 0;
  while (i < argv.length) {
    const arg = argv[i]!;
    if (arg === "--help" || arg === "-h") {
      if (out.subcommand === "unknown") {
        out.subcommand = "help";
      } else {
        out.help = true;
      }
      i++;
      continue;
    }
    if (arg === "--json") {
      out.json = true;
      i++;
      continue;
    }
    if (arg === "--config") {
      out.config = argv[i + 1];
      i += 2;
      continue;
    }
    if (arg === "--fragment") {
      out.fragment = argv[i + 1];
      i += 2;
      continue;
    }
    // First positional: subcommand
    if (out.subcommand === "unknown" && !arg.startsWith("-")) {
      out.rawSubcommand = arg;
      if (arg === "reload" || arg === "list") {
        out.subcommand = arg;
      } else {
        out.subcommand = "unknown";
      }
      i++;
      continue;
    }
    // Unknown flag or extra positional — ignore (or fail). For v1, ignore.
    i++;
  }

  return out;
}

// =============================================================================
// runAgentsReload
// =============================================================================

const DEFAULT_CONFIG_PATH = "~/.config/cortex/cortex.yaml";

export function runAgentsReload(args: ParsedAgentsArgs): ExitResult {
  if (args.help) {
    return {
      exitCode: 0,
      stdout: reloadHelp(),
      stderr: "",
    };
  }

  // --fragment mode: validate a single file.
  if (args.fragment) {
    return reloadFragment(args.fragment, args.json);
  }

  // --config mode: validate the agents.d/ directory next to cortex.yaml.
  const configPath = expandTilde(args.config ?? DEFAULT_CONFIG_PATH);
  const configDir = dirname(configPath);

  if (!existsSync(configDir)) {
    return {
      exitCode: 2,
      stdout: "",
      stderr: `cortex agents reload: config directory "${configDir}" does not exist\n`,
    };
  }

  const agentsDir = `${configDir}/agents.d`;

  try {
    const agents = loadAgentsDirectory(agentsDir);
    if (args.json) {
      return {
        exitCode: 0,
        stdout: JSON.stringify({ status: "ok", agents: agents.map(summarizeAgent) }, null, 2) + "\n",
        stderr: "",
      };
    }
    if (agents.length === 0) {
      return {
        exitCode: 0,
        stdout: `0 fragments in ${agentsDir} — nothing to load (OK)\n`,
        stderr: "",
      };
    }
    const lines = agents.map(formatAgentLine).join("\n");
    const summary = `${agents.length} fragment${agents.length === 1 ? "" : "s"} loaded OK`;
    return {
      exitCode: 0,
      stdout: `${lines}\n\n${summary}\n`,
      stderr: "",
    };
  } catch (err) {
    if (err instanceof FragmentLoadError) {
      if (args.json) {
        return {
          exitCode: 1,
          // JSON goes to stdout even on failure so scripts can parse it.
          stdout:
            JSON.stringify(
              { status: "error", error: { file: err.file, reason: err.reason } },
              null,
              2,
            ) + "\n",
          stderr: "",
        };
      }
      return {
        exitCode: 1,
        stdout: "",
        stderr: `cortex agents reload: ${err.message}\n`,
      };
    }
    // Unexpected error
    return {
      exitCode: 1,
      stdout: "",
      stderr: `cortex agents reload: unexpected error: ${err instanceof Error ? err.message : String(err)}\n`,
    };
  }
}

/**
 * Validate a single fragment file (no directory traversal). Schema-validates
 * and confirms the persona file exists. Returns exit 1 on validation
 * failure, exit 2 on file-missing (usage error).
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

  let content: string;
  try {
    content = readFileSync(expanded, "utf-8");
  } catch (err) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: `cortex agents reload: read failed for "${expanded}": ${err instanceof Error ? err.message : String(err)}\n`,
    };
  }

  let raw: unknown;
  try {
    raw = parseYaml(content);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    if (json) {
      return {
        exitCode: 1,
        stdout:
          JSON.stringify(
            { status: "error", error: { file: expanded, reason: `YAML parse error: ${reason}` } },
            null,
            2,
          ) + "\n",
        stderr: "",
      };
    }
    return {
      exitCode: 1,
      stdout: "",
      stderr: `cortex agents reload: ${basename(expanded)}: YAML parse error: ${reason}\n`,
    };
  }

  let agent: Agent;
  try {
    agent = AgentSchema.parse(raw);
  } catch (err: unknown) {
    const issues = (err as { issues?: Array<{ path?: unknown[]; message: string }> }).issues ?? [];
    const details =
      issues.length > 0
        ? issues.map((i) => `  ${(i.path ?? []).join(".")}: ${i.message}`).join("\n")
        : err instanceof Error
          ? err.message
          : String(err);
    if (json) {
      return {
        exitCode: 1,
        stdout:
          JSON.stringify(
            { status: "error", error: { file: expanded, reason: `schema validation failed: ${details}` } },
            null,
            2,
          ) + "\n",
        stderr: "",
      };
    }
    return {
      exitCode: 1,
      stdout: "",
      stderr: `cortex agents reload: ${basename(expanded)}: schema validation failed:\n${details}\n`,
    };
  }

  // Persona file check (loader does this; replicate here for the single-file path).
  const personaPath = isAbsolute(agent.persona)
    ? agent.persona
    : `${dirname(expanded)}/${agent.persona}`;
  if (!existsSync(expandTilde(personaPath))) {
    if (json) {
      return {
        exitCode: 1,
        stdout:
          JSON.stringify(
            {
              status: "error",
              error: { file: expanded, reason: `persona file does not exist: ${personaPath}` },
            },
            null,
            2,
          ) + "\n",
        stderr: "",
      };
    }
    return {
      exitCode: 1,
      stdout: "",
      stderr: `cortex agents reload: ${basename(expanded)}: persona file does not exist: ${personaPath}\n`,
    };
  }

  if (json) {
    return {
      exitCode: 0,
      stdout: JSON.stringify({ status: "ok", agents: [summarizeAgent(agent)] }, null, 2) + "\n",
      stderr: "",
    };
  }
  return {
    exitCode: 0,
    stdout: `${formatAgentLine(agent)}\n\n1 fragment loaded OK\n`,
    stderr: "",
  };
}

// =============================================================================
// runAgentsList
// =============================================================================

export function runAgentsList(args: ParsedAgentsArgs): ExitResult {
  if (args.help) {
    return { exitCode: 0, stdout: listHelp(), stderr: "" };
  }

  const configPath = expandTilde(args.config ?? DEFAULT_CONFIG_PATH);
  const configDir = dirname(configPath);

  if (!existsSync(configDir)) {
    return {
      exitCode: 2,
      stdout: "",
      stderr: `cortex agents list: config directory "${configDir}" does not exist\n`,
    };
  }

  const agentsDir = `${configDir}/agents.d`;

  try {
    const agents = loadAgentsDirectory(agentsDir);
    const sorted = [...agents].sort((a, b) => a.id.localeCompare(b.id));
    if (args.json) {
      return {
        exitCode: 0,
        stdout: JSON.stringify(sorted.map(summarizeAgent), null, 2) + "\n",
        stderr: "",
      };
    }
    if (sorted.length === 0) {
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    return {
      exitCode: 0,
      stdout: sorted.map(formatAgentLine).join("\n") + "\n",
      stderr: "",
    };
  } catch (err) {
    if (err instanceof FragmentLoadError) {
      return {
        exitCode: 1,
        stdout: "",
        stderr: `cortex agents list: ${err.message}\n`,
      };
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
  const args = parseAgentsArgs(argv);

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
