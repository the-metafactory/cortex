/**
 * P-14 U3.3 (#937) — curation gate tests (the NEGATIVE CONTROL, pure-function half).
 *
 * The curation gate is cortex's OWN, code-fixed mirror of signal's U3.2 recipe
 * (signal#141): ALLOW `system.{transport,federation}.>`; DENY everything else
 * (`trace.>`, `metric.>`, `log.>`, `session.>`, `system.signal.*`, any novel
 * class). This file pins the class matrix exhaustively — it is where the
 * negative control is proven at the gate level, BEFORE the integration test
 * proves a denied class never reaches the projection.
 */

import { describe, expect, test } from "bun:test";
import {
  evaluateObservabilityCuration,
  isFoldableObservabilityClass,
  FOLDED_OBSERVABILITY_PREFIXES,
  DENIED_OBSERVABILITY_PREFIXES,
} from "../federated-observability-curation";

describe("evaluateObservabilityCuration — ALLOW-list (the folded classes)", () => {
  test.each([
    "system.transport.leaf_connect",
    "system.transport.leaf_disconnect",
    "system.transport.liveness_drift",
    "system.transport.roster_snapshot",
    "system.transport.backend.reachable",
    "system.federation.peer.added",
    "system.federation.peer.removed",
  ])("ALLOWS the curated class %s", (type) => {
    expect(evaluateObservabilityCuration(type)).toEqual({ kind: "allow" });
    expect(isFoldableObservabilityClass(type)).toBe(true);
  });
});

describe("evaluateObservabilityCuration — DENY (the NEGATIVE CONTROL)", () => {
  test.each([
    // The session interior — NEVER folded cross-principal (ADR-0005).
    "trace.span.start",
    "trace.span.end",
    // Telemetry streams — signal's bounded context, not cortex's.
    "metric.gauge.observed",
    "log.record.emitted",
    "session.lifecycle.started",
    // A peer's collector substrate health — `system.signal.*` is DENIED while
    // its `system.federation.`/`system.transport.` siblings ALLOW. This is the
    // case the allow-list (not a `system.>` blanket) exists to catch.
    "system.signal.received",
    "system.signal.collector.degraded",
    "system.signal.collector.recovered",
  ])("DENIES the non-exported class %s (negative control)", (type) => {
    expect(evaluateObservabilityCuration(type)).toEqual({
      kind: "deny_not_curated",
      type,
    });
    expect(isFoldableObservabilityClass(type)).toBe(false);
  });

  test("DENIES an unanticipated novel class (fail-closed default-deny)", () => {
    // A peer cannot widen the fold by inventing a new class — deny is the default.
    expect(isFoldableObservabilityClass("system.exfiltrate.everything")).toBe(false);
    expect(isFoldableObservabilityClass("dispatch.task.started")).toBe(false);
    expect(isFoldableObservabilityClass("")).toBe(false);
    // A near-miss that merely STARTS like an allow prefix but isn't (no dot
    // boundary) must not slip through.
    expect(isFoldableObservabilityClass("system.transportx.evil")).toBe(false);
    expect(isFoldableObservabilityClass("system.federationx.evil")).toBe(false);
  });
});

describe("recipe correspondence — the allow/deny lists match signal#141", () => {
  test("the ALLOW prefixes are exactly transport + federation", () => {
    expect([...FOLDED_OBSERVABILITY_PREFIXES].sort()).toEqual([
      "system.federation.",
      "system.transport.",
    ]);
  });

  test("every documented DENY prefix is in fact denied by the gate", () => {
    // Belt-and-braces: the gate is allow-list-driven (deny is the default), so
    // every entry on the documented DENY list must evaluate to a deny when
    // exercised with a representative child class.
    for (const prefix of DENIED_OBSERVABILITY_PREFIXES) {
      const type = `${prefix}example.child`;
      expect(isFoldableObservabilityClass(type)).toBe(false);
    }
  });
});
