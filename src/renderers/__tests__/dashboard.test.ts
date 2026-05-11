/**
 * MIG-7.2d — DashboardRenderer tests.
 *
 * The dashboard renderer is a stub for this slice: ring-buffer storage
 * over rendered envelopes, full Mission Control integration deferred to
 * MIG-7.13. Tests pin the bounded-buffer behavior and the surface-router
 * contract so Mission Control's eventual reader can rely on a stable
 * snapshot shape.
 */

import { describe, expect, test } from "bun:test";
import { DashboardRenderer } from "../dashboard";
import type { Envelope } from "../../bus/myelin/envelope-validator";

function makeEnvelope(id: string): Envelope {
  return {
    id,
    source: "metafactory.test",
    type: "test.event",
    timestamp: "2026-05-11T18:00:00Z",
    sovereignty: {
      classification: "local",
      data_residency: "NZ",
      max_hop: 0,
      frontier_ok: true,
      model_class: "any",
    },
    payload: {},
  };
}

describe("DashboardRenderer", () => {
  test("buffers rendered envelopes in insertion order", async () => {
    const r = new DashboardRenderer({ kind: "dashboard", port: 8767, subscribe: ["local.{org}.>"], projections: [] });
    await r.render(makeEnvelope("e1"));
    await r.render(makeEnvelope("e2"));
    await r.render(makeEnvelope("e3"));
    expect(r.getRecent().map((e) => e.id)).toEqual(["e1", "e2", "e3"]);
  });

  test("respects the bufferSize bound (drops oldest)", async () => {
    const r = new DashboardRenderer(
      { kind: "dashboard", port: 8767, subscribe: ["local.{org}.>"], projections: [] },
      { bufferSize: 3 },
    );
    await r.render(makeEnvelope("e1"));
    await r.render(makeEnvelope("e2"));
    await r.render(makeEnvelope("e3"));
    await r.render(makeEnvelope("e4")); // overflows — e1 drops
    expect(r.getRecent().map((e) => e.id)).toEqual(["e2", "e3", "e4"]);
  });

  test("getRecent() returns a snapshot copy — caller mutation does not leak", async () => {
    const r = new DashboardRenderer({ kind: "dashboard", port: 8767, subscribe: ["local.{org}.>"], projections: [] });
    await r.render(makeEnvelope("e1"));
    const snap = r.getRecent() as Envelope[];
    // Try to mutate the snapshot.
    snap.push(makeEnvelope("e2-fake"));
    expect(r.getRecent().map((e) => e.id)).toEqual(["e1"]);
  });

  test("stop() drops the buffer", async () => {
    const r = new DashboardRenderer({ kind: "dashboard", port: 8767, subscribe: ["local.{org}.>"], projections: [] });
    await r.render(makeEnvelope("e1"));
    await r.render(makeEnvelope("e2"));
    await r.stop();
    expect(r.getRecent()).toEqual([]);
  });

  test("render() never throws even on absurd input", async () => {
    const r = new DashboardRenderer({ kind: "dashboard", port: 8767, subscribe: ["local.{org}.>"], projections: [] });
    // Cast to bypass type checking — simulates a malformed envelope leaking
    // past the router's validator (defense-in-depth on the renderer contract).
    const badEnv = null as unknown as Envelope;
    await expect(r.render(badEnv)).resolves.toBeUndefined();
  });

  test("render() silently drops null/non-object envelopes (does not leak into buffer)", async () => {
    const r = new DashboardRenderer({ kind: "dashboard", port: 8767, subscribe: ["local.{org}.>"], projections: [] });
    await r.render(makeEnvelope("e1"));
    // Malformed values must not corrupt the buffer — Holly cycle 1 W2.
    await r.render(null as unknown as Envelope);
    await r.render("not an envelope" as unknown as Envelope);
    await r.render(undefined as unknown as Envelope);
    await r.render(makeEnvelope("e2"));
    expect(r.getRecent().map((e) => e.id)).toEqual(["e1", "e2"]);
  });

  test("render() after stop() re-fills the buffer (intentional — stop is a teardown signal, not a render disable)", async () => {
    // Holly cycle 1 S1: pin the post-stop behavior. The Renderer contract
    // §3 says render-after-stop SHOULD be a no-op, but the dashboard's
    // ring buffer is the only state — re-filling after stop() is harmless
    // and matches the lifecycle (a fresh start() returns to the same
    // empty-buffer state). Tests can rely on this for clean iteration.
    const r = new DashboardRenderer({ kind: "dashboard", port: 8767, subscribe: ["local.{org}.>"], projections: [] });
    await r.render(makeEnvelope("e1"));
    await r.stop();
    expect(r.getRecent()).toEqual([]);
    await r.render(makeEnvelope("e2"));
    expect(r.getRecent().map((e) => e.id)).toEqual(["e2"]);
  });

  test("surfaceConfig exposes the configured subscribe patterns + dashboard id", () => {
    const r = new DashboardRenderer({
      kind: "dashboard",
      port: 8767,
      subscribe: ["local.{org}.review.>", "local.{org}.attention.>"],
      projections: [],
    });
    expect(r.surfaceConfig.id).toBe("dashboard");
    expect(r.surfaceConfig.subjects).toEqual(["local.{org}.review.>", "local.{org}.attention.>"]);
  });

  test("start() is a no-op (idempotent, fast)", async () => {
    const r = new DashboardRenderer({ kind: "dashboard", port: 8767, subscribe: ["local.{org}.>"], projections: [] });
    await r.start();
    await r.start(); // idempotent
    expect(r.getRecent()).toEqual([]);
  });
});
