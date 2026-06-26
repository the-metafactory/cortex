/**
 * cortex#1213 — rate-limit / dedupe for `system.access.denied` audit emits.
 *
 * ## Why
 *
 * A federated stack publishes its OWN presence onto `federated.{us}.agent.>`
 * (so peers see it) which loops back to its own federated subscriber. Before
 * the cortex#1213 self short-circuit that loopback was denied + audited on
 * EVERY heartbeat tick — flooding `local.{principal}.{stack}.system.access.denied`
 * with an identical envelope. The self short-circuit kills the loopback at the
 * root; THIS helper is the defence-in-depth backstop: any genuinely-repeated
 * denial (a real foreign peer that is misconfigured, a relay that keeps
 * re-sending) is AUDITED — security is preserved — but can never FLOOD the bus.
 *
 * ## Contract
 *
 * A denial is identified by the tuple `(capability, subject, reason, source)`.
 * The FIRST occurrence of a tuple emits; identical occurrences inside the
 * window are suppressed (counted); the first occurrence AFTER the window
 * elapses emits a rollup carrying the suppressed count, then the window
 * restarts. So a tuple denied every 30 s with a 60 s window emits at most
 * roughly once per 60 s, regardless of tick rate — the audit stays present
 * (governance still sees it) but bounded.
 *
 * `firstSeen` is `true` exactly once per distinct tuple (until eviction); it
 * drives the principal-facing "bubble up" WARN — surfaced ONCE, not per-tick.
 *
 * Pure + clock-injectable so it is deterministically unit-testable; it does
 * NOT emit anything itself (callers own the `runtime.publish`), it only
 * decides whether a caller SHOULD emit.
 */

/** The tuple a denial is deduped on. */
export interface DenialIdentity {
  /** Capability / intent the gate evaluated (e.g. `federated.subject_dispatch`). */
  capability: string;
  /** Subject the denied envelope arrived on. */
  subject: string;
  /** Structured reason `kind` (e.g. `peer_not_in_accept_list`). */
  reason: string;
  /** Source principal of the denied envelope (the actor being denied). */
  source: string;
}

/** The dedup decision for a single denial occurrence. */
export interface DenialDecision {
  /** Whether the caller should publish the `system.access.denied` audit now. */
  emit: boolean;
  /**
   * `true` the very FIRST time this tuple is seen (until eviction). Drives the
   * once-per-tuple principal-facing bubble-up WARN.
   */
  firstSeen: boolean;
  /**
   * Identical denials suppressed since the last emit. `0` on the first emit;
   * `> 0` on a rollup emit (so the rollup audit / log can say "+N suppressed").
   */
  suppressed: number;
}

/** Construction options — all optional; defaults match the cortex#1213 ask. */
export interface AccessDeniedDeduperOptions {
  /**
   * Suppression window in ms. Default 60 000 (1 min): an identical denial
   * emits at most once per minute. Small enough that a real misconfig still
   * surfaces promptly, large enough that a per-tick (≈30 s) heartbeat can
   * never flood.
   */
  windowMs?: number;
  /** Injectable monotonic-ish clock (tests). Defaults to `Date.now`. */
  now?: () => number;
  /**
   * Soft cap on tracked tuples. When exceeded, entries whose window has
   * already elapsed are pruned (a denial that hasn't recurred within the
   * window is, by definition, not flooding). Bounds memory for a pathological
   * spread of distinct denial tuples. Default 4096.
   */
  maxEntries?: number;
}

interface Entry {
  /** Last time we EMITTED for this tuple. */
  lastEmitAt: number;
  /** Identical denials suppressed since `lastEmitAt`. */
  suppressed: number;
}

/**
 * Windowed deduper for `system.access.denied` audit emits. One instance per
 * consumer (the federated subscriber owns one); state is per-instance so a
 * test can inject a clock and assert window behaviour without global bleed.
 */
export class AccessDeniedDeduper {
  private readonly windowMs: number;
  private readonly now: () => number;
  private readonly maxEntries: number;
  private readonly entries = new Map<string, Entry>();

  constructor(opts: AccessDeniedDeduperOptions = {}) {
    this.windowMs = opts.windowMs ?? 60_000;
    this.now = opts.now ?? Date.now;
    this.maxEntries = opts.maxEntries ?? 4096;
  }

  /**
   * Decide whether this denial occurrence should be emitted. Mutates internal
   * state (records the emit / increments the suppressed counter).
   */
  decide(id: DenialIdentity): DenialDecision {
    const key = keyOf(id);
    const t = this.now();
    const existing = this.entries.get(key);

    if (existing === undefined) {
      if (this.entries.size >= this.maxEntries) this.prune(t);
      this.entries.set(key, { lastEmitAt: t, suppressed: 0 });
      return { emit: true, firstSeen: true, suppressed: 0 };
    }

    if (t - existing.lastEmitAt >= this.windowMs) {
      // Window elapsed — emit a rollup carrying the suppressed count, restart.
      const suppressed = existing.suppressed;
      existing.lastEmitAt = t;
      existing.suppressed = 0;
      return { emit: true, firstSeen: false, suppressed };
    }

    // Inside the window — suppress (but count, so the next rollup is honest).
    existing.suppressed += 1;
    return { emit: false, firstSeen: false, suppressed: existing.suppressed };
  }

  /** Drop entries whose window has elapsed (they are not flooding). */
  private prune(now: number): void {
    for (const [key, entry] of this.entries) {
      if (now - entry.lastEmitAt >= this.windowMs) this.entries.delete(key);
    }
  }
}

/** Stable map key — ` ` separator can't appear in any of the fields. */
function keyOf(id: DenialIdentity): string {
  return `${id.source} ${id.capability} ${id.subject} ${id.reason}`;
}
