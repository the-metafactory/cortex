import { describe, test, expect } from "bun:test";
import { resolveReviewEngine } from "../review-engine";

describe("resolveReviewEngine — explicit engine", () => {
  test("engine: sage + model: codex → sage via codex (the case that used to fall through)", () => {
    expect(resolveReviewEngine({ engine: "sage", model: "codex" })).toEqual({
      engine: "sage",
      model: "codex",
    });
  });

  test("engine: sage + model: claude → sage via claude", () => {
    expect(resolveReviewEngine({ engine: "sage", model: "claude" })).toEqual({
      engine: "sage",
      model: "claude",
    });
  });

  test("engine: sage + no model → sage, model undefined (runner applies its default)", () => {
    expect(resolveReviewEngine({ engine: "sage" })).toEqual({ engine: "sage" });
  });

  test("engine: persona → persona, no model regardless of any model field", () => {
    expect(resolveReviewEngine({ engine: "persona", model: "codex" })).toEqual({
      engine: "persona",
    });
  });
});

describe("resolveReviewEngine — legacy migration (no engine field)", () => {
  test("legacy substrate: pi-dev → sage with NO model (runner honors SAGE_SUBSTRATE env — true parity, cortex#920 round 2)", () => {
    // Must NOT force model:pi — the pre-split `makePiDevPipelineRunner({})`
    // deferred to SAGE_SUBSTRATE env, so an un-migrated pi-dev config with
    // SAGE_SUBSTRATE=claude|codex kept that override.
    expect(resolveReviewEngine({ substrate: "pi-dev" })).toEqual({ engine: "sage" });
  });

  test("legacy substrate: claude-code → persona (unchanged)", () => {
    expect(resolveReviewEngine({ substrate: "claude-code" })).toEqual({ engine: "persona" });
  });

  test("legacy substrate: codex → persona (unchanged — this was the silent-fallthrough bug)", () => {
    expect(resolveReviewEngine({ substrate: "codex" })).toEqual({ engine: "persona" });
  });

  test("no runtime → persona (the default CC path)", () => {
    expect(resolveReviewEngine(undefined)).toEqual({ engine: "persona" });
    expect(resolveReviewEngine({})).toEqual({ engine: "persona" });
  });
});

describe("resolveReviewEngine — no silent backend coercion (cortex#920)", () => {
  test("model is passed through verbatim, never normalized to pi", () => {
    // The schema's z.enum already constrains model to claude|codex|pi, so the
    // resolver must NOT re-map — an out-of-enum value can't reach here, and a
    // valid one is forwarded as-is (no fail-open).
    expect(resolveReviewEngine({ engine: "sage", model: "pi" }).model).toBe("pi");
    expect(resolveReviewEngine({ engine: "sage", model: "claude" }).model).toBe("claude");
  });
});
