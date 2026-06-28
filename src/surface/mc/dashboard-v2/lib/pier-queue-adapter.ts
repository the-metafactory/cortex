/**
 * MC-B1 (cortex#1278) — pure selection adapter for the **Pier queue**: the
 * ADMIN view of PENDING admission requests awaiting Tier-2 grant.
 *
 * ## What the Pier queue is (and what it is NOT)
 *
 * A network is a roster of admitted principals (CONTEXT.md §188; ADR-0015 /
 * ADR-0018). The admission gate is `register → PENDING → grant` (ADR-0015): a
 * principal that has requested to join a network sits in a PENDING admission row
 * until a network admin grants it (Tier-2, sovereign decision). The Pier queue
 * is the network admin's INBOX of those pending requests — the read side of the
 * approval surface. The grant/reject ACTION is MC-B2 (#1276 → #1279), NOT this
 * slice: this is strictly read-only.
 *
 * ## Two postures (the load-bearing trust boundary)
 *
 * CONTEXT.md / the vision distinguish two postures:
 *   - ADMIN — the admin of a network they own. They CAN read the network's
 *     full pending list (the registry `GET /admission-requests?status=PENDING`
 *     is admin-gated). For this principal, pending requests are theirs to see —
 *     and (in B2) to grant.
 *   - MEMBER — a principal who merely belongs to a network they don't admin.
 *     The pending list is NOT theirs to see; they can read only their own
 *     admission row (`/admission-requests/mine`, a self-PoP read).
 *
 * `/api/networks` (MC-A1) carries this distinction as `roster_scope`:
 *   - `roster_status === "ok" && roster_scope === "complete"` → an
 *     admin-authoritative read succeeded → ADMIN posture for that network.
 *   - any other status/scope (`self`, `unreachable`, `unauthorized`,
 *     `not_configured`) → NOT admin-authoritative.
 *
 * This adapter surfaces pending **only** for `complete`-scope networks. A
 * self-scoped or degraded read NEVER contributes a pending entry — fail-closed:
 * the queue is empty rather than leaking another principal's pending request
 * for a network the viewer doesn't admin. This is the trust boundary B1 must
 * never weaken.
 *
 * Pure: no I/O, no bus, no crypto. The membership verdict (`pending`) is
 * computed server-side from the admission rows (ADR-0018 Q3); this is purely a
 * verdict/scope → admin-queue projection, trivially unit-testable.
 */

import type { NetworkMembershipDTO } from "../../api/networks";

/** One pending admission request awaiting Tier-2 grant, for the admin inbox. */
export interface PierQueueRequest {
  /** The network the principal has requested to join. */
  networkId: string;
  /** The network's leaf-node connection id (provenance, mirrors the roster panel). */
  leafNode: string;
  /** The principal requesting to join — awaiting the admin's grant. */
  principal: string;
  /**
   * Stacks of the requester observed present, sorted/deduped server-side. A
   * requester MAY already be online (e.g. statically pinned) before admission;
   * this is informational only — presence never confers membership (ADR-0018 Q3).
   */
  presentStacks: string[];
}

/** Pending requests grouped under one admin-posture (admin) network. */
export interface PierQueueNetworkGroup {
  networkId: string;
  leafNode: string;
  /** The network's pending requests (config/member order, deduped upstream). */
  requests: PierQueueRequest[];
}

/** The reconciled Pier queue: the admin's pending-admission inbox. */
export interface PierQueue {
  /** Admin (complete-roster) networks that have ≥1 pending request. */
  groups: PierQueueNetworkGroup[];
  /** Total pending requests across all admin-posture networks. */
  totalPending: number;
  /**
   * Count of joined networks the principal ADMINS (complete-roster read). Defines
   * the queue's authority scope — when 0, the admin queue does not apply.
   */
  adminNetworkCount: number;
  /**
   * Count of joined networks the principal does NOT admin (self-scoped or
   * degraded read). Pending is NOT visible for these (honest posture, surfaced
   * to the admin as a footnote — never as an error).
   */
  nonAdminNetworkCount: number;
}

/**
 * Admin posture for ONE network: true iff the admin-authoritative
 * (`complete`) admission-rows read succeeded. This is the single gate that
 * decides whether a network's pending requests are the viewer's to see.
 */
export function isAdminPosture(net: NetworkMembershipDTO): boolean {
  return net.roster_status === "ok" && net.roster_scope === "complete";
}

/**
 * Project the `/api/networks` DTO into the admin Pier queue.
 *
 * For each joined network: if it is NOT admin-posture, count it as non-admin
 * and contribute NO pending entries (the trust boundary — fail-closed). If it
 * IS admin-posture, collect its `pending`-verdict members as requests; a
 * network becomes a group only when it has ≥1 pending request.
 *
 * Pure — does not mutate its input.
 */
export function selectPierQueue(
  networks: readonly NetworkMembershipDTO[],
): PierQueue {
  const groups: PierQueueNetworkGroup[] = [];
  let totalPending = 0;
  let adminNetworkCount = 0;
  let nonAdminNetworkCount = 0;

  for (const net of networks) {
    if (!isAdminPosture(net)) {
      // Trust boundary: pending is not ours to see for a network we don't admin.
      nonAdminNetworkCount += 1;
      continue;
    }
    adminNetworkCount += 1;

    const requests: PierQueueRequest[] = net.members
      .filter((m) => m.verdict === "pending")
      .map((m) => ({
        networkId: net.network_id,
        leafNode: net.leaf_node,
        principal: m.principal,
        presentStacks: [...m.present_stacks],
      }));

    totalPending += requests.length;
    if (requests.length > 0) {
      groups.push({
        networkId: net.network_id,
        leafNode: net.leaf_node,
        requests,
      });
    }
  }

  return { groups, totalPending, adminNetworkCount, nonAdminNetworkCount };
}
