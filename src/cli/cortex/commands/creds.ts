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

import { existsSync, lstatSync, readdirSync } from "fs";
import { join } from "path";

import { expandTilde } from "../../../common/config/loader";
import { CliArgsError } from "./_shared/arg-error";
import { envelopeError, envelopeOk, renderJson } from "./_shared/envelope";
import { assertExhaustive } from "./_shared/assert-exhaustive";

// =============================================================================
// Types
// =============================================================================

export interface ParsedCredsArgs {
  subcommand: "list" | "issue" | "revoke" | "rotate" | "help" | "unknown";
  rawSubcommand: string;
  agentId: string | undefined;
  credsDir: string | undefined;
  config: string | undefined;
  json: boolean;
  help: boolean;
}

export interface ExitResult {
  exitCode: 0 | 1 | 2;
  stdout: string;
  stderr: string;
}

/**
 * Per-creds-file metadata returned in the JSON envelope's `items` array.
 *
 * Echo M2 + M4 on cortex#64 — F-4 uses the shared `CliJsonEnvelope<T>` from
 * `_shared/envelope.ts` so its JSON contract is identical in shape to F-3's
 * (modulo the `items` element type — there `Agent`-shaped, here
 * `CredsItem`-shaped). Scripting consumers can pin against
 * `CliJsonEnvelope<unknown>` without per-subcommand handling.
 *
 * No deprecated re-exports of the prior `CredsJsonEnvelope` / `CredsArgsError`
 * names — F-4 is the first cortex CLI to ship the shared shape and has no
 * external consumers yet (Echo A2 nit cortex#64). Importers use the shared
 * `_shared/envelope.ts` and `_shared/arg-error.ts` directly.
 */
export interface CredsItem {
  id: string;
  path: string;
  issuedAt: string;
}

/**
 * Message emitted by the v1 stubs for `issue` / `revoke` / `rotate`. Exported
 * so tests can assert against the exact string without it living in two
 * places.
 */
export const DEFERRED_SUBCOMMAND_MESSAGE =
  "not yet implemented — pending cortex daemon-IPC integration (cortex#67). " +
  "v1 ships `cortex creds list` only; issue/revoke/rotate light up when " +
  "cortex.ts wires the daemon-side RPC handler. See cortex#60 §6.3 + cortex#58 D8 for the design.";

/**
 * Canonical agent-id regex (lowercase alphanumeric + dash). Mirrors
 * `AgentSchema.id` in `src/common/types/cortex-config.ts`. Used by:
 *   - operator-input validation on `issue` / `revoke` / `rotate`
 *   - filesystem-input validation on `list` (Echo M1 cortex#64)
 */
const AGENT_ID_REGEX = /^[a-z0-9-]+$/;
const DEFAULT_CREDS_DIR = "~/.config/nats/creds";

/** Hardening cap on `readdirSync` entry count (Echo H1 nit cortex#64).
 *  A creds directory with thousands of entries is a misconfiguration; refuse
 *  to enumerate rather than allocate unbounded memory. */
const MAX_CREDS_DIR_ENTRIES = 10_000;

// =============================================================================
// parseCredsArgs
// =============================================================================

/**
 * Per-subcommand flag allowlist (Echo M3 on cortex#64). Parser rejects
 * flags that don't apply to the active subcommand — e.g.
 * `cortex creds issue echo --creds-dir /tmp` is now an error, not a silent
 * ignore.
 */
const SUBCOMMAND_FLAGS: Record<"list" | "issue" | "revoke" | "rotate", Set<string>> = {
  list: new Set(["--creds-dir", "--json", "--help", "-h"]),
  issue: new Set(["--config", "--json", "--help", "-h"]),
  revoke: new Set(["--config", "--json", "--help", "-h"]),
  rotate: new Set(["--config", "--json", "--help", "-h"]),
};

export function parseCredsArgs(argv: string[]): ParsedCredsArgs {
  const out: ParsedCredsArgs = {
    subcommand: "unknown",
    rawSubcommand: "",
    agentId: undefined,
    credsDir: undefined,
    config: undefined,
    json: false,
    help: false,
  };

  if (argv.length === 0) return out;

  // First pass: identify subcommand from the first positional (so we know
  // the flag allowlist before reading subsequent flags).
  const firstPositional = argv.find((a) => !a.startsWith("-"));
  if (firstPositional) {
    out.rawSubcommand = firstPositional;
    if (
      firstPositional === "list" ||
      firstPositional === "issue" ||
      firstPositional === "revoke" ||
      firstPositional === "rotate"
    ) {
      out.subcommand = firstPositional;
    }
  } else if (argv.includes("--help") || argv.includes("-h")) {
    out.subcommand = "help";
  }

  let i = 0;
  let positionalsSeen = 0;
  while (i < argv.length) {
    const arg = argv[i]!;

    if (arg === "--help" || arg === "-h") {
      if (out.subcommand !== "help") {
        out.help = true;
      }
      i++;
      continue;
    }
    if (arg === "--json") {
      assertFlagAllowed(out.subcommand, "--json");
      out.json = true;
      i++;
      continue;
    }
    if (arg === "--creds-dir") {
      assertFlagAllowed(out.subcommand, "--creds-dir");
      if (i + 1 >= argv.length || argv[i + 1]!.startsWith("-")) {
        throw new CliArgsError("creds", "--creds-dir requires a path argument");
      }
      out.credsDir = argv[i + 1];
      i += 2;
      continue;
    }
    if (arg === "--config") {
      assertFlagAllowed(out.subcommand, "--config");
      if (i + 1 >= argv.length || argv[i + 1]!.startsWith("-")) {
        throw new CliArgsError("creds", "--config requires a path argument");
      }
      out.config = argv[i + 1];
      i += 2;
      continue;
    }
    if (arg.startsWith("-")) {
      throw new CliArgsError("creds", `unknown flag: ${arg}`);
    }

    // Positionals
    positionalsSeen++;
    if (positionalsSeen === 1) {
      // Already captured above as rawSubcommand. No-op.
      i++;
      continue;
    }
    if (positionalsSeen === 2) {
      if (
        out.subcommand === "issue" ||
        out.subcommand === "revoke" ||
        out.subcommand === "rotate"
      ) {
        out.agentId = arg;
        i++;
        continue;
      }
      throw new CliArgsError("creds", `unexpected extra positional argument: "${arg}"`);
    }
    throw new CliArgsError("creds", `unexpected extra positional argument: "${arg}"`);
  }

  return out;
}

function assertFlagAllowed(
  subcommand: ParsedCredsArgs["subcommand"],
  flag: string,
): void {
  // Flags before a subcommand is determined are accepted (the subcommand
  // resolves at the end). Help is universal; --json is universal.
  if (subcommand === "unknown" || subcommand === "help") return;
  const allowed = SUBCOMMAND_FLAGS[subcommand];
  if (!allowed.has(flag)) {
    throw new CliArgsError(
      "creds",
      `flag ${flag} is not valid for subcommand "${subcommand}"`,
    );
  }
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
      return { exitCode: 0, stdout: renderJson(envelopeOk<CredsItem>([])), stderr: "" };
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

  // Echo H1 nit on cortex#64 — cap entry enumeration. A multi-thousand-entry
  // dir is a misconfiguration; bail rather than allocate unbounded memory.
  if (entries.length > MAX_CREDS_DIR_ENTRIES) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: `cortex creds list: refusing to enumerate ${dir} — ${entries.length} entries exceeds ${MAX_CREDS_DIR_ENTRIES} cap. Trim the directory or split by deployment.\n`,
    };
  }

  // Echo M1 on cortex#64 — id derivation now validates against the canonical
  // agent-id regex AND detects collisions. Filesystem input deserves the
  // same scrutiny as operator input on issue/revoke/rotate.
  const creds: CredsItem[] = [];
  const seenIds = new Map<string, string>();
  const skippedMalformed: string[] = [];
  const skippedColliding: { id: string; first: string; second: string }[] = [];

  for (const filename of entries) {
    const filePath = join(dir, filename);
    // Echo S1 nit on cortex#64 — lstatSync rejects symlinks. Creds files
    // are sensitive (NATS user JWT); refuse to read through a symlink that
    // could redirect to a file the operator didn't intend. Regular files
    // only.
    let mtime: Date;
    try {
      const stat = lstatSync(filePath);
      if (!stat.isFile()) continue;
      mtime = stat.mtime;
    } catch {
      continue;
    }

    // id = filename stem before the FIRST dot. Echo C2 cortex#64 — this is
    // intentional, not the same as "strip last extension." Rationale: a
    // canonical agent id matches `/^[a-z0-9-]+$/` (no dots). So
    //   `echo.creds`        → stem `echo`         (valid, accepted)
    //   `my.agent.creds`    → stem `my`           (likely a misnamed file;
    //                                              `my.agent` would fail the
    //                                              regex anyway, so picking
    //                                              the first segment matches
    //                                              the "trim ext + reject
    //                                              dots" behavior cleanly)
    //   `holly.nats.creds`  → stem `holly`        (the `.nats` middle is a
    //                                              non-canonical extension;
    //                                              first-dot stripping
    //                                              recovers the agent id)
    //   `Bad!Name.creds`    → stem `Bad!Name`     (fails regex; skipped with
    //                                              warning)
    // Using `path.basename(filename, ext)` (strip last ext) would yield
    // `my.agent` for `my.agent.creds`, which then fails the regex and is
    // skipped — same operator-visible outcome, just less informative warning.
    // First-dot stripping makes the warning name a recognizable agent-id
    // prefix.
    const id = filename.split(".")[0]!;
    if (!AGENT_ID_REGEX.test(id)) {
      skippedMalformed.push(filename);
      continue;
    }
    if (seenIds.has(id)) {
      skippedColliding.push({ id, first: seenIds.get(id)!, second: filename });
      continue;
    }
    seenIds.set(id, filename);
    creds.push({ id, path: filePath, issuedAt: mtime.toISOString() });
  }

  creds.sort((a, b) => a.id.localeCompare(b.id));

  // Surface malformed/colliding filenames as warnings on stderr. Echo M1
  // explicitly asked for collision visibility — silent collisions are how
  // operators end up debugging non-deterministic agent registration.
  let warnings = "";
  for (const f of skippedMalformed) {
    warnings += `cortex creds list: skipping "${f}" — filename stem doesn't match agent-id regex /^[a-z0-9-]+$/\n`;
  }
  for (const c of skippedColliding) {
    warnings += `cortex creds list: skipping "${c.second}" — id "${c.id}" already taken by "${c.first}"\n`;
  }

  if (args.json) {
    return { exitCode: 0, stdout: renderJson(envelopeOk(creds)), stderr: warnings };
  }

  if (creds.length === 0) {
    return {
      exitCode: 0,
      stdout: `0 creds files in ${dir}\n`,
      stderr: warnings,
    };
  }

  return {
    exitCode: 0,
    stdout: creds.map(formatCredsLine).join("\n") + "\n",
    stderr: warnings,
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

  // Validate the agent id at the CLI layer — surface operator input errors
  // before the deferred-stub message, even though v1 won't act.
  if (!args.agentId) {
    const reason = `missing agent id (usage: cortex creds ${subcommand} <agent-id>)`;
    if (args.json) {
      return {
        exitCode: 2,
        stdout: errorEnvelopeForSubcommand(reason, subcommand, args.agentId),
        stderr: "",
      };
    }
    return {
      exitCode: 2,
      stdout: "",
      stderr: `cortex creds ${subcommand}: ${reason}\n`,
    };
  }
  if (!AGENT_ID_REGEX.test(args.agentId)) {
    const reason = `agent id "${args.agentId}" is invalid — must match /^[a-z0-9-]+$/`;
    if (args.json) {
      return {
        exitCode: 2,
        stdout: errorEnvelopeForSubcommand(reason, subcommand, args.agentId),
        stderr: "",
      };
    }
    return {
      exitCode: 2,
      stdout: "",
      stderr: `cortex creds ${subcommand}: ${reason}\n`,
    };
  }

  if (args.json) {
    return {
      exitCode: 2,
      stdout: errorEnvelopeForSubcommand(DEFERRED_SUBCOMMAND_MESSAGE, subcommand, args.agentId),
      stderr: "",
    };
  }
  return {
    exitCode: 2,
    stdout: "",
    stderr: `cortex creds ${subcommand}: ${DEFERRED_SUBCOMMAND_MESSAGE}\n`,
  };
}

/** Build a creds-specific error envelope (uses shared `context` for
 *  subcommand-specific metadata, per Echo M2). */
function errorEnvelopeForSubcommand(
  reason: string,
  subcommand: string,
  agentId: string | undefined,
): string {
  const context: Record<string, string> = { subcommand };
  if (agentId) context.agentId = agentId;
  return renderJson(envelopeError<CredsItem>(reason, context));
}

// =============================================================================
// dispatchCreds
// =============================================================================

export function dispatchCreds(argv: string[]): ExitResult {
  let args: ParsedCredsArgs;
  try {
    args = parseCredsArgs(argv);
  } catch (err) {
    if (err instanceof CliArgsError) {
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
    default:
      // Echo n1 on cortex#64 — exhaustive guard via shared helper (A4 nit
      // round 2 cortex#64 moved it to _shared/ for F-5 reuse).
      return assertExhaustive(args.subcommand, "creds");
  }
}

// =============================================================================
// Output helpers
// =============================================================================

function formatCredsLine(c: CredsItem): string {
  return `${c.id.padEnd(20)} ${c.path}  issued ${c.issuedAt}`;
}

// =============================================================================
// Help text
// =============================================================================

function topLevelHelp(): string {
  return `cortex creds — manage per-agent NATS user credentials

Usage:
  cortex creds list   [--creds-dir <path>] [--json]
  cortex creds issue  <agent-id> [--config <path>] [--json]
  cortex creds revoke <agent-id> [--config <path>] [--json]
  cortex creds rotate <agent-id> [--config <path>] [--json]
  cortex creds --help

Subcommands:
  list     List existing creds files (v1: filesystem-only — fully functional)
  issue    Mint creds for an agent (v1: deferred — see cortex#60 §6.3)
  revoke   Revoke creds (v1: deferred)
  rotate   Revoke + issue atomically (v1: deferred)

Per-subcommand options:
  list:    --creds-dir <path>   Directory containing .creds files (default: ~/.config/nats/creds)
  issue:   --config <path>      cortex.yaml path (for v2 daemon contact)
  revoke:  --config <path>      same
  rotate:  --config <path>      same

Universal options:
  --json               Emit structured JSON envelope (shared shape via _shared/envelope.ts)
  --help, -h           Show help

Flag scoping: a flag passed to a subcommand that does not accept it is a usage
error (exit 2). E.g. \`cortex creds issue echo --creds-dir /tmp\` is rejected.

Exit codes:
  0    success
  1    operational failure
  2    usage error / deferred subcommand
`;
}

function listHelp(): string {
  return `cortex creds list — list local NATS creds files

Usage:
  cortex creds list [--creds-dir <path>] [--json]

Options:
  --creds-dir <path>   Default: ~/.config/nats/creds
  --json               Emit envelope { status, items: [{id, path, issuedAt}], error? }

Behavior:
  - Filenames whose stem doesn't match /^[a-z0-9-]+$/ are SKIPPED with a
    warning on stderr (Echo M1 on cortex#64).
  - Id collisions (two files yielding the same stem) are SKIPPED with a
    warning naming both files.
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
