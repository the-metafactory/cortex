/**
 * CK-8 (docs/plan-mc-future-state.md §4.A) — resolve a WORKING row's
 * task → signal-trace deep link, honoring the ADR-0005 local-origin boundary.
 *
 * The signal sideband proxy (`src/common/sideband/proxy.ts`) is
 * LOOPBACK-ENFORCED and LOCAL-STACK-ONLY: it forwards
 * `/api/observability/traces/{trace_id}/timeline` to `127.0.0.1:9092` on THIS
 * daemon. A federated PEER's trace lives on the PEER's daemon and is
 * unreachable through this loopback proxy — so the deep link is scoped to
 * LOCAL-origin rows, and a cross-stack row (CK-4a aggregation) gets an HONEST
 * degrade ("trace lives on ⟨stack⟩ — open its MC"), never a dead or fabricated
 * link (truth-not-theater; ADR-0005 — a peer has no resolvable trace here).
 *
 * `trace_id ≡ correlation_id` (W3C). A dispatch-anchored WORKING tile carries
 * its correlation_id INSIDE its task id: the dispatch-lifecycle projection mints
 * the anchor task as `mc-dispatch-task-{correlation_id}`
 * (`projection/anchor.ts` → `ANCHOR_TASK_PREFIX`). So the correlation_id is
 * derived by stripping that prefix — no schema/DTO change, which is exactly the
 * render-layer affordance this slice scopes to. A NON-anchored task (a
 * `local.observed` orphan, a legacy row) has no derivable trace id → honest
 * ABSENCE (no affordance): there is no correlatable trace, and we never
 * fabricate one.
 *
 * Pure — no fetch, no DOM. The `SidebandError` degrade + `deep_link` exit + the
 * signal-dark honest-absence line all live DOWNSTREAM in `SidebandSource`, which
 * this deep link opens; this module only decides WHICH of the three states a row
 * is in.
 */

import type { AgentOrigin } from "../../api/agents";

/**
 * Browser-safe mirror of `projection/anchor.ts` → `ANCHOR_TASK_PREFIX`. It is
 * duplicated (not imported) DELIBERATELY: `anchor.ts` value-imports `db/work-items`
 * which pulls `bun:sqlite` — server-only code that must never enter the dashboard
 * bundle. `working-trace-deeplink.parity.test.ts` asserts this constant equals the
 * server constant so the two can never silently drift.
 */
export const DISPATCH_ANCHOR_TASK_PREFIX = "mc-dispatch-task-";

export interface TraceDeepLinkInput {
  /** The WORKING tile's primary-assignment task id. */
  taskId: string;
  /** The tile's origin — `"local"` or a foreign `{principal, stack}`. Absent ⇒ local. */
  origin: AgentOrigin | undefined;
}

export type TraceDeepLink =
  /** Local origin + a derivable trace id: open the sideband timeline drill. */
  | { kind: "local"; traceId: string; timelineHref: string }
  /** Foreign origin: the trace lives on the peer's daemon — honest degrade. */
  | { kind: "cross-stack"; stackLabel: string }
  /** Local origin but no correlatable trace id — honest absence (no affordance). */
  | { kind: "none" };

/** Same-origin path MC proxies (server-side) to the loopback sideband. */
export function traceTimelineHref(traceId: string): string {
  return `/api/observability/traces/${encodeURIComponent(traceId)}/timeline`;
}

/** `{principal}/{stack}` — the peer identity shown in the honest degrade line. */
export function crossStackLabel(origin: { principal: string; stack: string }): string {
  return `${origin.principal}/${origin.stack}`;
}

/**
 * Decide a WORKING row's trace-deep-link state. Foreign origin is checked FIRST:
 * a peer's trace is unreachable through this daemon's loopback proxy regardless
 * of the task's shape (ADR-0005), so it always degrades honestly — never a link.
 */
export function resolveTraceDeepLink({ taskId, origin }: TraceDeepLinkInput): TraceDeepLink {
  if (origin && origin !== "local") {
    return { kind: "cross-stack", stackLabel: crossStackLabel(origin) };
  }
  // Local origin: derive correlation_id ≡ trace_id from the anchor task id.
  if (taskId.startsWith(DISPATCH_ANCHOR_TASK_PREFIX)) {
    const traceId = taskId.slice(DISPATCH_ANCHOR_TASK_PREFIX.length);
    if (traceId.length > 0) {
      return { kind: "local", traceId, timelineHref: traceTimelineHref(traceId) };
    }
  }
  // Local but non-anchored (no correlatable trace) — honest absence.
  return { kind: "none" };
}
