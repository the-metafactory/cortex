import { describe, test, expect } from "bun:test";
import { resolveReviewEngine } from "../review-engine";

describe("resolveReviewEngine — explicit engine", () => {
  test("engine: sage + substrate: codex → sage via codex (the case that used to fall through)", () => {
    expect(resolveReviewEngine({ engine: "sage", substrate: "codex" })).toEqual({
      engine: "sage",
      backend: "codex",
    });
  });

  test("engine: sage + substrate: claude → sage via claude", () => {
    expect(resolveReviewEngine({ engine: "sage", substrate: "claude" })).toEqual({
      engine: "sage",
      backend: "claude",
    });
  });

  test("engine: sage + no substrate → sage via pi (sage default backend)", () => {
    expect(resolveReviewEngine({ engine: "sage" })).toEqual({ engine: "sage", backend: "pi" });
  });

  test("engine: persona → persona regardless of substrate", () => {
    expect(resolveReviewEngine({ engine: "persona", substrate: "codex" }).engine).toBe("persona");
  });
});

describe("resolveReviewEngine — legacy migration (no engine field)", () => {
  test("legacy substrate: pi-dev → sage via pi (only value that selected the sage runner before)", () => {
    expect(resolveReviewEngine({ substrate: "pi-dev" })).toEqual({ engine: "sage", backend: "pi" });
  });

  test("legacy substrate: claude-code → persona (unchanged)", () => {
    expect(resolveReviewEngine({ substrate: "claude-code" }).engine).toBe("persona");
  });

  test("legacy substrate: codex → persona (unchanged — this was the silent-fallthrough bug)", () => {
    expect(resolveReviewEngine({ substrate: "codex" }).engine).toBe("persona");
  });

  test("no runtime → persona (the default CC path)", () => {
    expect(resolveReviewEngine(undefined).engine).toBe("persona");
    expect(resolveReviewEngine({}).engine).toBe("persona");
  });
});

describe("resolveReviewEngine — backend normalization", () => {
  test("pi-dev → pi, claude-code → claude (engine-flavored legacy values map to clean backends)", () => {
    expect(resolveReviewEngine({ engine: "sage", substrate: "pi-dev" }).backend).toBe("pi");
    expect(resolveReviewEngine({ engine: "sage", substrate: "claude-code" }).backend).toBe("claude");
  });
});
