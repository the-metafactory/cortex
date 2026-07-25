#!/usr/bin/env bun
/**
 * `cortex github-token <subcommand>` — mint GitHub App installation tokens
 * for cortex-hosted bot identities (cortex#2396, vision#11).
 *
 * Same shape as `cortex creds` (per-identity credential lifecycle) but for
 * GitHub App installation tokens instead of NATS user creds — `mint`
 * prints the short-lived token to stdout for command-substitution capture
 * (`GH_TOKEN=$(cortex github-token mint atlas)`), mirroring how a caller
 * would consume any other short-lived credential-minting CLI.
 *
 * Usage:
 *   bun src/cli/cortex/commands/github-token.ts mint <identity> [--config <path>] [--json]
 *   bun src/cli/cortex/commands/github-token.ts list [--config <path>] [--json]
 *   bun src/cli/cortex/commands/github-token.ts --help
 *
 * Exit codes:
 *   0  — success
 *   1  — mint failure (unknown identity, bad key permissions, GitHub API error)
 *   2  — usage error (bad flag, missing positional)
 */

import {
  DEFAULT_GITHUB_APP_IDENTITIES_PATH,
  GithubAppTokenError,
  loadGithubAppIdentities,
  mintTokenForIdentity,
} from "../../../common/auth/github-app-token";
import { CliArgsError, MissingPositionalError } from "./_shared/arg-error";
import { envelopeError, envelopeOk, renderJson } from "./_shared/envelope";
import { assertExhaustive } from "./_shared/assert-exhaustive";
import { type ExitResult } from "./_shared/exit-result";
import { parseSubcommandArgs, type SubcommandSpec } from "./_shared/parser";
import { boolFlag, valueFlag } from "./_shared/hydrate";

// =============================================================================
// Types
// =============================================================================

export interface ParsedGithubTokenArgs {
  subcommand: "mint" | "list" | "help" | "unknown";
  rawSubcommand: string;
  identity: string | undefined;
  config: string | undefined;
  json: boolean;
  help: boolean;
}

export { type ExitResult } from "./_shared/exit-result";

interface IdentityListItem {
  name: string;
  appId: string;
  installationId: string;
}

// =============================================================================
// Test-only fetch override — keeps `mint` tests hermetic (no real GitHub
// API call), same shape as creds.ts's `__setArcRunnerForTests`.
// =============================================================================

let fetchOverride: typeof fetch | null = null;

/** Test-only setter. Production callers never touch this. Passing `null`
 *  restores the real global `fetch`. */
export function __setFetchForTests(impl: typeof fetch | null): void {
  fetchOverride = impl;
}

// =============================================================================
// parseGithubTokenArgs
// =============================================================================

const GITHUB_TOKEN_SPEC: SubcommandSpec<"mint" | "list"> = {
  cliName: "github-token",
  subcommands: {
    mint: { positionals: ["identity"], flags: { "--config": "value" } },
    list: { flags: { "--config": "value" } },
  },
  universal: { "--help": "bool", "-h": "bool", "--json": "bool" },
};

export function parseGithubTokenArgs(argv: string[]): ParsedGithubTokenArgs {
  let parsed;
  try {
    parsed = parseSubcommandArgs(GITHUB_TOKEN_SPEC, argv);
  } catch (err) {
    if (err instanceof MissingPositionalError) {
      const sub = err.rawSubcommand;
      const known = sub === "mint" || sub === "list" ? sub : "unknown";
      return {
        subcommand: known,
        rawSubcommand: sub,
        identity: undefined,
        config: undefined,
        json: false,
        help: false,
      };
    }
    throw err;
  }

  return {
    subcommand: parsed.subcommand,
    rawSubcommand: parsed.rawSubcommand,
    identity: parsed.positionals.identity,
    config: valueFlag(parsed.flags, "--config"),
    json: boolFlag(parsed.flags, "--json"),
    help: parsed.help,
  };
}

// =============================================================================
// runGithubTokenMint
// =============================================================================

export async function runGithubTokenMint(args: ParsedGithubTokenArgs): Promise<ExitResult> {
  if (args.help) {
    return { exitCode: 0, stdout: mintHelp(), stderr: "" };
  }
  const identity = args.identity ?? "";

  let result;
  try {
    result = await mintTokenForIdentity(identity, {
      configPath: args.config,
      fetchImpl: fetchOverride ?? undefined,
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    const context = err instanceof GithubAppTokenError ? err.context : undefined;
    if (args.json) {
      return {
        exitCode: 1,
        stdout: renderJson(envelopeError(reason, context)),
        stderr: "",
      };
    }
    return { exitCode: 1, stdout: "", stderr: `cortex github-token mint: ${reason}\n` };
  }

  if (args.json) {
    return {
      exitCode: 0,
      stdout: renderJson(
        envelopeOk([{ identity, token: result.token, expiresAt: result.expiresAt }]),
      ),
      stderr: "",
    };
  }
  // Bare token on stdout — the intended consumption is command substitution
  // (`GH_TOKEN=$(cortex github-token mint atlas)`). Diagnostics go to
  // stderr so they never end up inside the captured env var.
  return {
    exitCode: 0,
    stdout: `${result.token}\n`,
    stderr: `cortex github-token mint: "${identity}" expires ${result.expiresAt}\n`,
  };
}

// =============================================================================
// runGithubTokenList — configured identity names only, no secrets
// =============================================================================

export function runGithubTokenList(args: ParsedGithubTokenArgs): ExitResult {
  if (args.help) {
    return { exitCode: 0, stdout: listHelp(), stderr: "" };
  }

  let identities: Record<string, { appId: string; installationId: string; keyPath: string }>;
  try {
    identities = loadGithubAppIdentities(args.config);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    const context = err instanceof GithubAppTokenError ? err.context : undefined;
    if (args.json) {
      return { exitCode: 1, stdout: renderJson(envelopeError(reason, context)), stderr: "" };
    }
    return { exitCode: 1, stdout: "", stderr: `cortex github-token list: ${reason}\n` };
  }

  const items: IdentityListItem[] = Object.entries(identities)
    .map(([name, cfg]) => ({ name, appId: cfg.appId, installationId: cfg.installationId }))
    .sort((a, b) => a.name.localeCompare(b.name));

  if (args.json) {
    return { exitCode: 0, stdout: renderJson(envelopeOk(items)), stderr: "" };
  }
  if (items.length === 0) {
    return {
      exitCode: 0,
      stdout: `0 GitHub App identities configured (${args.config ?? DEFAULT_GITHUB_APP_IDENTITIES_PATH})\n`,
      stderr: "",
    };
  }
  return {
    exitCode: 0,
    stdout:
      items.map((i) => `${i.name}\tapp=${i.appId}\tinstallation=${i.installationId}`).join("\n") +
      "\n",
    stderr: "",
  };
}

// =============================================================================
// dispatchGithubToken
// =============================================================================

export async function dispatchGithubToken(argv: string[]): Promise<ExitResult> {
  let args: ParsedGithubTokenArgs;
  try {
    args = parseGithubTokenArgs(argv);
  } catch (err) {
    if (err instanceof CliArgsError) {
      return {
        exitCode: 2,
        stdout: "",
        stderr: `cortex github-token: ${err.message}\n${topLevelHelp()}`,
      };
    }
    throw err;
  }

  switch (args.subcommand) {
    case "mint":
      return await runGithubTokenMint(args);
    case "list":
      return runGithubTokenList(args);
    case "help":
      return { exitCode: 0, stdout: topLevelHelp(), stderr: "" };
    case "unknown":
      if (args.rawSubcommand === "") {
        return {
          exitCode: 2,
          stdout: "",
          stderr: `cortex github-token: usage error — no subcommand specified.\n${topLevelHelp()}`,
        };
      }
      return {
        exitCode: 2,
        stdout: "",
        stderr: `cortex github-token: unknown subcommand "${args.rawSubcommand}".\n${topLevelHelp()}`,
      };
    default:
      return assertExhaustive(args.subcommand, "github-token");
  }
}

// =============================================================================
// Help text
// =============================================================================

function topLevelHelp(): string {
  return `cortex github-token — mint GitHub App installation tokens for cortex-hosted bot identities

Usage:
  cortex github-token mint <identity> [--config <path>] [--json]
  cortex github-token list [--config <path>] [--json]

Identities are configured in ${DEFAULT_GITHUB_APP_IDENTITIES_PATH} (or --config),
mapping a name (e.g. "atlas", "luna-dev") to { appId, installationId, keyPath }.
Never committed to a repo. keyPath must be chmod 600.
`;
}

function mintHelp(): string {
  return `cortex github-token mint <identity> — mint a short-lived (~1hr) installation access token

Usage:
  cortex github-token mint <identity> [--config <path>] [--json]

Behavior:
  - Signs a 10min App JWT (RS256) with the identity's configured private key.
  - Exchanges it for a GitHub App installation access token.
  - Prints the bare token to stdout (diagnostics on stderr) — intended for
    command substitution: GH_TOKEN=$(cortex github-token mint atlas)

Exit codes:
  0    minted successfully
  1    unknown identity / key not chmod 600 / GitHub API error
  2    missing <identity> / bad flag
`;
}

function listHelp(): string {
  return `cortex github-token list — list configured identity names (no secrets)

Usage:
  cortex github-token list [--config <path>] [--json]
`;
}

// =============================================================================
// Main
// =============================================================================

if (import.meta.main) {
  const result = await dispatchGithubToken(process.argv.slice(2));
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exit(result.exitCode);
}
