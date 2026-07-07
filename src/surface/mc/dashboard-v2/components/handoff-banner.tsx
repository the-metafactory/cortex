/**
 * FLG-1 (docs/plan-mc-future-state.md §4.D) — the guided-join handoff BANNER.
 *
 * A strip surfaced per joined network on the roster panel (R1 render home; CK-7
 * rehomes it into the cockpit GOVERN bar in R2). It renders the two-party
 * handoff (#1479) as it actually is: three ordered legs — **seal (admin) →
 * hub-authorize (hub owner) → leaf-up (member)** — each with its owner + status,
 * WHOSE MOVE is next, and — when leaf-up is blocked — WHY.
 *
 * ## Three-valued attestation (invariant 9 — Sage #1499)
 *
 * The "confirm" toggle is offered ONLY when `status.hub_attestable` — i.e. the
 * hub-authorize signal is `undefined` (un-auto-verifiable), the one state a
 * member attestation may raise. A real `false` (hub-denied) has
 * `hub_attestable === false`, so the UI NEVER presents an override for a hard
 * negative — it shows an honest "cannot be confirmed away" note instead. The
 * server is the actual guard (`deriveHandoffState` never upgrades a real
 * `false`); this is the matching UX honesty.
 *
 * `HandoffBanner` is PURE (props-only, SSR-renderable — the shape the tests
 * assert). `HandoffBannerLive` is the thin self-fetching wrapper the roster
 * panel mounts; it renders nothing until the read resolves, so it is inert under
 * `renderToStaticMarkup` (no effects fire) and a non-federated stack is
 * byte-identical to the pre-FLG-1 panel.
 */

import type {
  HandoffStatusDTO,
  HandoffLegDTO,
  HandoffOwner,
  LeafUpBlockedReason,
} from "../hooks/use-handoff";
import { useHandoff } from "../hooks/use-handoff";

/** Human label for a leg owner ("whose move"). The member is the local you. */
function ownerLabel(owner: HandoffOwner): string {
  switch (owner) {
    case "admin":
      return "admin";
    case "hub-owner":
      return "hub owner";
    case "member":
      return "you (member)";
  }
}

/** Tone token per leg status — reused by the `.tone-*` styles in global.css. */
function legTone(status: HandoffLegDTO["status"]): "ok" | "warn" | "muted" {
  switch (status) {
    case "done":
      return "ok";
    case "pending":
      return "warn";
    case "blocked":
      return "muted";
  }
}

/** Status glyph per leg — done / outstanding / blocked-by-an-earlier-leg. */
function legGlyph(status: HandoffLegDTO["status"]): string {
  switch (status) {
    case "done":
      return "✓";
    case "pending":
      return "●";
    case "blocked":
      return "○";
  }
}

/** Short leg label (the id reads well enough as the chain label). */
function legLabel(id: HandoffLegDTO["id"]): string {
  return id;
}

/** Honest one-liner for why leaf-up is blocked. */
function blockedReasonText(reason: LeafUpBlockedReason): string {
  switch (reason) {
    case "seal-pending":
      return "Leaf-up blocked — waiting on the admin to seal your leaf secret.";
    case "hub-unverifiable":
      return "Leaf-up blocked — hub authorization can’t be auto-verified from here yet.";
    case "hub-denied":
      return "Leaf-up blocked — the hub owner has not authorized you (a real negative — it cannot be overridden).";
  }
}

export interface HandoffBannerProps {
  status: HandoffStatusDTO;
  /** Whether the member attestation toggle is on. */
  confirmed: boolean;
  /** Flip the attestation (re-reads the handoff with `?confirmed=`). */
  onToggleConfirmed: (next: boolean) => void;
}

/**
 * PURE presentational banner — props only, no fetching. The roster panel mounts
 * {@link HandoffBannerLive} (which feeds this); tests render THIS directly.
 */
export function HandoffBanner({
  status,
  confirmed,
  onToggleConfirmed,
}: HandoffBannerProps) {
  const complete = status.next_owner === null;
  return (
    <div
      className="handoff-banner"
      data-network={status.network_id}
      data-member={status.member}
      data-next-owner={status.next_owner ?? "complete"}
      data-can-leaf-up={String(status.can_bring_leaf_up)}
      {...(status.leaf_up_blocked_reason !== null
        ? { "data-blocked-reason": status.leaf_up_blocked_reason }
        : {})}
      aria-label={`Guided-join handoff for ${status.network_id}`}
    >
      <div className="handoff-banner-head">
        <span className="handoff-banner-title">Guided join</span>
        <span className="dim handoff-banner-network">{status.network_id}</span>
      </div>

      <ol className="handoff-legs">
        {status.legs.map((leg, i) => (
          <li
            key={leg.id}
            className={`handoff-leg tone-${legTone(leg.status)}`}
            data-leg={leg.id}
            data-status={leg.status}
            data-owner={leg.owner}
            title={leg.detail}
          >
            <span className="handoff-leg-glyph" aria-hidden="true">
              {legGlyph(leg.status)}
            </span>
            <span className="handoff-leg-label">{legLabel(leg.id)}</span>
            <span className="dim handoff-leg-owner">{ownerLabel(leg.owner)}</span>
            {i < status.legs.length - 1 ? (
              <span className="dim handoff-leg-arrow" aria-hidden="true">
                →
              </span>
            ) : null}
          </li>
        ))}
      </ol>

      <div className="handoff-banner-next" data-complete={String(complete)}>
        {complete ? (
          <span className="tone-ok">All legs complete — leaf established.</span>
        ) : (
          <span>
            Next move:{" "}
            <strong>{ownerLabel(status.next_owner as HandoffOwner)}</strong>
            {status.next_leg !== null ? (
              <span className="dim"> — {legLabel(status.next_leg)}</span>
            ) : null}
          </span>
        )}
      </div>

      {status.leaf_up_blocked_reason !== null ? (
        <div
          className="dim handoff-banner-blocked"
          data-blocked-reason={status.leaf_up_blocked_reason}
        >
          {blockedReasonText(status.leaf_up_blocked_reason)}
        </div>
      ) : null}

      {status.hub_attestable ? (
        // The ONLY attestable state (hub-authorize signal is `undefined`). The
        // toggle upgrades that un-verifiable leg to treated-done; the server
        // never upgrades a real `false` (Sage #1499).
        <label className="handoff-banner-confirm">
          <input
            type="checkbox"
            checked={confirmed}
            onChange={(e) => onToggleConfirmed(e.target.checked)}
            data-testid="handoff-confirm-toggle"
          />{" "}
          <span>
            The hub owner confirmed to me that they applied my authorization
          </span>
          <span className="dim handoff-banner-confirm-caption">
            {" "}
            — treats the un-verifiable hub leg as done. It cannot un-block a real
            hub denial.
          </span>
        </label>
      ) : status.leaf_up_blocked_reason === "hub-denied" ? (
        <div className="dim handoff-banner-denied">
          The hub owner has not authorized you — this cannot be confirmed away.
        </div>
      ) : null}
    </div>
  );
}

export interface HandoffBannerLiveProps {
  networkId: string;
  /** The member the banner reports on (the local principal). `null` ⇒ no fetch. */
  member: string | null;
  /** Gate the fetch to when the Network view is visible. Defaults to true. */
  enabled?: boolean;
}

/**
 * Self-fetching wrapper the roster panel mounts. Renders NOTHING until the read
 * resolves — so it is SSR-inert (the roster panel stays effectively pure) and a
 * non-federated / unreachable read shows no strip at all.
 */
export function HandoffBannerLive({
  networkId,
  member,
  enabled = true,
}: HandoffBannerLiveProps) {
  const { status, confirmed, setConfirmed } = useHandoff(
    networkId,
    member,
    enabled,
  );
  if (status === null) return null;
  return (
    <HandoffBanner
      status={status}
      confirmed={confirmed}
      onToggleConfirmed={setConfirmed}
    />
  );
}
