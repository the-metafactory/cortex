/**
 * S5 (#1519, epic #1514) — `cortex network admit` / `cortex network reject`
 * injected-dependency seams.
 *
 * Mirrors the sibling triplets (`network-secret-ports.ts`,
 * `network-authorize-ports.ts`): every SIDE EFFECT the admit/reject
 * orchestration (`network-admit-lib.ts`) depends on is a port — a real adapter
 * for production (`network-admit-adapters.ts`) and a fake the tests assert
 * against. The three effect families (ADR-0015 + C-1316 + O-5):
 *
 *   - REGISTRY — admin-signed reads (single request / status-filtered list)
 *     and the signed admit/reject decision POST.
 *   - DISCORD  — best-effort community-fleet role ASSIGN ONLY (admit), O-5.
 *     Reject's role REMOVE is NOT part of this port — see the DISCORD section
 *     below for why.
 *   - SEAL     — fold the per-member leaf-secret delivery into a successful
 *     admit by delegating to the EXISTING `secret add-member` orchestration
 *     (C-1316). Payload-key / PSK crypto never runs here directly.
 */

import type { StackIdentityMaterial } from "../../../bus/stack-provisioning";
import type { NetworkSecretPorts } from "./network-secret-ports";

/**
 * Factory for the `secret add-member` port bundle the C-1316 fold-in seal
 * delegates to. Homed here (not in `network.ts` or `network-admit-adapters.ts`)
 * so both can import the SAME type without a circular import — this module
 * only imports `StackIdentityMaterial` + `NetworkSecretPorts`, never
 * `network.ts` or the admit adapters.
 */
export type SecretPortsFactory = (cfg: {
  hubConfigPath: string;
  registryUrl: string;
  material: StackIdentityMaterial;
}) => NetworkSecretPorts;

// =============================================================================
// REGISTRY — admission-request reads + the admit/reject decision POST.
// =============================================================================

/** One admission-request row as the registry's single-request GET returns it. */
export interface AdmissionRow {
  request_id: string;
  principal_id: string;
  status: string;
  peer_pubkey: string;
  network_id: string | null;
}

/** The subset of a row `admit --list-pending` renders (registry list GET). */
export interface AdmissionListRow {
  request_id: string;
  principal_id: string;
  peer_pubkey: string;
  network_id: string | null;
  status: string;
  created_at: string;
}

/** Outcome of an admin-signed GET of a single admission request. */
export type GetRequestResult =
  | { outcome: "ok"; row: AdmissionRow }
  | { outcome: "not_found" }
  | { outcome: "error"; status: number; body: string };

/**
 * Outcome of an admin-signed GET of the status-filtered admission list.
 * `forbidden` is the ADR-0020 read-scoping case (admin reads are
 * GLOBAL-admin-only today) — kept distinct from a generic `error` so the
 * caller can render its actionable fast-follow explanation.
 */
export type ListRequestsResult =
  | { outcome: "ok"; rows: AdmissionListRow[] }
  | { outcome: "forbidden"; body: string }
  | { outcome: "error"; status: number; body: string };

/**
 * Outcome of POSTing a signed admission decision (`admit` | `reject`). The
 * richer discriminants (`not_found` / `forbidden` / `already_decided`) exist
 * because `reject` distinguishes them into different messages; `admit`
 * currently folds every non-ok outcome into one generic message — see
 * {@link file://./network-admit-lib.ts}'s two separate message builders.
 */
export type PostDecisionResult =
  | { outcome: "ok"; principalId?: string }
  | { outcome: "not_found"; body: string }
  | { outcome: "forbidden"; body: string }
  | { outcome: "already_decided"; body: string }
  | { outcome: "error"; status: number; body: string };

/** The two roster-decision verbs the registry's shared `handleDecision` accepts. */
export type AdmissionDecision = "admit" | "reject";

/** An admin-signed admission-decision claim, as `buildAdmissionDecisionBody`
 *  (`network-admit-lib.ts`, pure crypto) produces it. */
export interface SignedAdmissionDecision {
  claim: { request_id: string; decision: AdmissionDecision; admin_pubkey: string; issued_at: string; nonce: string };
  signature: string;
}

/** Admin-signed reads of + decisions on the registry's admission-request rows. */
export interface AdmitRegistryPort {
  /** Admin-signed GET of a single admission request by id. */
  getRequest(requestId: string): Promise<GetRequestResult>;
  /** Admin-signed GET of every request at `status` (client-filters by network). */
  listRequests(status: string): Promise<ListRequestsResult>;
  /**
   * POST an ALREADY-SIGNED admission decision claim (built by the pure
   * `buildAdmissionDecisionBody` in the lib — signing failures there are a
   * DISTINCT error class from a POST/network failure, so the claim is built
   * outside this port and just submitted here).
   */
  postDecision(requestId: string, decision: AdmissionDecision, signedBody: SignedAdmissionDecision): Promise<PostDecisionResult>;
}

// =============================================================================
// DISCORD — O-5 community-fleet role assign (admit only).
//
// NOTE: the reject-side role REMOVAL is NOT part of this port — it turns out
// to be shared with `secret revoke-member` (out of scope for this slice), so
// it stays on the pre-S5 `removeDiscordFleetRole` helper in `network.ts`. Only
// admit's assign side was confirmed admit-exclusive (verified against every
// test file that references the Discord admit singleton).
// =============================================================================

/** The flags admit's fleet-role assign reads. */
export interface DiscordRoleInputs {
  /** The Discord member snowflake to assign the role to. */
  member: string;
  /** `--discord-server` profile name (optional). */
  server?: string;
  /** `--discord-guild` id override (optional). */
  guild?: string;
  /** Role name-or-id (defaults to `community-fleet`). */
  role: string;
}

/** Mirrors the sibling `AdmitSealStatus` union — every status the assign path can land on. */
export type DiscordRoleStatus = "skipped" | "skipped_no_token" | "skipped_no_guild" | "assigned" | "failed";

/** Outcome of a role assign — mirrors the CLI's discord_status/discord_warning fields. NEVER throws. */
export interface DiscordRoleOutcome {
  status: DiscordRoleStatus;
  /** Actionable warning when the role could not be assigned (empty on success). */
  warning: string;
}

/** Best-effort O-5 community-fleet role assign (admit). Never throws — every failure degrades to a warning. */
export interface AdmitDiscordPort {
  assignRole(inputs: DiscordRoleInputs): Promise<DiscordRoleOutcome>;
}

// =============================================================================
// SEAL — C-1316 admit-and-seal (fold the leaf-secret delivery into admit).
// =============================================================================

/** sealed = delivered (connectable); skipped = deliberately not run (--roster-only);
 *  fallback = tried/skipped but couldn't seal (still inert). */
export type AdmitSealStatus = "sealed" | "skipped" | "fallback";

/** The outcome of folding the per-member leaf-secret seal into a successful admit. */
export interface AdmitSealOutcome {
  status: AdmitSealStatus;
  /** Human transcript lines from the seal — NEVER carry a secret. */
  steps: string[];
  /** Why the seal was skipped or fell back. */
  reason?: string;
  /** The explicit `secret add-member` command to seal after the fact. */
  fallbackCmd?: string;
  /**
   * cortex#1481 — present iff the seal's hub turned out to be EXTERNAL (or
   * --seal-only forced it): the hub-owner artifact forwarded verbatim from
   * `SecretReport.hubOwnerArtifact`. The caller prints it explicitly.
   */
  hubOwnerArtifact?: string[];
  /**
   * cortex#1598 (C3) — present iff this was an OPERATOR-MODE scoped-mint seal:
   * the FED account + scoped-signing pubkeys the admit fold's probe-then-stamp
   * reads to verify the account is visible on the hub resolver BEFORE stamping
   * `hub_authorized_at`. Fingerprint-class values only (never a secret).
   */
  operator?: { fedAccountPubKey: string; signingKeyPubKey: string };
  /**
   * cortex#1598 (C3) — set by the admit fold's probe-then-stamp: `true` iff the
   * FED account was visible on the hub resolver AND `hub_authorized_at` was
   * stamped; `false` iff the probe was negative or the stamp failed (the member
   * is still connectable — the stamp is a separate re-runnable step). `undefined`
   * on the simple/non-operator path (authorize stays a manual command there).
   */
  hubAuthorizedStamped?: boolean;
}

/** The per-call arguments `sealMember` needs — everything EXCEPT the adapter's
 *  own construction-time `secretPortsFactory` dependency (that stays a config
 *  field on the live adapter, not a per-call argument). */
export interface SealMemberArgs {
  networkId: string | null;
  memberPubkey: string;
  registryUrl: string;
  hubConfigPath: string;
  material: StackIdentityMaterial;
  adminSeedPath: string;
  /** cortex#1481 — force seal-only (never write the local hub) even when the
   *  auto-detected locality would otherwise call the hub local. */
  sealOnly?: boolean;
  /** cortex#1481 — the hub's own federation account nkey-U, when known. */
  hubAccount?: string;
  /** cortex#1598 — operator-mode attestation (off the verified descriptor): when
   *  `operator`, the seal mints a scoped user + seals v2 instead of a PSK. */
  hubMode?: "operator" | "simple";
  /** cortex#1598 — resolver attestation; operator-mode admit refuses unless `nats`. */
  resolverMode?: "nats" | "memory";
  /** cortex#1598 — the hub FED account the scoped user is minted under. */
  hubFedAccount?: string;
}

/** Seal + deliver the per-member leaf PSK for a just-admitted member (C-1316). */
export interface AdmitSealPort {
  sealMember(args: SealMemberArgs): Promise<AdmitSealOutcome>;
}

/**
 * cortex#1598 (C3) — the operator-mode probe-then-stamp seam. After a scoped
 * mint seals, the admit fold probes the LOCAL hub monitor to confirm the FED
 * account (+ its scoped signing key) is visible on the resolver, then stamps
 * `hub_authorized_at` — NEVER blind (R4/R7). Both halves live here so the fold
 * stays pure (fake in tests, HTTP in prod).
 */
export interface HubAccountProbePort {
  /**
   * Read the hub config at `hubConfigPath`, derive its monitor URL, and GET
   * `/accountz?acc=<fedAccountPubKey>`. `present: true` REQUIRES BOTH the account
   * AND its scoped signing key to be visible — the signing key's presence is what
   * confirms the UPDATED account JWT propagated (a mint edits the account JWT), so
   * a first-admit before propagation reports `present: false` and does NOT stamp.
   * NEVER throws — any failure (no monitor, unreachable, non-200) returns
   * `present: false` + a reason.
   */
  probeAccountOnHub(input: {
    hubConfigPath: string;
    fedAccountPubKey: string;
    signingKeyPubKey: string;
  }): Promise<{ present: boolean; reason?: string }>;
  /** Stamp `hub_authorized_at` on the row (the SAME hub-admin-signed POST `authorize` uses). */
  postAuthorize(requestId: string): Promise<void>;
}

// =============================================================================
// The full port bundle the orchestrator depends on.
// =============================================================================

export interface AdmitPorts {
  registry: AdmitRegistryPort;
  discord: AdmitDiscordPort;
  seal: AdmitSealPort;
  /**
   * cortex#1598 (C3) — OPTIONAL operator-mode probe-then-stamp. Present on the
   * live bundle; the fold only reaches for it when the seal returns an
   * `operator` block (an operator-mode scoped mint). Absent ⇒ no auto-stamp
   * (simple-mode admit keeps `authorize` as a separate manual command).
   */
  hubProbe?: HubAccountProbePort;
}
