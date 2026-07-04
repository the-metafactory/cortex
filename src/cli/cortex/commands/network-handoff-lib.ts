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
 * ## The three leg SIGNALS — real vs unknown vs documented stub
 *
 * Each signal is a THREE-valued input (`true` / `false` / `undefined`), and
 * the distinction is load-bearing (Sage review, #1499):
 *
 *   - **seal** (admin) — `boolean`. Fed by the member's own ADMITTED admission
 *     row (`hasSealedSecret`), via the SAME `AdmissionStatePort` PoP `/mine`
 *     read `cortex network status`'s C-1350 lookup uses.
 *   - **hub-authorize** (hub owner) — `boolean | undefined`:
 *       - `true`  — a real signal says the hub owner applied the authorization
 *                   (cortex#1498 — the registry's `hub_authorized_at` marker,
 *                   stamped by `cortex network authorize`).
 *       - `false` — a real signal says they have NOT (a HARD negative — a
 *                   member attestation can NEVER override it).
 *       - `undefined` — the read itself failed (registry unreachable, no
 *                   seed/registry-url configured) — cannot auto-verify from
 *                   here at all. This is where the member ATTESTATION
 *                   (`attested`) applies: it upgrades an `undefined` to
 *                   treated-done, so `--guided` is a real deliberate-
 *                   confirmation gate for a degraded-connectivity case, not an
 *                   unconditional off-switch. It NEVER upgrades a real `false`.
 *   - **leaf-up** (member) — `boolean | undefined`. `true`/`false` from the
 *     LOCAL `/leafz` when the report is about the local stack; `undefined` when
 *     the report is about a REMOTE member (a member's leaf is observable only on
 *     that member's own machine — reporting the local machine's leaf as theirs
 *     would be a false read, Sage review #1499).
 *
 * `hubAuthorized: undefined` WITHOUT an attestation is treated as NOT done —
 * fail-closed. It never silently unblocks just because the signal doesn't
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
  /** seal leg — a sealed leaf secret present on the ADMITTED row. */
  sealed: boolean;
  /**
   * hub-authorize leg — `true` (real done) / `false` (real NOT done, hard) /
   * `undefined` (cannot auto-verify: documented-stub or remote). See module doc.
   */
  hubAuthorized: boolean | undefined;
  /**
   * leaf-up leg — `true`/`false` from LOCAL `/leafz`, or `undefined` when the
   * report is about a remote member whose leaf this machine cannot observe.
   */
  leafUp: boolean | undefined;
}

/** Options for {@link deriveHandoffState}. */
export interface DeriveHandoffOptions {
  /**
   * The member's own attestation (`join --hub-authorized-confirmed`): "the hub
   * owner has confirmed to me that they applied my authorization". Upgrades an
   * `undefined` hub-authorize signal to treated-done — but NEVER a real `false`.
   */
  attested?: boolean;
}

/** Why the leaf-up leg is not yet allowed (feeds {@link guardLeafUp}'s message). */
export type LeafUpBlockedReason = "seal-pending" | "hub-unverifiable" | "hub-denied";

export interface HandoffState {
  /** Always exactly 3 legs, in `seal, hub-authorize, leaf-up` order. */
  legs: HandoffLeg[];
  /** The next outstanding leg, in chain order. `undefined` when every leg is done. */
  nextLeg?: HandoffLegId;
  /** The owner of {@link nextLeg}. `undefined` when every leg is done. */
  nextOwner?: HandoffOwner;
  /**
   * `true` only when `seal` is done AND the hub-authorize leg is effectively
   * done (a real `true`, or an `undefined` upgraded by a member attestation —
   * never a real `false`). This is exactly the gate {@link guardLeafUp}
   * enforces before a member's leaf-up step is allowed to run.
   */
  canBringLeafUp: boolean;
  /**
   * When `canBringLeafUp` is false, WHY the leaf-up step is blocked — so
   * {@link guardLeafUp} can name the right remedy (admin seal vs an
   * un-auto-verifiable hub leg the member can attest vs a hard hub denial).
   */
  leafUpBlockedReason?: LeafUpBlockedReason;
}

/** cortex#1485 (Sage #1499 nit) — the per-leg descriptor table, ONE place for
 *  id → title + owner, so the derive branches don't each repeat them. */
const LEG_DESCRIPTORS: Record<HandoffLegId, { title: string; owner: HandoffOwner }> = {
  seal: { title: "seal — admin mints + seals the leaf secret", owner: "admin" },
  "hub-authorize": {
    title: "hub-authorize — hub owner applies the authorization",
    owner: "hub-owner",
  },
  "leaf-up": { title: "leaf-up — member brings the leaf online", owner: "member" },
};

function leg(id: HandoffLegId, status: HandoffLegStatus, detail: string): HandoffLeg {
  const d = LEG_DESCRIPTORS[id];
  return { id, title: d.title, owner: d.owner, status, detail };
}

/**
 * The effective "hub-authorize is done" decision. Pure. A real `true` is done;
 * an `undefined` becomes done ONLY under a member attestation; a real `false`
 * is NEVER done (attestation cannot override a real negative).
 */
function hubAuthorizeDone(hubAuthorized: boolean | undefined, attested: boolean): boolean {
  if (hubAuthorized === true) return true;
  if (hubAuthorized === false) return false;
  return attested; // undefined → attested upgrades it
}

/**
 * Pure — `true` only when the seal leg is done AND the hub-authorize leg is
 * effectively done. Fail-closed: an `undefined` hub-authorize with NO
 * attestation is NOT done; a real `false` is NOT done even WITH attestation.
 */
export function canBringLeafUp(
  sealed: boolean,
  hubAuthorized: boolean | undefined,
  attested = false,
): boolean {
  return sealed && hubAuthorizeDone(hubAuthorized, attested);
}

/**
 * Derive the full 3-leg handoff state from the raw signals (+ optional member
 * attestation). Pure — no I/O. Ordering is fixed (seal → hub-authorize →
 * leaf-up); a leg reads `blocked` (rather than `pending`) once an EARLIER leg
 * isn't done, so the report always names exactly one leg as the next step.
 */
export function deriveHandoffState(
  signals: HandoffSignals,
  opts: DeriveHandoffOptions = {},
): HandoffState {
  const attested = opts.attested === true;
  const hubDone = hubAuthorizeDone(signals.hubAuthorized, attested);

  const sealLeg = leg(
    "seal",
    signals.sealed ? "done" : "pending",
    signals.sealed
      ? "sealed leaf secret present on the ADMITTED admission row"
      : "no sealed leaf secret yet — the admin has not run `cortex network secret add-member`",
  );

  const hubLeg = !signals.sealed
    ? leg("hub-authorize", "blocked", "blocked — waiting on the seal leg")
    : signals.hubAuthorized === true
      ? leg("hub-authorize", "done", "hub authorization confirmed by a registry signal")
      : signals.hubAuthorized === false
        ? leg(
            "hub-authorize",
            "pending",
            "hub owner has NOT applied the authorization (registry reports NOT done) — a member " +
              "attestation cannot override this real negative",
          )
        : attested
          ? leg(
              "hub-authorize",
              "done",
              "attested by the member via `--hub-authorized-confirmed` (the registry read could not confirm it directly)",
            )
          : leg(
              "hub-authorize",
              "pending",
              "cannot be auto-verified right now (the registry read failed — unreachable, or no seed/registry-url " +
                "configured); treated as NOT done, fail-closed. If the hub owner has confirmed they applied your " +
                "authorization, re-run `join` with `--hub-authorized-confirmed`",
            );

  const leafReady = signals.sealed && hubDone;
  const leafLeg = !leafReady
    ? leg("leaf-up", "blocked", `blocked — waiting on ${signals.sealed ? "hub-authorize" : "seal"}`)
    : signals.leafUp === true
      ? leg("leaf-up", "done", "leaf established")
      : signals.leafUp === undefined
        ? leg(
            "leaf-up",
            "pending",
            "leaf state not observable from here (remote member, or the network is not configured locally) " +
              "— run this on the member's own machine for an authoritative reading",
          )
        : leg("leaf-up", "pending", "leaf not yet brought up");

  const legs = [sealLeg, hubLeg, leafLeg];
  const next = legs.find((l) => l.status !== "done");
  const canBring = signals.sealed && hubDone;

  let blockedReason: LeafUpBlockedReason | undefined;
  if (!canBring) {
    blockedReason = !signals.sealed
      ? "seal-pending"
      : signals.hubAuthorized === false
        ? "hub-denied"
        : "hub-unverifiable"; // undefined + not attested
  }

  return {
    legs,
    ...(next !== undefined && { nextLeg: next.id, nextOwner: next.owner }),
    canBringLeafUp: canBring,
    ...(blockedReason !== undefined && { leafUpBlockedReason: blockedReason }),
  };
}

export type LeafUpGuardResult = { allowed: true } | { allowed: false; message: string };

/**
 * The leaf-up ENFORCEMENT gate (#1485 acceptance point 2). Refuses
 * (fail-closed) unless {@link HandoffState.canBringLeafUp}, with a message
 * tailored to WHY — so the member gets an actionable next step, not a bare
 * refusal: an admin seal, an attestation they can supply, or a hard hub denial
 * they cannot override.
 */
export function guardLeafUp(state: HandoffState, networkId: string): LeafUpGuardResult {
  if (state.canBringLeafUp) return { allowed: true };
  switch (state.leafUpBlockedReason) {
    case "seal-pending":
      return {
        allowed: false,
        message:
          `cannot bring the leaf up for "${networkId}": the "seal" leg is not done (owner: admin) — an ` +
          `admin must run \`cortex network secret add-member ${networkId} <member-pubkey> --apply\` to mint ` +
          `+ seal your leaf secret first. Run \`cortex network handoff status <member> --network ${networkId}\`.`,
      };
    case "hub-denied":
      return {
        allowed: false,
        message:
          `cannot bring the leaf up for "${networkId}": the hub owner has NOT applied your authorization ` +
          `(the hub-authorize leg reports a real NOT-done) — \`--hub-authorized-confirmed\` cannot override a ` +
          `real negative signal. Wait for the hub owner to authorize you.`,
      };
    case "hub-unverifiable":
    default:
      return {
        allowed: false,
        message:
          `cannot bring the leaf up for "${networkId}": hub authorization can't be auto-verified from here ` +
          `right now (the registry read failed — unreachable, or no seed/registry-url configured). If the ` +
          `hub owner has confirmed they applied your authorization on the hub, re-run with ` +
          `\`--hub-authorized-confirmed\`.`,
      };
  }
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
  /** Non-fatal context (a degraded port read, the remote-member leaf-up
   *  caveat) — never blocks the report, always surfaced to the caller. */
  notes: string[];
}

export interface GatherHandoffOptions {
  networkId: string;
  /** The member the report is ABOUT. */
  member: string;
  /**
   * The principal this invocation is running AS. When `member !== selfPrincipal`
   * the leaf-up leg is inherently unobservable from here, so its signal is
   * `undefined` (unknown) instead of a false local `/leafz` read.
   */
  selfPrincipal: string;
}

export interface GatheredHandoffSignals {
  signals: HandoffSignals;
  notes: string[];
}

/**
 * cortex#1485 (Sage #1499) — the SHARED signal-gathering helper both
 * `handoff status` and the `join --guided` guard call, so the two can never
 * derive from different signals. Reads the seal leg (admission `/mine`), the
 * hub-authorize leg (the injected hub-auth port — the documented stub today,
 * the real #1498 read tomorrow, no caller change), and the leaf-up leg (LOCAL
 * `/leafz` only). Never throws — a degraded read becomes a `note` + a
 * fail-closed signal.
 */
export async function gatherHandoffSignals(
  ports: NetworkHandoffPorts,
  opts: GatherHandoffOptions,
): Promise<GatheredHandoffSignals> {
  const notes: string[] = [];
  const isLocal = opts.member === opts.selfPrincipal;

  const admissionRes = await ports.admission.resolve(opts.networkId);
  const sealed = admissionRes.ok && admissionRes.state.hasSealedSecret;
  if (!admissionRes.ok) {
    notes.push(`seal leg: could not read admission state — ${admissionRes.reason}`);
  }

  const hubRes = await ports.hubAuth.resolveHubAuthorized(opts.networkId, opts.member);
  if (hubRes.reason !== undefined) {
    notes.push(`hub-authorize leg: ${hubRes.reason}`);
  }

  let leafUp: boolean | undefined;
  if (!isLocal) {
    // A member's leaf is observable only on the member's OWN machine — never
    // report this machine's leaf as theirs (Sage #1499).
    leafUp = undefined;
    notes.push(
      `leaf-up leg: not observable for member "${opts.member}" from "${opts.selfPrincipal}"'s machine — ` +
        `only the member's own machine can observe its leaf. Reported as unknown.`,
    );
  } else {
    const snapshot = ports.config.readNetworks();
    const network = snapshot.networks.find((n) => n.id === opts.networkId);
    if (network === undefined) {
      leafUp = undefined;
      notes.push(`leaf-up leg: network "${opts.networkId}" is not configured locally yet — reported as unknown`);
    } else {
      const leafz = await ports.monitor.fetchLeafz();
      leafUp = isLeafEstablished(leafz, network);
    }
  }

  return { signals: { sealed, hubAuthorized: hubRes.confirmed, leafUp }, notes };
}

/**
 * Gather all three leg signals via the injected {@link NetworkHandoffPorts},
 * then derive the {@link HandoffState}. The READ half (acceptance point 1);
 * the ENFORCEMENT half is {@link guardLeafUp}, called by whatever wires the
 * leaf-up step (see `network.ts` `runJoin`'s `--guided` preflight, which shares
 * {@link gatherHandoffSignals}).
 */
export async function runHandoffStatus(
  ports: NetworkHandoffPorts,
  opts: GatherHandoffOptions,
): Promise<HandoffReport> {
  const { signals, notes } = await gatherHandoffSignals(ports, opts);
  const state = deriveHandoffState(signals);
  return { networkId: opts.networkId, member: opts.member, state, notes };
}
