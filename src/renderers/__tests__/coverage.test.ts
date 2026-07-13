/**
 * cortex#1893 (S12b-pre, ADR-0024 §OQ9) — renderer-coverage boot HARD-FAIL
 * guard tests. Security-critical: a degraded/absent pager must produce a LOUD
 * no-boot, never a silent no-page.
 *
 * Each acceptance criterion from the issue is pinned by name below:
 *   AC1 — one configured system sink → CONFIG error (unchanged behaviour)
 *   AC2 — two configured, one bundle absent → INSTALL-STATE error (bundle + arc install)
 *   AC3 — `dashboard` alone never satisfies coverage
 *   AC4 — error text never leaks `routingKey`/secrets
 *   AC5 — healthy dashboard + loaded pagerduty BOOTS (no false hard-fail)
 */

import { describe, expect, test } from "bun:test";
import {
  assertConfiguredSystemCoverage,
  assertRuntimeSystemCoverage,
  evaluateSystemCoverage,
  rendererBundleForKind,
  rendererCoversSystem,
  subjectPatternsIntersect,
  systemProbeSubjects,
  RendererCoverageConfigError,
  RendererCoverageInstallStateError,
  INERT_RENDERER_KINDS,
  type RendererCoverageInput,
} from "../coverage";

const CTX = { principal: "andreas" } as const;
const CTX_STACKFUL = { principal: "andreas", stack: "work" } as const;

// The canonical covering configs, with placeholders as a real config carries them.
const DASHBOARD: RendererCoverageInput = { kind: "dashboard", subscribe: ["local.{principal}.>"] };
const PAGERDUTY_SYSTEM: RendererCoverageInput = {
  kind: "pagerduty",
  subscribe: ["local.{principal}.system.>"],
};

// =============================================================================
// Subject math — the coverage primitive
// =============================================================================

describe("subjectPatternsIntersect", () => {
  const tok = (s: string) => s.split(".");

  test("a broad `local.p.>` covers the system probe", () => {
    expect(subjectPatternsIntersect(tok("local.andreas.>"), tok("local.andreas.system.>"))).toBe(
      true,
    );
  });

  test("a specific system subject covers the probe", () => {
    expect(
      subjectPatternsIntersect(
        tok("local.andreas.system.adapter.degraded"),
        tok("local.andreas.system.>"),
      ),
    ).toBe(true);
  });

  test("a sibling family (`dispatch.>`) does NOT cover system — no fail-open false positive", () => {
    expect(
      subjectPatternsIntersect(tok("local.andreas.dispatch.>"), tok("local.andreas.system.>")),
    ).toBe(false);
  });

  test("an exact non-system subject does not cover system", () => {
    expect(subjectPatternsIntersect(tok("local.andreas"), tok("local.andreas.system.>"))).toBe(
      false,
    );
  });

  test("`*` matches a single token but not a family mismatch", () => {
    expect(
      subjectPatternsIntersect(tok("local.andreas.*.>"), tok("local.andreas.system.>")),
    ).toBe(true);
    expect(
      subjectPatternsIntersect(tok("local.*.dispatch.>"), tok("local.andreas.system.>")),
    ).toBe(false);
  });
});

describe("systemProbeSubjects / rendererCoversSystem", () => {
  test("stack-less deployment → single stack-less probe", () => {
    expect(systemProbeSubjects(CTX)).toEqual(["local.andreas.system.>"]);
  });

  test("stack-ful deployment → both stack-ful and stack-less probes (matches observability renderer)", () => {
    expect(systemProbeSubjects(CTX_STACKFUL)).toEqual([
      "local.andreas.work.system.>",
      "local.andreas.system.>",
    ]);
  });

  test("dashboard default `local.{principal}.>` covers system (stack-less and stack-ful)", () => {
    expect(rendererCoversSystem(DASHBOARD.subscribe, CTX)).toBe(true);
    expect(rendererCoversSystem(DASHBOARD.subscribe, CTX_STACKFUL)).toBe(true);
  });

  test("a stack-less system pattern covers system even in a stack-ful deployment", () => {
    expect(rendererCoversSystem(["local.{principal}.system.>"], CTX_STACKFUL)).toBe(true);
  });

  test("a stack-ful system pattern covers system in a stack-ful deployment", () => {
    expect(rendererCoversSystem(["local.{principal}.{stack}.system.>"], CTX_STACKFUL)).toBe(true);
  });

  test("an empty subscribe (pagerduty default) covers nothing", () => {
    expect(rendererCoversSystem([], CTX)).toBe(false);
    expect(rendererCoversSystem([], CTX_STACKFUL)).toBe(false);
  });

  test("a dispatch-only subscribe does not cover system (stack-less or stack-ful)", () => {
    expect(rendererCoversSystem(["local.{principal}.dispatch.>"], CTX)).toBe(false);
    expect(rendererCoversSystem(["local.{principal}.dispatch.>"], CTX_STACKFUL)).toBe(false);
    expect(rendererCoversSystem(["local.{principal}.{stack}.dispatch.>"], CTX_STACKFUL)).toBe(
      false,
    );
  });
});

// =============================================================================
// evaluateSystemCoverage — the rule
// =============================================================================

describe("evaluateSystemCoverage", () => {
  test("AC5: dashboard + system-covering pagerduty is satisfied", () => {
    const v = evaluateSystemCoverage([DASHBOARD, PAGERDUTY_SYSTEM], CTX);
    expect(v.coveringKinds).toEqual(["dashboard", "pagerduty"]);
    expect(v.effectiveCoveringKinds).toEqual(["pagerduty"]);
    expect(v.satisfied).toBe(true);
  });

  test("AC3: dashboard alone is in scope but NOT satisfied (inert, single class)", () => {
    const v = evaluateSystemCoverage([DASHBOARD], CTX);
    expect(v.inScope).toBe(true);
    expect(v.coveringKinds).toEqual(["dashboard"]);
    expect(v.effectiveCoveringKinds).toEqual([]);
    expect(v.satisfied).toBe(false);
  });

  test("AC1: a single effective sink (pagerduty alone) is not satisfied — <2 classes", () => {
    const v = evaluateSystemCoverage([PAGERDUTY_SYSTEM], CTX);
    expect(v.satisfied).toBe(false);
  });

  test("two EFFECTIVE covering classes are satisfied", () => {
    const v = evaluateSystemCoverage(
      [PAGERDUTY_SYSTEM, { kind: "webhook-out", subscribe: ["local.{principal}.system.>"] }],
      CTX,
    );
    expect(v.effectiveCoveringKinds).toEqual(["pagerduty", "webhook-out"]);
    expect(v.satisfied).toBe(true);
  });

  test("two dashboard INSTANCES are still one class → not satisfied (all-inert)", () => {
    const v = evaluateSystemCoverage(
      [DASHBOARD, { kind: "dashboard", subscribe: ["local.{principal}.system.>"] }],
      CTX,
    );
    expect(v.coveringKinds).toEqual(["dashboard"]);
    expect(v.satisfied).toBe(false);
  });

  test("out of scope: no system-covering renderer → satisfied (no blast radius on non-system stacks)", () => {
    const v = evaluateSystemCoverage(
      [{ kind: "webhook-out", subscribe: ["local.{principal}.dispatch.>"] }],
      CTX,
    );
    expect(v.inScope).toBe(false);
    expect(v.satisfied).toBe(true);
  });

  test("out of scope: zero renderers → satisfied", () => {
    expect(evaluateSystemCoverage([], CTX).satisfied).toBe(true);
  });

  test("`dashboard` is the inert kind", () => {
    expect(INERT_RENDERER_KINDS.has("dashboard")).toBe(true);
    expect(INERT_RENDERER_KINDS.has("pagerduty")).toBe(false);
  });
});

// =============================================================================
// assertConfiguredSystemCoverage — the CONFIG-LOAD guard (AC1, AC3)
// =============================================================================

describe("assertConfiguredSystemCoverage (config-load)", () => {
  test("AC5: dashboard + pagerduty passes without throwing", () => {
    expect(() => assertConfiguredSystemCoverage([DASHBOARD, PAGERDUTY_SYSTEM], CTX)).not.toThrow();
  });

  test("AC1: a single configured sink throws the CONFIG error", () => {
    expect(() => assertConfiguredSystemCoverage([PAGERDUTY_SYSTEM], CTX)).toThrow(
      RendererCoverageConfigError,
    );
  });

  test("AC3: dashboard alone throws the CONFIG error", () => {
    let thrown: unknown;
    try {
      assertConfiguredSystemCoverage([DASHBOARD], CTX);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(RendererCoverageConfigError);
    // It is a CONFIG fault, NOT an install-state fault.
    expect(thrown).not.toBeInstanceOf(RendererCoverageInstallStateError);
    expect((thrown as Error).message).toContain("(config)");
    expect((thrown as Error).message).toContain("[dashboard]");
  });

  test("out-of-scope / zero-renderer configs never throw", () => {
    expect(() => assertConfiguredSystemCoverage([], CTX)).not.toThrow();
    expect(() =>
      assertConfiguredSystemCoverage(
        [{ kind: "webhook-out", subscribe: ["local.{principal}.dispatch.>"] }],
        CTX,
      ),
    ).not.toThrow();
  });
});

// =============================================================================
// assertRuntimeSystemCoverage — the POST-S6 install-state guard (AC2, AC5)
// =============================================================================

describe("assertRuntimeSystemCoverage (post-S6 install-state)", () => {
  test("AC5: dashboard + started pagerduty BOOTS (no false hard-fail)", () => {
    expect(() =>
      assertRuntimeSystemCoverage(
        {
          // started renderers carry already-substituted concrete subjects.
          started: [
            { kind: "dashboard", subscribe: ["local.andreas.>"] },
            { kind: "pagerduty", subscribe: ["local.andreas.system.>"] },
          ],
          skippedForMissingBundle: [],
        },
        CTX,
      ),
    ).not.toThrow();
  });

  test("AC2: dashboard started but pagerduty bundle absent → INSTALL-STATE error naming bundle + arc install", () => {
    let thrown: unknown;
    try {
      assertRuntimeSystemCoverage(
        {
          started: [{ kind: "dashboard", subscribe: ["local.andreas.>"] }],
          // pagerduty's kind never registered → its config landed here.
          skippedForMissingBundle: [PAGERDUTY_SYSTEM],
        },
        CTX,
      );
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(RendererCoverageInstallStateError);
    // NOT reported as a config error.
    expect(thrown).not.toBeInstanceOf(RendererCoverageConfigError);
    const msg = (thrown as Error).message;
    expect(msg).toContain("(install-state)");
    expect(msg).toContain("metafactory-cortex-renderer-pagerduty");
    expect(msg).toContain("arc install metafactory-cortex-renderer-pagerduty");
    expect((thrown as RendererCoverageInstallStateError).missingKinds).toEqual(["pagerduty"]);
    expect((thrown as RendererCoverageInstallStateError).missingBundles).toEqual([
      "metafactory-cortex-renderer-pagerduty",
    ]);
  });

  test("AC5 (stack-ful): dashboard + started pagerduty with a stack segment BOOTS", () => {
    expect(() =>
      assertRuntimeSystemCoverage(
        {
          started: [
            { kind: "dashboard", subscribe: ["local.andreas.work.>"] },
            { kind: "pagerduty", subscribe: ["local.andreas.work.system.>"] },
          ],
          skippedForMissingBundle: [],
        },
        CTX_STACKFUL,
      ),
    ).not.toThrow();
  });

  test("a skipped bundle that does NOT cover system does not trigger install-state (shortfall is config)", () => {
    // started dashboard alone; the skipped bundle covers only dispatch → the
    // shortfall isn't explained by a missing SYSTEM sink → config error.
    let thrown: unknown;
    try {
      assertRuntimeSystemCoverage(
        {
          started: [{ kind: "dashboard", subscribe: ["local.andreas.>"] }],
          skippedForMissingBundle: [
            { kind: "webhook-out", subscribe: ["local.andreas.dispatch.>"] },
          ],
        },
        CTX,
      );
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(RendererCoverageConfigError);
  });

  test("bundle naming falls back to the compass#115 convention for unknown kinds", () => {
    expect(rendererBundleForKind("pagerduty")).toBe("metafactory-cortex-renderer-pagerduty");
    expect(rendererBundleForKind("slacklog")).toBe("metafactory-cortex-renderer-slacklog");
  });
});

// =============================================================================
// AC4 — secrets never leak into error text
// =============================================================================

describe("AC4: error text never leaks routingKey / secrets", () => {
  const SECRET = "R0UT1NG-K3Y-SUPER-SECRET-do-not-leak";

  test("CONFIG error carries only kinds — never the routingKey or a principal's subscribe values", () => {
    // A pagerduty-alone config whose secret must never surface. Use a
    // DISTINCTIVE subscribe token so we can prove the principal's actual
    // subject values are never echoed (only the generic rule template is).
    const distinctive = "local.andreas.system.super-private-family.>";
    const err = new RendererCoverageConfigError(
      evaluateSystemCoverage([{ kind: "pagerduty", subscribe: [distinctive] }], CTX),
    );
    expect(err.message).not.toContain(SECRET);
    expect(err.message).not.toContain("routingKey");
    // The principal's own subscribe patterns are never echoed.
    expect(err.message).not.toContain("super-private-family");
  });

  test("INSTALL-STATE error carries only kinds + bundle names — never the routingKey", () => {
    const err = new RendererCoverageInstallStateError(["pagerduty"]);
    expect(err.message).not.toContain(SECRET);
    expect(err.message).not.toContain("routingKey");
  });

  test("the guard never READS a secret field — passing a routingKey-bearing entry cannot surface it", () => {
    // Simulate the real raw config entry shape: pagerduty carries `routingKey`.
    const withSecret: RendererCoverageInput & { routingKey: string } = {
      kind: "pagerduty",
      subscribe: ["local.{principal}.system.>"],
      routingKey: SECRET,
    };
    let msg = "";
    try {
      assertRuntimeSystemCoverage(
        {
          started: [{ kind: "dashboard", subscribe: ["local.andreas.>"] }],
          skippedForMissingBundle: [withSecret],
        },
        CTX,
      );
    } catch (err) {
      msg = (err as Error).message;
    }
    expect(msg).toContain("(install-state)");
    expect(msg).not.toContain(SECRET);
  });
});
