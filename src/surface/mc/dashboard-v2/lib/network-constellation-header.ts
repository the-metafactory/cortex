/**
 * MC-D3 (cortex#1290) — pure projection for the constellation canvas HEADER.
 *
 * The constellation star-map carries a per-network header reading
 * `<NETWORK> · <admin|member> · N stacks` (the mockup's `MERIDIAN · … · 2 STACKS`).
 * This adapter projects the `/api/networks` membership DTO (MC-A1) into that
 * header model. It is the SKIN's read of the A-wave truth — it invents nothing.
 *
 * ## Posture vocab (load-bearing — CONTEXT.md §"Network posture (admin vs member)")
 *
 * The header says **admin** / **member**. The design mockup's original on-screen
 * label is renamed to `admin` per the vocabulary migration — the deprecated
 * network-posture word is reserved for the MC authorization-role tier + the NATS
 * account-tree root, never the per-network posture (CONTEXT.md §"Network
 * posture"). The posture is the SAME admin-authoritative determination the Pier
 * queue uses — `isAdminPosture` (an `ok` + `complete` roster read) — REUSED here,
 * not re-derived (one source of truth for "do I admin this network?").
 *
 * ## Aggregate-only (sovereignty — the privacy boundary)
 *
 * A header row carries presence-level AGGREGATES only: the network id, the
 * viewer's posture, a distinct-present-stacks tally, and the A3 confidentiality
 * token. It exposes no session field — so the header (like the rest of a
 * federated peer's projection, ADR-0007) can never become a drill into another
 * principal's session interiors. Full node→session→envelope drill is for the
 * principal's OWN local stacks only; this header is sovereign by construction.
 *
 * Pure + DOM-free → unit-tested without a browser; the component takes the result
 * and renders the header strip.
 */

import type { NetworkMembershipDTO } from "../../api/networks";
import { isAdminPosture } from "./pier-queue-adapter";
import {
  confidentialityBadge,
  type ConfidentialityPostureToken,
} from "./network-membership-adapter";

/** The viewer's stance toward a given network (CONTEXT.md §"Network posture"). */
export type NetworkPosture = "admin" | "member";

/** One network's constellation-header model — a presence-level aggregate. */
export interface ConstellationHeaderNetwork {
  /** The network's id (the header's leading label). */
  networkId: string;
  /**
   * The viewer's per-network posture — `admin` (governs the network: roster,
   * Pier queue, grant/revoke) or `member` (an admitted sovereign peer, no admin
   * affordances). Derived via {@link isAdminPosture}; never the deprecated label.
   */
  posture: NetworkPosture;
  /**
   * Distinct `{principal}/{stack}` pairs observed PRESENT across this network's
   * admitted members. Presence-level aggregate — never a session count. Presence
   * does not confer membership (ADR-0018 Q3); this is "stacks alight right now".
   */
  stackCount: number;
  /**
   * MC-A3 (#1277) confidentiality posture token. The constellation's `K`
   * encryption marker is FINALIZED in D4; D3 renders what A3 already wires
   * (honest — `degraded`/`unknown` are never badged as encrypted).
   */
  confidentiality: ConfidentialityPostureToken;
  /**
   * MC-D4 (#1291) — the per-network payload-key id/epoch (ADR-0019), the
   * mockup's `K7`. `null` when no key is held (off / degraded / unknown), so the
   * skin shows the epoch ONLY alongside a genuinely-sealed marker — never a key
   * label without a held key (the A3 honesty hinge, carried up to the header).
   */
  keyId: string | null;
}

/** Count distinct `{principal}/{stack}` pairs observed present across members. */
function countDistinctPresentStacks(net: NetworkMembershipDTO): number {
  const seen = new Set<string>();
  for (const m of net.members) {
    for (const stack of m.present_stacks) {
      seen.add(`${m.principal}/${stack}`);
    }
  }
  return seen.size;
}

/**
 * Project the `/api/networks` DTO into the constellation header model — one row
 * per joined network, in input order. Empty in → empty out (a non-federated
 * stack renders no header). Pure; does not mutate its input.
 */
export function buildConstellationHeader(
  networks: readonly NetworkMembershipDTO[],
): ConstellationHeaderNetwork[] {
  return networks.map((net) => {
    const posture = confidentialityBadge(net.confidentiality).posture;
    // Carry the key-id ONLY when a key is genuinely held (sealed posture). For
    // off/degraded/unknown there is no live key, so no epoch is shown — the A3
    // honesty hinge, preserved up to the header (never a key label sans key).
    const sealed = posture === "encrypted" || posture === "encrypted-required";
    return {
      networkId: net.network_id,
      posture: isAdminPosture(net) ? "admin" : "member",
      stackCount: countDistinctPresentStacks(net),
      confidentiality: posture,
      keyId: sealed ? (net.confidentiality?.key_id ?? null) : null,
    };
  });
}
