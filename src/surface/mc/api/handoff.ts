/**
 * FLG-1 (docs/plan-mc-future-state.md §4.D) — `GET /api/networks/:net/handoff/:member`.
 *
 * Surfaces the guided-join **two-party handoff** (epic #1479's pure
 * `deriveHandoffState`, cortex#1485) on the glass — the model shipped with ZERO
 * MC call sites; this endpoint is the first. A network join is a 3-leg handoff
 * across ≤3 people/machines:
 *
 *     seal (admin) → hub-authorize (hub owner) → leaf-up (member)
 *
 * The read reports each leg's status + owner, WHOSE MOVE is next (`next_owner`),
 * and — when the leaf-up leg is blocked — WHY (`leaf_up_blocked_reason` ∈
 * {seal-pending, hub-unverifiable, hub-denied}). The daemon signs/mutates
 * nothing here; it is a pure projection of the injected leg signals.
 *
 * ## No-interiors discipline (plan invariant 1 — the DashboardSnapshot guard)
 *
 * The plan routes every new cockpit/aggregation READ through the worker-scoped
 * `DashboardSnapshot` no-interiors guard. That guard is the CF worker's SHAPE
 * contract on the public `/api/state` projection
 * (`worker/src/routes/state.ts` + `dashboard-snapshot-contract.test.ts`); this
 * endpoint is a DAEMON read, so the equivalent enforcement is (a) the
 * metadata-only {@link HandoffStatusDTO} below and (b) the daemon-side SHAPE
 * contract test (`__tests__/handoff-contract.test.ts`) — the direct analog of
 * the worker's. The DTO carries ONLY lifecycle metadata: leg statuses, owners,
 * the next-owner + blocked-reason, and human-readable notes/details. No session
 * interior, and — critically — no secret material: the seal leg is a BOOLEAN
 * "is a leaf secret sealed?" signal, NEVER the sealed ciphertext / K / a PSK
 * (secret-material discipline, invariant 6). "Never beside it" ⇒ the read flows
 * through the SAME {@link HandoffView} seam `cortex.ts` wires, not a fresh
 * unguarded registry/bus path opened inside the surface layer.
 *
 * ## Three-valued attestation (plan invariant 9 — Sage #1499)
 *
 * The glass "confirmed" toggle (`?confirmed=true`) maps to the member ATTESTATION
 * that `deriveHandoffState({ attested })` accepts. The pure model's
 * `hubAuthorizeDone` upgrades ONLY an `undefined` hub-authorize signal to
 * treated-done — NEVER a real `false`. So a hub-DENIED network stays blocked
 * even when the glass sends `confirmed=true`; the attestation is a
 * degraded-connectivity confirmation, not a naive boolean override. This handler
 * is a thin wrapper: it adds no boolean check of its own — the guarantee lives in
 * the model, and the contract test asserts it end-to-end.
 *
 * ## Dependency direction (surface must not import the bus)
 *
 * Like `/api/networks`, the server depends only on the minimal {@link HandoffView}
 * seam + the PURE `deriveHandoffState`; `cortex.ts` adapts the live signal
 * gathering (`gatherHandoffSignals` + the live ports) to it at boot. The surface
 * imports the pure model + types only — never the ports/adapters/bus.
 */

import {
  deriveHandoffState,
  type HandoffSignals,
  type HandoffLegId,
  type HandoffLegStatus,
  type HandoffOwner,
  type LeafUpBlockedReason,
} from "../../../cli/cortex/commands/network-handoff-lib";

export type { HandoffLegId, HandoffLegStatus, HandoffOwner, LeafUpBlockedReason };

/**
 * The raw 3-leg signals for one `(network, member)`, plus non-fatal degradation
 * notes. Byte-shape-identical to the CLI's `GatheredHandoffSignals` (the shared
 * `gatherHandoffSignals` return) so `cortex.ts` can hand its result straight
 * through — never re-derived here.
 */
export interface HandoffSignalsResult {
  signals: HandoffSignals;
  /** Non-fatal context (a degraded port read, the remote-member caveat). Never secrets. */
  notes: string[];
}

/**
 * The minimal read-only seam the MC server depends on to serve the handoff
 * endpoint. `cortex.ts` supplies a live implementation (gathering the 3 leg
 * signals via the shared `gatherHandoffSignals` + live ports); tests supply a
 * stub. `null` (no federation/registry) → the route 503s honestly.
 */
export interface HandoffView {
  /** The serving (local) principal — the member the roster banner reports on. */
  localPrincipal: string;
  /**
   * Gather the 3 leg signals for `member` on `networkId`. NEVER throws (a
   * degraded read becomes a fail-closed signal + a note — the
   * `gatherHandoffSignals` contract). Resolves to `null` when `networkId` is not
   * a network this stack has joined.
   */
  resolveHandoffSignals(
    networkId: string,
    member: string,
  ): Promise<HandoffSignalsResult | null>;
}

/** One leg of the handoff, snake_case for the wire DTO. */
export interface HandoffLegDTO {
  id: HandoffLegId;
  title: string;
  status: HandoffLegStatus;
  owner: HandoffOwner;
  detail: string;
}

/**
 * `GET /api/networks/:net/handoff/:member` response body — metadata ONLY (the
 * no-interiors DTO; see the module doc + `__tests__/handoff-contract.test.ts`).
 */
export interface HandoffStatusDTO {
  network_id: string;
  member: string;
  /** Always exactly 3 legs, in `seal → hub-authorize → leaf-up` order. */
  legs: HandoffLegDTO[];
  /** The next outstanding leg's id ("whose move"), or `null` when every leg is done. */
  next_leg: HandoffLegId | null;
  /** The owner of {@link next_leg}, or `null` when done. */
  next_owner: HandoffOwner | null;
  /** `true` only when seal is done AND hub-authorize is effectively done. */
  can_bring_leaf_up: boolean;
  /** Why leaf-up is blocked, or `null` when it is not. */
  leaf_up_blocked_reason: LeafUpBlockedReason | null;
  /**
   * Whether the hub-authorize signal is `undefined` (un-auto-verifiable) and can
   * therefore be raised by the member attestation. This is the ONLY state in
   * which the glass may offer the "confirm" toggle: a real `false` (hub-denied)
   * has `hub_attestable === false`, so the UI never presents an override for a
   * hard negative (Sage #1499). Derived from the RAW signal, not the leg status.
   */
  hub_attestable: boolean;
  /**
   * Whether the member "confirmed" attestation was requested. Echoes the
   * `?confirmed=` toggle — the LEGS reflect whether it actually took effect (an
   * `undefined` hub leg upgrades; a real `false` never does).
   */
  attested: boolean;
  /** Non-fatal degradation context (never secrets/interiors). */
  notes: string[];
}

export interface HandleGetHandoffOpts {
  networkId: string;
  member: string;
  /**
   * The glass "confirmed" toggle → the member attestation. Fail-closed: only an
   * explicit `true` attests; the model upgrades an `undefined` hub-authorize
   * signal to done, NEVER a real `false` (Sage #1499).
   */
  confirmed: boolean;
}

/**
 * Handle `GET /api/networks/:net/handoff/:member`.
 *
 * `view === null` → 503 (no federation configured — honest). Unknown network →
 * 404. Otherwise gather the leg signals (never-throw) and wrap the PURE
 * `deriveHandoffState`, mapping the `confirmed` toggle to the attestation. Never
 * a 5xx-splat: the signal gathering is never-throw and the derive is pure; the
 * catch is a structural belt-and-braces (same posture as `handleListNetworks`).
 */
export async function handleGetHandoff(
  view: HandoffView | null,
  opts: HandleGetHandoffOpts,
): Promise<Response> {
  try {
    if (view === null) {
      return Response.json(
        {
          error:
            "handoff status unavailable — no federation/registry configured on this stack",
        },
        { status: 503 },
      );
    }

    const gathered = await view.resolveHandoffSignals(opts.networkId, opts.member);
    if (gathered === null) {
      return Response.json(
        { error: `network "${opts.networkId}" is not one this stack has joined` },
        { status: 404 },
      );
    }

    // The 3-valued attestation (Sage #1499): `confirmed` maps to `attested`,
    // which `deriveHandoffState` upgrades an `undefined` hub-authorize signal
    // with — but NEVER a real `false`. This handler adds no boolean override of
    // its own; the model is the guard. A hub-denied network therefore stays
    // blocked here even under `confirmed=true`.
    const state = deriveHandoffState(gathered.signals, { attested: opts.confirmed });

    const dto: HandoffStatusDTO = {
      network_id: opts.networkId,
      member: opts.member,
      legs: state.legs.map((l) => ({
        id: l.id,
        title: l.title,
        status: l.status,
        owner: l.owner,
        detail: l.detail,
      })),
      next_leg: state.nextLeg ?? null,
      next_owner: state.nextOwner ?? null,
      can_bring_leaf_up: state.canBringLeafUp,
      leaf_up_blocked_reason: state.leafUpBlockedReason ?? null,
      // Derived from the RAW hub-authorize signal — `undefined` (un-verifiable)
      // is the only attestable state. A real `false` is NOT attestable, so the
      // glass never offers a "confirm" override for a hard hub denial (Sage
      // #1499). Independent of `confirmed`: a member toggling confirm off must
      // still see the toggle, so this reflects the signal, not the leg status.
      hub_attestable: gathered.signals.hubAuthorized === undefined,
      attested: opts.confirmed,
      notes: gathered.notes,
    };

    return Response.json(dto);
  } catch (err) {
    process.stderr.write(
      `[api] GET /api/networks/:net/handoff/:member failed: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return Response.json(
      {
        error: `Failed to resolve handoff status: ${err instanceof Error ? err.message : String(err)}`,
      },
      { status: 500 },
    );
  }
}
