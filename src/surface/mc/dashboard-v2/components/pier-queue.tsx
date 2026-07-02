/**
 * MC-B1 (cortex#1278) — the **Pier queue** panel: an admin's inbox of
 * PENDING admission requests awaiting Tier-2 grant (ADR-0015 / ADR-0018;
 * CONTEXT.md §172).
 *
 * Surfaces who has requested to join which network so the network admin can SEE
 * the queue, and — since MC-B2 (#1279) — ACT on it: the Tier-2 grant/reject
 * affordance is embedded below as {@link PierDecideForm} (request-id-driven,
 * CF-Access + typed-confirm gated, local-daemon-signed).
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
import { isAdminPosture, selectPierQueue } from "../lib/pier-queue-adapter";
import { PierDecideForm } from "./pier-decide";
import type { FetchLike } from "../lib/pier-decide-lib";

export interface PierQueueProps {
  networks: readonly NetworkMembershipDTO[];
  /** Injected transport for the decide action (tests). Production omits → `fetch`. */
  decideFetch?: FetchLike;
  /** Called after a successful admit/reject (e.g. to refetch the networks view). */
  onDecided?: () => void;
}

export function PierQueue({ networks, decideFetch, onDecided }: PierQueueProps) {
  const queue = selectPierQueue(networks);
  // MC-B2 — the decision action targets networks the principal ADMINS
  // (complete-scope), the SAME trust gate the queue itself uses.
  const adminNetworks = networks.filter(isAdminPosture).map((n) => n.network_id);

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
        administer. Review here, then grant or reject below.
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

      {/* MC-B2 — the Tier-2 grant/reject action (request-id-driven, typed-confirm,
          local-daemon-signed). Only shown when the principal admins ≥1 network. */}
      <PierDecideForm
        adminNetworks={adminNetworks}
        {...(decideFetch ? { fetchImpl: decideFetch } : {})}
        {...(onDecided ? { onDecided } : {})}
      />
    </section>
  );
}
