/**
 * MC-A1 (cortex#1275) — the **admission-rows** read: the ADR-0018 Q3 source of
 * truth for network membership.
 *
 * ## Why this exists (and why NOT `roster-read.ts`)
 *
 * A network is a **roster of admitted principals** (CONTEXT.md §188). ADR-0018
 * **Q3** is emphatic: the roster `members[]` are sourced from **ADMITTED
 * admission rows**, *not* from announced capabilities — "capabilities are an
 * orthogonal facet … never the thing that confers membership."
 *
 * The existing registry roster read (`roster-read.ts` → `resolveNetworkRoster`,
 * #1086) consumes `GET /networks/{id}/roster`, whose `members[]` the registry
 * STILL documents as **capability-derived**
 * (`src/services/network-registry/src/types.ts` `NetworkRoster`: "membership is
 * implicit: a principal is in a network if any of their capabilities lists that
 * network"). Building a *membership* verdict on that read would conflate
 * capability with membership — exactly the bug class ADR-0015/0018 warn against.
 * So this module deliberately reads the **admission rows** instead, keyed on the
 * `AdmissionStatus` (`PENDING | ADMITTED | REJECTED | REVOKED`).
 *
 * The Q3-correct *peer* roster read (registry `members[] ← ADMITTED rows`, or an
 * equivalent member-accessible admitted-roster endpoint) is a **registry-side
 * prerequisite** that has not yet landed: today a non-admin member can read only
 * its OWN admission rows (`GET /admission-requests/mine`, a signed PoP read);
 * the FULL roster list (`GET /admission-requests?status=…`) is admin-gated. This
 * module therefore models that reality explicitly via {@link AdmissionRowsResult}
 * `scope` (`"complete"` admin/authoritative vs `"self"` member-PoP) so the
 * caller knows whether a present-but-unlisted principal is a real anomaly
 * (`complete`) or simply unknowable from a self-only read (`self`).
 *
 * ## Reuse target
 *
 * `resolveAdmittedRoster` + the {@link AdmissionRowsProvider} seam are the clean,
 * reusable foundation the admission-state slice (A2, #1276) and the Pier/PENDING
 * queue (B1, #1278) build on — not an inline read. The seam is injected so the
 * orchestration is unit-testable with a fake provider and carries no transport,
 * crypto, or auth specifics itself.
 */

import type { RosterAuthorship } from "./roster-authorship";

export type { RosterAuthorship } from "./roster-authorship";

/**
 * Admission lifecycle status, mirroring the registry's `AdmissionStatus`
 * (`src/services/network-registry/src/types.ts`). Re-declared on the consumer
 * side (the registry is a separate deploy target — same redeclare rationale as
 * `src/common/registry/types.ts`).
 *
 * FLG-4 (docs/plan-mc-future-state.md §4.D) adds `DEPARTED` to keep lockstep with
 * the registry's C-1350 status set — a member that LEFT voluntarily (ADMITTED →
 * DEPARTED). It is the honesty hinge the roster glass must keep visually distinct
 * from `REVOKED` (admin-kicked): "left" ≠ "kicked".
 */
export type AdmissionStatus =
  | "PENDING"
  | "ADMITTED"
  | "REJECTED"
  | "REVOKED"
  | "DEPARTED";

/**
 * One admission row, narrowed to the membership-relevant fields. A row binds a
 * principal to a network at a status. `network_id === null` is a network-less
 * registration row (registered-but-not-joined) — never a member of any specific
 * network, so {@link resolveAdmittedRoster} ignores it.
 *
 * FLG-4 adds the OPTIONAL roster-state facets a richer read may carry (the
 * extended registry member-read, or an admin-list read). A provider that cannot
 * observe them simply omits them — {@link resolveAdmittedRoster} defaults each to
 * an honest absence (`sealed:false`, `hub_authorized_at:null`,
 * `authorship:"unchecked"`). NONE of these are secret material: `sealed` is a
 * BOOLEAN delivery signal (never the ciphertext), `hub_authorized_at` is a
 * timestamp, and `authorship` is the RESOLVED tri-state verdict (never the raw
 * signature/claim) — secret-material discipline (invariant 6) is preserved.
 */
export interface AdmissionRow {
  principal_id: string;
  network_id: string | null;
  status: AdmissionStatus;
  /**
   * FLG-4 — whether a sealed leaf secret has been DELIVERED onto this row. A
   * boolean signal only (`sealed_secret !== null` on the registry row); NEVER the
   * sealed ciphertext. Optional — a reader that cannot observe delivery omits it.
   */
  sealed?: boolean;
  /**
   * FLG-4 — ISO-8601 UTC the hub-admin stamped hub-authorize (cortex#1498), or
   * `null` when not authorized. Optional — a reader that cannot observe it omits
   * it (defaults to `null`).
   */
  hub_authorized_at?: string | null;
  /**
   * FLG-4 / #1600 — the RESOLVED hub-admin authorship verdict for this row (the
   * provider ran {@link verifyRosterAuthorship} against the pinned network-admin
   * pubkey). Optional — absent ⇒ `"unchecked"`. The raw `{claim, signature}` is
   * NOT carried here (it is verified at the provider and discarded); only the
   * tri-state verdict crosses this seam.
   */
  authorship?: RosterAuthorship;
}

/**
 * FLG-4 — one member's roster LIFECYCLE state, projected from an admission row.
 * The metadata-only, no-secrets record the `/api/networks` read surfaces per
 * member (including FORMER members — departed/revoked — which are NOT in the
 * admitted/pending sets but ARE lifecycle states the glass must show honestly).
 */
export interface AdmittedMemberState {
  principal_id: string;
  /** The row's lifecycle status, verbatim (incl. `DEPARTED` vs `REVOKED`). */
  status: AdmissionStatus;
  /** Sealed-secret DELIVERED (boolean signal; never the ciphertext). */
  sealed: boolean;
  /** ISO-8601 UTC hub-authorize timestamp (cortex#1498), or `null`. */
  hub_authorized_at: string | null;
  /** #1600 — resolved hub-admin authorship verdict (default `"unchecked"`). */
  authorship: RosterAuthorship;
}

/**
 * Outcome of a {@link AdmissionRowsProvider} read. Never throws — every failure
 * is a discriminated `ok:false` so a long-running view/reconciler branches
 * without try/catch.
 *
 * `scope` on success distinguishes the two member-readable surfaces:
 *   - `"complete"` — the rows are the FULL network roster (admin-authoritative).
 *     A present principal NOT in the admitted set is a real anomaly.
 *   - `"self"` — the rows are only the caller's OWN admission rows (member PoP
 *     read). The roster is NOT fully known; anomaly detection MUST be suppressed.
 */
export type AdmissionRowsResult =
  | { ok: true; rows: AdmissionRow[]; scope: "complete" | "self" }
  | {
      ok: false;
      reason: "unreachable" | "unauthorized" | "not_configured";
      detail: string;
    };

/**
 * The injected admission-rows read seam. The concrete implementations
 * (self-PoP `/admission-requests/mine`; admin-list `GET /admission-requests`)
 * live with their transport/crypto; this interface is all the orchestration —
 * and the MC endpoint — depend on. Never throws.
 */
export interface AdmissionRowsProvider {
  readAdmissionRows(networkId: string): Promise<AdmissionRowsResult>;
}

/** The reconciled admitted/pending roster for one network, from admission rows. */
export interface AdmittedRoster {
  /** Principal ids whose admission row for this network is `ADMITTED`. */
  admitted: string[];
  /** Principal ids whose admission row for this network is `PENDING`. */
  pending: string[];
  /**
   * FLG-4 — per-member roster lifecycle STATE for EVERY row on this network
   * (admitted, pending, AND former: revoked/departed/rejected), first-seen order,
   * deduped by principal. This is the FLG-4 carrier: seal-delivery, hub-authorize
   * timestamp, admission state, and the #1600 authorship verdict. The
   * `admitted`/`pending` string arrays above are UNCHANGED (back-compat for the
   * membership reconciler); `states` is the additive superset the roster glass
   * reads for lifecycle. OPTIONAL for back-compat with older stub literals that
   * predate FLG-4 (a consumer treats absent as `[]` — honest absence);
   * {@link resolveAdmittedRoster} ALWAYS populates it.
   */
  states?: AdmittedMemberState[];
  /**
   * True when the underlying read was the COMPLETE roster (admin-authoritative).
   * False for a SELF-only member read — the caller MUST NOT treat a present
   * non-admitted principal as an anomaly, since the roster is not fully known.
   */
  authoritative: boolean;
}

/** Outcome of {@link resolveAdmittedRoster}. Never throws. */
export type ResolveAdmittedRosterResult =
  | { ok: true; roster: AdmittedRoster }
  | {
      ok: false;
      reason: "unreachable" | "unauthorized" | "not_configured";
      detail: string;
    };

function dedupePreserveOrder(ids: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/**
 * Resolve "who is ADMITTED / PENDING on `networkId`" from the **admission rows**
 * (ADR-0018 Q3 source of truth), via the injected provider.
 *
 * Filters to rows for THIS network (drops network-less registration rows),
 * projects `ADMITTED` → `admitted[]` and `PENDING` → `pending[]` (deduped,
 * first-seen order), and carries the read's `scope` through to
 * `authoritative`. `REJECTED` / `REVOKED` rows are NOT members and are dropped.
 *
 * Pure over its injected provider — no transport, crypto, or auth here.
 */
export async function resolveAdmittedRoster(
  networkId: string,
  provider: AdmissionRowsProvider,
): Promise<ResolveAdmittedRosterResult> {
  const res = await provider.readAdmissionRows(networkId);
  if (!res.ok) {
    return { ok: false, reason: res.reason, detail: res.detail };
  }
  const forNetwork = res.rows.filter((r) => r.network_id === networkId);
  const admitted = dedupePreserveOrder(
    forNetwork.filter((r) => r.status === "ADMITTED").map((r) => r.principal_id),
  );
  const pending = dedupePreserveOrder(
    forNetwork.filter((r) => r.status === "PENDING").map((r) => r.principal_id),
  );
  // FLG-4 — project EVERY row (incl. former: revoked/departed/rejected) into a
  // per-member lifecycle state, deduped by principal, first-seen order (matching
  // the admitted/pending dedupe above; a principal with multiple rows keeps its
  // first-seen row — deterministic without server-supplied ordering).
  const states = projectMemberStates(forNetwork);
  return {
    ok: true,
    roster: {
      admitted,
      pending,
      states,
      authoritative: res.scope === "complete",
    },
  };
}

/**
 * Project admission rows → per-member {@link AdmittedMemberState}, deduped by
 * principal (first-seen order). Defaults each optional facet to an honest
 * absence: `sealed:false`, `hub_authorized_at:null`, `authorship:"unchecked"`.
 */
function projectMemberStates(rows: readonly AdmissionRow[]): AdmittedMemberState[] {
  const seen = new Set<string>();
  const out: AdmittedMemberState[] = [];
  for (const r of rows) {
    if (seen.has(r.principal_id)) continue;
    seen.add(r.principal_id);
    out.push({
      principal_id: r.principal_id,
      status: r.status,
      sealed: r.sealed ?? false,
      hub_authorized_at: r.hub_authorized_at ?? null,
      authorship: r.authorship ?? "unchecked",
    });
  }
  return out;
}
