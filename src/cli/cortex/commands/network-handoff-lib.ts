/**
 * `cortex network handoff` — PURE state model (cortex#1485, epic #1479, join-6).
 *
 * A network join is a **3-leg handoff across up to 3 people/machines**:
 *
 *     seal (admin) → hub-authorize (hub owner) → leaf-up (member)
 *
 * Before this, each leg was a fire-and-forget verb (`secret add-member`, a
 * hub-side nats-server edit nobody but the hub owner can see, `join --apply`)
 * — nobody could ask "what's outstanding, and whose job is it?", and nothing
 * enforced ORDER. Bringing the leaf up before the hub authorization was
 * actually applied was a real Authorization-Violation storm window during
 * the metafactory-community bring-up. This module models the handoff as
 * STATE: three ordered legs, each `done | pending | blocked`, with an owner
 * — plus the enforcement gate (`guardLeafUp`) that refuses the leaf-up leg
 * until its dependencies are done.
 *
 * ## The three leg SIGNALS — what's real vs a documented stub
 *
 *   - **seal** (admin) — REAL. Fed by {@link HandoffSignals.sealed}, which the
 *     orchestrator ({@link runHandoffStatus}) resolves via the SAME
 *     `AdmissionStatePort` PoP `/mine` read `cortex network status`'s C-1350
 *     admission lookup and `join`'s C-1315 blocker-classification already use
 *     — `hasSealedSecret` on the member's own ADMITTED admission row.
 *   - **hub-authorize** (hub owner) — a DOCUMENTED STUB today. This is
 *     exactly the gap `cortex network doctor`'s Pair 3 leg
 *     (`sealed-secret-hub-authorized`, cortex#1482) already named: the member
 *     has no hub-side visibility (cortex#1481), and the registry carries only
 *     an opaque ciphertext sealed to the member's OWN pubkey — there is no
 *     plaintext here to compare against the hub's live `authorization`
 *     entries. A real signal needs an EXPLICIT hub-owner-side marker (e.g. a
 *     `hub_authorized_at` field stamped onto the registry admission row by a
 *     hub-owner action) that does not exist yet — see
 *     `network-handoff-adapters.ts` for why (the `admission_requests` table
 *     is a real SQL table, so adding the column is a registry
 *     schema/migration — out of scope for this slice). `HandoffSignals.hubAuthorized`
 *     is typed `boolean | undefined` specifically so this module is ready to
 *     read that signal the moment it exists, without a shape change here.
 *   - **leaf-up** (member) — REAL. Fed by {@link HandoffSignals.leafUp}, which
 *     the orchestrator resolves via `isLeafEstablished` (exported from
 *     `network-doctor-lib.ts`) — the SAME `/leafz` leaf-established lookup
 *     `cortex network doctor`'s leg 3 (#1484) performs, not a second
 *     implementation.
 *
 * `hubAuthorized: undefined` (the documented-stub state, always what the live
 * adapter returns today) is treated exactly like `false` — fail-closed: an
 * UNKNOWN hub-authorize leg blocks leaf-up exactly as a KNOWN-pending one
 * would. It never silently unblocks just because the signal happens not to
 * exist yet.
 */

export type HandoffLegId = "seal" | "hub-authorize" | "leaf-up";
export type HandoffLegStatus = "done" | "pending" | "blocked";
export type HandoffOwner = "admin" | "hub-owner" | "member";

/** One leg of the handoff report — status + owner + a human detail. */
export interface HandoffLeg {
  id: HandoffLegId;
  title: string;
  status: HandoffLegStatus;
  owner: HandoffOwner;
  detail: string;
}

/** The raw per-leg signals {@link deriveHandoffState} derives from. */
export interface HandoffSignals {
  /** seal leg — real: a sealed leaf secret present on the ADMITTED row. */
  sealed: boolean;
  /**
   * hub-authorize leg — `true`/`false` once a real hub-owner-side marker
   * exists; `undefined` on the documented-stub path (today, always — see the
   * module doc). Any value other than exactly `true` is treated as NOT done.
   */
  hubAuthorized: boolean | undefined;
  /** leaf-up leg — real: an established leaf found for this network. */
  leafUp: boolean;
}

export interface HandoffState {
  /** Always exactly 3 legs, in `seal, hub-authorize, leaf-up` order. */
  legs: HandoffLeg[];
  /** The next outstanding leg, in chain order. `undefined` when every leg is done. */
  nextLeg?: HandoffLegId;
  /** The owner of {@link nextLeg}. `undefined` when every leg is done. */
  nextOwner?: HandoffOwner;
  /**
   * `true` only when BOTH `seal` and `hub-authorize` are done. This is
   * exactly the gate {@link guardLeafUp} enforces before a member's leaf-up
   * step is allowed to run.
   */
  canBringLeafUp: boolean;
}

const TITLES: Record<HandoffLegId, string> = {
  seal: "seal — admin mints + seals the leaf secret",
  "hub-authorize": "hub-authorize — hub owner applies the authorization",
  "leaf-up": "leaf-up — member brings the leaf online",
};

const OWNERS: Record<HandoffLegId, HandoffOwner> = {
  seal: "admin",
  "hub-authorize": "hub-owner",
  "leaf-up": "member",
};

/**
 * Pure — `true` only when both legs a leaf-up depends on are DONE.
 * Fail-closed: an `undefined` (documented-stub / unknown) hub-authorize
 * signal is treated as NOT done, same as an explicit `false`.
 */
export function canBringLeafUp(sealed: boolean, hubAuthorized: boolean | undefined): boolean {
  return sealed && hubAuthorized === true;
}

/**
 * Derive the full 3-leg handoff state from the raw signals. Pure — no I/O.
 * Ordering is fixed (seal → hub-authorize → leaf-up); a leg reads `blocked`
 * (rather than merely `pending`) once an EARLIER leg in the chain isn't done,
 * so the report always names exactly one leg as the outstanding next step.
 */
export function deriveHandoffState(signals: HandoffSignals): HandoffState {
  const hubDone = signals.hubAuthorized === true;

  const seal: HandoffLeg = {
    id: "seal",
    title: TITLES.seal,
    owner: OWNERS.seal,
    status: signals.sealed ? "done" : "pending",
    detail: signals.sealed
      ? "sealed leaf secret present on the ADMITTED admission row"
      : "no sealed leaf secret yet — the admin has not run `cortex network secret add-member`",
  };

  const hubAuthorize: HandoffLeg = !signals.sealed
    ? {
        id: "hub-authorize",
        title: TITLES["hub-authorize"],
        owner: OWNERS["hub-authorize"],
        status: "blocked",
        detail: "blocked — waiting on the seal leg",
      }
    : {
        id: "hub-authorize",
        title: TITLES["hub-authorize"],
        owner: OWNERS["hub-authorize"],
        status: hubDone ? "done" : "pending",
        detail: hubDone
          ? "hub authorization confirmed"
          : signals.hubAuthorized === undefined
            ? "cannot be confirmed from here yet — documented stub (no hub-owner-side marker exists on the " +
              "registry row today); treated as NOT done, fail-closed (see network-handoff-adapters.ts)"
            : "hub owner has not yet confirmed authorization",
      };

  const leafUpReady = signals.sealed && hubDone;
  const leafUp: HandoffLeg = !leafUpReady
    ? {
        id: "leaf-up",
        title: TITLES["leaf-up"],
        owner: OWNERS["leaf-up"],
        status: "blocked",
        detail: `blocked — waiting on ${signals.sealed ? "hub-authorize" : "seal"}`,
      }
    : {
        id: "leaf-up",
        title: TITLES["leaf-up"],
        owner: OWNERS["leaf-up"],
        status: signals.leafUp ? "done" : "pending",
        detail: signals.leafUp ? "leaf established" : "leaf not yet brought up",
      };

  const legs = [seal, hubAuthorize, leafUp];
  const next = legs.find((l) => l.status !== "done");

  return {
    legs,
    ...(next !== undefined && { nextLeg: next.id, nextOwner: next.owner }),
    canBringLeafUp: canBringLeafUp(signals.sealed, signals.hubAuthorized),
  };
}

export type LeafUpGuardResult = { allowed: true } | { allowed: false; message: string };

/**
 * The leaf-up ENFORCEMENT gate (#1485 acceptance point 2). Refuses
 * (fail-closed) unless {@link HandoffState.canBringLeafUp}. Returns an
 * actionable message naming the outstanding leg + its owner — never a bare
 * refusal, so a caller is never left storming the hub blind.
 */
export function guardLeafUp(state: HandoffState, networkId: string): LeafUpGuardResult {
  if (state.canBringLeafUp) return { allowed: true };
  // The outstanding leg is always `seal` or `hub-authorize` here (leaf-up
  // itself is never the reason canBringLeafUp is false).
  const blocking =
    state.legs.find((l) => l.id !== "leaf-up" && l.status !== "done") ??
    state.legs.find((l) => l.id === "hub-authorize");
  const legId = blocking?.id ?? "hub-authorize";
  const owner = blocking?.owner ?? "hub-owner";
  return {
    allowed: false,
    message:
      `cannot bring the leaf up for "${networkId}": the "${legId}" leg is not yet confirmed ` +
      `(owner: ${owner}) — run \`cortex network handoff status <member> --network ${networkId}\` ` +
      `and wait for that leg before retrying.`,
  };
}

// =============================================================================
// Orchestrator — gathers signals via injected ports, then derives + guards.
// =============================================================================

import { isLeafEstablished } from "./network-doctor-lib";
import type { NetworkHandoffPorts } from "./network-handoff-ports";

export interface HandoffReport {
  networkId: string;
  member: string;
  state: HandoffState;
  /** Non-fatal context (a degraded port read, or the self-vs-remote leaf-up
   *  caveat below) — never blocks the report, always surfaced to the caller. */
  notes: string[];
}

export interface RunHandoffStatusOptions {
  networkId: string;
  /** The member positional — who this report is ABOUT. */
  member: string;
  /**
   * The principal this invocation is actually running AS (derived from
   * --principal/config, the same way `doctor`/`status` resolve it). The
   * leaf-up leg is inherently observable ONLY from the machine that's
   * running — so when `member !== selfPrincipal`, `runHandoffStatus` adds an
   * honest note instead of silently reporting a leaf-up leg that isn't
   * actually about `member`.
   */
  selfPrincipal: string;
}

/**
 * Gather all three leg signals via the injected {@link NetworkHandoffPorts},
 * then derive the {@link HandoffState}. This is the READ half (acceptance
 * point 1); the ENFORCEMENT half is {@link guardLeafUp}, called separately by
 * whatever wires the leaf-up step (see `network.ts` `runJoin`'s `--guided`
 * preflight).
 */
export async function runHandoffStatus(
  ports: NetworkHandoffPorts,
  opts: RunHandoffStatusOptions,
): Promise<HandoffReport> {
  const notes: string[] = [];
  if (opts.member !== opts.selfPrincipal) {
    notes.push(
      `checked from "${opts.selfPrincipal}"'s own machine — the leaf-up leg reflects THIS machine's local ` +
        `leaf state, not necessarily "${opts.member}"'s. Run this command on the member's own machine for an ` +
        `authoritative leaf-up leg.`,
    );
  }

  const admissionRes = await ports.admission.resolve(opts.networkId);
  const sealed = admissionRes.ok && admissionRes.state.hasSealedSecret;
  if (!admissionRes.ok) {
    notes.push(`seal leg: could not read admission state — ${admissionRes.reason}`);
  }

  const hubRes = await ports.hubAuth.resolveHubAuthorized(opts.networkId, opts.member);
  if (hubRes.reason !== undefined) {
    notes.push(`hub-authorize leg: ${hubRes.reason}`);
  }

  const snapshot = ports.config.readNetworks();
  const network = snapshot.networks.find((n) => n.id === opts.networkId);
  let leafUp = false;
  if (network === undefined) {
    notes.push(`leaf-up leg: network "${opts.networkId}" is not configured locally yet`);
  } else {
    const leafz = await ports.monitor.fetchLeafz();
    leafUp = isLeafEstablished(leafz, network);
  }

  const state = deriveHandoffState({ sealed, hubAuthorized: hubRes.confirmed, leafUp });
  return { networkId: opts.networkId, member: opts.member, state, notes };
}
