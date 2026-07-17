/**
 * R26 P1 (cortex#1371) — the AdmissionGate: the KV-arbitrated distributed
 * token bucket + in-flight lease counter at the spawn gate (design
 * `docs/design-substrate-rate-limiting.md` Design B; contract
 * `myelin/specs/admission.md`, myelin#195).
 *
 * ## What this is
 *
 * `check()` decides whether a policy-ALLOWED dispatch may spawn, keyed on the
 * envelope-resolved requester principal. State lives in a NATS-KV bucket
 * (JetStream-backed — the fabric's own durable layer), arbitrated by
 * compare-and-swap on entry revisions: concurrent admits on the same key
 * serialise through the JetStream leader, so the counters are EXACT under N
 * cortex nodes — no node-local drift, no divide-by-N (§1.5 / Design C
 * rejection).
 *
 * ## Tiers (phase 1 ships 1–2)
 *
 *   1. `stack`      — the global spawn ceiling (`rate.stack`, `inflight.stack`)
 *   2. `principal`  — per-requester (`rate.principal.{id}`, `inflight.principal.{id}`),
 *                     limits resolved principals > roles > defaults
 *                     (`resolveAdmissionLimits`); the anonymous public
 *                     principal is clamped to the built-in ceiling.
 *
 * ## Two-phase evaluation (spec §5.1)
 *
 * Evaluate (read-only — a REFUSED request writes NOTHING, so a flooder can't
 * burn shared tokens or CAS-contend admitted traffic), then commit (CAS per
 * tier, re-validating against the fresh read; a later-tier failure refunds
 * earlier tiers best-effort — errs toward under-admission).
 *
 * ## Failure posture (design §4.3, Q1 sign-off)
 *
 * Store errors DEGRADE to node-local approximate buckets (same pure state
 * functions over process memory) with a LOUD transition event — never
 * silent — and recover on the next successful KV round-trip. The anonymous
 * public principal FAILS CLOSED while degraded: zero-authority traffic never
 * rides the approximate path.
 *
 * ## Inertness
 *
 * The gate is only ever CONSTRUCTED when `policy.admission` is configured
 * (`cortex.ts`); with the block absent the dispatch path carries a single
 * `undefined` check — byte-identical behaviour (the CO-4 rule,
 * `gate-floor.ts:29-37`). Even when constructed, a requester whose resolved
 * tiers carry no limits admits without touching the store.
 */

import type { ProvisionKv, ProvisionKvEntry } from "../jetstream/types";
import type {
  AdmissionLimits,
  AdmissionPolicy,
} from "../../common/types/admission";
import { resolveAdmissionLimits } from "../../common/types/admission";
import { DEFAULT_RATE_RETRY_AFTER_MS } from "../gate-floor";
import type {
  InflightEntry,
  ParsedEntry,
  RateEntry,
  RateWindowName,
} from "./state";
import {
  DEFAULT_LEASE_TTL_MS,
  acquireLease,
  checkInflight,
  checkRate,
  consumeRate,
  encodeEntry,
  parseInflightEntry,
  parseRateEntry,
  pruneInflight,
  refillRateEntry,
  refundRate,
  releaseLease,
} from "./state";

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

/** Tier names shipped in phase 1 (3–4 reserved — myelin spec §3). */
export type AdmissionTierName = "stack" | "principal";

export interface AdmissionCheckRequest {
  /** Bare requester principal id, envelope-resolved (myelin spec §1). */
  principalId: string;
  /** True when the requester resolved to the anonymous public principal. */
  anonymous: boolean;
  /** Lease id for in-flight counters — the dispatch task id. */
  leaseId: string;
}

/**
 * Opaque in-flight lease handle — pass to {@link AdmissionGate.release} when
 * the dispatch terminates (the harness guarantees a terminal lifecycle
 * envelope, so callers release in a `finally`).
 */
export interface AdmissionLease {
  leaseId: string;
  /** In-flight keys that acquired a lease, in acquisition order. */
  keys: string[];
  /** True when acquired against the node-local degraded fallback. */
  local: boolean;
}

export type AdmissionOutcome =
  | { admit: true; lease: AdmissionLease | undefined; degraded: boolean }
  | {
      admit: false;
      /**
       * What refused: a rate window, a concurrency cap, the store itself, or a
       * `malformed_principal` — a principal id that violates the RFC-0010 §3.3
       * key-segment grammar. The first three are TRANSIENT (retry may clear);
       * `malformed_principal` is PERMANENT (retry cannot fix a malformed id) and
       * the dispatch-listener maps it to `policy_denied`/term, never `not_now`.
       */
      reason: "rate" | "concurrency" | "store_error" | "malformed_principal";
      tier: AdmissionTierName;
      key: string;
      /** Refusing window (`per_minute`|`per_hour`|`per_day`) — rate refusals only. */
      window?: RateWindowName;
      limit?: number;
      observed?: number;
      retry_after_ms: number;
      degraded: boolean;
    };

export type DegradeMode = "degraded-local" | "recovered";

export interface AdmissionGateOptions {
  /** The parsed `policy.admission` block. */
  config: AdmissionPolicy;
  /**
   * The provisioned KV bucket, or `null` when provisioning failed / the
   * runtime is disabled — the gate then runs PERMANENTLY degraded (loud).
   */
  kv: ProvisionKv | null;
  /** Principal id → role ids, from `policy.principals[].role` (tier-2 resolution). */
  principalRoles: ReadonlyMap<string, readonly string[]>;
  /**
   * Degrade-posture transition hook — `cortex.ts` wires this to publish the
   * loud `system.admission.degraded` envelope (design §4.4: transitions MUST
   * be loud, and are emitted per TRANSITION, never per request). The gate
   * additionally writes stderr on every transition regardless.
   */
  onDegradeTransition?: (mode: DegradeMode, detail: string) => void;
  /** Injectable clock (ms epoch) — tests drive window rollover with this. */
  clock?: () => number;
  /** Bounded CAS retry attempts per key (spec §5 RECOMMENDED 3). */
  casAttempts?: number;
  /** Orphan-lease TTL (spec §4.2). */
  leaseTtlMs?: number;
  log?: { warn: (msg: string) => void };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/** A tier with resolved limits + its KV keys (myelin spec §3 grammar). */
interface ResolvedTier {
  tier: AdmissionTierName;
  limits: AdmissionLimits;
  rateKey: string;
  inflightKey: string;
}

/**
 * RFC-0010 §3.3 / Appendix A `key-segment` — lowercase kebab (`[a-z0-9-]`), a
 * strict subset of the NATS KV key alphabet. The charset is VALIDATED, NEVER
 * COERCED (the RFC-0006 D15 carve, landed in RFC-0010): silent normalisation
 * (uppercasing, `_`→`-`, truncation) maps distinct principals onto one KV key,
 * merging their counters — a correctness and isolation failure (§6). cortex
 * historically coerced here (`s.replace(/[^a-zA-Z0-9_-]/g,"-")`, admitting
 * `A-Z`/`_`); cortex#2189 (myelin#235 W5) brings it to spec.
 */
const KEY_SEGMENT_RE = /^[a-z0-9-]+$/;

/**
 * Thrown when a principal id is not a valid RFC-0010 §3.3 `key-segment`. A
 * malformed principal cannot be safely keyed — coercion is forbidden — so the
 * dispatch is REFUSED (permanently), never admitted onto a coerced,
 * counter-merging key. Caught by `check()` and mapped to a permanent
 * `malformed_principal` refusal; never escapes the gate.
 */
export class AdmissionKeyError extends Error {
  readonly segment: string;
  constructor(segment: string) {
    super(
      `admission key segment violates RFC-0010 §3.3 key-segment grammar ` +
        `(lowercase [a-z0-9-], validated-never-coerced): ${JSON.stringify(segment)}`,
    );
    this.name = "AdmissionKeyError";
    this.segment = segment;
  }
}

/** Validate a principal id as an RFC-0010 §3.3 `key-segment` (reject, never
 * coerce). Returns the id verbatim when valid; throws {@link AdmissionKeyError}
 * otherwise. The `admissionKeyPrincipalSegment` conformance operation (RFC §8). */
function keySegment(s: string): string {
  if (!KEY_SEGMENT_RE.test(s)) throw new AdmissionKeyError(s);
  return s;
}

function hasRateLimits(limits: AdmissionLimits): boolean {
  return (
    limits.per_minute !== undefined ||
    limits.per_hour !== undefined ||
    limits.per_day !== undefined
  );
}

/** Internal signal: the KV store failed (I/O error, CAS exhaustion, or an
 * entry newer than this build understands). Caught by `check()`/`release()`
 * and mapped to the failure posture — never escapes the gate. */
class AdmissionStoreError extends Error {}

interface ReadState<T> {
  /** Parsed state, or `undefined` when absent / tombstoned / corrupt. */
  state: T | undefined;
  /** Live revision to CAS against; `null` when the key has never existed. */
  revision: number | null;
}

export class AdmissionGate {
  private readonly config: AdmissionPolicy;
  private readonly kv: ProvisionKv | null;
  private readonly principalRoles: ReadonlyMap<string, readonly string[]>;
  private readonly onDegradeTransition:
    | ((mode: DegradeMode, detail: string) => void)
    | undefined;
  private readonly clock: () => number;
  private readonly casAttempts: number;
  private readonly leaseTtlMs: number;
  private readonly log: { warn: (msg: string) => void };

  /** True while operating on the node-local approximate fallback. */
  private degraded = false;
  /** Node-local approximate state (degraded posture only). */
  private readonly localRate = new Map<string, RateEntry>();
  private readonly localInflight = new Map<string, InflightEntry>();

  constructor(opts: AdmissionGateOptions) {
    this.config = opts.config;
    this.kv = opts.kv;
    this.principalRoles = opts.principalRoles;
    this.onDegradeTransition = opts.onDegradeTransition;
    this.clock = opts.clock ?? Date.now;
    this.casAttempts = opts.casAttempts ?? 3;
    this.leaseTtlMs = opts.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS;
    this.log = opts.log ?? {
      warn: (msg: string) => process.stderr.write(`${msg}\n`),
    };
  }

  /**
   * Decide admission for a policy-allowed dispatch. Never throws — every
   * failure resolves to a decision per the §4.3 posture.
   */
  async check(req: AdmissionCheckRequest): Promise<AdmissionOutcome> {
    let tiers: ResolvedTier[];
    try {
      tiers = this.resolveTiers(req);
    } catch (err) {
      if (err instanceof AdmissionKeyError) {
        // A principal id that violates the §3.3 key-segment grammar cannot be
        // safely keyed (coercion is forbidden — it would merge counters).
        // PERMANENT refusal; never touches the store, never rides the degraded
        // fallback. See `malformedPrincipalRefusal`.
        return this.malformedPrincipalRefusal(err);
      }
      throw err;
    }
    // Nothing configured for this requester ⇒ inert: admit without touching
    // the store (and without flipping any degrade state).
    if (tiers.length === 0) {
      return { admit: true, lease: undefined, degraded: false };
    }
    const nowMs = this.clock();

    if (this.kv !== null) {
      try {
        const outcome = await this.checkDistributed(tiers, req, nowMs);
        this.noteRecovered();
        return outcome;
      } catch (err) {
        if (!(err instanceof AdmissionStoreError)) {
          // Unexpected fault — same posture as a store error, but say so.
          this.log.warn(
            `admission-gate: unexpected fault during KV check (${err instanceof Error ? err.message : String(err)}) — taking store-error posture`,
          );
        }
        this.noteDegraded(
          err instanceof Error ? err.message : String(err),
        );
      }
    } else {
      this.noteDegraded("admission KV bucket unavailable since boot");
    }

    // ---- Degraded posture (design §4.3, Q1) ----
    if (req.anonymous) {
      // Anonymous FAILS CLOSED: zero-authority traffic never rides the
      // approximate path. Transient refusal — the store may recover.
      const firstTier = tiers[0];
      return {
        admit: false,
        reason: "store_error",
        tier: firstTier !== undefined ? firstTier.tier : "principal",
        key: firstTier !== undefined ? firstTier.rateKey : "rate.principal.public",
        retry_after_ms: DEFAULT_RATE_RETRY_AFTER_MS,
        degraded: true,
      };
    }
    return this.checkLocal(tiers, req, nowMs);
  }

  /**
   * Release an in-flight lease. Idempotent; NEVER throws — a release failure
   * must not fail the dispatch it trails (orphans are pruned by the lease
   * TTL, spec §4.2).
   */
  async release(lease: AdmissionLease): Promise<void> {
    for (const key of lease.keys) {
      if (lease.local || this.kv === null) {
        const entry = this.localInflight.get(key);
        if (entry !== undefined) {
          this.localInflight.set(key, releaseLease(entry, lease.leaseId));
        }
        continue;
      }
      try {
        await this.releaseDistributed(key, lease.leaseId);
      } catch (err) {
        // Logged, not rethrown: the TTL prune self-heals the orphan.
        this.log.warn(
          `admission-gate: lease release failed on "${key}" (lease=${lease.leaseId}): ${err instanceof Error ? err.message : String(err)} — orphan will TTL-prune`,
        );
      }
    }
  }

  // -------------------------------------------------------------------------
  // Tier resolution
  // -------------------------------------------------------------------------

  private resolveTiers(req: AdmissionCheckRequest): ResolvedTier[] {
    const tiers: ResolvedTier[] = [];
    if (this.config.stack !== undefined) {
      tiers.push({
        tier: "stack",
        limits: this.config.stack,
        rateKey: "rate.stack",
        inflightKey: "inflight.stack",
      });
    }
    const principalLimits = resolveAdmissionLimits(this.config, {
      principalId: req.principalId,
      anonymous: req.anonymous,
      roles: this.principalRoles.get(req.principalId) ?? [],
    });
    if (principalLimits !== undefined) {
      const seg = keySegment(req.principalId);
      tiers.push({
        tier: "principal",
        limits: principalLimits,
        rateKey: `rate.principal.${seg}`,
        inflightKey: `inflight.principal.${seg}`,
      });
    }
    return tiers;
  }

  // -------------------------------------------------------------------------
  // Distributed (KV/CAS) path — myelin spec §5
  // -------------------------------------------------------------------------

  private async checkDistributed(
    tiers: ResolvedTier[],
    req: AdmissionCheckRequest,
    nowMs: number,
  ): Promise<AdmissionOutcome> {
    // ---- Phase A: evaluate, READ-ONLY (spec §5.1). First refusal in tier
    // order wins and nothing is written anywhere. ----
    for (const tier of tiers) {
      if (hasRateLimits(tier.limits)) {
        const read = await this.readRate(tier.rateKey);
        const refilled = refillRateEntry(read.state, tier.limits, nowMs);
        const verdict = checkRate(refilled, tier.limits);
        if (!verdict.ok) {
          return this.rateRefusal(tier, verdict, false);
        }
      }
      if (tier.limits.max_concurrent !== undefined) {
        const read = await this.readInflight(tier.inflightKey);
        const pruned = pruneInflight(read.state, nowMs, this.leaseTtlMs);
        const verdict = checkInflight(pruned, tier.limits.max_concurrent);
        if (!verdict.ok) {
          return this.inflightRefusal(tier, verdict, false);
        }
      }
    }

    // ---- Phase B: commit, CAS per key, re-validating each fresh read. A
    // later-tier refusal / exhaustion refunds earlier tiers (best-effort —
    // errs toward under-admission). ----
    const committedRate: ResolvedTier[] = [];
    const leaseKeys: string[] = [];
    try {
      for (const tier of tiers) {
        if (hasRateLimits(tier.limits)) {
          const verdict = await this.commitRate(tier, nowMs);
          if (verdict !== null) {
            await this.rollback(committedRate, leaseKeys, req.leaseId, nowMs);
            return verdict;
          }
          committedRate.push(tier);
        }
        if (tier.limits.max_concurrent !== undefined) {
          const verdict = await this.commitLease(tier, req.leaseId, nowMs);
          if (verdict !== null) {
            await this.rollback(committedRate, leaseKeys, req.leaseId, nowMs);
            return verdict;
          }
          leaseKeys.push(tier.inflightKey);
        }
      }
    } catch (err) {
      // Store failure mid-commit: compensate what we consumed, then let the
      // caller take the degraded posture for the WHOLE request.
      await this.rollback(committedRate, leaseKeys, req.leaseId, nowMs);
      throw err;
    }

    return {
      admit: true,
      lease:
        leaseKeys.length > 0
          ? { leaseId: req.leaseId, keys: leaseKeys, local: false }
          : undefined,
      degraded: false,
    };
  }

  /** Commit one token consumption on a tier's rate key. `null` = committed;
   * a refusal decision = the fresh re-read refused (lost the race). */
  private async commitRate(
    tier: ResolvedTier,
    nowMs: number,
  ): Promise<AdmissionOutcome | null> {
    for (let attempt = 0; attempt < this.casAttempts; attempt++) {
      const read = await this.readRate(tier.rateKey);
      const refilled = refillRateEntry(read.state, tier.limits, nowMs);
      const verdict = checkRate(refilled, tier.limits);
      if (!verdict.ok) return this.rateRefusal(tier, verdict, false);
      const consumed = consumeRate(refilled, tier.limits);
      if (await this.casWrite(tier.rateKey, encodeEntry(consumed), read.revision)) {
        return null;
      }
      // CAS lost — another node admitted concurrently; re-read and retry.
    }
    throw new AdmissionStoreError(
      `CAS retries exhausted on "${tier.rateKey}" (${this.casAttempts} attempts)`,
    );
  }

  /** Commit a lease acquisition on a tier's in-flight key. */
  private async commitLease(
    tier: ResolvedTier,
    leaseId: string,
    nowMs: number,
  ): Promise<AdmissionOutcome | null> {
    const maxConcurrent = tier.limits.max_concurrent;
    if (maxConcurrent === undefined) return null;
    for (let attempt = 0; attempt < this.casAttempts; attempt++) {
      const read = await this.readInflight(tier.inflightKey);
      const pruned = pruneInflight(read.state, nowMs, this.leaseTtlMs);
      const verdict = checkInflight(pruned, maxConcurrent);
      if (!verdict.ok) return this.inflightRefusal(tier, verdict, false);
      const acquired = acquireLease(pruned, leaseId, nowMs);
      if (
        await this.casWrite(tier.inflightKey, encodeEntry(acquired), read.revision)
      ) {
        return null;
      }
    }
    throw new AdmissionStoreError(
      `CAS retries exhausted on "${tier.inflightKey}" (${this.casAttempts} attempts)`,
    );
  }

  /** Best-effort compensation when a later tier aborts a partially-committed
   * admit (spec §5.1): refund consumed tokens, release acquired leases. A
   * failed refund is logged and dropped — under-admission is the safe
   * direction and self-corrects on refill / TTL prune. */
  private async rollback(
    committedRate: ResolvedTier[],
    leaseKeys: string[],
    leaseId: string,
    nowMs: number,
  ): Promise<void> {
    for (const tier of committedRate) {
      try {
        const read = await this.readRate(tier.rateKey);
        const refilled = refillRateEntry(read.state, tier.limits, nowMs);
        const refunded = refundRate(refilled, tier.limits);
        await this.casWrite(tier.rateKey, encodeEntry(refunded), read.revision);
      } catch (err) {
        this.log.warn(
          `admission-gate: rate refund failed on "${tier.rateKey}": ${err instanceof Error ? err.message : String(err)} — under-admission self-corrects on refill`,
        );
      }
    }
    for (const key of leaseKeys) {
      try {
        await this.releaseDistributed(key, leaseId);
      } catch (err) {
        this.log.warn(
          `admission-gate: lease rollback failed on "${key}": ${err instanceof Error ? err.message : String(err)} — orphan will TTL-prune`,
        );
      }
    }
  }

  private async releaseDistributed(key: string, leaseId: string): Promise<void> {
    for (let attempt = 0; attempt < this.casAttempts; attempt++) {
      const read = await this.readInflight(key);
      if (read.state === undefined) return; // nothing to release
      const released = releaseLease(read.state, leaseId);
      if (released.leases.length === read.state.leases.length) return; // absent — idempotent no-op
      if (await this.casWrite(key, encodeEntry(released), read.revision)) {
        return;
      }
    }
    throw new AdmissionStoreError(
      `CAS retries exhausted releasing lease on "${key}"`,
    );
  }

  // -------------------------------------------------------------------------
  // KV plumbing
  // -------------------------------------------------------------------------

  private async kvGet(key: string): Promise<ProvisionKvEntry | null> {
    if (this.kv === null) throw new AdmissionStoreError("KV unavailable");
    try {
      return await this.kv.get(key);
    } catch (err) {
      throw new AdmissionStoreError(
        `KV get("${key}") failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private async readRate(key: string): Promise<ReadState<RateEntry>> {
    const entry = await this.kvGet(key);
    return this.decodeRead(key, entry, parseRateEntry);
  }

  private async readInflight(key: string): Promise<ReadState<InflightEntry>> {
    const entry = await this.kvGet(key);
    return this.decodeRead(key, entry, parseInflightEntry);
  }

  private decodeRead<T>(
    key: string,
    entry: ProvisionKvEntry | null,
    parse: (bytes: Uint8Array) => ParsedEntry<T>,
  ): ReadState<T> {
    if (entry === null) return { state: undefined, revision: null };
    // A DEL/PURGE tombstone carries a live revision but no value — treat the
    // VALUE as absent while CAS-ing against the tombstone's revision.
    if (entry.operation !== "PUT") {
      return { state: undefined, revision: entry.revision };
    }
    const parsed = parse(entry.value);
    if (parsed.kind === "newer") {
      // An entry from a NEWER contract version — never guess (spec §4);
      // surface as a store error so the posture machinery decides.
      throw new AdmissionStoreError(
        `entry "${key}" carries a newer admission-contract version than this build understands`,
      );
    }
    if (parsed.kind === "corrupt") {
      // Self-healing: treat as fresh state and overwrite on the next commit
      // (spec §4) — but SAY so, corruption is never silent.
      this.log.warn(
        `admission-gate: corrupt entry at "${key}" (rev=${entry.revision}) — treating as fresh state (self-heals on next admit)`,
      );
      return { state: undefined, revision: entry.revision };
    }
    return { state: parsed.entry, revision: entry.revision };
  }

  /**
   * CAS write: `create` when the key never existed, `update(revision)`
   * otherwise. Returns `false` on a lost race (caller re-reads and retries);
   * only genuinely-broken transport should reject, and the caller maps that
   * to the store posture via the bounded retry loop.
   */
  private async casWrite(
    key: string,
    value: Uint8Array,
    revision: number | null,
  ): Promise<boolean> {
    if (this.kv === null) throw new AdmissionStoreError("KV unavailable");
    try {
      if (revision === null) {
        await this.kv.create(key, value);
      } else {
        await this.kv.update(key, value, revision);
      }
      return true;
    } catch {
      // nats.js surfaces both lost-CAS shapes ("wrong last sequence", key
      // already exists) and transport faults as rejections; the bounded
      // retry loop upstream re-reads and either wins, refuses on the fresh
      // state, or exhausts into the store-error posture. Treating all
      // rejections as retryable keeps us off brittle error-string parsing.
      return false;
    }
  }

  // -------------------------------------------------------------------------
  // Node-local degraded fallback (design §4.3 / Design C, demoted to fallback)
  // -------------------------------------------------------------------------

  private checkLocal(
    tiers: ResolvedTier[],
    req: AdmissionCheckRequest,
    nowMs: number,
  ): AdmissionOutcome {
    // Evaluate (read-only) — same two-phase discipline as the KV path so the
    // refusal semantics can't drift between postures.
    for (const tier of tiers) {
      if (hasRateLimits(tier.limits)) {
        const refilled = refillRateEntry(
          this.localRate.get(tier.rateKey),
          tier.limits,
          nowMs,
        );
        const verdict = checkRate(refilled, tier.limits);
        if (!verdict.ok) return this.rateRefusal(tier, verdict, true);
      }
      if (tier.limits.max_concurrent !== undefined) {
        const pruned = pruneInflight(
          this.localInflight.get(tier.inflightKey),
          nowMs,
          this.leaseTtlMs,
        );
        const verdict = checkInflight(pruned, tier.limits.max_concurrent);
        if (!verdict.ok) return this.inflightRefusal(tier, verdict, true);
      }
    }
    // Commit — single process, no CAS needed.
    const leaseKeys: string[] = [];
    for (const tier of tiers) {
      if (hasRateLimits(tier.limits)) {
        const refilled = refillRateEntry(
          this.localRate.get(tier.rateKey),
          tier.limits,
          nowMs,
        );
        this.localRate.set(tier.rateKey, consumeRate(refilled, tier.limits));
      }
      if (tier.limits.max_concurrent !== undefined) {
        const pruned = pruneInflight(
          this.localInflight.get(tier.inflightKey),
          nowMs,
          this.leaseTtlMs,
        );
        this.localInflight.set(
          tier.inflightKey,
          acquireLease(pruned, req.leaseId, nowMs),
        );
        leaseKeys.push(tier.inflightKey);
      }
    }
    return {
      admit: true,
      lease:
        leaseKeys.length > 0
          ? { leaseId: req.leaseId, keys: leaseKeys, local: true }
          : undefined,
      degraded: true,
    };
  }

  // -------------------------------------------------------------------------
  // Refusal builders + degrade transitions
  // -------------------------------------------------------------------------

  private rateRefusal(
    tier: ResolvedTier,
    verdict: Exclude<ReturnType<typeof checkRate>, { ok: true }>,
    degraded: boolean,
  ): AdmissionOutcome {
    return {
      admit: false,
      reason: "rate",
      tier: tier.tier,
      key: tier.rateKey,
      window: verdict.window,
      limit: verdict.limit,
      observed: verdict.observed,
      retry_after_ms: verdict.retry_after_ms,
      degraded,
    };
  }

  /** Permanent refusal for a principal id that fails the §3.3 key-segment
   * grammar. LOUD (this is a defensive isolation guard — a malformed principal
   * should never reach admission, so its arrival is worth a line) and the key
   * is a SENTINEL — the raw malformed value is never echoed into a KV key. */
  private malformedPrincipalRefusal(err: AdmissionKeyError): AdmissionOutcome {
    this.log.warn(
      `admission-gate: REJECTED malformed principal — key-segment grammar ` +
        `violation (RFC-0010 §3.3): ${JSON.stringify(err.segment)}. Refusing ` +
        `dispatch (permanent); coercion is forbidden (it would merge counters).`,
    );
    return {
      admit: false,
      reason: "malformed_principal",
      tier: "principal",
      key: "rate.principal.<malformed>",
      // Permanent — no retry can make a malformed id valid.
      retry_after_ms: 0,
      degraded: false,
    };
  }

  private inflightRefusal(
    tier: ResolvedTier,
    verdict: Exclude<ReturnType<typeof checkInflight>, { ok: true }>,
    degraded: boolean,
  ): AdmissionOutcome {
    return {
      admit: false,
      reason: "concurrency",
      tier: tier.tier,
      key: tier.inflightKey,
      limit: verdict.limit,
      observed: verdict.observed,
      retry_after_ms: DEFAULT_RATE_RETRY_AFTER_MS,
      degraded,
    };
  }

  /** Enter the degraded posture — LOUD, once per transition (design §4.4). */
  private noteDegraded(detail: string): void {
    if (this.degraded) return;
    this.degraded = true;
    this.log.warn(
      `admission-gate: DEGRADED to node-local approximate buckets — ${detail}. ` +
        `Named principals ride the local fallback; anonymous dispatches FAIL CLOSED until the store recovers.`,
    );
    this.onDegradeTransition?.("degraded-local", detail);
  }

  /** Leave the degraded posture — also loud, and local state is discarded
   * (the KV counters are authoritative again). */
  private noteRecovered(): void {
    if (!this.degraded) return;
    this.degraded = false;
    this.localRate.clear();
    this.localInflight.clear();
    this.log.warn(
      "admission-gate: RECOVERED — KV admission store reachable again; node-local fallback state discarded",
    );
    this.onDegradeTransition?.("recovered", "KV admission store reachable again");
  }
}
