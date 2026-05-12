/**
 * Exhaustive-switch helper for cortex CLI dispatchers (Echo A4 nit on
 * cortex#64). The `never` parameter type catches missed switch cases at
 * compile time; the runtime branch surfaces a clear error if the type
 * assertion ever lapses (e.g. unsafe cast upstream).
 *
 * Reused across F-3 (`dispatchAgents`), F-4 (`dispatchCreds`), and any
 * future cortex CLI dispatcher.
 */
import type { ExitResult } from "./exit-result";

export function assertExhaustive(value: never, cliName: string): ExitResult {
  return {
    exitCode: 2,
    stdout: "",
    stderr: `cortex ${cliName}: internal error — unhandled subcommand "${String(value)}"\n`,
  };
}
