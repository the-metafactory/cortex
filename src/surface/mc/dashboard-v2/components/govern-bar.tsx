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

import { useState } from "react";
import type { NetworkPosture } from "../lib/mc-shell-model";
import type { NetworkMembershipDTO } from "../../api/networks";
import {
  GOVERN_VERB_SLOTS,
  governIsAdmin,
  selectAdmissionRequests,
  adminAuthorityBadges,
} from "../lib/govern-bar-adapter";
import {
  canAuthorize,
  submitAuthorize,
  describeAuthorizeOutcome,
  type AuthorizeOutcome,
  type FetchLike,
} from "../lib/authorize-lib";
import { HandoffBannerLive } from "./handoff-banner";
import { DoctorDrill } from "./network-doctor-panel";
import "./govern-bar.css";

/**
 * The browser `fetch` narrowed to the {@link FetchLike} shape the authorize lib
 * consumes. Defined once so the live control and any injected test double share
 * the exact call surface (the lib never imports the DOM `fetch`).
 */
const browserFetch: FetchLike = (path, init) =>
  fetch(path, { method: init.method, headers: init.headers, body: init.body });

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
 * FLG-2 (cortex#1706) — the WIRED **Authorize** control. Rendered ONLY inside
 * the admin verb rail (the rail itself is admin-gated by `governIsAdmin`, so
 * invariant 8 holds — a non-admin never sees this affordance at all).
 *
 * Authorize stamps `hub_authorized_at` on an ADMITTED admission request — a
 * trust-GRANTING, high-blast control verb. It therefore sits behind the FND-3
 * step-up MFA gate: the principal supplies the target `request_id`, re-types it
 * to confirm (the intent gate, mirroring the CLI `--apply` posture), AND enters
 * the current 6-digit TOTP code, which is sent in the `X-Cortex-Step-Up-Otp`
 * header. The daemon signs the hub-admin claim locally + POSTs the registry.
 *
 * SSR-inert: no effect fires until the principal interacts, so the whole bar
 * still renders to static markup for the tests.
 */
function AuthorizeControl({ caption }: { caption: string }) {
  const [requestId, setRequestId] = useState("");
  const [confirm, setConfirm] = useState("");
  const [stepUpCode, setStepUpCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<AuthorizeOutcome | null>(null);

  const ready = canAuthorize({ requestId, confirm, stepUpCode, busy });

  async function onAuthorize(): Promise<void> {
    if (!ready) return;
    setBusy(true);
    setOutcome(null);
    const result = await submitAuthorize(
      { request_id: requestId.trim(), confirm },
      stepUpCode,
      browserFetch,
    );
    setOutcome(result);
    setBusy(false);
    if (result.kind === "ok") {
      // Clear the fields on success — the request is authorized; a fresh code
      // would be needed for the next one anyway (TOTP is single-use per window).
      setRequestId("");
      setConfirm("");
      setStepUpCode("");
    }
  }

  const described = outcome ? describeAuthorizeOutcome(outcome) : null;

  return (
    <div className="govern-authorize" data-verb-live="authorize">
      <div className="govern-authorize-fields">
        <input
          type="text"
          className="govern-authorize-input"
          placeholder="admission request id"
          aria-label="Admission request id to authorize"
          value={requestId}
          disabled={busy}
          onChange={(e) => setRequestId(e.target.value)}
        />
        <input
          type="text"
          className="govern-authorize-input"
          placeholder="re-type request id to confirm"
          aria-label="Confirm the request id"
          value={confirm}
          disabled={busy}
          onChange={(e) => setConfirm(e.target.value)}
        />
        <input
          type="text"
          inputMode="numeric"
          autoComplete="one-time-code"
          className="govern-authorize-input govern-authorize-otp"
          placeholder="step-up code"
          aria-label="Step-up MFA code"
          value={stepUpCode}
          disabled={busy}
          onChange={(e) => setStepUpCode(e.target.value)}
        />
        <button
          type="button"
          className="govern-verb-btn govern-authorize-btn"
          disabled={!ready}
          aria-disabled={!ready}
          title={caption}
          onClick={() => {
            void onAuthorize();
          }}
        >
          {busy ? "Authorizing…" : "Authorize"}
        </button>
      </div>
      {described !== null ? (
        <p className={`govern-authorize-result tone-${described.tone}`} role="status">
          {described.text}
        </p>
      ) : null}
    </div>
  );
}

/**
 * The per-verb rail (admin only). FLG-2 wired the **Authorize** slot LIVE (it
 * renders the interactive {@link AuthorizeControl}); the remaining decision-gated
 * verbs (seal / rotate / revoke) stay HARNESS placeholders — disabled with an
 * honest "lands with FLG-N" caption. DISPATCH is a `live` pointer at the
 * existing control below the bar (not a second dispatch trigger).
 */
function VerbRail() {
  return (
    <div className="govern-verb-rail" role="group" aria-label="Govern verbs">
      {GOVERN_VERB_SLOTS.map((slot) => (
        <div
          key={slot.id}
          className={`govern-verb-slot state-${slot.state}`}
          data-verb={slot.id}
          data-verb-state={slot.state}
        >
          {slot.id === "authorize" ? (
            <AuthorizeControl caption={slot.caption} />
          ) : (
            <button
              type="button"
              className="govern-verb-btn"
              // The decision-gated verbs (seal/rotate/revoke) are disabled
              // outright; the `dispatch` live slot is a pointer, not a second
              // dispatch trigger (the live control renders below the bar).
              disabled
              aria-disabled="true"
              title={slot.caption}
            >
              {slot.label}
            </button>
          )}
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
