/**
 * Shared parser-failure error class for `cortex` CLI subcommands.
 * Each subcommand parser throws this on bad flags / missing values /
 * extra positionals. Dispatchers catch + map to exit 2.
 *
 * Extracted by F-4 (Echo M4 on cortex#64) to consolidate three
 * structurally-identical *ArgsError classes across migrate-config.ts,
 * agents.ts (F-3), and creds.ts (F-4).
 */
export class CliArgsError extends Error {
  /** Name of the subcommand whose parser raised the error (e.g. "agents", "creds"). */
  public readonly cliName: string;

  constructor(cliName: string, message: string) {
    super(message);
    this.name = "CliArgsError";
    this.cliName = cliName;
  }
}

/**
 * Specific subclass for the "missing required positional argument" case.
 * Callers that want to handle missing-positional specifically (e.g.
 * `parseCredsArgs` translates it into a degenerate args object so the
 * deferred-subcommand handler emits a friendly envelope) can `instanceof`
 * check this class instead of regex-matching the error message.
 *
 * Echo cortex#66 round-1 M1 — was previously caught by regex on the
 * message string, which coupled the caller to internal phrasing.
 */
export class MissingPositionalError extends CliArgsError {
  /** Name of the missing positional (e.g. "agent-id"). */
  public readonly positionalName: string;
  /**
   * The resolved `rawSubcommand` at the throw site — the first true
   * positional captured by the parser, with flag-value pairs skipped.
   * Callers reconstruct a degenerate args object without re-scanning
   * argv (Echo cortex#66 round-1 fix — previous catch used a naive
   * `argv.find(!startsWith("-"))` that returned flag values like
   * `/tmp` for `["--config", "/tmp", "issue"]`).
   */
  public readonly rawSubcommand: string;

  constructor(cliName: string, positionalName: string, rawSubcommand: string) {
    super(cliName, `missing required positional argument: <${positionalName}>`);
    this.name = "MissingPositionalError";
    this.positionalName = positionalName;
    this.rawSubcommand = rawSubcommand;
  }
}

/**
 * Specific subclass for unknown / disallowed flag cases. Restored to
 * match the pre-cortex#66 message wording ("unknown flag: X") for both
 * the universally-unknown case AND the per-subcommand-not-allowed case.
 *
 * Echo cortex#66 round-1 M3 — operator-visible error wording changed
 * between F-3/F-4 legacy parser ("unknown flag: --verbose") and the
 * generic parser ("flag --verbose is not valid for subcommand 'list'").
 * The behavior is the same (both reject the flag at exit 2); only the
 * wording differs. Standardize on the legacy wording for muscle memory.
 */
export class UnknownFlagError extends CliArgsError {
  /** The offending flag, e.g. "--verbose". */
  public readonly flag: string;

  constructor(cliName: string, flag: string) {
    super(cliName, `unknown flag: ${flag}`);
    this.name = "UnknownFlagError";
    this.flag = flag;
  }
}
