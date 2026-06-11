/**
 * P-14 U2.3 (#935) — Network-view TRANSPORT OVERLAY (pure fold).
 *
 * Folds signal's projected `system.transport.*` rows (U2.1's observability
 * projection, exposed payload-bearing via `transportRoster` on
 * `/api/observability-events`) into a per-peer-stack overlay the Network view
 * paints onto the graph:
 *
 *   - a stack-hub VERDICT badge (connected / registered-absent / unregistered-present)
 *     keyed by `{principal}/{stack}` — the intent⋈reality verdict signal computed
 *     in its P-13.B reconciler; and
 *   - leaf LIVENESS + RTT for the same key (present + rtt_ms, when the leaf is live).
 *
 * ## SOURCED FROM SIGNAL — never re-derived (CONTEXT.md §Sourced-from-signal)
 *
 * cortex does NOT reconcile intent against reality here. The verdict string is
 * taken VERBATIM from signal's envelopes:
 *
 *   | signal envelope `type`                | overlay verdict it asserts                |
 *   |---------------------------------------|-------------------------------------------|
 *   | `system.transport.liveness_drift`     | `payload.attributes.to` (the drift target)|
 *   | `system.transport.leaf_connect`       | `connected` (a leaf appeared)             |
 *   | `system.transport.leaf_disconnect`    | `registered-absent` (a leaf vanished)     |
 *   | `system.transport.roster_snapshot`    | each `leaves[]` entry → `connected`        |
 *
 * `liveness_drift` is authoritative for a peer (it's signal's reconciled verdict,
 * including the `unregistered-present` anomaly + `registered-absent` that the
 * edge events alone can't express); the edge / snapshot events only seed a
 * verdict when no drift has been seen for that key. Leaf RTT / liveness come from
 * the `leaf` / `leaves[]` body (`rtt_ms`, presence), which only `connected` peers
 * carry — exactly as signal's reconciler stamps them.
 *
 * Rows arrive newest-first (the DB read's `ORDER BY timestamp DESC`); the fold is
 * a single pass that keeps the FIRST (newest) authoritative signal per key, so a
 * later poll's verdict wins over an earlier one without any clock comparison.
 *
 * Pure + DOM-free → unit-testable against fixtures (the live oracle:
 * `signal transport roster <network>` verdicts must match this overlay).
 */

import type { TransportRosterEventRow } from "../../api/observability-tab";

/**
 * The three deterministic liveness verdicts — signal's P-13.B vocabulary,
 * mirrored here so the badge mapping is typed. NOT re-computed; signal emits
 * these strings, the overlay carries them through.
 */
export type TransportVerdict =
  | "connected"
  | "registered-absent"
  | "unregistered-present";

export const TRANSPORT_VERDICTS: readonly TransportVerdict[] = [
  "connected",
  "registered-absent",
  "unregistered-present",
] as const;

/** True when `v` is one of signal's three verdict strings (a wire-value guard). */
export function isTransportVerdict(v: unknown): v is TransportVerdict {
  return (
    v === "connected" ||
    v === "registered-absent" ||
    v === "unregistered-present"
  );
}

/** One peer-stack's overlay state, keyed by `{principal}/{stack}`. */
export interface TransportPeerOverlay {
  /** `{principal}/{stack}` — the join key against the stack-hub + agent origin. */
  key: string;
  principal: string;
  stack: string;
  /** The network this observation is scoped to (from the envelope payload). */
  network: string | null;
  /** Signal's verdict — taken verbatim, never re-derived. */
  verdict: TransportVerdict;
  /** Leaf liveness: true when signal reports the leaf present (a live link). */
  present: boolean;
  /** Round-trip time in ms from signal's leaf roster, or null when absent/unreported. */
  rttMs: number | null;
}

/**
 * The overlay model the Network view threads onto the graph: a lookup keyed by
 * `{principal}/{stack}` plus the network label (for the legend). `byKey` is a
 * Map for O(1) node-render lookups.
 */
export interface TransportOverlay {
  byKey: Map<string, TransportPeerOverlay>;
  /** The distinct network(s) observed in this roster (sorted), for a legend line. */
  networks: string[];
}

/** The empty overlay — no transport observations (e.g. a non-hub stack). */
export const EMPTY_TRANSPORT_OVERLAY: TransportOverlay = {
  byKey: new Map(),
  networks: [],
};

function asString(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function asNumber(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function asRecord(v: unknown): Record<string, unknown> {
  return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};
}

/** `{principal}/{stack}` join key, or null when either half is missing. */
function peerKey(principal: string | null, stack: string | null): string | null {
  return principal !== null && stack !== null ? `${principal}/${stack}` : null;
}

/**
 * A single fold candidate extracted from one row — the verdict signal asserts for
 * one peer-stack, plus that row's leaf liveness/RTT, plus whether it is the
 * AUTHORITATIVE source (a `liveness_drift`) or merely a seed (edge / snapshot).
 */
interface Candidate {
  key: string;
  principal: string;
  stack: string;
  network: string | null;
  verdict: TransportVerdict;
  present: boolean;
  rttMs: number | null;
  /** `liveness_drift` is authoritative; edges/snapshots only seed when no drift seen. */
  authoritative: boolean;
}

/** Extract the leaf liveness/RTT off a `leaf` / `leaves[]` entry body. */
function leafLiveness(leaf: Record<string, unknown>): { present: boolean; rttMs: number | null } {
  // A leaf entry present in a connect/snapshot body IS a live link; RTT may be
  // null (the hub didn't report it) — mirror signal's ObservedLeaf nullable rtt_ms.
  return { present: true, rttMs: asNumber(leaf.rtt_ms) };
}

/** Pull the candidate(s) one transport row contributes, or `[]` when unreadable. */
function candidatesForRow(row: TransportRosterEventRow): Candidate[] {
  const payload = row.payload;
  const network = asString(payload.network) ?? asString(row.stackId);

  switch (row.type) {
    case "system.transport.liveness_drift": {
      // Authoritative: signal's reconciled verdict. The peer + verdict ride
      // `attributes` (reconciler: { peer, principal, stack, from, to }).
      const attrs = asRecord(payload.attributes);
      const to = attrs.to;
      if (!isTransportVerdict(to)) return [];
      const principal = asString(attrs.principal);
      const stack = asString(attrs.stack);
      // Prefer the explicit attribute key, else split `peer` ("principal/stack").
      let key = peerKey(principal, stack);
      let p = principal;
      let s = stack;
      if (key === null) {
        const peer = asString(attrs.peer);
        const slash = peer?.indexOf("/") ?? -1;
        if (peer !== null && slash > 0) {
          p = peer.slice(0, slash);
          s = peer.slice(slash + 1);
          key = peer;
        }
      }
      if (key === null || p === null || s === null) return [];
      // A drift carries no leaf body; liveness/RTT only exist for a connected
      // peer and arrive via the connect/snapshot rows folded alongside.
      return [
        {
          key,
          principal: p,
          stack: s,
          network,
          verdict: to,
          present: to === "connected" || to === "unregistered-present",
          rttMs: null,
          authoritative: true,
        },
      ];
    }
    case "system.transport.leaf_connect":
    case "system.transport.leaf_disconnect": {
      const leaf = asRecord(payload.leaf);
      const principal = asString(leaf.principal);
      const stack = asString(leaf.stack);
      const key = peerKey(principal, stack);
      if (key === null || principal === null || stack === null) return [];
      const connect = row.type === "system.transport.leaf_connect";
      const live = leafLiveness(leaf);
      return [
        {
          key,
          principal,
          stack,
          network: asString(leaf.network) ?? network,
          // An edge seeds a verdict only when no drift dominates: a connect leaf
          // is `connected`; a disconnect leaves the peer registered-absent.
          verdict: connect ? "connected" : "registered-absent",
          present: connect ? live.present : false,
          rttMs: connect ? live.rttMs : null,
          authoritative: false,
        },
      ];
    }
    case "system.transport.roster_snapshot": {
      const leaves = Array.isArray(payload.leaves) ? payload.leaves : [];
      const out: Candidate[] = [];
      for (const raw of leaves) {
        const leaf = asRecord(raw);
        const principal = asString(leaf.principal);
        const stack = asString(leaf.stack);
        const key = peerKey(principal, stack);
        if (key === null || principal === null || stack === null) continue;
        const live = leafLiveness(leaf);
        out.push({
          key,
          principal,
          stack,
          network: asString(leaf.network) ?? network,
          // A leaf in the permitted roster snapshot is present → connected.
          verdict: "connected",
          present: live.present,
          rttMs: live.rttMs,
          authoritative: false,
        });
      }
      return out;
    }
    default:
      return [];
  }
}

/**
 * Fold the transport-family rows (newest-first) into the per-peer-stack overlay.
 *
 * Precedence, resolved in one newest-first pass:
 *   1. the FIRST (newest) `liveness_drift` for a key wins its verdict outright;
 *   2. otherwise the FIRST (newest) edge/snapshot seeds it;
 *   3. leaf liveness/RTT is taken from the first row for the key that carries a
 *      leaf body (drifts carry none), so a `connected` verdict still shows RTT
 *      from its accompanying connect/snapshot row — UNLESS the key's newest
 *      authoritative event already resolved presence ABSENT (a `registered-absent`
 *      drift or a `leaf_disconnect`), in which case an older connect/snapshot
 *      row must NOT resurrect presence/RTT (the just-disconnected peer's stale
 *      connect row is still in the 200-row window; newest authoritative wins).
 *
 * Empty / unreadable input → {@link EMPTY_TRANSPORT_OVERLAY} (shape-compatible).
 */
export function buildTransportOverlay(
  rows: readonly TransportRosterEventRow[],
): TransportOverlay {
  if (rows.length === 0) return { byKey: new Map(), networks: [] };

  const byKey = new Map<string, TransportPeerOverlay>();
  /** Track whether a key's verdict was set by an authoritative drift (locks it). */
  const lockedByDrift = new Set<string>();
  /**
   * Keys whose presence was RESOLVED-ABSENT by their newest authoritative event
   * (a `registered-absent` drift, or a `leaf_disconnect`). Once a key is in here,
   * an OLDER leaf-bearing row (connect / snapshot) must NOT resurrect presence or
   * backfill RTT — the newest authoritative event wins, so the absence stands.
   */
  const presenceResolved = new Set<string>();
  const networks = new Set<string>();

  for (const row of rows) {
    for (const c of candidatesForRow(row)) {
      if (c.network !== null) networks.add(c.network);
      const existing = byKey.get(c.key);
      if (existing === undefined) {
        byKey.set(c.key, {
          key: c.key,
          principal: c.principal,
          stack: c.stack,
          network: c.network,
          verdict: c.verdict,
          present: c.present,
          rttMs: c.rttMs,
        });
        if (c.authoritative) lockedByDrift.add(c.key);
        // If the NEWEST event for this key asserts absence (a `registered-absent`
        // drift or a `leaf_disconnect` — the only candidates with present:false),
        // lock presence absent: a later (older) connect/snapshot must not flip it.
        if (!c.present) presenceResolved.add(c.key);
        continue;
      }
      // Verdict precedence: a drift locks the key (newest drift already won, since
      // we walk newest-first); a non-drift never overrides a drift-locked verdict.
      if (c.authoritative && !lockedByDrift.has(c.key)) {
        existing.verdict = c.verdict;
        existing.present = c.present;
        lockedByDrift.add(c.key);
        if (existing.network === null) existing.network = c.network;
      }
      // Leaf liveness/RTT: backfill from the first row carrying a real leaf body —
      // UNLESS the key's newest authoritative event already resolved it absent, in
      // which case an older connect/snapshot must NOT resurrect presence or RTT
      // (newest authoritative event wins; the stale connect row just hasn't aged
      // out of the 200-row window yet).
      if (!presenceResolved.has(c.key)) {
        if (existing.rttMs === null && c.rttMs !== null) existing.rttMs = c.rttMs;
        if (!existing.present && c.present && c.rttMs !== null) {
          // A leaf-bearing row (connect / snapshot) flips presence on; this only
          // runs for keys NOT resolved-absent by a newer drift / disconnect.
          existing.present = true;
        }
      }
      if (existing.network === null && c.network !== null) existing.network = c.network;
    }
  }

  return { byKey, networks: [...networks].sort() };
}

/** Look up one peer-stack's overlay by `{principal}/{stack}` (null when absent). */
export function overlayForStack(
  overlay: TransportOverlay,
  principal: string | null,
  stack: string | null,
): TransportPeerOverlay | null {
  const key = peerKey(principal, stack);
  return key === null ? null : (overlay.byKey.get(key) ?? null);
}

// =============================================================================
// Verdict → badge mapping (pure; the single source of truth for the UI label,
// severity class + tooltip, shared by the hub badge + any legend).
// =============================================================================

/** Severity tier driving the badge's colour class (CSS keys off `data-verdict`). */
export type VerdictSeverity = "ok" | "warn" | "alert";

export interface VerdictBadge {
  verdict: TransportVerdict;
  /** Short label shown in the badge pill. */
  label: string;
  /** Severity class suffix (`ok` / `warn` / `alert`). */
  severity: VerdictSeverity;
  /** The full class name for the badge pill. */
  className: string;
  /** Hover title explaining the intent⋈reality meaning (signal's P-13.B vocab). */
  title: string;
}

const VERDICT_BADGES: Record<TransportVerdict, Omit<VerdictBadge, "verdict">> = {
  connected: {
    label: "connected",
    severity: "ok",
    className: "network-verdict-badge network-verdict-connected",
    title: "Connected — registered AND a live leaf is present (intent ∩ reality).",
  },
  "registered-absent": {
    label: "registered-absent",
    severity: "warn",
    className: "network-verdict-badge network-verdict-registered-absent",
    title:
      "Registered-absent — a registered peer with no live leaf (intent \\ reality).",
  },
  "unregistered-present": {
    label: "unregistered-present",
    severity: "alert",
    className:
      "network-verdict-badge network-verdict-unregistered-present",
    title:
      "Unregistered-present — a live leaf with no registry entry, the security anomaly (reality \\ intent).",
  },
};

/**
 * Map one of signal's verdict strings to its badge descriptor (label + severity
 * + class + tooltip). The mapping is total over {@link TransportVerdict}, so the
 * Network view never renders an unmapped verdict.
 */
export function verdictBadge(verdict: TransportVerdict): VerdictBadge {
  return { verdict, ...VERDICT_BADGES[verdict] };
}

/** Format a leaf RTT for display (e.g. `8.4ms`), or `—` when unreported. */
export function formatRtt(rttMs: number | null): string {
  if (rttMs === null) return "—";
  // One decimal place, matching `signal transport roster` output (`8.4ms`).
  return `${Math.round(rttMs * 10) / 10}ms`;
}
