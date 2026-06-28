/**
 * MC-B1 (cortex#1278) — the **Pier queue** panel: an admin's inbox of
 * PENDING admission requests awaiting Tier-2 grant (ADR-0015 / ADR-0018;
 * CONTEXT.md §172).
 *
 * READ-ONLY. This slice surfaces who has requested to join which network so the
 * network admin can SEE the queue; the grant/reject ACTION is MC-B2 (#1276) and
 * lands as buttons here later. No action affordances in B1.
 *
 * ## Posture (the trust boundary, enforced in the pure adapter)
 *
 * The queue shows pending ONLY for networks the principal ADMINS (an
 * admin-authoritative `complete` roster read — `selectPierQueue`). For a network
 * the principal only MEMBERS, the pending list is not theirs to see, so it never
 * appears here; the count of such networks is surfaced honestly as a footnote,
 * never as an error.
 *
 * Additive + self-effacing (mirrors the A1 roster panel): when the principal
 * admins NO networks, the panel renders nothing — a pure-member or non-federated
 * stack is byte-identical to the pre-B1 view.
 */

import type { NetworkMembershipDTO } from "../hooks/use-networks";
import { selectPierQueue } from "../lib/pier-queue-adapter";

export interface PierQueueProps {
  networks: readonly NetworkMembershipDTO[];
}

export function PierQueue({ networks }: PierQueueProps) {
  const queue = selectPierQueue(networks);

  // The admin queue only exists for someone who admins a network. Admin
  // nothing → render nothing (keep a pure-member / non-federated stack
  // untouched).
  if (queue.adminNetworkCount === 0) return null;

  const adminPlural = queue.adminNetworkCount === 1 ? "" : "s";

  return (
    <section className="pier-queue-panel" aria-label="Pier queue (pending admission requests)">
      <h3 className="pier-queue-title">
        Pier queue <span className="dim">— pending admission requests</span>
      </h3>
      <p className="dim pier-queue-subtitle">
        Principals awaiting <strong>Tier-2 grant</strong> to join a network you
        administer. Read-only — review here; grant or reject from the registry.
      </p>

      {queue.totalPending === 0 ? (
        <div className="dim pier-queue-empty">
          No pending requests across {queue.adminNetworkCount} network{adminPlural}{" "}
          you administer.
        </div>
      ) : (
        <ul className="pier-queue-list">
          {queue.groups.map((g) => (
            <li key={g.networkId} className="pier-queue-group">
              <div className="pier-queue-group-header">
                <span className="pier-queue-id">{g.networkId}</span>
                <span className="dim pier-queue-leaf">leaf: {g.leafNode}</span>
                <span className="dim pier-queue-count">
                  {g.requests.length} pending
                </span>
              </div>
              <ul className="pier-queue-requests">
                {g.requests.map((r) => (
                  <li key={r.principal} className="pier-queue-request">
                    <span className="pier-queue-principal">{r.principal}</span>
                    <span
                      className="pier-queue-badge tone-pending"
                      title="Admission request pending — awaiting Tier-2 grant"
                    >
                      pending
                    </span>
                    {r.presentStacks.length > 0 ? (
                      <span
                        className="dim pier-queue-stacks"
                        title="Stacks of this requester observed present (presence never confers membership)"
                      >
                        {r.presentStacks.join(", ")}
                      </span>
                    ) : null}
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}

      {queue.nonAdminNetworkCount > 0 ? (
        <p className="dim pier-queue-footnote">
          {queue.nonAdminNetworkCount} joined network
          {queue.nonAdminNetworkCount === 1 ? "" : "s"} you don&rsquo;t administer{" "}
          {queue.nonAdminNetworkCount === 1 ? "is" : "are"} hidden — pending
          requests are visible only to a network&rsquo;s admin.
        </p>
      ) : null}
    </section>
  );
}
