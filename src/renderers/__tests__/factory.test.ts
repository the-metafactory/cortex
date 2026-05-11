/**
 * MIG-7.2d — Renderer factory tests.
 *
 * Pins the discriminated-union dispatch in `createRenderer`. Each
 * implemented kind constructs the right runtime class; unimplemented
 * kinds throw `UnimplementedRendererKindError` with a tagged message
 * so a config typo fails fast at startup.
 */

import { describe, expect, test } from "bun:test";
import { createRenderer, DashboardRenderer, PagerDutyRenderer, UnimplementedRendererKindError } from "../index";

describe("createRenderer", () => {
  test("dispatches kind=dashboard → DashboardRenderer", () => {
    const r = createRenderer({
      kind: "dashboard",
      port: 8767,
      subscribe: ["local.{org}.>"],
      projections: [],
    });
    expect(r).toBeInstanceOf(DashboardRenderer);
    expect(r.kind).toBe("dashboard");
  });

  test("dispatches kind=pagerduty → PagerDutyRenderer", () => {
    const r = createRenderer({
      kind: "pagerduty",
      routingKey: "rk-test",
      subscribe: ["local.{org}.system.>"],
    });
    expect(r).toBeInstanceOf(PagerDutyRenderer);
    expect(r.kind).toBe("pagerduty");
  });

  test("kind=cli-tail throws UnimplementedRendererKindError (deferred)", () => {
    expect(() =>
      createRenderer({ kind: "cli-tail", subscribe: ["local.{org}.>"] }),
    ).toThrow(UnimplementedRendererKindError);
  });

  test("kind=webhook-out throws UnimplementedRendererKindError (deferred)", () => {
    expect(() =>
      createRenderer({
        kind: "webhook-out",
        url: "https://example.com/hook",
        subscribe: ["local.{org}.>"],
      }),
    ).toThrow(UnimplementedRendererKindError);
  });

  test("error message names the offending kind", () => {
    expect(() =>
      createRenderer({ kind: "cli-tail", subscribe: [] }),
    ).toThrow(/kind "cli-tail"/);
  });
});
