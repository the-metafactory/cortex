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
import {
  CliArgsError,
  MissingPositionalError,
  UnknownFlagError,
} from "./arg-error";

// =============================================================================
// Spec types
// =============================================================================

/**
 * - `value`     — consumes the next argv entry; last-wins on repeat.
 * - `bool`      — no value; presence = `true`.
 * - `value-list` — consumes the next argv entry; REPEATABLE, each
 *                 occurrence accumulates into a `string[]` (cortex#1057).
 */
export type FlagKind = "value" | "bool" | "value-list";

/**
 * Canonical type of the `flags` map produced by `parseSubcommandArgs`.
 * `value` flags hold a string, `bool` flags hold `true`, `value-list`
 * flags hold a `string[]` (cortex#1057). Callers that pass the flags map
 * around should reference this alias rather than re-spelling the union,
 * so the shape stays in one place.
 */
export type FlagMap = Record<string, string | true | string[]>;

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
   *  `true` when present; value-list flags hold a `string[]` accumulating
   *  every occurrence. Absent keys = flag not provided. */
  flags: FlagMap;
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
      ? spec.subcommands[out.subcommand]
      : undefined;

  // Second pass: walk argv, accumulating flags + positionals.
  let positionalIdx = -1; // -1 = subcommand slot, 0+ = subcommand's positionals
  let i = 0;
  while (i < argv.length) {
    const arg = argv[i] ?? "";

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
      if (kind === "value" || kind === "value-list") {
        const next = argv[i + 1];
        if (next === undefined || next.startsWith("-")) {
          throw new CliArgsError(spec.cliName, `${arg} requires a value argument`);
        }
        if (kind === "value-list") {
          // Accumulate; each occurrence appends. Existing value is always a
          // string[] for a value-list flag (or absent on the first hit).
          const existing = out.flags[arg];
          const list = Array.isArray(existing) ? existing : [];
          list.push(next);
          out.flags[arg] = list;
        } else {
          out.flags[arg] = next;
        }
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
    out.positionals[declared[nameIdx] ?? ""] = arg;
    i++;
  }

  // Required-positionals check: every declared positional must be present.
  // Skip for help / unknown subcommands — caller renders usage.
  if (activeRule) {
    for (const name of activeRule.positionals ?? []) {
      if (!(name in out.positionals)) {
        // Pass `out.rawSubcommand` so callers don't have to re-scan argv
        // (Echo cortex#66 round-1 warning — naive re-scan dropped flag-
        // value pairs and returned wrong rawSubcommand).
        throw new MissingPositionalError(spec.cliName, name, out.rawSubcommand);
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
    const arg = argv[i] ?? "";
    if (!arg.startsWith("-")) return arg;
    const kind = lookupFlagKindAcrossSpec(spec, arg);
    if (kind === "value" || kind === "value-list") {
      i += 2;
    } else {
      // bool or unknown — single token consume
      i += 1;
    }
  }
  return undefined;
}

/**
 * Per-spec flag-kind map, memoized via WeakMap. Echo cortex#66 round-1
 * perf suggestion — `lookupFlagKindAcrossSpec` was recomputing the
 * merged map (and re-validating the same-kind invariant) on every flag
 * access. Now we build the map once on first lookup per spec object;
 * subsequent lookups are O(1) and the invariant becomes a one-time
 * validation at first parse.
 */
const FLAG_KIND_CACHE = new WeakMap<object, Map<string, FlagKind>>();

function buildFlagKindMap<S extends string>(
  spec: SubcommandSpec<S>,
): Map<string, FlagKind> {
  const map = new Map<string, FlagKind>();
  for (const [flag, kind] of Object.entries(spec.universal)) {
    map.set(flag, kind);
  }
  // `Object.values<S>(spec.subcommands)` returns `unknown[]` when the
  // generic key type is unconstrained-string; the cast is load-bearing
  // for downstream `rule.flags` access. ESLint disagrees (the type-aware
  // checker sees `SubcommandRule[]` already), but tsc requires it.
  // Confirmed during sweep #1: blanket auto-fix removed this and broke tsc.
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
  const rules = Object.values(spec.subcommands) as SubcommandRule[];
  for (const rule of rules) {
    if (!rule.flags) continue;
    for (const [flag, kind] of Object.entries(rule.flags)) {
      const existing = map.get(flag);
      if (existing !== undefined && existing !== kind) {
        throw new CliArgsError(
          spec.cliName,
          `spec invariant violated: flag "${flag}" declared with conflicting kinds (${existing} vs ${kind}) across subcommands`,
        );
      }
      map.set(flag, kind);
    }
  }
  return map;
}

/**
 * Look up a flag's kind across the entire spec (universal + every
 * subcommand's allowlist). Returns undefined if the flag isn't declared
 * anywhere — the strict second pass will throw with a clear error.
 *
 * Invariant: a given flag has the same kind (value vs bool) across all
 * subcommands that accept it. Validated once per spec at first lookup
 * (Echo cortex#66 round-1 N5 + perf-suggestion).
 */
function lookupFlagKindAcrossSpec<S extends string>(
  spec: SubcommandSpec<S>,
  flag: string,
): FlagKind | undefined {
  let map = FLAG_KIND_CACHE.get(spec);
  if (!map) {
    map = buildFlagKindMap(spec);
    FLAG_KIND_CACHE.set(spec, map);
  }
  return map.get(flag);
}

function resolveFlagKind<S extends string>(
  spec: SubcommandSpec<S>,
  activeRule: SubcommandRule | undefined,
  _subcommand: ParsedSubcommandArgs<S>["subcommand"],
  flag: string,
): FlagKind {
  // Echo cortex#66 round-2 security warning — bare `in` traversed the
  // prototype chain, so `--toString` / `--__proto__` / `--constructor`
  // would resolve to `Object.prototype.toString` etc. instead of
  // throwing UnknownFlagError. Use `Object.prototype.hasOwnProperty.call`
  // for both lookups so only declared flags are accepted. The
  // cached `lookupFlagKindAcrossSpec` is already prototype-safe via
  // `Map.get`; this function preserves its own subcommand-scoping
  // logic but with the same defense.
  if (Object.prototype.hasOwnProperty.call(spec.universal, flag)) {
    const kind = spec.universal[flag];
    if (kind !== undefined) return kind;
  }
  if (
    activeRule?.flags &&
    Object.prototype.hasOwnProperty.call(activeRule.flags, flag)
  ) {
    const kind = activeRule.flags[flag];
    if (kind !== undefined) return kind;
  }
  // Echo cortex#66 round-1 M3 — restore the legacy "unknown flag: X"
  // wording across both code paths (subcommand-known-but-flag-disallowed
  // AND no-subcommand-and-unknown-flag). The legacy parsers in F-3/F-4
  // both said "unknown flag: X" in either case; the original cortex#66
  // implementation surfaced two different messages, which changed
  // principal-visible output as a side effect of the refactor.
  throw new UnknownFlagError(spec.cliName, flag);
}
