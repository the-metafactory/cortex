/**
 * Standard CLI exit-result shape across cortex subcommand handlers.
 * Returned by every `runSubcommand(args) → ExitResult` and consumed by
 * the dispatcher's `process.exit` glue.
 *
 * Extracted from `_shared/assert-exhaustive.ts` (cortex#65 — Echo round-2
 * ExitResult-duplication nit on cortex#64). The handler files (agents.ts,
 * creds.ts) used to redeclare this shape inline; now they import.
 */
export interface ExitResult {
  /**
   * Process exit code. Most subcommands use the classic 0 (success) / 1
   * (operational failure) / 2 (usage error) trichotomy. `cortex network ping`
   * (#56) additionally uses 3 (no-responder) / 4 (timeout) / 5 (refused) per
   * its verdict taxonomy (`docs/design-network-ping.md` §3.3), so this is a
   * plain `number` rather than the narrow `0 | 1 | 2` union.
   */
  exitCode: number;
  stdout: string;
  stderr: string;
}
