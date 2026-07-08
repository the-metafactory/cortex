/**
 * CK-7 (cortex#1673, docs/plan-mc-future-state.md §4.A) — the **GOVERN bar SHELL**.
 *
 * The posture-gated verb rail that the future govern verbs plug into, mounted in
 * the cockpit's GOVERN lane (`mc-cockpit.tsx`). This slice is the SHELL only —
 * NO real verbs are wired. It renders:
 *
 *   1. ADMIN posture (the pier-queue gate — `governIsAdmin`): the verb RAIL, an
 *      empty per-verb harness (authorize / seal / rotate / revoke = decision-gated
 *      placeholders; dispatch = the one already-live slot, CK-3), plus the
 *      admission-request banner (pending count, NO grant/deny — FLG-5 brings the
 *      request ids) and the two distinct authority badges (registry / hub admin).
 *   2. MEMBER posture: the member footer — "You participate in ⟨net⟩ — admission &
 *      keys are the admin's" — with Leave surfaced as STATE + CLI guidance TEXT,
 *      explicitly NOT a button (invariant 16), and the two authority badges.
 *   3. BOTH postures: the two NAMED banners the govern area owns — the handoff
 *      banner (FLG-1, self-effacing) — and the doctor drill (FLG-3, on-demand).
 *
 * Every admin affordance gates on {@link governIsAdmin} (the SAME
 * `roster_scope === "complete"` admin-authoritative gate the Pier queue uses), so
 * a non-admin never sees a verb slot — fail-closed. The mockup's on-screen
 * posture word is the deprecated pre-migration term; this bar renders **admin /
 * member** only (never lifts the mockup string verbatim).
 *
 * PURE (props-only, SSR-renderable) apart from the two self-fetching banner
 * wrappers ({@link HandoffBannerLive}, {@link DoctorDrill}), which are SSR-inert
 * (no effect fires until their read/click resolves), so the whole bar renders to
 * static markup for the tests.
 */

import type { NetworkPosture } from "../lib/mc-shell-model";
import type { NetworkMembershipDTO } from "../../api/networks";
import {
  GOVERN_VERB_SLOTS,
  governIsAdmin,
  selectAdmissionRequests,
  adminAuthorityBadges,
} from "../lib/govern-bar-adapter";
import { HandoffBannerLive } from "./handoff-banner";
import { DoctorDrill } from "./network-doctor-panel";
import "./govern-bar.css";

export interface GovernBarProps {
  /** Posture toward the dived network (`null` at the root / unresolved). */
  posture: NetworkPosture | null;
  /** The dived network id — feeds the banners, doctor drill, and footer copy. */
  networkId: string | null;
  /** The serving (local) principal — the handoff member + the footer's "you". */
  localPrincipal: string | null;
  /**
   * The dived network's membership DTO, when resolved. Used for the exact
   * admin-authoritative gate (`isAdminPosture`) and the admission-request count.
   * `null` above a resolved network ⇒ gate falls back to `posture`.
   */
  network?: NetworkMembershipDTO | null;
}

/** The two authority badges (registry-admin vs hub-admin), kept visually distinct. */
function AuthorityBadges() {
  return (
    <div className="govern-authority-badges" aria-label="Network authorities">
      {adminAuthorityBadges().map((b) => (
        <span
          key={b.token}
          className={`govern-authority-badge tone-${b.tone}`}
          data-authority={b.token}
          title={b.title}
        >
          {b.label}
        </span>
      ))}
    </div>
  );
}

/**
 * The empty per-verb rail (admin only). Every slot is a HARNESS placeholder —
 * the decision-gated verbs are disabled with an honest "lands with FLG-N"
 * caption; the one `live` slot (dispatch) points at the existing control. No slot
 * dispatches a real verb in this shell.
 */
function VerbRail() {
  return (
    <div className="govern-verb-rail" role="group" aria-label="Govern verbs (shell)">
      {GOVERN_VERB_SLOTS.map((slot) => (
        <div
          key={slot.id}
          className={`govern-verb-slot state-${slot.state}`}
          data-verb={slot.id}
          data-verb-state={slot.state}
        >
          <button
            type="button"
            className="govern-verb-btn"
            // SHELL: no verb is wired — the slot is inert. The decision-gated
            // verbs are disabled outright; the live slot is a pointer, not a
            // second dispatch trigger (the live control renders below the bar).
            disabled
            aria-disabled="true"
            title={slot.caption}
          >
            {slot.label}
          </button>
          <span className="dim govern-verb-flag" title={slot.caption}>
            {slot.state === "live" ? "live · " : "soon · "}
            {slot.flag}
          </span>
        </div>
      ))}
    </div>
  );
}

/**
 * The admission-request banner (admin only). Surfaces the pending COUNT for the
 * dived network; it deliberately offers NO grant/deny action — the per-request
 * ids that action needs arrive with FLG-5, so the shell is honest that the
 * decision affordance is not yet here.
 */
function AdmissionRequestBanner({
  network,
}: {
  network: NetworkMembershipDTO | null;
}) {
  const summary = selectAdmissionRequests(network);
  if (summary === null) return null;
  const plural = summary.pending === 1 ? "" : "s";
  return (
    <div
      className="govern-banner govern-admission-banner"
      data-network={summary.networkId}
      data-pending={summary.pending}
      aria-label={`Admission requests for ${summary.networkId}`}
    >
      <div className="govern-banner-head">
        <span className="govern-banner-title">Admission requests</span>
        <span className="dim govern-banner-network">{summary.networkId}</span>
      </div>
      {summary.pending === 0 ? (
        <p className="dim govern-banner-body">
          No pending admission requests on this network.
        </p>
      ) : (
        <p className="govern-banner-body">
          <strong>
            {summary.pending} request{plural}
          </strong>{" "}
          awaiting admission.{" "}
          <span className="dim">
            Grant / deny arrives with FLG-5 (per-request ids) — this shell shows
            the count honestly, no action yet.
          </span>
        </p>
      )}
    </div>
  );
}

/**
 * The member-posture footer. Govern verbs (admission, keys) are the network
 * admin's — a member participates. Leave is surfaced as STATE + CLI guidance
 * TEXT, explicitly NOT a button (invariant 16, a recorded deviation from the
 * mockup). The two authority badges keep registry-admin vs hub-admin distinct.
 */
function MemberFooter({
  networkId,
  localPrincipal,
}: {
  networkId: string | null;
  localPrincipal: string | null;
}) {
  const netLabel = networkId ?? "this network";
  return (
    <div className="govern-member-footer" aria-label="Member posture">
      <p className="govern-member-note">
        {localPrincipal !== null ? (
          <>
            <strong>{localPrincipal}</strong>,{" "}
          </>
        ) : null}
        {/* Kept as one contiguous phrase (no inline element splitting it) so the
            copy reads plainly and stays greppable. */}
        you participate in {netLabel} — admission &amp; keys are the network
        admin&rsquo;s.
      </p>
      <AuthorityBadges />
      {/* Invariant 16 — Leave is CLI-side by design; it is STATE + guidance TEXT,
          never a button. */}
      <p
        className="dim govern-leave-guidance"
        data-leave="cli-only"
      >
        To leave, run{" "}
        <code className="govern-leave-cmd">cortex network leave {netLabel}</code>{" "}
        from your stack — leaving is CLI-side by design (there is no Leave button).
      </p>
    </div>
  );
}

/**
 * The GOVERN bar shell. Admin ⇒ verb rail + admission banner + authority badges;
 * member ⇒ member footer; both ⇒ the handoff banner + doctor drill. Unknown
 * posture (`null`) ⇒ an honest neutral note.
 */
export function GovernBar({
  posture,
  networkId,
  localPrincipal,
  network = null,
}: GovernBarProps) {
  const isAdmin = governIsAdmin(network, posture);

  return (
    <div
      className="govern-bar"
      data-posture={posture ?? "unknown"}
      aria-label="Govern bar"
    >
      {isAdmin ? (
        <>
          <VerbRail />
          <AdmissionRequestBanner network={network} />
          <AuthorityBadges />
        </>
      ) : posture === "member" ? (
        <MemberFooter networkId={networkId} localPrincipal={localPrincipal} />
      ) : (
        <p className="dim govern-unknown-note">
          Govern verbs are the network admin&rsquo;s.
        </p>
      )}

      {/* Both postures: the two named banners the govern area owns. Both are
          self-effacing — the handoff banner renders nothing until its read
          resolves (and nothing with no local principal); the doctor drill is a
          collapsed on-demand button. Mounted only when a network is dived. */}
      {networkId !== null ? (
        <div className="govern-banners">
          <HandoffBannerLive networkId={networkId} member={localPrincipal} />
          <DoctorDrill networkId={networkId} />
        </div>
      ) : null}
    </div>
  );
}
