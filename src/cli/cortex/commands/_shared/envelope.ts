/**
 * Shared JSON envelope contract for `cortex` CLI subcommands.
 * Extracted by F-4 (Echo M2 + M4 on cortex#64) so F-3 (`agents`) and F-4
 * (`creds`) emit structurally consistent JSON. Scripting consumers can
 * pin against `CliJsonEnvelope<T>` regardless of subcommand.
 *
 * **Shape:**
 *
 * ```ts
 * interface CliJsonEnvelope<T> {
 *   status: "ok" | "error";
 *   items: T[];                       // always present (empty on error)
 *   error?: { reason: string; context?: Record<string, string> };
 * }
 * ```
 *
 * The optional `context` map carries subcommand-specific metadata (file path,
 * agent id, fragment name, etc.) without forcing every CLI into a
 * subcommand-specific error shape. F-3 retrofit deferred to a follow-up PR
 * — this PR introduces the shared contract and uses it from F-4.
 */
export interface CliJsonEnvelope<T> {
  status: "ok" | "error";
  /** Per-subcommand payload. Always present — empty array on error. */
  items: T[];
  error?: {
    reason: string;
    /** Subcommand-specific structured context (file path, agent id, etc.). */
    context?: Record<string, string>;
  };
}

/** Build the success envelope. */
export function envelopeOk<T>(items: T[]): CliJsonEnvelope<T> {
  return { status: "ok", items };
}

/** Build the error envelope. `context` is optional structured metadata. */
export function envelopeError<T>(
  reason: string,
  context?: Record<string, string>,
): CliJsonEnvelope<T> {
  return {
    status: "error",
    items: [],
    ...(context ? { error: { reason, context } } : { error: { reason } }),
  };
}

/** Serialize to JSON string with trailing newline (CLI convention). */
export function renderJson<T>(envelope: CliJsonEnvelope<T>): string {
  return JSON.stringify(envelope, null, 2) + "\n";
}
