/**
 * R26 P1 (cortex#1371) — pure admission-state machinery: the KV entry
 * formats + refill / prune / check / consume rules from the myelin admission
 * contract (`myelin/specs/admission.md` §4, myelin#195).
 *
 * Everything in this module is PURE + TOTAL: no I/O, no clock reads, no
 * throws on the decision paths. The CAS loop in `gate.ts` (and the
 * node-local degraded fallback) both drive these same functions, so the
 * distributed and the degraded posture cannot drift on semantics — only on
 * where the state lives.
 *
 * Entry-format invariants (spec §4):
 *   - versioned (`v: 1`); a NEWER version than we understand is surfaced as
 *     `"newer"` so the caller takes the store-error posture (never guess);
 *     a CORRUPT entry is surfaced as `"corrupt"` so the caller may treat it
 *     as fresh (self-healing) — biased choices live in the gate, not here.
 *   - refill is clock-skew-clamped (`max(0, elapsed)`), deltas over the
 *     LOCAL node's clock — token buckets tolerate small inter-node skew.
 *   - refusals never mutate: `check*` functions read; `consume*` functions
 *     return NEW objects (callers only persist on admit — spec §5 rule 1).
 */

import type { AdmissionLimits } from "../../common/types/admission";

// ---------------------------------------------------------------------------
// Entry shapes (myelin admission spec §4 — the wire interop surface)
// ---------------------------------------------------------------------------

/** Window lengths in milliseconds, keyed by the config vocabulary. */
export const WINDOW_MS = {
  per_minute: 60_000,
  per_hour: 3_600_000,
  per_day: 86_400_000,
} as const;

export type RateWindowName = keyof typeof WINDOW_MS;

export const RATE_WINDOW_NAMES: readonly RateWindowName[] = [
  "per_minute",
  "per_hour",
  "per_day",
];

/** Per-window token-bucket state (spec §4.1). */
export interface RateWindowState {
  /** Remaining tokens — fractional; capacity = the configured window limit. */
  tokens: number;
  /** Unix epoch ms of the last refill computation (writing node's clock). */
  refilled_at_ms: number;
}

/** The `rate.*` entry — all configured windows under one CAS-guarded key. */
export interface RateEntry {
  v: 1;
  windows: Partial<Record<RateWindowName, RateWindowState>>;
}

/** One in-flight lease (spec §4.2). */
export interface InflightLease {
  /** Unique lease id — the dispatch task/correlation id. */
  id: string;
  /** Unix epoch ms at acquisition. */
  acquired_at_ms: number;
}

/** The `inflight.*` entry — a self-expiring lease list, not a bare counter. */
export interface InflightEntry {
  v: 1;
  leases: InflightLease[];
}

/**
 * Orphan-lease TTL (spec §4.2 prune rule) — leases older than this are
 * presumed abandoned by a dead node and dropped on read. 1 h: comfortably
 * above a long interactive session, small enough to bound orphan leakage.
 * The phase-2 lifecycle sweeper reconciles faster; this is the floor.
 */
export const DEFAULT_LEASE_TTL_MS = 3_600_000;

// ---------------------------------------------------------------------------
// Parsing — versioned, fail-explicit
// ---------------------------------------------------------------------------

export type ParsedEntry<T> =
  | { kind: "ok"; entry: T }
  | { kind: "corrupt" }
  | { kind: "newer" };

function parseVersioned<T>(
  bytes: Uint8Array,
  validate: (v: unknown) => v is T,
): ParsedEntry<T> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return { kind: "corrupt" };
  }
  if (typeof parsed !== "object" || parsed === null) return { kind: "corrupt" };
  const v = (parsed as { v?: unknown }).v;
  if (typeof v !== "number") return { kind: "corrupt" };
  if (v > 1) return { kind: "newer" };
  if (!validate(parsed)) return { kind: "corrupt" };
  return { kind: "ok", entry: parsed };
}

function isRateEntry(v: unknown): v is RateEntry {
  // Widened to `unknown` field types on purpose: the bytes came off the wire,
  // so nothing about the shape may be assumed (a `Partial<RateEntry>` cast
  // would let the type system erase the null/shape checks below as
  // "unnecessary" when they are exactly the point).
  const e = v as { v?: unknown; windows?: unknown };
  if (e.v !== 1 || typeof e.windows !== "object" || e.windows === null) {
    return false;
  }
  for (const state of Object.values(e.windows)) {
    const s = state as { tokens?: unknown; refilled_at_ms?: unknown } | undefined;
    if (
      s === undefined ||
      typeof s.tokens !== "number" ||
      !Number.isFinite(s.tokens) ||
      typeof s.refilled_at_ms !== "number"
    ) {
      return false;
    }
  }
  return true;
}

function isInflightEntry(v: unknown): v is InflightEntry {
  const e = v as { v?: unknown; leases?: unknown };
  if (e.v !== 1 || !Array.isArray(e.leases)) return false;
  return (e.leases as unknown[]).every((l) => {
    if (typeof l !== "object" || l === null) return false;
    const lease = l as { id?: unknown; acquired_at_ms?: unknown };
    return typeof lease.id === "string" && typeof lease.acquired_at_ms === "number";
  });
}

export function parseRateEntry(bytes: Uint8Array): ParsedEntry<RateEntry> {
  return parseVersioned(bytes, isRateEntry);
}

export function parseInflightEntry(
  bytes: Uint8Array,
): ParsedEntry<InflightEntry> {
  return parseVersioned(bytes, isInflightEntry);
}

export function encodeEntry(entry: RateEntry | InflightEntry): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(entry));
}

// ---------------------------------------------------------------------------
// Rate — refill / check / consume / refund (spec §4.1)
// ---------------------------------------------------------------------------

/**
 * Refill a rate entry against the resolved limits at `nowMs` (spec §4.1
 * refill rule). Windows configured but absent from the entry initialise at
 * FULL capacity; windows present but no longer configured are dropped.
 * Missing entry (`undefined`) ⇒ fresh full-capacity state.
 */
export function refillRateEntry(
  entry: RateEntry | undefined,
  limits: AdmissionLimits,
  nowMs: number,
): RateEntry {
  const windows: Partial<Record<RateWindowName, RateWindowState>> = {};
  for (const name of RATE_WINDOW_NAMES) {
    const capacity = limits[name];
    if (capacity === undefined) continue;
    const prior = entry?.windows[name];
    if (prior === undefined) {
      windows[name] = { tokens: capacity, refilled_at_ms: nowMs };
      continue;
    }
    // Clock-skew clamp: a retrograde clock refuses-safe (no refill), never
    // mints tokens.
    const elapsed = Math.max(0, nowMs - prior.refilled_at_ms);
    const tokens = Math.min(
      capacity,
      prior.tokens + (elapsed * capacity) / WINDOW_MS[name],
    );
    windows[name] = { tokens, refilled_at_ms: nowMs };
  }
  return { v: 1, windows };
}

export type RateCheck =
  | { ok: true }
  | {
      ok: false;
      window: RateWindowName;
      limit: number;
      observed: number;
      retry_after_ms: number;
    };

/**
 * Check a (freshly refilled) rate entry: admit iff every configured window
 * holds ≥ 1 token. On refusal reports the SLOWEST refusing window and the
 * time until one full token is available there (spec §4.1 retry hint).
 */
export function checkRate(entry: RateEntry, limits: AdmissionLimits): RateCheck {
  let worst:
    | { window: RateWindowName; limit: number; observed: number; retry: number }
    | undefined;
  for (const name of RATE_WINDOW_NAMES) {
    const capacity = limits[name];
    if (capacity === undefined) continue;
    const state = entry.windows[name];
    const tokens = state?.tokens ?? capacity;
    if (tokens >= 1) continue;
    const retry = Math.ceil(((1 - tokens) * WINDOW_MS[name]) / capacity);
    if (worst === undefined || retry > worst.retry) {
      worst = { window: name, limit: capacity, observed: tokens, retry };
    }
  }
  if (worst === undefined) return { ok: true };
  return {
    ok: false,
    window: worst.window,
    limit: worst.limit,
    observed: worst.observed,
    retry_after_ms: worst.retry,
  };
}

/** Consume one token from every configured window. Returns a NEW entry. */
export function consumeRate(
  entry: RateEntry,
  limits: AdmissionLimits,
): RateEntry {
  const windows: Partial<Record<RateWindowName, RateWindowState>> = {};
  for (const name of RATE_WINDOW_NAMES) {
    const capacity = limits[name];
    if (capacity === undefined) continue;
    const state = entry.windows[name];
    if (state === undefined) continue;
    windows[name] = { ...state, tokens: state.tokens - 1 };
  }
  return { v: 1, windows };
}

/**
 * Refund one token to every configured window, capped at capacity — the
 * best-effort abort compensation for a multi-tier commit that failed after
 * this tier consumed (spec §5.1). A failed refund errs toward
 * UNDER-admission (safe direction); it self-corrects on refill.
 */
export function refundRate(
  entry: RateEntry,
  limits: AdmissionLimits,
): RateEntry {
  const windows: Partial<Record<RateWindowName, RateWindowState>> = {};
  for (const name of RATE_WINDOW_NAMES) {
    const capacity = limits[name];
    if (capacity === undefined) continue;
    const state = entry.windows[name];
    if (state === undefined) continue;
    windows[name] = { ...state, tokens: Math.min(capacity, state.tokens + 1) };
  }
  return { v: 1, windows };
}

// ---------------------------------------------------------------------------
// In-flight — prune / check / acquire / release (spec §4.2)
// ---------------------------------------------------------------------------

/**
 * Prune expired leases at `nowMs` (spec §4.2 prune rule). Missing entry ⇒
 * empty lease list.
 */
export function pruneInflight(
  entry: InflightEntry | undefined,
  nowMs: number,
  leaseTtlMs: number,
): InflightEntry {
  const leases = (entry?.leases ?? []).filter(
    (l) => nowMs - l.acquired_at_ms <= leaseTtlMs,
  );
  return { v: 1, leases };
}

export type InflightCheck =
  | { ok: true }
  | { ok: false; limit: number; observed: number };

/** Check a (freshly pruned) in-flight entry against `max_concurrent`. */
export function checkInflight(
  entry: InflightEntry,
  maxConcurrent: number,
): InflightCheck {
  if (entry.leases.length < maxConcurrent) return { ok: true };
  return { ok: false, limit: maxConcurrent, observed: entry.leases.length };
}

/** Append a lease. Returns a NEW entry. Idempotent on lease id. */
export function acquireLease(
  entry: InflightEntry,
  leaseId: string,
  nowMs: number,
): InflightEntry {
  if (entry.leases.some((l) => l.id === leaseId)) return entry;
  return {
    v: 1,
    leases: [...entry.leases, { id: leaseId, acquired_at_ms: nowMs }],
  };
}

/**
 * Remove a lease by id. Returns a NEW entry; removing an absent lease is a
 * no-op (release MUST be idempotent — spec §4.2 release rule).
 */
export function releaseLease(
  entry: InflightEntry,
  leaseId: string,
): InflightEntry {
  return { v: 1, leases: entry.leases.filter((l) => l.id !== leaseId) };
}
