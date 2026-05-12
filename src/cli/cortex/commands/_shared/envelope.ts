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
 *   items: T[];                                 // always present (empty on error)
 *   data?: Record<string, string>;              // success-side structured metadata
 *   error?: { reason: string; context?: Record<string, string> };
 * }
 * ```
 *
 * Success-side `data` (cortex#79): carries arc-supplied fields (creds_path,
 * pub key, account) without abusing the `error.context` channel. Empty
 * (and unset) for subcommands that have no per-success metadata, e.g.
 * F-3 agents list. The optional `error.context` map carries
 * subcommand-specific metadata on the failure path.
 */
export interface CliJsonEnvelope<T> {
  status: "ok" | "error";
  /** Per-subcommand payload. Always present — empty array on error. */
  items: T[];
  /** Success-side structured metadata. Mirrors `error.context` shape. */
  data?: Record<string, string>;
  error?: {
    reason: string;
    /** Subcommand-specific structured context (file path, agent id, etc.). */
    context?: Record<string, string>;
  };
}

/** Build the success envelope. `data` is optional structured metadata
 *  (e.g. arc-supplied creds_path on `cortex creds issue`). */
export function envelopeOk<T>(
  items: T[],
  data?: Record<string, string>,
): CliJsonEnvelope<T> {
  return data ? { status: "ok", items, data } : { status: "ok", items };
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
