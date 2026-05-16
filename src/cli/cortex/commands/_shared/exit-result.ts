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
  exitCode: 0 | 1 | 2;
  stdout: string;
  stderr: string;
}
