/**
 * Generic subcommand-argument parser for cortex CLI commands.
 *
 * Closes cortex#66 — F-2/F-3/F-4 had three structurally-identical
 * hand-rolled parsers. Each declared its own subcommand enum, its own
 * flag table, its own positional handling, its own error mapping. This
 * helper consolidates the pattern: a CLI declares its grammar via
 * `SubcommandSpec`, the helper does the parsing, the CLI's
 * `runSubcommand(args)` consumes a structurally consistent
 * `ParsedSubcommandArgs<S>`.
 *
 * Design rules (chosen for cortex's actual usage, not full POSIX):
 *
 * - Flags are either `value` (consume the next argv entry) or `bool`
 *   (no value, presence = true).
 * - Universal flags apply to every subcommand AND the no-subcommand /
 *   help / unknown states. Per-subcommand flags apply only when that
 *   subcommand is active.
 * - Positionals are ordered, named, and all currently required.
 *   (An optional-positional kind can be added when a real case arises.)
 * - First positional is always the subcommand selector. If it doesn't
 *   match any declared subcommand, `subcommand` is `"unknown"` and
 *   `rawSubcommand` carries the value — caller decides whether that's
 *   an error or e.g. a help-dispatch trigger.
 * - `--help` / `-h` AT THE START becomes `subcommand: "help"`. Anywhere
 *   AFTER the subcommand it sets `help: true` on the args — caller
 *   surfaces subcommand-specific help.
 *
 * Throws `CliArgsError` (from `./arg-error.ts`) on:
 *
 * - `--flag` requires a value but the next argv is missing / another flag
 * - Unknown flag (not in universal + active subcommand's allowlist)
 * - Flag passed to subcommand that doesn't accept it
 * - Extra positional beyond what the subcommand declares
 * - Missing required positional after the subcommand name
 *
 * Does NOT validate positional values (e.g. agent id regex). Callers do
 * domain validation after parsing.
 */
import { CliArgsError } from "./arg-error";

// =============================================================================
// Spec types
// =============================================================================

export type FlagKind = "value" | "bool";

export interface SubcommandSpec<SubcommandName extends string> {
  /** CLI name passed into `CliArgsError` for diagnostics ("agents", "creds"). */
  cliName: string;
  /** Per-subcommand grammar. */
  subcommands: Record<SubcommandName, SubcommandRule>;
  /** Flags valid regardless of which subcommand (or even no subcommand). */
  universal: Record<string, FlagKind>;
}

export interface SubcommandRule {
  /** Ordered list of named required positionals AFTER the subcommand name. */
  positionals?: string[];
  /** Per-subcommand flag allowlist (in addition to universal flags). */
  flags?: Record<string, FlagKind>;
}

// =============================================================================
// Parse result
// =============================================================================

export interface ParsedSubcommandArgs<SubcommandName extends string> {
  /** Active subcommand, or `"help"` / `"unknown"`. */
  subcommand: SubcommandName | "help" | "unknown";
  /** Raw first-positional verbatim. Empty string if none was given. */
  rawSubcommand: string;
  /** Positionals captured by name — keys are the subcommand's declared
   *  positional names. Absent keys = positional not provided. */
  positionals: Record<string, string>;
  /** Flag values. Value-flags hold the captured string; bool-flags hold
   *  `true` when present. Absent keys = flag not provided. */
  flags: Record<string, string | true>;
  /** `true` if a `--help`/`-h` was seen AFTER the subcommand name. */
  help: boolean;
}

// =============================================================================
// parseSubcommandArgs
// =============================================================================

export function parseSubcommandArgs<S extends string>(
  spec: SubcommandSpec<S>,
  argv: string[],
): ParsedSubcommandArgs<S> {
  const out: ParsedSubcommandArgs<S> = {
    subcommand: "unknown",
    rawSubcommand: "",
    positionals: {},
    flags: {},
    help: false,
  };

  if (argv.length === 0) return out;

  // First pass: identify the subcommand so flag-allowlist checks know
  // which rule applies. Walks argv skipping flag-value pairs so that e.g.
  // `--creds-dir /tmp list` correctly identifies `list` (not `/tmp`).
  const firstPositional = findFirstPositional(spec, argv);

  if (firstPositional) {
    out.rawSubcommand = firstPositional;
    if (Object.prototype.hasOwnProperty.call(spec.subcommands, firstPositional)) {
      out.subcommand = firstPositional as S;
    }
  } else {
    // No positional at all. If --help/-h is in argv, this is `help`. Else
    // stays `unknown` (no subcommand, no help — caller renders error).
    if (argv.includes("--help") || argv.includes("-h")) {
      out.subcommand = "help";
    }
  }

  const activeRule: SubcommandRule | undefined =
    out.subcommand !== "unknown" && out.subcommand !== "help"
      ? spec.subcommands[out.subcommand as S]
      : undefined;

  // Second pass: walk argv, accumulating flags + positionals.
  let positionalIdx = -1; // -1 = subcommand slot, 0+ = subcommand's positionals
  let i = 0;
  while (i < argv.length) {
    const arg = argv[i]!;

    if (arg === "--help" || arg === "-h") {
      if (positionalIdx === -1 && out.rawSubcommand === "") {
        out.subcommand = "help";
      } else {
        out.help = true;
      }
      i++;
      continue;
    }

    if (arg.startsWith("-")) {
      const kind = resolveFlagKind(spec, activeRule, out.subcommand, arg);
      if (kind === "value") {
        if (i + 1 >= argv.length || argv[i + 1]!.startsWith("-")) {
          throw new CliArgsError(spec.cliName, `${arg} requires a value argument`);
        }
        out.flags[arg] = argv[i + 1]!;
        i += 2;
      } else {
        out.flags[arg] = true;
        i++;
      }
      continue;
    }

    // Positional
    positionalIdx++;
    if (positionalIdx === 0) {
      // The subcommand slot — already captured in `rawSubcommand` first
      // pass. Consume and move on.
      i++;
      continue;
    }

    // Subcommand-defined positional at index `positionalIdx - 1`.
    if (!activeRule) {
      throw new CliArgsError(
        spec.cliName,
        `unexpected extra positional argument: "${arg}"`,
      );
    }
    const declared = activeRule.positionals ?? [];
    const nameIdx = positionalIdx - 1;
    if (nameIdx >= declared.length) {
      throw new CliArgsError(
        spec.cliName,
        `unexpected extra positional argument: "${arg}"`,
      );
    }
    out.positionals[declared[nameIdx]!] = arg;
    i++;
  }

  // Required-positionals check: every declared positional must be present.
  // Skip for help / unknown subcommands — caller renders usage.
  if (activeRule) {
    for (const name of activeRule.positionals ?? []) {
      if (!(name in out.positionals)) {
        throw new CliArgsError(
          spec.cliName,
          `missing required positional argument: <${name}>`,
        );
      }
    }
  }

  return out;
}

// =============================================================================
// Internal
// =============================================================================

/**
 * Walk argv skipping flag-value pairs to find the first true positional —
 * the subcommand selector. Uses the spec to know which flags consume a
 * following value. Unknown flags (not in any allowlist) are treated as
 * single-token to keep the heuristic conservative; the strict second pass
 * will surface a clear error.
 */
function findFirstPositional<S extends string>(
  spec: SubcommandSpec<S>,
  argv: string[],
): string | undefined {
  let i = 0;
  while (i < argv.length) {
    const arg = argv[i]!;
    if (!arg.startsWith("-")) return arg;
    const kind = lookupFlagKindAcrossSpec(spec, arg);
    if (kind === "value") {
      i += 2;
    } else {
      // bool or unknown — single token consume
      i += 1;
    }
  }
  return undefined;
}

/**
 * Look up a flag's kind across the entire spec (universal + every
 * subcommand's allowlist). Returns undefined if the flag isn't declared
 * anywhere — the strict second pass will throw with a clear error.
 *
 * Assumes: a given flag has the same kind (value vs bool) across all
 * subcommands that accept it. cortex's CLIs follow this convention; if
 * a future CLI breaks it, refactor to require explicit kind-per-subcommand.
 */
function lookupFlagKindAcrossSpec<S extends string>(
  spec: SubcommandSpec<S>,
  flag: string,
): FlagKind | undefined {
  if (flag in spec.universal) return spec.universal[flag];
  for (const rule of Object.values(spec.subcommands) as SubcommandRule[]) {
    if (rule.flags && flag in rule.flags) return rule.flags[flag]!;
  }
  return undefined;
}

function resolveFlagKind<S extends string>(
  spec: SubcommandSpec<S>,
  activeRule: SubcommandRule | undefined,
  subcommand: ParsedSubcommandArgs<S>["subcommand"],
  flag: string,
): FlagKind {
  // Universal flags first.
  if (flag in spec.universal) {
    return spec.universal[flag]!;
  }
  if (activeRule?.flags && flag in activeRule.flags) {
    return activeRule.flags[flag]!;
  }
  // Subcommand-active but flag not in its allowlist.
  if (activeRule) {
    throw new CliArgsError(
      spec.cliName,
      `flag ${flag} is not valid for subcommand "${subcommand as string}"`,
    );
  }
  // No active subcommand — the flag is universally unrecognized.
  throw new CliArgsError(spec.cliName, `unknown flag: ${flag}`);
}
