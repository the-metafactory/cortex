/**
 * R26 P1 (cortex#1371) — tests for the AdmissionGate against an in-memory
 * CAS-faithful KV stub. Covers the review checklist for the primitive:
 *
 *   - concurrent admits SERIALISE through CAS (exactly `limit` admits win);
 *   - window rollover readmits;
 *   - degrade path: store error ⇒ node-local fallback + loud transition
 *     events (once per transition, recovery discards local state);
 *   - anonymous fail-closed on store error + built-in ceiling clamp;
 *   - refusals are READ-ONLY (no KV writes — myelin spec §5 rule 1);
 *   - in-flight leases: acquire on admit, release on terminal, TTL prune;
 *   - nothing-configured-for-requester ⇒ inert (zero KV I/O).
 */

import { describe, expect, test } from "bun:test";
import type { ProvisionKv, ProvisionKvEntry } from "../../jetstream/types";
import { AdmissionGate, type DegradeMode } from "../gate";
import type { AdmissionPolicy } from "../../../common/types/admission";

const T0 = 1_751_412_000_000;

/**
 * In-memory KV faithful to the NATS-KV CAS semantics the gate relies on:
 * `create` rejects when the key exists; `update` rejects unless the given
 * revision is the live one. Tracks op counts so tests can assert the
 * read-only-refusal property.
 */
function memoryKv(): {
  kv: ProvisionKv;
  data: Map<string, { value: Uint8Array; revision: number }>;
  writes: () => number;
  failNext: (n: number) => void;
  failAll: (on: boolean) => void;
} {
  const data = new Map<string, { value: Uint8Array; revision: number }>();
  let revisionCounter = 0;
  let writeCount = 0;
  let failNextN = 0;
  let failEverything = false;
  const maybeFail = () => {
    if (failEverything) throw new Error("kv unavailable (simulated outage)");
    if (failNextN > 0) {
      failNextN--;
      throw new Error("kv transient failure (simulated)");
    }
  };
  const kv: ProvisionKv = {
     
    get: async (key): Promise<ProvisionKvEntry | null> => {
      maybeFail();
      const e = data.get(key);
      if (e === undefined) return null;
      return { value: e.value, revision: e.revision, operation: "PUT" };
    },
     
    create: async (key, value): Promise<number> => {
      maybeFail();
      if (data.has(key)) throw new Error(`wrong last sequence: key "${key}" exists`);
      writeCount++;
      const revision = ++revisionCounter;
      data.set(key, { value, revision });
      return revision;
    },
     
    update: async (key, value, revision): Promise<number> => {
      maybeFail();
      const e = data.get(key);
      if (e?.revision !== revision) {
        throw new Error(`wrong last sequence: expected ${e?.revision ?? "<absent>"}, got ${revision}`);
      }
      writeCount++;
      const next = ++revisionCounter;
      data.set(key, { value, revision: next });
      return next;
    },
  };
  return {
    kv,
    data,
    writes: () => writeCount,
    failNext: (n) => {
      failNextN = n;
    },
    failAll: (on) => {
      failEverything = on;
    },
  };
}

function makeGate(
  config: AdmissionPolicy,
  kv: ProvisionKv | null,
  opts: {
    clock?: () => number;
    roles?: ReadonlyMap<string, readonly string[]>;
    transitions?: { mode: DegradeMode; detail: string }[];
    casAttempts?: number;
    leaseTtlMs?: number;
  } = {},
): AdmissionGate {
  return new AdmissionGate({
    config,
    kv,
    principalRoles: opts.roles ?? new Map(),
    clock: opts.clock ?? (() => T0),
    log: { warn: () => {} },
    ...(opts.transitions !== undefined && {
      onDegradeTransition: (mode: DegradeMode, detail: string) => {
        opts.transitions?.push({ mode, detail });
      },
    }),
    ...(opts.casAttempts !== undefined && { casAttempts: opts.casAttempts }),
    ...(opts.leaseTtlMs !== undefined && { leaseTtlMs: opts.leaseTtlMs }),
  });
}

const named = (leaseId: string, principalId = "andreas") => ({
  principalId,
  anonymous: false,
  leaseId,
});

describe("AdmissionGate — distributed (KV) path", () => {
  test("admits under the limit, refuses over it, with per-window retry hint", async () => {
    const m = memoryKv();
    const gate = makeGate({ defaults: { per_minute: 2 } }, m.kv);
    expect((await gate.check(named("t1"))).admit).toBe(true);
    expect((await gate.check(named("t2"))).admit).toBe(true);
    const third = await gate.check(named("t3"));
    expect(third.admit).toBe(false);
    if (!third.admit) {
      expect(third.reason).toBe("rate");
      expect(third.tier).toBe("principal");
      expect(third.key).toBe("rate.principal.andreas");
      expect(third.window).toBe("per_minute");
      expect(third.limit).toBe(2);
      expect(third.retry_after_ms).toBeGreaterThan(0);
      expect(third.degraded).toBe(false);
    }
  });

  test("CONCURRENT admits serialise via CAS — exactly `limit` admits win", async () => {
    const m = memoryKv();
    // High CAS attempt budget: with 12 genuinely-concurrent contenders on one
    // key, a fair loser needs several re-reads before the dust settles.
    const gate = makeGate({ defaults: { per_minute: 5 } }, m.kv, {
      casAttempts: 32,
    });
    const outcomes = await Promise.all(
      Array.from({ length: 12 }, (_, i) => gate.check(named(`task-${i}`))),
    );
    const admits = outcomes.filter((o) => o.admit).length;
    const refusals = outcomes.filter((o) => !o.admit);
    expect(admits).toBe(5);
    expect(refusals).toHaveLength(7);
    // Every refusal is the transient rate taxonomy, never a store error.
    for (const r of refusals) {
      if (!r.admit) expect(r.reason).toBe("rate");
    }
  });

  test("window rollover readmits after the window elapses", async () => {
    const m = memoryKv();
    let now = T0;
    const gate = makeGate({ defaults: { per_minute: 1 } }, m.kv, {
      clock: () => now,
    });
    expect((await gate.check(named("t1"))).admit).toBe(true);
    expect((await gate.check(named("t2"))).admit).toBe(false);
    now = T0 + 60_000;
    expect((await gate.check(named("t3"))).admit).toBe(true);
  });

  test("refusals are READ-ONLY — no KV writes past the point of refusal", async () => {
    const m = memoryKv();
    const gate = makeGate({ defaults: { per_minute: 1 } }, m.kv);
    await gate.check(named("t1")); // consumes the single token (1 write)
    const writesAfterAdmit = m.writes();
    await gate.check(named("t2")); // refused — must not write
    await gate.check(named("t3")); // refused — must not write
    expect(m.writes()).toBe(writesAfterAdmit);
  });

  test("stack tier (tier 1) is evaluated before principal (tier 2) and wins refusals", async () => {
    const m = memoryKv();
    const gate = makeGate(
      { stack: { per_minute: 1 }, defaults: { per_minute: 5 } },
      m.kv,
    );
    expect((await gate.check(named("t1", "alice"))).admit).toBe(true);
    // A DIFFERENT principal is refused by the shared stack ceiling.
    const refused = await gate.check(named("t2", "bob"));
    expect(refused.admit).toBe(false);
    if (!refused.admit) {
      expect(refused.tier).toBe("stack");
      expect(refused.key).toBe("rate.stack");
    }
  });

  test("max_concurrent: lease acquired on admit, released lease frees the slot", async () => {
    const m = memoryKv();
    const gate = makeGate({ defaults: { max_concurrent: 1 } }, m.kv);
    const first = await gate.check(named("t1"));
    expect(first.admit).toBe(true);
    const lease = first.admit ? first.lease : undefined;
    expect(lease).toBeDefined();
    expect(lease?.keys).toEqual(["inflight.principal.andreas"]);

    const blocked = await gate.check(named("t2"));
    expect(blocked.admit).toBe(false);
    if (!blocked.admit) {
      expect(blocked.reason).toBe("concurrency");
      expect(blocked.limit).toBe(1);
    }

    if (lease !== undefined) await gate.release(lease);
    expect((await gate.check(named("t3"))).admit).toBe(true);
  });

  test("orphan leases TTL-prune: a dead node's lease stops blocking after the TTL", async () => {
    const m = memoryKv();
    let now = T0;
    const gate = makeGate({ defaults: { max_concurrent: 1 } }, m.kv, {
      clock: () => now,
      leaseTtlMs: 1000,
    });
    expect((await gate.check(named("orphan"))).admit).toBe(true);
    // Never released (node died). Within the TTL the slot stays taken…
    expect((await gate.check(named("t2"))).admit).toBe(false);
    // …and after the TTL the prune rule frees it.
    now = T0 + 1001;
    expect((await gate.check(named("t3"))).admit).toBe(true);
  });

  test("role-derived limits: most permissive role wins; principal override beats roles", async () => {
    const m = memoryKv();
    const config: AdmissionPolicy = {
      defaults: { per_minute: 1 },
      roles: { basic: { per_minute: 2 }, power: { per_minute: 4 } },
      principals: [{ id: "vip", per_minute: 6 }],
    };
    const roles = new Map<string, readonly string[]>([
      ["dual", ["basic", "power"]],
      ["vip", ["basic"]],
    ]);
    const gate = makeGate(config, m.kv, { roles });
    // dual holds both roles → 4/min (most permissive), not 2.
    for (let i = 0; i < 4; i++) {
      expect((await gate.check(named(`d${i}`, "dual"))).admit).toBe(true);
    }
    expect((await gate.check(named("d4", "dual"))).admit).toBe(false);
    // vip's principal override (6) beats its role (2) and the default (1).
    for (let i = 0; i < 6; i++) {
      expect((await gate.check(named(`v${i}`, "vip"))).admit).toBe(true);
    }
    expect((await gate.check(named("v6", "vip"))).admit).toBe(false);
  });

  test("requester with NO resolved limits is inert — zero KV I/O", async () => {
    const m = memoryKv();
    // Only a principal override for someone else — no stack, no defaults.
    const gate = makeGate(
      { principals: [{ id: "other", per_minute: 1 }] },
      m.kv,
    );
    const outcome = await gate.check(named("t1", "unlimited"));
    expect(outcome).toEqual({ admit: true, lease: undefined, degraded: false });
    expect(m.data.size).toBe(0);
    expect(m.writes()).toBe(0);
  });
});

describe("AdmissionGate — anonymous principal", () => {
  const anon = (leaseId: string) => ({
    principalId: "public",
    anonymous: true,
    leaseId,
  });

  /** Admit + immediately release the in-flight lease, so the ceiling's
   * `max_concurrent: 1` doesn't shadow the per-minute clamp under test. */
  async function checkAndRelease(
    gate: AdmissionGate,
    leaseId: string,
  ): Promise<Awaited<ReturnType<AdmissionGate["check"]>>> {
    const outcome = await gate.check(anon(leaseId));
    if (outcome.admit && outcome.lease !== undefined) {
      await gate.release(outcome.lease);
    }
    return outcome;
  }

  test("built-in ceiling clamps config: 2/min even when config says 100/min", async () => {
    const m = memoryKv();
    const gate = makeGate({ anonymous: { per_minute: 100 } }, m.kv);
    expect((await checkAndRelease(gate, "a1")).admit).toBe(true);
    expect((await checkAndRelease(gate, "a2")).admit).toBe(true);
    const third = await checkAndRelease(gate, "a3");
    expect(third.admit).toBe(false);
    if (!third.admit) {
      expect(third.reason).toBe("rate");
      expect(third.limit).toBe(2);
    }
  });

  test("ceiling's max_concurrent: 1 holds while an anonymous dispatch is in flight", async () => {
    const m = memoryKv();
    const gate = makeGate({ anonymous: { per_minute: 100, max_concurrent: 50 } }, m.kv);
    const first = await gate.check(anon("a1"));
    expect(first.admit).toBe(true);
    // Lease NOT released — the single in-flight slot is taken.
    const second = await gate.check(anon("a2"));
    expect(second.admit).toBe(false);
    if (!second.admit) {
      expect(second.reason).toBe("concurrency");
      expect(second.limit).toBe(1);
    }
  });

  test("ceiling applies even with NO anonymous block (any admission config arms it)", async () => {
    const m = memoryKv();
    const gate = makeGate({ defaults: { per_minute: 50 } }, m.kv);
    expect((await checkAndRelease(gate, "a1")).admit).toBe(true);
    expect((await checkAndRelease(gate, "a2")).admit).toBe(true);
    expect((await checkAndRelease(gate, "a3")).admit).toBe(false);
  });

  test("FAILS CLOSED on store error (never rides the local fallback)", async () => {
    const m = memoryKv();
    const gate = makeGate({ defaults: { per_minute: 50 } }, m.kv);
    m.failAll(true);
    const outcome = await gate.check(anon("a1"));
    expect(outcome.admit).toBe(false);
    if (!outcome.admit) {
      expect(outcome.reason).toBe("store_error");
      expect(outcome.degraded).toBe(true);
      expect(outcome.retry_after_ms).toBeGreaterThan(0);
    }
  });
});

describe("AdmissionGate — degrade posture (design §4.3 / Q1)", () => {
  test("store outage degrades NAMED principals to local buckets, loudly, once", async () => {
    const m = memoryKv();
    const transitions: { mode: DegradeMode; detail: string }[] = [];
    const gate = makeGate({ defaults: { per_minute: 2 } }, m.kv, { transitions });
    m.failAll(true);

    // Local fallback still ENFORCES the limits — approximate, not absent.
    const first = await gate.check(named("t1"));
    expect(first.admit).toBe(true);
    if (first.admit) expect(first.degraded).toBe(true);
    expect((await gate.check(named("t2"))).admit).toBe(true);
    const refused = await gate.check(named("t3"));
    expect(refused.admit).toBe(false);
    if (!refused.admit) {
      expect(refused.reason).toBe("rate");
      expect(refused.degraded).toBe(true);
    }
    // ONE transition event for three degraded checks — per transition, not
    // per request (design §4.4).
    expect(transitions.map((t) => t.mode)).toEqual(["degraded-local"]);
  });

  test("recovery: next successful KV round-trip emits 'recovered' and discards local state", async () => {
    const m = memoryKv();
    const transitions: { mode: DegradeMode; detail: string }[] = [];
    const gate = makeGate({ defaults: { per_minute: 2 } }, m.kv, { transitions });
    m.failAll(true);
    await gate.check(named("t1"));
    m.failAll(false);
    const recovered = await gate.check(named("t2"));
    expect(recovered.admit).toBe(true);
    if (recovered.admit) expect(recovered.degraded).toBe(false);
    expect(transitions.map((t) => t.mode)).toEqual(["degraded-local", "recovered"]);
  });

  test("kv === null (provisioning failed at boot): permanently degraded, named ride local", async () => {
    const transitions: { mode: DegradeMode; detail: string }[] = [];
    const gate = makeGate({ defaults: { per_minute: 1 } }, null, { transitions });
    const first = await gate.check(named("t1"));
    expect(first.admit).toBe(true);
    if (first.admit) expect(first.degraded).toBe(true);
    expect((await gate.check(named("t2"))).admit).toBe(false);
    expect(transitions.map((t) => t.mode)).toEqual(["degraded-local"]);
  });

  test("CAS exhaustion takes the store posture (degraded), not a crash", async () => {
    const m = memoryKv();
    const transitions: { mode: DegradeMode; detail: string }[] = [];
    // casAttempts=1 + a competing writer that always wins ⇒ exhaustion.
    const gate = makeGate({ defaults: { per_minute: 5 } }, m.kv, {
      transitions,
      casAttempts: 1,
    });
    // Seed the key, then wrap update to ALWAYS lose the race once.
    await gate.check(named("seed"));
    const realUpdate = m.kv.update.bind(m.kv);
    let sabotage = true;
    m.kv.update = async (key, value, revision) => {
      if (sabotage) throw new Error("wrong last sequence (simulated racer)");
      return realUpdate(key, value, revision);
    };
    const outcome = await gate.check(named("contended"));
    sabotage = false;
    // Named principal: degraded-local decision, still an ADMIT (limit 5).
    expect(outcome.admit).toBe(true);
    if (outcome.admit) expect(outcome.degraded).toBe(true);
    expect(transitions.map((t) => t.mode)).toEqual(["degraded-local"]);
  });

  test("a NEWER-versioned entry takes the store posture (never guessed at)", async () => {
    const m = memoryKv();
    m.data.set("rate.principal.andreas", {
      value: new TextEncoder().encode('{"v":2,"windows":{}}'),
      revision: 1,
    });
    const transitions: { mode: DegradeMode; detail: string }[] = [];
    const gate = makeGate({ defaults: { per_minute: 5 } }, m.kv, { transitions });
    const outcome = await gate.check(named("t1"));
    expect(outcome.admit).toBe(true); // named → local fallback admits
    if (outcome.admit) expect(outcome.degraded).toBe(true);
    expect(transitions.map((t) => t.mode)).toEqual(["degraded-local"]);
  });

  test("local lease release works in degraded mode", async () => {
    const gate = makeGate({ defaults: { max_concurrent: 1 } }, null);
    const first = await gate.check(named("t1"));
    expect(first.admit).toBe(true);
    const lease = first.admit ? first.lease : undefined;
    expect(lease?.local).toBe(true);
    expect((await gate.check(named("t2"))).admit).toBe(false);
    if (lease !== undefined) await gate.release(lease);
    expect((await gate.check(named("t3"))).admit).toBe(true);
  });
});

describe("AdmissionGate — release robustness", () => {
  test("release never throws, even on a hard store outage", async () => {
    const m = memoryKv();
    const gate = makeGate({ defaults: { max_concurrent: 2 } }, m.kv);
    const outcome = await gate.check(named("t1"));
    const lease = outcome.admit ? outcome.lease : undefined;
    expect(lease).toBeDefined();
    m.failAll(true);
    if (lease !== undefined) {
      // Must resolve, never reject — a release failure is logged gate-side
      // and the lease TTL self-heals.
      await gate.release(lease);
    }
  });

  test("double release is a no-op", async () => {
    const m = memoryKv();
    const gate = makeGate({ defaults: { max_concurrent: 2 } }, m.kv);
    const outcome = await gate.check(named("t1"));
    const lease = outcome.admit ? outcome.lease : undefined;
    if (lease !== undefined) {
      await gate.release(lease);
      await gate.release(lease);
    }
    expect((await gate.check(named("t2"))).admit).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// RFC-0010 §3.3 — key-segment reject-not-coerce (cortex#2189 / myelin#235 W5).
// The principal segment charset is VALIDATED, never coerced: a malformed
// principal is REFUSED (permanently), never admitted onto a coerced key that
// would merge two principals' counters (§6 isolation failure).
// ---------------------------------------------------------------------------
describe("AdmissionGate — malformed principal reject-not-coerce (RFC-0010 §3.3)", () => {
  test("an out-of-charset principal is REJECTED, not coerced (never touches the store)", async () => {
    const m = memoryKv();
    const gate = makeGate({ defaults: { per_minute: 5 } }, m.kv);
    // `Bad_Name` has an uppercase + `_`; the legacy coercer would have keyed it
    // as `rate.principal.Bad-Name`. §3.3 requires rejection instead.
    const outcome = await gate.check(named("t1", "Bad_Name"));
    expect(outcome.admit).toBe(false);
    if (!outcome.admit) {
      expect(outcome.reason).toBe("malformed_principal");
      // Permanent — no retry hint that would invite a redelivery loop.
      expect(outcome.retry_after_ms).toBe(0);
      // The raw malformed value is NEVER echoed into a KV key.
      expect(outcome.key).toBe("rate.principal.<malformed>");
      expect(outcome.degraded).toBe(false);
    }
    // Read-only refusal: a malformed principal writes nothing and never keys a
    // (coerced) counter into the store.
    expect(m.writes()).toBe(0);
    expect(m.data.has("rate.principal.Bad-Name")).toBe(false);
    expect(m.data.has("rate.principal.Bad_Name")).toBe(false);
  });

  test("COLLISION CASE: `amt_surface` and `amt-surface` never merge onto one counter", async () => {
    const m = memoryKv();
    const gate = makeGate({ defaults: { per_minute: 1 } }, m.kv);
    // The valid kebab principal admits and consumes its single token.
    expect((await gate.check(named("t1", "amt-surface"))).admit).toBe(true);
    expect((await gate.check(named("t2", "amt-surface"))).admit).toBe(false); // its own window exhausted
    // The underscore sibling would, under coercion, share `amt-surface`'s
    // (now-exhausted) counter and be starved. §3.3 rejects it as malformed
    // instead — its refusal is `malformed_principal`, NOT a borrowed `rate`.
    const sibling = await gate.check(named("t3", "amt_surface"));
    expect(sibling.admit).toBe(false);
    if (!sibling.admit) expect(sibling.reason).toBe("malformed_principal");
    // The coerced key never came into existence.
    expect(m.data.has("rate.principal.amt_surface")).toBe(false);
  });

  test("a valid lowercase-kebab principal passes verbatim", async () => {
    const m = memoryKv();
    const gate = makeGate({ defaults: { per_minute: 1 } }, m.kv);
    const outcome = await gate.check(named("t1", "amt-surface-2"));
    expect(outcome.admit).toBe(true);
    expect(m.data.has("rate.principal.amt-surface-2")).toBe(true);
  });

  test("`check()` still never throws on a malformed principal", async () => {
    const m = memoryKv();
    const gate = makeGate({ defaults: { per_minute: 5 } }, m.kv);
    // Resolves to a decision (never rejects) — the gate's total-function contract.
    await expect(gate.check(named("t1", "UPPER.dots"))).resolves.toMatchObject({
      admit: false,
      reason: "malformed_principal",
    });
  });
});
