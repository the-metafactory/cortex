/**
 * P2 (cortex#1087, design-roster-driven-federation-wiring §7 P2 + §8 OQ2) — the
 * pure derivation of a network's `accept_subjects` from its roster peer set.
 *
 * ## The gap this closes (OQ2, RESOLVED)
 *
 * `evaluateFederationGate` (`src/bus/surface-router.ts`) admits an inbound
 * `federated.*` envelope only when (1) the SOURCE principal resolves via
 * `peers[]` AND (2) `accept_subjects` contains a pattern matching the SUBJECT.
 * Those two checks are SEPARATE: being in `peers[]` is necessary but NOT
 * sufficient — the accept-list is a second, independent gate keyed on the wire
 * SUBJECT, not on peer membership.
 *
 * Before this slice, `network join` wrote an OWN-only accept-list
 * (`federated.{self.principal}.{self.stack}.>`). That admits inbound DISPATCH
 * (which is RECEIVER-addressed — a peer dispatching TO me publishes onto MY
 * subtree) but REJECTS inbound PRESENCE, which is SOURCE-addressed: the
 * federated presence subscriber binds `federated.*.*.agent.>` where segment[1]
 * is the SOURCE peer principal (ADR-0007). So `jc`'s
 * `federated.jc.{stack}.agent.online` never matches an OWN-only
 * `federated.andreas.meta-factory.>` accept-list — it is denied at gate step 3
 * even though `jc ∈ peers[]`. The accept-list IS the gate; widening it is the fix.
 *
 * ## Dual-grammar (honour BOTH addressing conventions)
 *
 * Federated subjects carry the wire grammar `federated.{addressee}.{stack}.…`
 * where `{addressee}` means different principals for the two traffic classes:
 *
 *   - **DISPATCH is RECEIVER-addressed** — a peer dispatching work TO me targets
 *     `federated.{ME}.{my-stack}.…`. I accept my OWN subtree.
 *   - **PRESENCE is SOURCE-addressed** — a peer announcing ITS presence publishes
 *     `federated.{PEER}.{peer-stack}.agent.…`. I accept each PEER's subtree.
 *
 * So a correct accept-list legitimately needs BOTH: my own subtree (for inbound
 * dispatch) ∪ one subtree per roster peer (for inbound presence). That union is
 * exactly what {@link deriveAcceptSubjects} produces.
 *
 * ## Empty-roster (#762) — caller's concern, not this function's
 *
 * This is a PURE projection: 0 peers in ⇒ just the own subtree out. It NEVER
 * returns `[]` for a valid `self` (the own subtree is always present), so the
 * accept-list is never accidentally emptied. The #762 "0 resolved peers →
 * preserve hand-pins" guard is a SEPARATE policy decision the `network join`
 * builder makes about the PEERS list; this function does not entangle with it.
 * When the join preserves prior hand-pinned peers, it derives the accept-list
 * from THAT preserved peer set, so the two stay consistent (see network-lib.ts).
 *
 * ## Signal-optional (design §4, hard constraint)
 *
 * Pure over its inputs — no registry, no filesystem, no `signal` import. It
 * consumes the minimal `{principal, stack}` wire view (structurally satisfied by
 * the P1 {@link RosterPeer} projection from the verified roster, and by the
 * config-peer view the `network join` builder writes); whoever resolved that
 * roster (the CLI today, the P3 reconciler tomorrow) owns the trust boundary.
 * This is string assembly.
 */

// =============================================================================
// Types
// =============================================================================

/**
 * A wire identity — the two segments that build a federated subtree
 * `federated.{principal}.{stack}.>`. Used for BOTH the local stack (its own
 * subtree, for inbound dispatch) and each roster peer (its subtree, for inbound
 * presence). Structurally a subset of the P1 `RosterPeer` shape, so a
 * `RosterPeer[]` is accepted directly without an adapter.
 */
export interface FederatedWireIdentity {
  /** Principal id — the `{principal}` wire segment. */
  principal: string;
  /** Stack slug — the `{stack}` wire segment. */
  stack: string;
}

/** The local stack's wire identity — alias for readability at call sites. */
export type AcceptSubjectsSelf = FederatedWireIdentity;

// =============================================================================
// deriveAcceptSubjects
// =============================================================================

/**
 * Derive a network's `accept_subjects` from the local stack identity + its
 * roster peer set, honouring the dual-grammar (design §7 P2):
 *
 *   `[ federated.{self.principal}.{self.stack}.>,           // dispatch TO me
 *      ...federated.{peer.principal}.{peer.stack}.> per peer // presence FROM peers
 *   ]`
 *
 * The own subtree comes FIRST (stable, human-readable ordering: "my subtree,
 * then the peers I accept presence from"), followed by one subtree per peer in
 * roster order. Duplicates are collapsed (a peer that somehow equals the self,
 * or two roster entries with the same principal/stack, contribute the pattern
 * once) so the written accept-list has no redundant rows — `subjectMatches` is
 * order-/duplicate-insensitive, but a clean list reads better in config and in
 * the `network status` view.
 *
 * Pure: no I/O, no mutation of inputs, deterministic. Never returns `[]` for a
 * valid `self` — the own subtree is always present, so this function cannot
 * accidentally empty a stack's accept-list (the OWN-only behaviour it replaces
 * is the degenerate `peers.length === 0` case, preserved exactly).
 *
 * @param self  The local stack's `{principal}`/`{stack}` wire identity.
 * @param peers The network's roster peers (local principal already excluded by
 *              the P1 projection; an accidental self-entry is de-duped anyway).
 */
export function deriveAcceptSubjects(
  self: AcceptSubjectsSelf,
  peers: readonly FederatedWireIdentity[],
): string[] {
  const ownSubtree = federatedSubtree(self.principal, self.stack);

  // Insertion-ordered de-dupe: own subtree first, then each peer's subtree.
  const seen = new Set<string>([ownSubtree]);
  const out: string[] = [ownSubtree];

  for (const peer of peers) {
    const subtree = federatedSubtree(peer.principal, peer.stack);
    if (seen.has(subtree)) continue;
    seen.add(subtree);
    out.push(subtree);
  }

  return out;
}

/**
 * The `federated.{principal}.{stack}.>` subtree wildcard for one wire identity —
 * the single accept-list pattern that admits every federated subject addressed
 * to (dispatch) or sourced from (presence) `{principal}/{stack}`. The terminal
 * `>` matches one-or-more trailing segments (`subjectMatches`, surface-router),
 * covering `…agent.online`, `…tasks.code-review.ts`, and every other action.
 */
function federatedSubtree(principal: string, stack: string): string {
  return `federated.${principal}.${stack}.>`;
}
