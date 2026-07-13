/**
 * MIG-7.2d — Renderer factory tests.
 *
 * Pins the discriminated-union dispatch in `createRenderer`. Each
 * implemented kind constructs the right runtime class; unimplemented
 * kinds throw `UnimplementedRendererKindError` with a tagged message
 * so a config typo fails fast at startup.
 */

import { describe, expect, test } from "bun:test";
import { createRenderer, DashboardRenderer, UnimplementedRendererKindError } from "../index";
import { createDefaultSurfacePluginRegistry } from "../../adapters/registry";

// cortex#1788 (S3, ADR-0024 D5) — `createRenderer` now resolves through the
// registry instead of switching on `RendererKind`. `cli-tail`/`webhook-out`
// are NOT registered in this slice (S6 owns shipping them as bundles), so
// they still hit `UnimplementedRendererKindError` — same observable
// behavior, different mechanism (unregistered vs. schema-recognised-but-
// unimplemented). cortex#1894 (S12b) — `pagerduty` extracted to the
// `metafactory-cortex-renderer-pagerduty` bundle, so the in-tree default
// registry no longer registers it either: `dashboard` is the only in-tree
// renderer (OQ8 anchor), and `pagerduty` now hits the same unregistered-kind
// path until its bundle loads at daemon boot.
const registry = createDefaultSurfacePluginRegistry();

describe("createRenderer", () => {
  test("dispatches kind=dashboard → DashboardRenderer", () => {
    const r = createRenderer({
      kind: "dashboard",
      port: 8767,
      subscribe: ["local.{principal}.>"],
      projections: [],
    }, registry);
    expect(r).toBeInstanceOf(DashboardRenderer);
    expect(r.kind).toBe("dashboard");
  });

  test("kind=pagerduty throws UnimplementedRendererKindError in-tree (extracted to a bundle, cortex#1894)", () => {
    expect(() =>
      createRenderer({
        kind: "pagerduty",
        routingKey: "rk-test",
        subscribe: ["local.{principal}.system.>"],
      }, registry),
    ).toThrow(UnimplementedRendererKindError);
  });

  test("kind=cli-tail throws UnimplementedRendererKindError (not registered in this slice)", () => {
    expect(() =>
      createRenderer({ kind: "cli-tail", subscribe: ["local.{principal}.>"] }, registry),
    ).toThrow(UnimplementedRendererKindError);
  });

  test("kind=webhook-out throws UnimplementedRendererKindError (not registered in this slice)", () => {
    expect(() =>
      createRenderer({
        kind: "webhook-out",
        url: "https://example.com/hook",
        subscribe: ["local.{principal}.>"],
      }, registry),
    ).toThrow(UnimplementedRendererKindError);
  });

  test("error message names the offending kind", () => {
    expect(() =>
      createRenderer({ kind: "cli-tail", subscribe: [] }, registry),
    ).toThrow(/kind "cli-tail"/);
  });
});
