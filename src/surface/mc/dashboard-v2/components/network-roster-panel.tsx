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
  admissionStateBadge,
  authorshipBadge,
  confidentialityBadge,
  formatHubAuthorized,
  partitionRosterStates,
  sealBadge,
  verdictBadge,
  rosterStatusBadge,
  summarizeMembership,
} from "../lib/network-membership-adapter";

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
          // FLG-4 — per-member lifecycle states: seal/authorize/authorship badges
          // on live rows (keyed by principal), plus FORMER members (departed vs
          // revoked, kept visually distinct) rendered as a separate group.
          const { byPrincipal: stateByPrincipal, former: formerMembers } =
            partitionRosterStates(net.roster_states ?? []);
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
              {/* Guided-join handoff banner + doctor drill removed from the
                  roster (they are join/onboarding affordances, not roster
                  state). The roster stays a pure trust-group view: group header
                  + membership rows + former members. */}
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
                    // FLG-4 — the member's lifecycle state (seal / hub-authorize /
                    // authorship), when the read carries it. Absent ⇒ no extra
                    // badges (honest: pre-FLG-4 server or facet-less read).
                    const st = stateByPrincipal.get(m.principal);
                    const seal = st ? sealBadge(st.sealed) : null;
                    const hubAuth = st ? formatHubAuthorized(st.hub_authorized_at) : null;
                    const authorship = st ? authorshipBadge(st.authorship) : null;
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
                        {/* FLG-4 — seal delivery + hub-authorize + #1600 authorship. */}
                        {seal ? (
                          <span
                            className={`network-roster-seal tone-${seal.tone}`}
                            data-seal={seal.token}
                            title={seal.title}
                          >
                            {seal.label}
                          </span>
                        ) : null}
                        {hubAuth ? (
                          <span
                            className={`network-roster-hubauth ${hubAuth.authorized ? "tone-ok" : "tone-warn"}`}
                            data-hub-authorized={hubAuth.authorized ? "true" : "false"}
                            title={hubAuth.title}
                          >
                            {hubAuth.label}
                          </span>
                        ) : null}
                        {authorship ? (
                          <span
                            className={`network-roster-authorship tone-${authorship.tone}`}
                            data-authorship={authorship.token}
                            title={authorship.title}
                          >
                            {authorship.label}
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
              {/* FLG-4 — FORMER members (departed vs revoked, kept visually
                  distinct). Depart/leave/retire are surfaced as STATE ONLY —
                  there are NO glass verbs here (retire is root-seed-signed and
                  never a button; leave/depart are CLI-side by design). */}
              {formerMembers.length > 0 ? (
                <div className="network-roster-former" data-former-count={formerMembers.length}>
                  <div className="dim network-roster-former-title">
                    Former members <span className="dim">— state only (leave / retire are CLI-side by design)</span>
                  </div>
                  <ul className="network-roster-members network-roster-former-list">
                    {formerMembers.map((f) => {
                      const stateBadge = admissionStateBadge(f.admission_state);
                      return (
                        <li key={`former:${f.principal}`} className="network-roster-member network-roster-former-member">
                          <span className="network-roster-principal">{f.principal}</span>
                          <span
                            className={`network-roster-badge tone-${stateBadge.tone}`}
                            data-admission-state={stateBadge.token}
                            title={stateBadge.title}
                          >
                            {stateBadge.label}
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
