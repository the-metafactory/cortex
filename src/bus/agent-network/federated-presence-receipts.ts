/**
 * FS-6 (cortex#1821) — per-peer FEDERATED-PRESENCE RECEIPT ledger.
 *
 * The single distinction that turns a 2-day andreas⇄jc federation hunt into a
 * 5-minute one: an admitted-but-not-present peer is either
 *
 *   - **offline** — we HAVE received its federated presence before; it has since
 *     gone stale (the peer's stack went away), OR
 *   - **unheard** — we have NEVER received a single `federated.{peer}.{stack}.agent.*`
 *     envelope from it. The peer may be perfectly healthy; WE are deaf to it — an
 *     import / cred / accept-list gap (the cortex#1812 root-cause class).
 *
 * The system already KNOWS which: the federated-presence subscriber sees zero
 * inbound envelopes for an unheard peer and a non-zero stream for a heard one. It
 * just never SAID so. This ledger is where it says so.
 *
 * ## What it counts (the FS-6 acceptance boundary)
 *
 * EVERY `federated.{principal}.{stack}.agent.*` envelope that REACHES the
 * subscriber for a peer principal is recorded here — **folded OR gated**. We
 * record it BEFORE the accept-list / chain-verify gates run, so a peer we can
 * physically hear on the wire but that the gate later DROPS (denied subject,
 * over-hop, un-accept-listed) is still "heard", not "unheard". That is the honest
 * signal: "unheard" must mean *nothing arrived on the wire at all* (an import/cred
 * gap), not *arrived-but-policy-dropped* (a config choice the roster already
 * surfaces elsewhere). Conflating the two would re-hide the exact bug FS-6 exists
 * to expose.
 *
 * ## Identity
 *
 * Keyed by the SOURCE PRINCIPAL (`envelope.source`'s first segment) — the same
 * principal the membership verdict is keyed on (ADR-0018 Q3, roster is
 * principal-keyed). A peer with two stacks that we hear from either counts as one
 * heard principal; that is correct — "have we EVER heard this principal" is a
 * principal-level question. (The subscriber derives the source principal the same
 * way it always has; this ledger never re-parses the wire.)
 *
 * ## Read path
 *
 * The MC `/api/networks` verdict projection reads {@link everReceived} through the
 * `NetworksView.receivedPresenceFrom` seam (wired in `cortex.ts`). Pure state, no
 * bus, no I/O — trivially unit-testable by calling {@link record} directly.
 */

/** One peer principal's received-presence receipt. */
export interface FederatedPresenceReceipt {
  /**
   * Count of `federated.{principal}.{stack}.agent.*` envelopes ever seen from
   * this peer principal (folded OR gated). A monotonic tally — never decremented.
   */
  count: number;
  /**
   * Epoch-ms (receiver clock) the most recent envelope from this peer was seen.
   * The receiver's observation time, NOT any wire timestamp.
   */
  lastAt: number;
}

/**
 * In-memory per-peer received-presence ledger. Owned by the federated-presence
 * subscriber; read by the MC verdict projection. A pure tally — no eviction (a
 * heard peer stays "heard" for the life of the process; that is the intended
 * semantics — "unheard" is about NEVER having heard, and a peer that goes stale
 * is "offline", surfaced by the ABSENCE of live presence, not by forgetting we
 * heard it).
 */
export class FederatedPresenceReceipts {
  private readonly receipts = new Map<string, FederatedPresenceReceipt>();

  /**
   * Record one received federated-presence envelope from `principal` at `atMs`
   * (receiver clock). Increments the count and advances `lastAt` to the max of
   * the current and the new observation (so an out-of-order older observation
   * never rewinds `lastAt`). Idempotent in shape — every call bumps the count.
   */
  record(principal: string, atMs: number): void {
    const existing = this.receipts.get(principal);
    if (existing === undefined) {
      this.receipts.set(principal, { count: 1, lastAt: atMs });
      return;
    }
    existing.count += 1;
    if (atMs > existing.lastAt) existing.lastAt = atMs;
  }

  /**
   * True when we have EVER received a federated-presence envelope from this peer
   * principal. The FS-6 hinge: `false` ⇒ `absent-unheard` (import/cred gap);
   * `true` + not-present ⇒ `absent-offline` (heard, went away).
   */
  everReceived(principal: string): boolean {
    return this.receipts.has(principal);
  }

  /** The full receipt for a peer principal, or `undefined` when never heard. */
  get(principal: string): FederatedPresenceReceipt | undefined {
    const r = this.receipts.get(principal);
    return r ? { ...r } : undefined;
  }

  /** Snapshot of every heard principal → its receipt (copies — caller-safe). */
  snapshot(): Map<string, FederatedPresenceReceipt> {
    const out = new Map<string, FederatedPresenceReceipt>();
    for (const [principal, r] of this.receipts) out.set(principal, { ...r });
    return out;
  }
}
