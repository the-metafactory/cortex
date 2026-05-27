/**
 * Shared presentation caps for dispatch.task terminal envelopes.
 *
 * The envelope constructors deliberately accept caller-provided strings:
 * each harness knows its substrate result shape. These helpers keep the
 * principal-facing lifecycle summaries consistent across harnesses.
 */

/**
 * Trim error messages so verbose stacks do not blow downstream worklog
 * limits. 500 chars matches the `system.inbound.failed` convention.
 */
export function truncateDispatchErrorSummary(msg: string): string {
  return msg.length > 500 ? msg.slice(0, 497) + "..." : msg;
}

/**
 * Trim result summaries to the first line. Surfaces typically render this
 * inline next to a task label, so cap at 1000 chars to leave room for chrome.
 */
export function truncateDispatchResultSummary(text: string): string {
  const first = text.split("\n", 1)[0] ?? text;
  return first.length > 1000 ? first.slice(0, 997) + "..." : first;
}
