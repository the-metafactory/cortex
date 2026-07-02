/**
 * R26 P1 (cortex#1371) — tests for the pure admission state machinery
 * (`state.ts`): the entry formats + refill / prune / check / consume rules
 * from the myelin admission contract (`myelin/specs/admission.md` §4).
 */

import { describe, expect, test } from "bun:test";
import {
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
  WINDOW_MS,
  type InflightEntry,
  type RateEntry,
} from "../state";

const T0 = 1_751_412_000_000; // arbitrary epoch-ms anchor

describe("refillRateEntry", () => {
  test("missing entry initialises every configured window at full capacity", () => {
    const entry = refillRateEntry(undefined, { per_minute: 6, per_hour: 60 }, T0);
    expect(entry.windows.per_minute).toEqual({ tokens: 6, refilled_at_ms: T0 });
    expect(entry.windows.per_hour).toEqual({ tokens: 60, refilled_at_ms: T0 });
    expect(entry.windows.per_day).toBeUndefined();
  });

  test("refills proportionally to elapsed time, capped at capacity", () => {
    const drained: RateEntry = {
      v: 1,
      windows: { per_minute: { tokens: 0, refilled_at_ms: T0 } },
    };
    // Half a window later → half capacity refilled.
    const half = refillRateEntry(drained, { per_minute: 6 }, T0 + WINDOW_MS.per_minute / 2);
    expect(half.windows.per_minute?.tokens).toBeCloseTo(3, 5);
    // Ten windows later → capped at capacity, not 60.
    const capped = refillRateEntry(drained, { per_minute: 6 }, T0 + 10 * WINDOW_MS.per_minute);
    expect(capped.windows.per_minute?.tokens).toBe(6);
  });

  test("window rollover: a fully-drained window admits again after one window", () => {
    let entry = refillRateEntry(undefined, { per_minute: 2 }, T0);
    entry = consumeRate(entry, { per_minute: 2 });
    entry = consumeRate(entry, { per_minute: 2 });
    expect(checkRate(entry, { per_minute: 2 }).ok).toBe(false);
    // One full minute later the bucket is back at capacity.
    const rolled = refillRateEntry(entry, { per_minute: 2 }, T0 + WINDOW_MS.per_minute);
    expect(rolled.windows.per_minute?.tokens).toBe(2);
    expect(checkRate(rolled, { per_minute: 2 }).ok).toBe(true);
  });

  test("clock skew clamp: a retrograde clock never mints tokens", () => {
    const drained: RateEntry = {
      v: 1,
      windows: { per_minute: { tokens: 1, refilled_at_ms: T0 } },
    };
    const past = refillRateEntry(drained, { per_minute: 6 }, T0 - 30_000);
    expect(past.windows.per_minute?.tokens).toBe(1);
  });

  test("drops windows no longer configured; initialises newly-configured ones full", () => {
    const entry: RateEntry = {
      v: 1,
      windows: { per_minute: { tokens: 1, refilled_at_ms: T0 } },
    };
    const migrated = refillRateEntry(entry, { per_hour: 10 }, T0);
    expect(migrated.windows.per_minute).toBeUndefined();
    expect(migrated.windows.per_hour).toEqual({ tokens: 10, refilled_at_ms: T0 });
  });
});

describe("checkRate", () => {
  test("admits when every configured window holds ≥ 1 token", () => {
    const entry = refillRateEntry(undefined, { per_minute: 1, per_day: 5 }, T0);
    expect(checkRate(entry, { per_minute: 1, per_day: 5 })).toEqual({ ok: true });
  });

  test("refuses with the SLOWEST refusing window's retry hint", () => {
    // Both windows drained; per_day refills far slower, so it dominates.
    let entry = refillRateEntry(undefined, { per_minute: 1, per_day: 1 }, T0);
    entry = consumeRate(entry, { per_minute: 1, per_day: 1 });
    const verdict = checkRate(entry, { per_minute: 1, per_day: 1 });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.window).toBe("per_day");
      expect(verdict.limit).toBe(1);
      // One full token on a 1/day bucket = a full day.
      expect(verdict.retry_after_ms).toBe(WINDOW_MS.per_day);
    }
  });

  test("retry hint is time-to-one-token, not time-to-full", () => {
    let entry = refillRateEntry(undefined, { per_minute: 6 }, T0);
    for (let i = 0; i < 6; i++) entry = consumeRate(entry, { per_minute: 6 });
    const verdict = checkRate(entry, { per_minute: 6 });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      // capacity 6/min ⇒ one token every 10s.
      expect(verdict.retry_after_ms).toBe(10_000);
    }
  });
});

describe("refundRate", () => {
  test("returns one token, capped at capacity", () => {
    let entry = refillRateEntry(undefined, { per_minute: 3 }, T0);
    entry = consumeRate(entry, { per_minute: 3 });
    expect(entry.windows.per_minute?.tokens).toBe(2);
    entry = refundRate(entry, { per_minute: 3 });
    expect(entry.windows.per_minute?.tokens).toBe(3);
    // Refunding at capacity does not overflow.
    entry = refundRate(entry, { per_minute: 3 });
    expect(entry.windows.per_minute?.tokens).toBe(3);
  });
});

describe("in-flight leases", () => {
  test("acquire → check → release round-trip", () => {
    let entry = pruneInflight(undefined, T0, 3_600_000);
    expect(checkInflight(entry, 2)).toEqual({ ok: true });
    entry = acquireLease(entry, "task-a", T0);
    entry = acquireLease(entry, "task-b", T0);
    expect(checkInflight(entry, 2)).toEqual({ ok: false, limit: 2, observed: 2 });
    entry = releaseLease(entry, "task-a");
    expect(checkInflight(entry, 2)).toEqual({ ok: true });
  });

  test("acquire is idempotent on lease id", () => {
    let entry = pruneInflight(undefined, T0, 3_600_000);
    entry = acquireLease(entry, "task-a", T0);
    entry = acquireLease(entry, "task-a", T0 + 5);
    expect(entry.leases).toHaveLength(1);
  });

  test("release of an absent lease is a no-op (idempotent)", () => {
    let entry = pruneInflight(undefined, T0, 3_600_000);
    entry = acquireLease(entry, "task-a", T0);
    entry = releaseLease(entry, "task-a");
    entry = releaseLease(entry, "task-a");
    expect(entry.leases).toHaveLength(0);
  });

  test("prune drops orphan leases past the TTL (dead-node self-healing)", () => {
    const ttl = 3_600_000;
    let entry: InflightEntry = { v: 1, leases: [] };
    entry = acquireLease(entry, "orphan", T0);
    entry = acquireLease(entry, "fresh", T0 + ttl);
    const pruned = pruneInflight(entry, T0 + ttl + 1, ttl);
    expect(pruned.leases.map((l) => l.id)).toEqual(["fresh"]);
  });
});

describe("entry parsing (versioned, fail-explicit)", () => {
  test("round-trips both entry kinds through encode/parse", () => {
    const rate = refillRateEntry(undefined, { per_minute: 6 }, T0);
    const parsedRate = parseRateEntry(encodeEntry(rate));
    expect(parsedRate).toEqual({ kind: "ok", entry: rate });

    const inflight = acquireLease({ v: 1, leases: [] }, "task-a", T0);
    const parsedInflight = parseInflightEntry(encodeEntry(inflight));
    expect(parsedInflight).toEqual({ kind: "ok", entry: inflight });
  });

  test("corrupt bytes / malformed shapes parse as corrupt (self-heal path)", () => {
    const enc = new TextEncoder();
    expect(parseRateEntry(enc.encode("not json")).kind).toBe("corrupt");
    expect(parseRateEntry(enc.encode('{"v":1}')).kind).toBe("corrupt");
    expect(
      parseRateEntry(enc.encode('{"v":1,"windows":{"per_minute":{"tokens":"x"}}}')).kind,
    ).toBe("corrupt");
    expect(parseInflightEntry(enc.encode('{"v":1,"leases":[{"id":1}]}')).kind).toBe(
      "corrupt",
    );
  });

  test("a NEWER contract version parses as 'newer' (never guessed at)", () => {
    const enc = new TextEncoder();
    expect(parseRateEntry(enc.encode('{"v":2,"windows":{}}')).kind).toBe("newer");
    expect(parseInflightEntry(enc.encode('{"v":9,"leases":[]}')).kind).toBe("newer");
  });
});
