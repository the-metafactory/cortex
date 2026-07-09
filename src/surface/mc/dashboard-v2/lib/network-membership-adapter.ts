/**
 * MC-A1 (cortex#1275) — pure presentation adapter for the networks-as-first-class
 * roster panel. Maps the `/api/networks` DTO into render-ready badge/label shapes.
 *
 * Kept out of the React tree so the mapping is unit-testable without a DOM — the
 * panel component consumes the output. Mirrors `network-graph-adapter`'s
 * pure-projection pattern. Carries NO membership logic of its own (the verdict
 * is computed server-side from the admission rows, ADR-0018 Q3); this is purely
 * verdict → visual.
 */

import type {
  MembershipVerdict,
  NetworkConfidentialityDTO,
  NetworkMembershipDTO,
  PeerAcceptance,
  RosterAdmissionState,
  RosterAuthorship,
  RosterMemberStateDTO,
  RosterStatus,
  RosterScope,
} from "../../api/networks";

/** Visual tone for a verdict badge — maps to a CSS class on the panel. */
export type VerdictTone = "ok" | "warn" | "danger" | "pending";

/** A render-ready verdict badge. */
export interface VerdictBadge {
  label: string;
  tone: VerdictTone;
  /** Tooltip / aria description. */
  title: string;
}

/**
 * Map a membership verdict → badge. Deterministic + total over the union, so the
 * compiler enforces a case for every verdict (a new verdict won't silently fall
 * through).
 */
export function verdictBadge(verdict: MembershipVerdict): VerdictBadge {
  switch (verdict) {
    case "admitted-present":
      return {
        label: "present",
        tone: "ok",
        title: "Admitted to the roster and observed present",
      };
    case "absent-offline":
      return {
        label: "absent (offline)",
        tone: "warn",
        title:
          "Admitted to the roster but not observed present. We HAVE received this peer's federated presence before — it has since gone away (a transient outage of the peer's stack). Wait for it to return.",
      };
    case "absent-unheard":
      return {
        label: "absent (unheard — check import/cred)",
        tone: "danger",
        title:
          "Admitted to the roster but not observed present, AND we have NEVER received a single federated-presence envelope from it. We are DEAF to this peer: the peer may be healthy, but an import / cred / accept-list gap means nothing reaches us. Actionable: check the import/cred wiring, not the peer.",
      };
    case "present-but-unadmitted":
      return {
        label: "unadmitted",
        tone: "danger",
        title:
          "Observed present but on no admitted roster — an anomaly (stale roster or un-admitted peer)",
      };
    case "pending":
      return {
        label: "pending",
        tone: "pending",
        title: "Admission request pending — not yet admitted",
      };
  }
}

/**
 * FS-6 (cortex#1821) — the absent federated-peer NODE's eyebrow + tone, derived
 * from its absent-family verdict. The constellation node can't fit the full
 * roster badge, so this gives it a compact, HONEST sublabel:
 *
 *   - `absent-offline` → `federated · offline` (heard before, went away).
 *   - `absent-unheard` → `federated · unheard` (never heard — an import/cred gap),
 *     flagged `danger` so the deaf-to-peer case is visually distinct from a plain
 *     transient outage.
 *   - any other/legacy absent value → `federated · absent` (the pre-FS-6 label),
 *     so an older server DTO still renders sensibly.
 *
 * `token` is a stable, non-localized `data-*` value for tests/automation.
 */
export interface FederatedAbsenceReason {
  eyebrow: string;
  tone: VerdictTone;
  token: "offline" | "unheard" | "absent";
}

export function federatedAbsenceReason(verdict: string): FederatedAbsenceReason {
  switch (verdict) {
    case "absent-offline":
      return { eyebrow: "federated · offline", tone: "warn", token: "offline" };
    case "absent-unheard":
      return { eyebrow: "federated · unheard", tone: "danger", token: "unheard" };
    default:
      return { eyebrow: "federated · absent", tone: "warn", token: "absent" };
  }
}

// --- MC-A2: per-principal acceptance (the second trust layer) ---------------

/**
 * Stable, non-localized acceptance token — for `data-*` attributes, automation,
 * and tests. Distinct from the human `label`.
 */
export type AcceptanceToken =
  | "self"
  | "accepted-network"
  | "accepted-named"
  | "not-accepted";

/** A render-ready acceptance badge. */
export interface AcceptanceBadge {
  label: string;
  tone: VerdictTone;
  /** Stable token (data-* / tests); never localized. */
  token: AcceptanceToken;
  title: string;
}

/**
 * Map a member's {@link PeerAcceptance} → a badge. Acceptance is the SECOND
 * trust layer (CONTEXT.md §"Joining a network"): admission grants membership,
 * accept-policy CHOOSES whom this principal trusts. `self` and the two accepted
 * variants render quietly (ok/dim); `not-accepted` is surfaced (warn) so a peer
 * that is admitted-but-not-accepted is VISIBLE — you dispatch it no federated
 * work despite it being on the roster. Total over the union (compiler-enforced).
 */
export function acceptanceBadge(accepts: PeerAcceptance): AcceptanceBadge {
  switch (accepts) {
    case "self":
      return {
        label: "you",
        tone: "ok",
        token: "self",
        title: "The serving principal — itself an admitted member",
      };
    case "accepted-network":
      return {
        label: "accepted",
        tone: "ok",
        token: "accepted-network",
        title:
          "Accepted: a federated offering trusts this network's whole roster (accept-policy network:<id>)",
      };
    case "accepted-named":
      return {
        label: "accepted",
        tone: "ok",
        token: "accepted-named",
        title:
          "Accepted: this principal is named in a federated offering's accept-policy (principals:[…])",
      };
    case "not-accepted":
      return {
        label: "not accepted",
        tone: "warn",
        token: "not-accepted",
        title:
          "Admitted to the roster but NOT accepted by this principal — no federated offering admits it (default-deny). You dispatch it no federated work.",
      };
  }
}

/** A human label + tone for the roster read's availability. */
export interface RosterStatusBadge {
  label: string;
  tone: VerdictTone;
  title: string;
}

/**
 * Map a network's `roster_status` (+ `roster_scope`) → a small status chip so it
 * is clear at a glance whether a roster is live + authoritative or self-only /
 * degraded — the registry-Q3 reality is surfaced honestly, never hidden.
 */
export function rosterStatusBadge(
  status: RosterStatus,
  scope: RosterScope | null,
): RosterStatusBadge {
  switch (status) {
    case "ok":
      return scope === "complete"
        ? { label: "roster: complete", tone: "ok", title: "Authoritative admitted roster" }
        : {
            label: "roster: self-only",
            tone: "warn",
            title:
              "Only this stack's own admission is known; peer roster not yet enumerable",
          };
    case "unreachable":
      return {
        label: "registry unreachable",
        tone: "warn",
        title: "Could not reach the registry — showing self membership only",
      };
    case "unauthorized":
      return {
        label: "not authorized",
        tone: "warn",
        title: "This stack is not authorized to read the full roster",
      };
    case "not_configured":
      return {
        label: "roster source pending",
        tone: "warn",
        title:
          "Live admission-rows read not wired (A1) — pending A2 + registry ADR-0018 Q3 roster fix",
      };
  }
}

// --- MC-A3: per-network confidentiality posture (ADR-0019/0018) -------------

/**
 * Stable, non-localized posture token — for `data-*` attributes, automation, and
 * tests. Distinct from the human `label`.
 */
export type ConfidentialityPostureToken =
  | "encrypted" // enabled + key held — sealed, transition window (cleartext-in still accepted)
  | "encrypted-required" // required + key held — sealed, cleartext-in REJECTED
  | "cleartext" // mode off — signed, not sealed
  | "degraded" // enabled/required but NO key — publishing cleartext-with-warning (the honesty hinge)
  | "unknown"; // posture not reported (older/stale server) — never assume encrypted

/** A render-ready confidentiality badge. */
export interface ConfidentialityBadge {
  label: string;
  tone: VerdictTone;
  /** Stable posture token (data-* / tests); never localized. */
  posture: ConfidentialityPostureToken;
  /** Tooltip / aria description. */
  title: string;
}

/** `(key <kid>)` suffix for a title when a key-id is known; else empty. */
function keyIdSuffix(c: NetworkConfidentialityDTO): string {
  return c.key_id ? ` (key ${c.key_id})` : "";
}

/**
 * Map a network's confidentiality posture → a badge. READ-ONLY HONESTY: it
 * NEVER badges "encrypted" unless a key is actually held. The two load-bearing
 * cases the surface must not blur (ADR-0019):
 *
 *   - `enabled`/`required` but NO key → `degraded` (the runtime publishes
 *     cleartext-with-warning, ADR-0019 §5) — flagged `danger`, never "encrypted".
 *   - posture absent (older/stale server) → `unknown` — never assumed encrypted.
 *
 * Total over the `EncryptionMode` union: the `default` branch assigns `c.mode` to
 * `never`, so adding a mode without a case is a COMPILE error (the project does
 * not set `noImplicitReturns`, so this `never` assignment — not the switch shape —
 * is what enforces totality). The runtime fallback is "unknown", never "encrypted".
 */
export function confidentialityBadge(
  c: NetworkConfidentialityDTO | undefined,
): ConfidentialityBadge {
  if (c === undefined) {
    return {
      label: "encryption: unknown",
      tone: "warn",
      posture: "unknown",
      title:
        "Confidentiality posture not reported by the server — not assumed encrypted (ADR-0019).",
    };
  }
  // Honesty hinge: configured-to-seal but no key ⇒ NOT actually sealing.
  if ((c.mode === "enabled" || c.mode === "required") && !c.key_present) {
    return {
      label: "encryption: no key",
      tone: "danger",
      posture: "degraded",
      title:
        `Network is configured 'encryption: ${c.mode}' but no payload key (K) is present — ` +
        "federated payloads publish in CLEARTEXT with a warning (ADR-0019 §5). Not sealed.",
    };
  }
  switch (c.mode) {
    case "required":
      return {
        label: "encrypted (required)",
        tone: "ok",
        posture: "encrypted-required",
        title:
          `Federated payloads sealed with the per-network key${keyIdSuffix(c)} (ADR-0019); ` +
          "cleartext inbound is REJECTED.",
      };
    case "enabled":
      return {
        label: "encrypted",
        tone: "ok",
        posture: "encrypted",
        title:
          `Federated payloads sealed with the per-network key${keyIdSuffix(c)} (ADR-0019); ` +
          "cleartext-but-signed inbound still accepted (transition window).",
      };
    case "off":
      return {
        label: "cleartext",
        tone: "warn",
        posture: "cleartext",
        title:
          "Federated payloads cross in cleartext (signed, not sealed) — encryption is off (ADR-0019).",
      };
    default: {
      // Exhaustiveness guard: a new EncryptionMode must add a case above, or this
      // assignment fails to compile. Runtime fallback degrades to "unknown" — it
      // NEVER claims "encrypted" for an unrecognized mode (the honesty invariant).
      const _exhaustive: never = c.mode;
      return {
        label: "encryption: unknown",
        tone: "warn",
        posture: "unknown",
        title: `Unrecognized encryption mode '${String(_exhaustive)}' — not assumed encrypted (ADR-0019).`,
      };
    }
  }
}

// --- FLG-4: per-member roster lifecycle state (seal / authorize / departed) ---

/**
 * A render-ready admission-state badge. The load-bearing distinction FLG-4
 * demands: `departed` ("left") is visually SEPARABLE from `revoked` ("kicked") —
 * different label, different tone, different stable token — so the glass never
 * blurs a voluntary leave into an admin kick.
 */
export interface AdmissionStateBadge {
  label: string;
  tone: VerdictTone;
  /** Stable token (data-* / tests); never localized. */
  token: RosterAdmissionState;
  title: string;
}

/**
 * Map a member's {@link RosterAdmissionState} → a badge. Total over the union
 * (compiler-enforced via the `never` guard), so a new state cannot silently fall
 * through. `departed` vs `revoked` are deliberately given DIFFERENT tones + labels
 * (the FLG-4 honesty invariant: "left" ≠ "kicked").
 */
export function admissionStateBadge(state: RosterAdmissionState): AdmissionStateBadge {
  switch (state) {
    case "admitted":
      return { label: "admitted", tone: "ok", token: "admitted", title: "Admitted to the network roster" };
    case "pending":
      return { label: "pending", tone: "pending", token: "pending", title: "Admission request pending — not yet admitted" };
    case "departed":
      return {
        label: "left",
        tone: "warn",
        token: "departed",
        title:
          "DEPARTED — this member left the network voluntarily (ADMITTED → DEPARTED). A voluntary leave, NOT an admin kick.",
      };
    case "revoked":
      return {
        label: "revoked",
        tone: "danger",
        token: "revoked",
        title:
          "REVOKED — an admin kicked this member from the network (admin-signed revoke). Distinct from a voluntary 'left'.",
      };
    case "rejected":
      return {
        label: "rejected",
        tone: "danger",
        token: "rejected",
        title: "REJECTED — this admission request was declined by an admin (never admitted).",
      };
    case "unknown":
      return {
        label: "state unknown",
        tone: "warn",
        token: "unknown",
        title: "Admission state not resolvable from the current read — not assumed admitted.",
      };
    default: {
      const _exhaustive: never = state;
      return {
        label: "state unknown",
        tone: "warn",
        token: "unknown",
        title: `Unrecognized admission state '${String(_exhaustive)}' — not assumed admitted.`,
      };
    }
  }
}

/** A render-ready seal-delivery badge. */
export interface SealBadge {
  label: string;
  tone: VerdictTone;
  /** Stable token (data-* / tests). */
  token: "sealed" | "unsealed";
  title: string;
}

/**
 * Map the boolean seal-delivery signal → a badge. `sealed` is a DELIVERY signal
 * only (a leaf secret ciphertext has been placed on the row) — never the secret
 * itself. An admitted member with no sealed delivery is a real, honest state
 * (the handoff's seal leg is still outstanding), shown as `warn`.
 */
export function sealBadge(sealed: boolean): SealBadge {
  return sealed
    ? { label: "sealed", tone: "ok", token: "sealed", title: "A sealed leaf secret has been delivered onto this member's row (delivery signal only — never the secret)." }
    : { label: "unsealed", tone: "warn", token: "unsealed", title: "No sealed leaf secret delivered yet — the guided-join seal leg is still outstanding." };
}

/**
 * Format the hub-authorize timestamp for display, or a stable "not authorized"
 * label when `null`. Kept pure (no `toLocaleString` locale drift in tests): the
 * ISO string is surfaced verbatim, the UI can prettify in the DOM layer.
 */
export function formatHubAuthorized(ts: string | null): { label: string; authorized: boolean; title: string } {
  return ts === null
    ? { label: "hub-authorize pending", authorized: false, title: "The hub owner has not yet authorized this member's leaf (no hub_authorized_at)." }
    : { label: `hub-authorized ${ts}`, authorized: true, title: `Hub owner authorized this member's leaf at ${ts} (cortex#1498).` };
}

/** A render-ready #1600 authorship badge. */
export interface AuthorshipBadge {
  label: string;
  tone: VerdictTone;
  /** Stable token (data-* / tests). */
  token: RosterAuthorship;
  title: string;
}

/**
 * Map the #1600 hub-admin authorship verdict → a badge. The honesty invariant:
 * `verified` is shown ONLY when the daemon actually ran the signature check and
 * it passed; `unverifiable` is a surfaced NEGATIVE (checked, did not pass);
 * `unchecked` is an honest gap (no pinned admin key / no material) — NEVER
 * dressed up as a pass. Total over the union (compiler-enforced).
 */
export function authorshipBadge(a: RosterAuthorship): AuthorshipBadge {
  switch (a) {
    case "verified":
      return {
        label: "authorship verified",
        tone: "ok",
        token: "verified",
        title: "The hub-admin's signature on this member's sealed row verified against the pinned network-admin pubkey (#1600).",
      };
    case "unverifiable":
      return {
        label: "authorship UNVERIFIABLE",
        tone: "danger",
        token: "unverifiable",
        title: "The hub-admin authorship signature did NOT verify against the pinned network-admin pubkey (mismatched admin or bad signature). Treat with suspicion (#1600).",
      };
    case "unchecked":
      return {
        label: "authorship unchecked",
        tone: "warn",
        token: "unchecked",
        title: "Authorship not checked — no pinned network-admin pubkey configured, or the row carries no hub-admin {claim, signature}. Not a pass and not a failure (#1600).",
      };
    default: {
      const _exhaustive: never = a;
      return {
        label: "authorship unchecked",
        tone: "warn",
        token: "unchecked",
        title: `Unrecognized authorship verdict '${String(_exhaustive)}' — not assumed verified.`,
      };
    }
  }
}

/** Whether an admission state denotes a FORMER member (left / kicked / declined). */
export function isFormerMemberState(state: RosterAdmissionState): boolean {
  return state === "departed" || state === "revoked" || state === "rejected";
}

/**
 * Partition a network's `roster_states` into current-member states (keyed by
 * principal for the seal/authorize/authorship badges on live rows) and FORMER
 * members (departed/revoked/rejected — rendered as a distinct group). Pure.
 */
export function partitionRosterStates(states: readonly RosterMemberStateDTO[]): {
  byPrincipal: Map<string, RosterMemberStateDTO>;
  former: RosterMemberStateDTO[];
} {
  const byPrincipal = new Map<string, RosterMemberStateDTO>();
  const former: RosterMemberStateDTO[] = [];
  for (const s of states) {
    if (isFormerMemberState(s.admission_state)) {
      former.push(s);
    } else {
      // First-seen wins (matches the server-side dedupe); don't let a later
      // duplicate silently overwrite the canonical current state.
      if (!byPrincipal.has(s.principal)) byPrincipal.set(s.principal, s);
    }
  }
  return { byPrincipal, former };
}

/** Per-verdict counts for a network's member set (for the panel summary). */
export interface MembershipSummary {
  present: number;
  absent: number;
  unadmitted: number;
  pending: number;
  total: number;
}

/** Tally a network's members by verdict — pure, for the panel header summary. */
export function summarizeMembership(
  net: Pick<NetworkMembershipDTO, "members">,
): MembershipSummary {
  const summary: MembershipSummary = {
    present: 0,
    absent: 0,
    unadmitted: 0,
    pending: 0,
    total: net.members.length,
  };
  for (const m of net.members) {
    switch (m.verdict) {
      case "admitted-present":
        summary.present += 1;
        break;
      case "absent-offline":
      case "absent-unheard":
        // Both absent-family verdicts roll up into the single `absent` tally for
        // the panel header summary (the row badge + node eyebrow carry the FS-6
        // offline/unheard distinction; the header stays a coarse count).
        summary.absent += 1;
        break;
      case "present-but-unadmitted":
        summary.unadmitted += 1;
        break;
      case "pending":
        summary.pending += 1;
        break;
    }
  }
  return summary;
}
