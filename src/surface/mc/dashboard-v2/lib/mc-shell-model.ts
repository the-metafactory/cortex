/**
 * MC-D2 (cortex#1289) — pure model for the constellation skin's **shell chrome**:
 * the command-bar breadcrumb + posture, and the altitude-rail selection.
 *
 * The shell chrome is navigation scaffolding for the MC Network view. This module
 * owns the small amount of LOGIC behind it — altitude levels, the you-are-here
 * selection, the breadcrumb derivation, and per-network posture — so the React
 * components stay thin and the behaviour is unit-testable without a DOM.
 *
 * ## Posture term = admin / member (the deprecated label is forbidden)
 *
 * Posture is the stance a principal holds toward a *given* network — **admin**
 * (you govern it: own the hub + admission gate, hold the roster) or **member**
 * (an admitted sovereign peer). It is **per-network, not global** (CONTEXT.md
 * §"Network posture (admin vs member)"). The constellation mockup's legacy
 * on-screen label is renamed to **admin** here; the deprecated network-posture
 * word is reserved for the MC authorization-role tier + the NSC account-tree
 * root, never the network posture (CONTEXT.md).
 *
 * Admin posture is derived exactly as the Pier queue derives it (MC-B1): a
 * network is admin-posture iff its admin-authoritative (`complete`) admission-rows
 * read succeeded. We reuse `isAdminPosture` so the two surfaces can never drift.
 *
 * ## CK-1 scope — the rail is live below NETWORK (dive-to-stack)
 *
 * The altitude rail names five levels (NETWORKS → NETWORK → STACK → ASSISTANT →
 * SESSION). D2 wired only the top two; CK-1 makes the whole spine data-driven.
 * The selection now carries the drilled-into stack (a {@link StackCoord}), the
 * selected assistant, and the opened session, so `stopReachability` classifies
 * every stop from real state instead of returning a blanket `future`. Diving
 * into a constellation stack lights STACK/ASSISTANT; selecting one of a local
 * assistant's sessions lights SESSION and opens the reused F-7 drill-down as the
 * interior. No fabricated drill state — a stop is `reachable` only when the
 * coordinate that backs it is actually present.
 *
 * ## Sovereignty boundary — SESSION granularity is LOCAL-ONLY (ADR-0005)
 *
 * The SESSION level applies ONLY to the principal's OWN (local) stacks — the
 * serving stack and same-principal siblings (DB-read aggregation). Across the
 * federation boundary a peer principal's stacks expose AGGREGATED metadata at
 * best (presence, capability catalog, health, counts like "N active sessions") —
 * never individual sessions or interiors. So for a FEDERATED peer the deepest
 * reachable level is STACK/ASSISTANT (aggregate); SESSION is unreachable by
 * construction. The boundary is a feature, not a gap. CK-1 carries the
 * federated-vs-local bit on the selection's {@link StackCoord} (`federated`) and
 * gates SESSION on it — `stopReachability('session', …)` is `future` for a
 * federated stack, and `openSession` refuses one (defense in depth). Tests pin
 * that a federated peer bottoms out at STACK/ASSISTANT.
 */

import type { NetworkMembershipDTO } from "../hooks/use-networks";
import { isAdminPosture } from "./pier-queue-adapter";

/** The five altitude levels — the primary navigation gesture (10k ft → session). */
export type AltitudeLevel =
  | "networks"
  | "network"
  | "stack"
  | "assistant"
  | "session";

/** Ordered altitude levels, highest (10k ft) → deepest. */
export const ALTITUDE_LEVELS: readonly AltitudeLevel[] = [
  "networks",
  "network",
  "stack",
  "assistant",
  "session",
] as const;

/** Display metadata for one altitude rail stop. */
export interface AltitudeStopMeta {
  level: AltitudeLevel;
  /** Mono, uppercase label rendered on the rail. */
  label: string;
  /** Optional altitude annotation (only the 10k-ft NETWORKS root carries one). */
  altLabel?: string;
}

/** Per-level display metadata (label + the NETWORKS altitude annotation). */
export const ALTITUDE_META: Record<AltitudeLevel, AltitudeStopMeta> = {
  networks: { level: "networks", label: "NETWORKS", altLabel: "10k ft" },
  network: { level: "network", label: "NETWORK" },
  stack: { level: "stack", label: "STACK" },
  assistant: { level: "assistant", label: "ASSISTANT" },
  session: { level: "session", label: "SESSION" },
};

/**
 * A dived-into stack coordinate — the identity of ONE stack in the constellation
 * (STACK level and deeper). Carries the sovereignty bit the SESSION gate keys on.
 */
export interface StackCoord {
  /** The `{principal}` that owns the stack. */
  principal: string;
  /** The `{stack}` id within that principal. */
  stack: string;
  /**
   * Sovereignty coordinate (ADR-0005). `false` for the serving principal's
   * OWN-LOCAL stacks — its own stack AND same-principal siblings (DB-read
   * aggregation, not federation). `true` for a CROSS-PRINCIPAL federated peer.
   * SESSION altitude is reachable ONLY when `federated === false`; a federated
   * peer bottoms out at STACK/ASSISTANT (aggregate metadata), never
   * SESSION/ENVELOPE. Derive it from `classifyOrigin`/`isLocalCategory` at the
   * call site (self + sibling ⇒ local ⇒ `false`; foreign ⇒ `true`).
   */
  federated: boolean;
}

/**
 * The current you-are-here selection. `networks` ↔ `network` carry only the
 * network id; CK-1 adds the deeper coordinates — the drilled-into `stack`, the
 * selected `assistantId`, and the opened `sessionId` — so the whole rail is
 * data-driven and the reused drill-down interior can be keyed off `sessionId`.
 * Coordinates are `null` above the level that owns them.
 */
export interface AltitudeSelection {
  level: AltitudeLevel;
  /** The drilled-into network id, or `null` at the networks (10k-ft) root. */
  networkId: string | null;
  /** The dived-into stack (STACK level and deeper), or `null` above STACK. */
  stack: StackCoord | null;
  /** The selected assistant/agent id (ASSISTANT level and deeper), or `null`. */
  assistantId: string | null;
  /**
   * The opened session id (SESSION level), or `null`. Keys the reused F-7
   * drill-down interior. Only ever set on an OWN-LOCAL stack (ADR-0005).
   */
  sessionId: string | null;
}

/** The 10k-ft root — the networks level with no network selected. */
export const ROOT_SELECTION: AltitudeSelection = {
  level: "networks",
  networkId: null,
  stack: null,
  assistantId: null,
  sessionId: null,
};

/** Network posture toward a given network — per-network, never global. */
export type NetworkPosture = "admin" | "member";

/**
 * Per-network posture: `admin` iff the admin-authoritative (`complete`) admission
 * roster read succeeded (reuses MC-B1's `isAdminPosture`, so the Pier queue and
 * the command-bar pill can never disagree). Every other read scope/status is
 * `member` — fail-closed: we never claim admin authority we can't prove.
 */
export function networkPosture(net: NetworkMembershipDTO): NetworkPosture {
  return isAdminPosture(net) ? "admin" : "member";
}

/**
 * The posture of the currently-selected network, or `null` at the root.
 *
 * Posture is per-network, so at the 10k-ft networks root (no single network
 * selected) there is no single posture to report — `null` (the command bar then
 * shows no pill, an honest placeholder, rather than fabricating one). When a
 * selected network id is no longer in the data (it dropped out), also `null`.
 */
export function selectedNetworkPosture(
  networks: readonly NetworkMembershipDTO[],
  selection: AltitudeSelection,
): NetworkPosture | null {
  if (selection.networkId === null) return null;
  const net = networks.find((n) => n.network_id === selection.networkId);
  return net ? networkPosture(net) : null;
}

/**
 * The rail/breadcrumb label for a dived stack: bare `{stack}` for an OWN-LOCAL
 * stack, `{principal}/{stack}` for a federated peer (so the foreign provenance is
 * always visible where it matters). Mirrors the node-card provenance convention.
 */
export function stackLabel(stack: StackCoord): string {
  return stack.federated ? `${stack.principal}/${stack.stack}` : stack.stack;
}

/**
 * One you-are-here breadcrumb segment (clickable to navigate back to it). Each
 * segment carries the full coordinate set for its level so a click can
 * reconstruct the exact selection (see {@link navigateToSegment}).
 */
export interface BreadcrumbSegment {
  /** The text shown for this segment. */
  label: string;
  /** The altitude level this segment navigates to when clicked. */
  level: AltitudeLevel;
  /** The network this segment scopes to (`null` for the root segment). */
  networkId: string | null;
  /** The dived stack for STACK+ segments; `null` above STACK. */
  stack: StackCoord | null;
  /** The assistant id for ASSISTANT+ segments; `null` above ASSISTANT. */
  assistantId: string | null;
  /** The session id for the SESSION segment; `null` above SESSION. */
  sessionId: string | null;
}

/**
 * Build the you-are-here breadcrumb from the current selection. The root
 * (`NETWORK·OF·NETWORKS`) is always present; each drilled-into coordinate appends
 * a further segment (network → stack → assistant → session), so the breadcrumb
 * grows exactly as deep as the selection.
 */
export function buildBreadcrumb(
  selection: AltitudeSelection,
): BreadcrumbSegment[] {
  const segments: BreadcrumbSegment[] = [
    {
      label: "NETWORK·OF·NETWORKS",
      level: "networks",
      networkId: null,
      stack: null,
      assistantId: null,
      sessionId: null,
    },
  ];
  if (selection.networkId !== null) {
    segments.push({
      label: selection.networkId,
      level: "network",
      networkId: selection.networkId,
      stack: null,
      assistantId: null,
      sessionId: null,
    });
  }
  if (selection.stack !== null) {
    segments.push({
      label: stackLabel(selection.stack),
      level: "stack",
      networkId: selection.networkId,
      stack: selection.stack,
      assistantId: null,
      sessionId: null,
    });
  }
  if (selection.assistantId !== null) {
    segments.push({
      label: selection.assistantId,
      level: "assistant",
      networkId: selection.networkId,
      stack: selection.stack,
      assistantId: selection.assistantId,
      sessionId: null,
    });
  }
  if (selection.sessionId !== null) {
    segments.push({
      label: selection.sessionId,
      level: "session",
      networkId: selection.networkId,
      stack: selection.stack,
      assistantId: selection.assistantId,
      sessionId: selection.sessionId,
    });
  }
  return segments;
}

/** Drill into a specific network (networks → network). Clears deeper coords. */
export function drillToNetwork(networkId: string): AltitudeSelection {
  return {
    level: "network",
    networkId,
    stack: null,
    assistantId: null,
    sessionId: null,
  };
}

/** Ascend back to the 10k-ft networks root. */
export function ascendToRoot(): AltitudeSelection {
  return ROOT_SELECTION;
}

/**
 * Dive from the constellation into one of its stacks (NETWORK → STACK) — the
 * CK-1 dive-to-stack gesture. Carries the current network context and the stack
 * coordinate (incl. the federated bit); clears assistant/session below it.
 */
export function diveToStack(
  networkId: string | null,
  stack: StackCoord,
): AltitudeSelection {
  return {
    level: "stack",
    networkId,
    stack,
    assistantId: null,
    sessionId: null,
  };
}

/**
 * Select an assistant within the dived stack (STACK → ASSISTANT). Preserves the
 * stack coordinate; clears any opened session below it. A no-op-safe builder: it
 * keeps whatever `stack` the base selection carries (may be `null` if the caller
 * hasn't dived — the rail only offers this when a stack is present).
 */
export function selectAssistant(
  base: AltitudeSelection,
  assistantId: string,
): AltitudeSelection {
  return {
    level: "assistant",
    networkId: base.networkId,
    stack: base.stack,
    assistantId,
    sessionId: null,
  };
}

/**
 * Open a session interior on an OWN-LOCAL stack (ASSISTANT → SESSION), keying the
 * reused F-7 drill-down. Returns `null` when the base stack is absent or
 * FEDERATED — SESSION is unreachable across the federation boundary by
 * construction (ADR-0005), so the model refuses to fabricate it. This is defense
 * in depth alongside `stopReachability`; callers should also gate the affordance
 * on `stackReachesSession`.
 */
export function openSession(
  base: AltitudeSelection,
  sessionId: string,
): AltitudeSelection | null {
  if (base.stack === null || base.stack.federated) return null;
  return {
    level: "session",
    networkId: base.networkId,
    stack: base.stack,
    assistantId: base.assistantId,
    sessionId,
  };
}

/**
 * Ascend the rail to an ancestor stop, truncating every coordinate deeper than
 * `level`. Used when the principal clicks a reachable higher stop (or breadcrumb
 * segment): going up to STACK drops the assistant + session, going up to NETWORK
 * drops the stack too, and so on.
 */
export function ascendToLevel(
  selection: AltitudeSelection,
  level: AltitudeLevel,
): AltitudeSelection {
  const depth = ALTITUDE_LEVELS.indexOf(level);
  return {
    level,
    networkId: depth >= 1 ? selection.networkId : null,
    stack: depth >= 2 ? selection.stack : null,
    assistantId: depth >= 3 ? selection.assistantId : null,
    sessionId: depth >= 4 ? selection.sessionId : null,
  };
}

/**
 * Resolve a breadcrumb-segment click into the next selection. Each segment
 * carries its full coordinate set, so navigation just reconstructs the selection
 * at that segment's level (the root segment reconstructs {@link ROOT_SELECTION}).
 */
export function navigateToSegment(
  segment: BreadcrumbSegment,
): AltitudeSelection {
  return {
    level: segment.level,
    networkId: segment.networkId,
    stack: segment.stack,
    assistantId: segment.assistantId,
    sessionId: segment.sessionId,
  };
}

/** Reachability of a rail stop for the current data + selection. */
export type StopReachability = "current" | "reachable" | "future";

/**
 * Whether SESSION altitude is reachable for a given stack — the ADR-0005 gate.
 * True ONLY for an OWN-LOCAL stack (`stack !== null && !stack.federated`). A
 * federated peer bottoms out at STACK/ASSISTANT, so this is `false` there and
 * `stopReachability('session', …)` stays `future`.
 */
export function stackReachesSession(stack: StackCoord | null): boolean {
  return stack !== null && !stack.federated;
}

/**
 * Classify a rail stop from real selection state (CK-1 — no blanket `future`):
 *   - `current`   — the active level (lit on the rail);
 *   - `reachable` — navigable now with the coordinate that backs it present;
 *   - `future`    — no backing coordinate yet (a disabled stub).
 *
 * Rules:
 *   - `networks` — always reachable (the root you can always return to).
 *   - `network`  — reachable iff ≥1 network is joined (else nothing to drill
 *     into — an honest `future` stub).
 *   - `stack`    — reachable iff a stack has been dived into (`selection.stack`).
 *   - `assistant`— reachable iff a stack is dived; ASSISTANT is aggregate metadata
 *     available for BOTH local and federated peers, so it does not gate on the
 *     federated bit.
 *   - `session`  — reachable ONLY on an OWN-LOCAL stack (ADR-0005 sovereignty
 *     boundary): `future` when no stack is dived AND `future` for a FEDERATED
 *     peer — that peer bottoms out at STACK/ASSISTANT by construction.
 */
export function stopReachability(
  level: AltitudeLevel,
  selection: AltitudeSelection,
  networkCount: number,
): StopReachability {
  if (level === selection.level) return "current";
  if (level === "networks") return "reachable";
  if (level === "network") return networkCount > 0 ? "reachable" : "future";
  if (level === "stack") return selection.stack !== null ? "reachable" : "future";
  if (level === "assistant") {
    return selection.stack !== null ? "reachable" : "future";
  }
  // level === "session" — own-local only (ADR-0005). Federated peers bottom out
  // at STACK/ASSISTANT; a session is unreachable across the boundary.
  return stackReachesSession(selection.stack) ? "reachable" : "future";
}
