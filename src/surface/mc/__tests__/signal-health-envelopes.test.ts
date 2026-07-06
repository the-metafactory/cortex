/**
 * cortex#1468 — canonical signal-HEALTH-envelope ANTI-DRIFT suite.
 *
 * Sibling of `signal-transport-envelopes.test.ts` (cortex#1467), for the
 * self-observability family the attention producer consumes: signal's
 * `system.signal.*` collector/backend health edges. The U2.1 attention arms
 * originally shipped DEAD because they matched phantom `system.transport.backend.*`
 * names that exist nowhere in signal; cortex#1468 re-points them to signal's real
 * `system.signal.backend.*` grammar (recovery emitters added by
 * the-metafactory/signal#166). This suite locks the fix two ways, driven by
 * provenance-pinned fixtures reproduced from signal's builder output
 * (signal `main` @ 81eebaa):
 *
 *   1. ANTI-DRIFT — each family's canonical fixture is routed through
 *      `validateEnvelope`; the real hyphen-free `type` PASSES and an
 *      underscore-injected `type` FAILS. A future fixture that regresses to an
 *      impossible spelling now fails the suite.
 *   2. AC — `produceObservabilityAttention` OPENS on `backend.unreachable` /
 *      `collector.degraded` and RESOLVES on `backend.reachable` /
 *      `collector.recovered`, driven by the canonical envelope BODIES.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";

import { validateEnvelope } from "../../../bus/myelin/envelope-validator";
import { produceObservabilityAttention } from "../projection/observability-attention";
import { ADAPTER_ATTENTION_PREFIX } from "../projection/adapter-lifecycle";
import { SCHEMA_SQL } from "../db/schema";
import {
  SIGNAL_HEALTH_TYPES,
  SIGNAL_HEALTH_FIXTURES,
  makeSignalHealthEnvelope,
  toInvalidType,
} from "./__fixtures__/signal-health-envelopes";

// ---------------------------------------------------------------------------
// 1. ANTI-DRIFT — the fixture envelopes clear cortex's vendored myelin schema,
//    and an underscore-injected leaf is rejected. (cortex#1468)
// ---------------------------------------------------------------------------

describe("canonical signal-health fixtures — validateEnvelope anti-drift", () => {
  for (const fx of SIGNAL_HEALTH_FIXTURES) {
    it(`${fx.family}: the canonical hyphen-free envelope PASSES validateEnvelope`, () => {
      const result = validateEnvelope(fx.envelope);
      // Surface the AJV errors on failure so any drift is diagnosable.
      if (!result.ok) {
        throw new Error(
          `validateEnvelope rejected canonical ${fx.family}: ${JSON.stringify(result.errors)}`,
        );
      }
      expect(result.ok).toBe(true);
    });

    it(`${fx.family}: injecting an underscore into the leaf type is REJECTED`, () => {
      // The impossible spelling class the old phantom fixtures leaned on: an
      // underscore in the `type` never survives AJV (myelin type grammar forbids
      // `_`), so it could only ever be "tested" by bypassing validation. Prove
      // the schema bites — at least the backend family goes through the validator.
      const bad = makeSignalHealthEnvelope(fx.type, { payload: fx.payload });
      (bad as unknown as { type: string }).type = toInvalidType(fx.type);
      expect(validateEnvelope(bad).ok).toBe(false);
    });
  }

  it("the four fixtures cover exactly the four hyphen-free health leaves", () => {
    expect(SIGNAL_HEALTH_FIXTURES.map((f) => f.type).sort()).toEqual(
      [
        SIGNAL_HEALTH_TYPES.backendReachable,
        SIGNAL_HEALTH_TYPES.backendUnreachable,
        SIGNAL_HEALTH_TYPES.collectorDegraded,
        SIGNAL_HEALTH_TYPES.collectorRecovered,
      ].sort(),
    );
  });
});

// ---------------------------------------------------------------------------
// 2. AC — the producer OPENS/RESOLVES driven by the CANONICAL envelope bodies
//    (validated above), not by hand-invented ad-hoc objects.
// ---------------------------------------------------------------------------

describe("produceObservabilityAttention — driven by canonical signal-health bodies", () => {
  let db: Database;
  beforeEach(() => {
    db = new Database(":memory:");
    for (const sql of SCHEMA_SQL) db.exec(sql);
  });
  afterEach(() => db.close());

  it("backend.unreachable OPENS att:adapter:transport:{id}; backend.reachable RESOLVES it", () => {
    const outage = SIGNAL_HEALTH_FIXTURES.find((f) => f.family === "backend-unreachable")!;
    const recovery = SIGNAL_HEALTH_FIXTURES.find((f) => f.family === "backend-reachable")!;

    const opened = produceObservabilityAttention(db, {
      type: outage.envelope.type,
      payload: outage.envelope.payload,
    });
    expect(opened).toMatchObject({ action: "opened" });
    expect(opened?.itemId.startsWith(`${ADAPTER_ATTENTION_PREFIX}transport:`)).toBe(true);

    const resolved = produceObservabilityAttention(db, {
      type: recovery.envelope.type,
      payload: recovery.envelope.payload,
    });
    expect(resolved).toMatchObject({ action: "resolved" });
    // Same origin id (`backend: "victoria"`) → resolves the item just opened.
    expect(resolved?.itemId).toBe(opened?.itemId);
  });

  it("collector.degraded OPENS; collector.recovered RESOLVES the same item", () => {
    const outage = SIGNAL_HEALTH_FIXTURES.find((f) => f.family === "collector-degraded")!;
    const recovery = SIGNAL_HEALTH_FIXTURES.find((f) => f.family === "collector-recovered")!;

    const opened = produceObservabilityAttention(db, {
      type: outage.envelope.type,
      payload: outage.envelope.payload,
    });
    expect(opened).toMatchObject({ action: "opened" });
    expect(opened?.itemId.startsWith(`${ADAPTER_ATTENTION_PREFIX}collector:`)).toBe(true);

    const resolved = produceObservabilityAttention(db, {
      type: recovery.envelope.type,
      payload: recovery.envelope.payload,
    });
    expect(resolved).toMatchObject({ action: "resolved" });
    expect(resolved?.itemId).toBe(opened?.itemId);
  });
});
