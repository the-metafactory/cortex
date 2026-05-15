/**
 * Standard CLI exit-result shape across cortex subcommand handlers.
 * Returned by every `runSubcommand(args) → ExitResult` and consumed by
 * the dispatcher's `process.exit` glue.
 *
 * Extracted from `_shared/assert-exhaustive.ts` (cortex#65 — Echo round-2
 * ExitResult-duplication nit on cortex#64). The handler files (agents.ts,
 * creds.ts) used to redeclare this shape inline; now they import.
 *
 * **Exit-code vocabulary:**
 *   - `0` — success
 *   - `1` — runtime error
 *   - `2` — usage error (bad flags / missing args / unknown subcommand)
 *   - `124` — timeout (matches `timeout(1)`; reserved for commands that
 *     wait on external events, e.g. `cortex wait-for-review` cortex#232).
 *     Shell pipelines can branch on `$? -eq 124` to distinguish a clean
 *     "no event yet" from a runtime failure.
 */
export interface ExitResult {
  exitCode: 0 | 1 | 2 | 124;
  stdout: string;
  stderr: string;
}
