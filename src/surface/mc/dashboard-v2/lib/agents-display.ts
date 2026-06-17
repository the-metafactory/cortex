/**
 * G-1114.B.4 — pure display helpers for the agents panel.
 *
 * Kept out of the React component so the formatting (relative-time, panel mode
 * selection) is unit-testable without a DOM, mirroring `working-grid-display.ts`.
 */

import type { AgentPresenceTile, AgentOrigin } from "../hooks/use-agents";

/**
 * G-1114.E.4 — true when an origin is NOT the serving stack's own `"local"`
 * record. A thin guard so view code reads `isForeignOrigin(origin)` rather than
 * re-checking the `"local"`-string-vs-object discriminant. Mirrors the bus-side
 * `isForeignOrigin`, re-declared here so the surface layer stays bus-free.
 *
 * ⚠️ NOTE: this is the SERVING-STACK guard (origin is an object), NOT the
 * "federated peer" guard. A same-principal LOCAL SIBLING (#1008 DB-read
 * aggregation) also carries an object origin yet is NOT federated — it's the
 * principal's own stack on the principal's own box. Use {@link classifyOrigin}
 * (which knows the serving principal) to tell a sibling from a true foreign
 * peer; only `classifyOrigin(...) === "foreign"` means "federated stack".
 */
export function isForeignOrigin(
  origin: AgentOrigin,
): origin is { principal: string; stack: string } {
  return origin !== "local";
}

/**
 * The three origin categories the Network graph distinguishes:
 *   - `"self"`    — the SERVING stack's own agent (`origin: "local"`).
 *   - `"sibling"` — a SAME-PRINCIPAL local stack reached via #1008 DB-read
 *     aggregation (`origin: {principal, stack}` with `principal` === the serving
 *     principal). Same principal, same machine — a LOCAL stack, NOT federated.
 *   - `"foreign"` — a CROSS-PRINCIPAL federated peer (`origin.principal` !== the
 *     serving principal). The only category that is truly "federated".
 *
 * `self` + `sibling` both render as LOCAL hubs ("stack"); only `foreign` renders
 * as a "federated stack". This is the fix for the #1008 mislabel where every
 * object-origin (including same-principal siblings) read as federated.
 */
export type OriginCategory = "self" | "sibling" | "foreign";

/**
 * Classify an origin against the SERVING principal into {@link OriginCategory}.
 *
 *   - `"local"` → `"self"`.
 *   - `{principal,stack}` with `principal === servingPrincipal` → `"sibling"`
 *     (a same-principal LOCAL stack — DB-read aggregation, not federation).
 *   - `{principal,stack}` with `principal !== servingPrincipal` → `"foreign"`
 *     (a cross-principal federated peer).
 *
 * When `servingPrincipal` is unknown (`null` — e.g. a foreign-only snapshot with
 * no `"local"` agent to derive it from), an object origin can't be proven a
 * sibling, so it conservatively classifies as `"foreign"`. A `"local"` origin is
 * always `"self"` regardless.
 */
export function classifyOrigin(
  origin: AgentOrigin,
  servingPrincipal: string | null,
): OriginCategory {
  if (origin === "local") return "self";
  if (servingPrincipal !== null && origin.principal === servingPrincipal) {
    return "sibling";
  }
  return "foreign";
}

/** True when a category renders with the LOCAL (non-federated) visual + label. */
export function isLocalCategory(category: OriginCategory): boolean {
  return category === "self" || category === "sibling";
}

/**
 * G-1114.E.4 — the provenance label for a foreign agent / hub: `{principal}/{stack}`
 * (e.g. `jc/research`). `null` for a local origin (local nodes carry no foreign
 * provenance badge). Used by the node cards + the detail panel to render where a
 * federated peer agent actually lives.
 */
export function originProvenanceLabel(origin: AgentOrigin): string | null {
  return origin === "local" ? null : `${origin.principal}/${origin.stack}`;
}

/** Panel render mode, selected from load/error/data state. */
export type AgentsPanelMode = "error" | "loading" | "empty" | "list";

export interface AgentsPanelInput {
  agents: AgentPresenceTile[];
  loaded: boolean;
  error: string | null;
}

/**
 * Pick the panel's render mode.
 *   - `error`   — boot fetch failed (and nothing loaded yet).
 *   - `loading` — first fetch in flight.
 *   - `empty`   — loaded, no agents observed.
 *   - `list`    — loaded, ≥1 agent.
 *
 * A refetch error after a successful boot is intentionally NOT `error` (the hook
 * swallows it warn-only) — the last-good list stays on screen.
 */
export function pickAgentsPanelMode(input: AgentsPanelInput): AgentsPanelMode {
  if (input.error && !input.loaded) return "error";
  if (!input.loaded) return "loading";
  if (input.agents.length === 0) return "empty";
  return "list";
}

/**
 * Format an epoch-ms timestamp as a compact relative string ("just now",
 * "12s ago", "3m ago", "2h ago", "5d ago"). `null`/`undefined` → "never".
 * `now` is injectable for deterministic tests.
 */
export function formatRelativeTime(
  epochMs: number | null | undefined,
  now: number = Date.now()
): string {
  if (epochMs === null || epochMs === undefined) return "never";
  const deltaMs = now - epochMs;
  // A future or near-zero timestamp (clock skew) reads as "just now" rather
  // than a negative duration.
  if (deltaMs < 5_000) return "just now";
  const seconds = Math.floor(deltaMs / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

/**
 * The TTL-lapse offline reason the registry's liveness reaper (G-1114.C.3)
 * stamps when heartbeats STOP with no `agent.offline` envelope (the agent went
 * silent — possibly crashed). Mirrors `TTL_LAPSE_OFFLINE_REASON` from the bus
 * registry, duplicated here so the surface layer stays bus-free (the DTO carries
 * the string; the panel never imports the bus type).
 */
export const TTL_LAPSE_REASON = "ttl_lapse" as const;

/**
 * Human-readable label for an agent's offline reason, distinguishing the
 * inferred TTL-lapse path (the agent went silent — "timed out", possibly
 * crashed) from the graceful, announced reasons (`shutdown`/`restart`/`error`,
 * each carried by an explicit `agent.offline` envelope).
 *
 * `ttl_lapse` is the load-bearing distinction (G-1114.C.4): a timed-out agent is
 * rendered as "no heartbeat" rather than a clean shutdown, because the principal
 * needs to know the difference between "this agent left on purpose" and "this
 * agent stopped answering". Unknown / future reasons degrade to a titled-case
 * echo of the raw string so a new wire reason never renders as blank.
 */
export function offlineReasonLabel(reason: string | null | undefined): string {
  switch (reason) {
    case TTL_LAPSE_REASON:
      return "no heartbeat";
    case "shutdown":
      return "shut down";
    case "restart":
      return "restarting";
    case "error":
      return "errored";
    case null:
    case undefined:
    case "":
      // Offline with no recorded reason — still distinct from online.
      return "offline";
    default:
      // A reason we don't have a friendly label for (a future wire value, or a
      // legacy `graceful-shutdown`-style string): echo it rather than blank it.
      return reason;
  }
}

/**
 * True when an offline agent went offline because its heartbeats LAPSED (the
 * reaper inferred it — the agent went silent, possibly crashed) rather than via
 * a graceful, announced `agent.offline`. Drives the panel's distinct
 * "timed out" treatment + the "last seen Xm ago" emphasis.
 */
export function isTtlLapse(reason: string | null | undefined): boolean {
  return reason === TTL_LAPSE_REASON;
}

/** One capability chip to render. */
export interface CapabilityBadge {
  /** The capability id (`review.code`, …). */
  label: string;
  /** True for the synthetic empty-set placeholder (rendered dimmed, not as a real cap). */
  placeholder: boolean;
}

/** The placeholder text shown when an agent declares no capabilities. */
export const NO_CAPABILITIES_LABEL = "no capabilities declared";

/**
 * Project a capability list into the badge set the panel renders. An empty set
 * yields a single placeholder badge ("no capabilities declared") so the column
 * is never blank; a non-empty set yields one real badge per capability, in the
 * order the registry reported them (no re-sorting — the registry's order is the
 * agent's declared order).
 */
export function formatCapabilities(
  capabilities: readonly string[]
): CapabilityBadge[] {
  if (capabilities.length === 0) {
    return [{ label: NO_CAPABILITIES_LABEL, placeholder: true }];
  }
  return capabilities.map((cap) => ({ label: cap, placeholder: false }));
}
