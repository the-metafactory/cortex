#!/usr/bin/env bun
/**
 * F-4 — `cortex creds <subcommand>` CLI.
 *
 * Manages per-agent NATS user credentials (cortex#58 D7+D8 + cortex#60 §6.3).
 *
 * **v1 scope:** `list` is fully functional (scans local creds dir). `issue`,
 * `revoke`, `rotate` ship as stubs returning exit 2 with a clear "deferred"
 * message. The daemon-mediated signing flow (NATS req/rep + UNIX socket
 * fallback, per the interview answers) lands when cortex.ts gains the
 * daemon-side RPC handler. Same scope-narrowing pattern as F-2 and F-3.
 *
 * Usage:
 *   bun src/cli/cortex/commands/creds.ts list   [--creds-dir <path>] [--local] [--json]
 *   bun src/cli/cortex/commands/creds.ts issue  <agent-id> [--config <path>] [--json]
 *   bun src/cli/cortex/commands/creds.ts revoke <agent-id> [--config <path>] [--json]
 *   bun src/cli/cortex/commands/creds.ts rotate <agent-id> [--config <path>] [--json]
 *   bun src/cli/cortex/commands/creds.ts --help
 *
 * Exit codes:
 *   0  — success
 *   1  — operational failure (e.g. daemon unreachable, when implemented)
 *   2  — usage error (bad flag, deferred subcommand v1, bad agent id)
 */

import { existsSync, readdirSync, statSync } from "fs";
import { join } from "path";

import { expandTilde } from "../../../common/config/loader";

// =============================================================================
// Types
// =============================================================================

export interface ParsedCredsArgs {
  subcommand: "list" | "issue" | "revoke" | "rotate" | "help" | "unknown";
  rawSubcommand: string;
  agentId: string | undefined;
  credsDir: string | undefined;
  config: string | undefined;
  local: boolean;
  json: boolean;
  help: boolean;
}

export interface ExitResult {
  exitCode: 0 | 1 | 2;
  stdout: string;
  stderr: string;
}

/**
 * **JSON envelope contract** for `cortex creds` — mirrors F-3's shape so
 * scripting consumers don't have to special-case per CLI.
 *
 * `creds: []` is ALWAYS present (empty on error/non-list subcommands).
 * `error?` is present iff `status === "error"`.
 */
export interface CredsJsonEnvelope {
  status: "ok" | "error";
  creds: { id: string; path: string; issuedAt: string }[];
  error?: { reason: string; subcommand: string };
}

/**
 * Usage error thrown by the parser on bad flag combinations. dispatchCreds
 * catches and maps to exit 2.
 */
export class CredsArgsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CredsArgsError";
  }
}

/**
 * Message emitted by the v1 stubs for `issue` / `revoke` / `rotate`. Exported
 * so tests can assert against the exact string without it living in two
 * places.
 */
export const DEFERRED_SUBCOMMAND_MESSAGE =
  "not yet implemented — pending cortex daemon-IPC integration (cortex#60 §6.3 / D8). " +
  "v1 ships `cortex creds list` only; issue/revoke/rotate land when cortex.ts wires the daemon-side RPC handler.";

const AGENT_ID_REGEX = /^[a-z0-9-]+$/;
const DEFAULT_CREDS_DIR = "~/.config/nats/creds";

// =============================================================================
// parseCredsArgs
// =============================================================================

export function parseCredsArgs(argv: string[]): ParsedCredsArgs {
  const out: ParsedCredsArgs = {
    subcommand: "unknown",
    rawSubcommand: "",
    agentId: undefined,
    credsDir: undefined,
    config: undefined,
    local: false,
    json: false,
    help: false,
  };

  if (argv.length === 0) return out;

  let i = 0;
  let positionalsSeen = 0;
  while (i < argv.length) {
    const arg = argv[i]!;

    if (arg === "--help" || arg === "-h") {
      if (out.subcommand === "unknown" && out.rawSubcommand === "") {
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
    if (arg === "--local") {
      out.local = true;
      i++;
      continue;
    }
    if (arg === "--creds-dir") {
      if (i + 1 >= argv.length || argv[i + 1]!.startsWith("-")) {
        throw new CredsArgsError("--creds-dir requires a path argument");
      }
      out.credsDir = argv[i + 1];
      i += 2;
      continue;
    }
    if (arg === "--config") {
      if (i + 1 >= argv.length || argv[i + 1]!.startsWith("-")) {
        throw new CredsArgsError("--config requires a path argument");
      }
      out.config = argv[i + 1];
      i += 2;
      continue;
    }
    if (arg.startsWith("-")) {
      throw new CredsArgsError(`unknown flag: ${arg}`);
    }

    // Positional handling
    positionalsSeen++;
    if (positionalsSeen === 1) {
      // First positional: subcommand
      out.rawSubcommand = arg;
      if (arg === "list" || arg === "issue" || arg === "revoke" || arg === "rotate") {
        out.subcommand = arg;
      }
      i++;
      continue;
    }
    if (positionalsSeen === 2) {
      // Second positional: agent id (only valid for issue / revoke / rotate)
      if (
        out.subcommand === "issue" ||
        out.subcommand === "revoke" ||
        out.subcommand === "rotate"
      ) {
        out.agentId = arg;
        i++;
        continue;
      }
      throw new CredsArgsError(`unexpected extra positional argument: "${arg}"`);
    }
    throw new CredsArgsError(`unexpected extra positional argument: "${arg}"`);
  }

  return out;
}

// =============================================================================
// runCredsList
// =============================================================================

export function runCredsList(args: ParsedCredsArgs): ExitResult {
  if (args.help) {
    return { exitCode: 0, stdout: listHelp(), stderr: "" };
  }

  const dir = expandTilde(args.credsDir ?? DEFAULT_CREDS_DIR);

  if (!existsSync(dir)) {
    if (args.json) {
      return {
        exitCode: 0,
        stdout: jsonOk([]),
        stderr: "",
      };
    }
    return {
      exitCode: 0,
      stdout: `0 creds files in ${dir} (directory does not exist)\n`,
      stderr: "",
    };
  }

  let entries: string[];
  try {
    entries = readdirSync(dir).filter((f) => !f.startsWith("."));
  } catch (err) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: `cortex creds list: ${err instanceof Error ? err.message : String(err)}\n`,
    };
  }

  const creds: CredsJsonEnvelope["creds"] = [];
  for (const filename of entries) {
    const filePath = join(dir, filename);
    let mtime: Date;
    try {
      const stat = statSync(filePath);
      if (!stat.isFile()) continue;
      mtime = stat.mtime;
    } catch {
      // Race: file vanished between readdir and stat. Skip.
      continue;
    }
    // id is the filename stem (everything before the FIRST `.`).
    // Handles `echo.creds`, `echo.nats.creds`, plain `echo` all consistently.
    const id = filename.split(".")[0]!;
    creds.push({
      id,
      path: filePath,
      issuedAt: mtime.toISOString(),
    });
  }

  creds.sort((a, b) => a.id.localeCompare(b.id));

  if (args.json) {
    return { exitCode: 0, stdout: jsonOk(creds), stderr: "" };
  }

  if (creds.length === 0) {
    return {
      exitCode: 0,
      stdout: `0 creds files in ${dir}\n`,
      stderr: "",
    };
  }

  return {
    exitCode: 0,
    stdout: creds.map(formatCredsLine).join("\n") + "\n",
    stderr: "",
  };
}

// =============================================================================
// runCredsIssue / Revoke / Rotate (v1 stubs)
// =============================================================================

export function runCredsIssue(args: ParsedCredsArgs): ExitResult {
  return runDeferredSubcommand(args, "issue");
}

export function runCredsRevoke(args: ParsedCredsArgs): ExitResult {
  return runDeferredSubcommand(args, "revoke");
}

export function runCredsRotate(args: ParsedCredsArgs): ExitResult {
  return runDeferredSubcommand(args, "rotate");
}

function runDeferredSubcommand(
  args: ParsedCredsArgs,
  subcommand: "issue" | "revoke" | "rotate",
): ExitResult {
  if (args.help) {
    return { exitCode: 0, stdout: deferredSubcommandHelp(subcommand), stderr: "" };
  }

  // Validate the agent id even though we won't act on it — surface bad
  // operator input at the CLI layer, not in some future daemon RPC.
  if (!args.agentId) {
    if (args.json) {
      return {
        exitCode: 2,
        stdout: jsonError(`missing agent id for "${subcommand}"`, subcommand),
        stderr: "",
      };
    }
    return {
      exitCode: 2,
      stdout: "",
      stderr: `cortex creds ${subcommand}: missing agent id (usage: cortex creds ${subcommand} <agent-id>)\n`,
    };
  }
  if (!AGENT_ID_REGEX.test(args.agentId)) {
    const reason = `agent id "${args.agentId}" is invalid — must match /^[a-z0-9-]+$/`;
    if (args.json) {
      return { exitCode: 2, stdout: jsonError(reason, subcommand), stderr: "" };
    }
    return {
      exitCode: 2,
      stdout: "",
      stderr: `cortex creds ${subcommand}: ${reason}\n`,
    };
  }

  // Stub: emit the deferred message.
  if (args.json) {
    return {
      exitCode: 2,
      stdout: jsonError(DEFERRED_SUBCOMMAND_MESSAGE, subcommand),
      stderr: "",
    };
  }
  return {
    exitCode: 2,
    stdout: "",
    stderr: `cortex creds ${subcommand}: ${DEFERRED_SUBCOMMAND_MESSAGE}\n`,
  };
}

// =============================================================================
// dispatchCreds
// =============================================================================

export function dispatchCreds(argv: string[]): ExitResult {
  let args: ParsedCredsArgs;
  try {
    args = parseCredsArgs(argv);
  } catch (err) {
    if (err instanceof CredsArgsError) {
      return {
        exitCode: 2,
        stdout: "",
        stderr: `cortex creds: ${err.message}\n${topLevelHelp()}`,
      };
    }
    throw err;
  }

  switch (args.subcommand) {
    case "list":
      return runCredsList(args);
    case "issue":
      return runCredsIssue(args);
    case "revoke":
      return runCredsRevoke(args);
    case "rotate":
      return runCredsRotate(args);
    case "help":
      return { exitCode: 0, stdout: topLevelHelp(), stderr: "" };
    case "unknown":
      if (args.rawSubcommand === "") {
        return {
          exitCode: 2,
          stdout: "",
          stderr: `cortex creds: usage error — no subcommand specified.\n${topLevelHelp()}`,
        };
      }
      return {
        exitCode: 2,
        stdout: "",
        stderr: `cortex creds: unknown subcommand "${args.rawSubcommand}".\n${topLevelHelp()}`,
      };
  }
}

// =============================================================================
// Output helpers
// =============================================================================

function jsonOk(creds: CredsJsonEnvelope["creds"]): string {
  const envelope: CredsJsonEnvelope = { status: "ok", creds };
  return JSON.stringify(envelope, null, 2) + "\n";
}

function jsonError(reason: string, subcommand: string): string {
  const envelope: CredsJsonEnvelope = {
    status: "error",
    creds: [],
    error: { reason, subcommand },
  };
  return JSON.stringify(envelope, null, 2) + "\n";
}

function formatCredsLine(c: { id: string; path: string; issuedAt: string }): string {
  return `${c.id.padEnd(20)} ${c.path}  issued ${c.issuedAt}`;
}

// =============================================================================
// Help text
// =============================================================================

function topLevelHelp(): string {
  return `cortex creds — manage per-agent NATS user credentials

Usage:
  cortex creds list   [--creds-dir <path>] [--local] [--json]
  cortex creds issue  <agent-id> [--config <path>] [--json]
  cortex creds revoke <agent-id> [--config <path>] [--json]
  cortex creds rotate <agent-id> [--config <path>] [--json]
  cortex creds --help

Subcommands:
  list     List existing creds files (v1: filesystem-only — fully functional)
  issue    Mint creds for an agent (v1: deferred — see cortex#60 §6.3)
  revoke   Revoke creds (v1: deferred)
  rotate   Revoke + issue atomically (v1: deferred)

Common options:
  --creds-dir <path>   Directory containing .creds files (default: ~/.config/nats/creds)
  --config <path>      cortex.yaml path (for issue/revoke/rotate when implemented)
  --local              Operate on local files only (no daemon contact) — implied for list in v1
  --json               Emit structured JSON envelope
  --help, -h           Show help

Exit codes:
  0    success
  1    operational failure
  2    usage error / deferred subcommand
`;
}

function listHelp(): string {
  return `cortex creds list — list local NATS creds files

Usage:
  cortex creds list [--creds-dir <path>] [--local] [--json]

Options:
  --creds-dir <path>   Default: ~/.config/nats/creds
  --json               Emit envelope { status, creds: [{id, path, issuedAt}], error? }
`;
}

function deferredSubcommandHelp(sub: "issue" | "revoke" | "rotate"): string {
  return `cortex creds ${sub} — ${sub} per-agent NATS credentials (v1: deferred)

Usage:
  cortex creds ${sub} <agent-id> [--config <path>] [--json]

${DEFERRED_SUBCOMMAND_MESSAGE}

When implemented, the v2 surface will:
  - Validate the agent id against the cortex.yaml registry
  - Connect to the cortex daemon via NATS req/rep (preferred) or UNIX socket (fallback)
  - Daemon performs server-side ${sub === "issue" ? "mint" : sub === "revoke" ? "revoke (server-side first)" : "rotate (revoke + mint atomic)"}
  - On success, write/remove the local creds file at ~/.config/nats/creds/<id>.creds
`;
}

// =============================================================================
// Main
// =============================================================================

if (import.meta.main) {
  const result = dispatchCreds(process.argv.slice(2));
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exit(result.exitCode);
}
