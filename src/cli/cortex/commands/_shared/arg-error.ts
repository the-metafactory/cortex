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
