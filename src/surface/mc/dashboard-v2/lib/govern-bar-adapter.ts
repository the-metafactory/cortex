/**
 * CK-7 (cortex#1673, docs/plan-mc-future-state.md §4.A) — pure model for the
 * **GOVERN bar SHELL**: the posture-gated verb rail the future govern verbs
 * (FLG-2/6/8/9) plug into.
 *
 * ## SHELL only — no verbs are wired here
 *
 * This slice builds the HARNESS, not the verbs. The four govern verbs
 * (authorize / seal / rotate / revoke) are DECISION-GATED and land later
 * (FLG-2/6/8/9); this module names the rail's slots and the honest "lands with
 * FLG-N" captions so the shell is truthful about what is not yet wired. The one
 * already-LIVE govern verb is DISPATCH (CK-3, cortex#1289) — the rail carries it
 * as a `live` slot that points at the existing dispatch control rather than
 * duplicating it.
 *
 * ## The gate is the pier-queue gate (they must never drift)
 *
 * Every admin affordance gates on {@link isAdminPosture} — the SAME
 * admin-authoritative (`roster_status === "ok" && roster_scope === "complete"`)
 * gate the Pier queue (MC-B1) and the command-bar posture pill
 * (`mc-shell-model.ts`) use. Reusing it is deliberate: an admin rail can never
 * render on a network the principal cannot prove they administer. Fail-closed —
 * absent the complete-roster proof, no verb slot renders (buttons never render
 * for non-admin posture, invariant 8).
 *
 * ## Admission requests without ids (honest — FLG-5 brings the ids)
 *
 * The admission-request banner surfaces the COUNT of pending admission requests
 * for a network the principal admins. The per-request ids that a Grant/Deny
 * action needs arrive with FLG-5; until then the banner renders the pending
 * count honestly and says so — it offers NO grant/deny affordance (truth-not-
 * theater).
 *
 * Pure: no I/O, no bus, no crypto. Trivially unit-testable.
 */

import type { NetworkMembershipDTO } from "../../api/networks";
import { isAdminPosture } from "./pier-queue-adapter";

/** Whether a rail slot is a decision-gated placeholder or an already-wired verb. */
export type GovernVerbState = "pending" | "live";

/** One slot in the GOVERN verb rail — a per-verb harness, NOT a wired verb. */
export interface GovernVerbSlot {
  /** Stable token (also the `data-verb` attribute + React key). */
  id: "authorize" | "seal" | "rotate" | "revoke" | "dispatch";
  /** Human label rendered on the (disabled) slot. */
  label: string;
  /** The slice that wires this slot LIVE (honest provenance). */
  flag: string;
  /** `pending` ⇒ decision-gated placeholder (disabled); `live` ⇒ already wired. */
  state: GovernVerbState;
  /** Honest one-liner: what the verb will do + when it lands (or where it lives). */
  caption: string;
}

/**
 * The GOVERN verb rail taxonomy. The four decision-gated verbs are `pending`
 * placeholders (FLG-2/6/8/9); DISPATCH is `live` (CK-3) and points at the
 * existing dispatch control below the bar — the rail names it so the taxonomy is
 * complete, but does NOT re-wire it.
 */
export const GOVERN_VERB_SLOTS: readonly GovernVerbSlot[] = [
  {
    id: "authorize",
    label: "Authorize",
    flag: "FLG-2",
    state: "live",
    caption: "Stamp hub_authorized_at on an ADMITTED request — hub-admin, step-up-gated.",
  },
  {
    id: "seal",
    label: "Seal",
    flag: "FLG-6",
    state: "pending",
    caption: "Seal a member's leaf secret — decision-gated, lands with FLG-6.",
  },
  {
    id: "rotate",
    label: "Rotate key",
    flag: "FLG-8",
    state: "pending",
    caption: "Rotate the network payload key — decision-gated, lands with FLG-8.",
  },
  {
    id: "revoke",
    label: "Revoke",
    flag: "FLG-9",
    state: "pending",
    caption: "Revoke a member — decision-gated, lands with FLG-9.",
  },
  {
    id: "dispatch",
    label: "Dispatch",
    flag: "CK-3",
    state: "live",
    caption: "Already wired — the live dispatch control is below the bar.",
  },
] as const;

/**
 * The admin gate for the GOVERN bar — reuses the Pier-queue gate verbatim so the
 * two surfaces can never disagree. When a network DTO is present we gate on the
 * admin-authoritative read (`isAdminPosture`); when only the derived posture
 * string is available (e.g. above a resolved network) we fall back to it.
 */
export function governIsAdmin(
  network: NetworkMembershipDTO | null | undefined,
  posture: "admin" | "member" | null,
): boolean {
  if (network) return isAdminPosture(network);
  return posture === "admin";
}

/** The admin-facing admission-request summary for ONE network (count only, FLG-5 brings ids). */
export interface AdmissionRequestSummary {
  networkId: string;
  leafNode: string;
  /** Pending admission requests awaiting Tier-2 grant. Ids come with FLG-5. */
  pending: number;
}

/**
 * Project a network DTO into its admission-request summary — ONLY for a network
 * the principal admins (complete-roster read). A member/degraded read returns
 * `null` (the pending list is not theirs to see — the same trust boundary the
 * Pier queue enforces). Pending is counted from the server-computed `pending`
 * membership verdict; NO request ids are surfaced (FLG-5).
 */
export function selectAdmissionRequests(
  network: NetworkMembershipDTO | null,
): AdmissionRequestSummary | null {
  if (!network || !isAdminPosture(network)) return null;
  const pending = network.members.filter(
    (m: NetworkMembershipDTO["members"][number]) => m.verdict === "pending",
  ).length;
  return {
    networkId: network.network_id,
    leafNode: network.leaf_node,
    pending,
  };
}

/** A distinct network-authority badge — registry-admin vs hub-admin (two authorities). */
export interface AdminAuthorityBadge {
  /** Stable token (`data-authority`). */
  token: "registry-admin" | "hub-admin";
  label: string;
  /** `.tone-*` class suffix — the two authorities read visually distinct. */
  tone: "info" | "accent";
  title: string;
}

/**
 * The two network authorities, kept visually distinct (CK-7 acceptance): the
 * REGISTRY admin owns the admission gate + the roster (who is in the network),
 * the HUB admin owns the NATS hub + the payload keys (transport + confidentiality).
 * They are two authorities, not one — a member footer names both so "admission &
 * keys are the admin's" is honest about which authority owns which.
 */
export function adminAuthorityBadges(): readonly AdminAuthorityBadge[] {
  return [
    {
      token: "registry-admin",
      label: "registry admin",
      tone: "info",
      title:
        "Owns the admission gate and the roster — who is admitted to the network.",
    },
    {
      token: "hub-admin",
      label: "hub admin",
      tone: "accent",
      title:
        "Owns the NATS hub and the payload keys — transport auth and confidentiality.",
    },
  ];
}
