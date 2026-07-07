/**
 * MC-A1 (cortex#1275) — the networks-as-first-class roster panel.
 *
 * Renders each JOINED network as a first-class trust group (CONTEXT.md §188): a
 * group header (network id · leaf · roster-status chip · per-verdict summary)
 * over its admitted-roster member rows, each carrying its membership verdict
 * badge. The membership verdict is computed SERVER-SIDE from the admission rows
 * (ADR-0018 Q3) — this component is pure presentation off the `/api/networks`
 * DTO and the pure `network-membership-adapter`.
 *
 * Additive: rendered ABOVE the agent-topology canvas in the Network view. The
 * local-stack agent pane (the graph) is untouched — this panel renders nothing
 * when there are no joined networks, so a non-federated stack is byte-identical
 * to the pre-A1 view.
 */

import type { NetworkMembershipDTO } from "../hooks/use-networks";
import {
  acceptanceBadge,
  confidentialityBadge,
  verdictBadge,
  rosterStatusBadge,
  summarizeMembership,
} from "../lib/network-membership-adapter";
// FLG-1 (docs/plan-mc-future-state.md §4.D) — the guided-join handoff banner, a
// strip per joined network (R1 render home; CK-7 rehomes it into the cockpit).
// Self-fetching + SSR-inert (renders nothing until the read resolves), so the
// panel stays effectively pure and a non-federated stack is unchanged.
import { HandoffBannerLive } from "./handoff-banner";
// FLG-3 (docs/plan-mc-future-state.md §4.D) — the network doctor drill ("why is
// this red"), an on-demand control per joined network (R1 render home; CK-7
// rehomes it into the cockpit + wires red-edge drilling). Self-fetching only on
// click, so the panel stays effectively pure.
import { DoctorDrill } from "./network-doctor-panel";

export interface NetworkRosterPanelProps {
  networks: readonly NetworkMembershipDTO[];
  /** The serving principal — its own row is marked "you". */
  localPrincipal?: string | null;
}

export function NetworkRosterPanel({
  networks,
  localPrincipal = null,
}: NetworkRosterPanelProps) {
  // Nothing joined → render nothing (keep the agent pane untouched for a
  // non-federated stack).
  if (networks.length === 0) return null;

  return (
    <section
      className="network-roster-panel"
      aria-label="Networks (trust groups)"
    >
      <h3 className="network-roster-title">
        Networks <span className="dim">— trust groups</span>
      </h3>
      <p className="dim network-roster-subtitle">
        Each network is a roster of <strong>admitted principals</strong> (the
        registry is the source of truth), reconciled against observed presence
        into a membership verdict.
      </p>
      <ul className="network-roster-list">
        {networks.map((net) => {
          const status = rosterStatusBadge(net.roster_status, net.roster_scope);
          const confidentiality = confidentialityBadge(net.confidentiality);
          const summary = summarizeMembership(net);
          return (
            <li key={net.network_id} className="network-roster-group">
              <div className="network-roster-group-header">
                <span className="network-roster-id">{net.network_id}</span>
                <span className="dim network-roster-leaf">
                  leaf: {net.leaf_node}
                </span>
                <span
                  className={`network-roster-status tone-${status.tone}`}
                  title={status.title}
                >
                  {status.label}
                </span>
                {/* MC-A3 (cortex#1277) — per-network confidentiality posture
                    (ADR-0019/0018). Read-only honesty: never "encrypted" without
                    a key. `data-posture` is the stable token for automation/tests. */}
                <span
                  className={`network-roster-confidentiality tone-${confidentiality.tone}`}
                  data-posture={confidentiality.posture}
                  title={confidentiality.title}
                >
                  {confidentiality.label}
                </span>
                <span className="dim network-roster-summary">
                  {summary.present} present · {summary.absent} absent
                  {summary.pending > 0 ? ` · ${summary.pending} pending` : ""}
                  {summary.unadmitted > 0
                    ? ` · ${summary.unadmitted} unadmitted`
                    : ""}
                </span>
              </div>
              {/* FLG-1 — the guided-join handoff banner for THIS stack's own
                  join to this network (member = the local principal). Self-
                  fetching + SSR-inert: renders nothing until the read resolves,
                  and nothing at all on a stack with no local principal. */}
              <HandoffBannerLive networkId={net.network_id} member={localPrincipal} />
              {/* FLG-3 — the doctor drill for THIS network. On-demand (a live
                  per-peer probe), collapsed to a button until the principal
                  asks "why is this red?". */}
              <DoctorDrill networkId={net.network_id} />
              {net.members.length === 0 ? (
                <div className="dim network-roster-empty">
                  No admitted members resolved.
                </div>
              ) : (
                <ul className="network-roster-members">
                  {net.members.map((m) => {
                    const badge = verdictBadge(m.verdict);
                    const acceptance = acceptanceBadge(m.accepts);
                    const isYou = localPrincipal !== null && m.principal === localPrincipal;
                    return (
                      <li
                        key={m.principal}
                        className="network-roster-member"
                      >
                        <span className="network-roster-principal">
                          {m.principal}
                          {isYou ? (
                            <span className="dim network-roster-you"> (you)</span>
                          ) : null}
                        </span>
                        <span
                          className={`network-roster-badge tone-${badge.tone}`}
                          title={badge.title}
                        >
                          {badge.label}
                        </span>
                        {/* MC-A2 — the SECOND trust layer (acceptance), shown
                            alongside the membership verdict. Self is already
                            marked "(you)" above, so its acceptance badge is
                            redundant — render it only for peers. */}
                        {m.accepts !== "self" ? (
                          <span
                            className={`network-roster-acceptance tone-${acceptance.tone}`}
                            data-acceptance={acceptance.token}
                            title={acceptance.title}
                          >
                            {acceptance.label}
                          </span>
                        ) : null}
                        {m.present_stacks.length > 0 ? (
                          <span className="dim network-roster-stacks">
                            {m.present_stacks.join(", ")}
                          </span>
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
