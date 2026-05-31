import { test, expect, describe, spyOn, afterEach } from "bun:test";
import { resolvePrincipalEnv } from "../principal-env";

describe("resolvePrincipalEnv — R9 (cortex#388 PR-3) compat shim", () => {
  afterEach(() => {
    // Restore any stderr spy installed by a test.
    spyOn(process.stderr, "write").mockRestore?.();
  });

  test("returns the canonical CORTEX_PRINCIPAL value when set", () => {
    const env = { CORTEX_PRINCIPAL: "andreas" };
    expect(resolvePrincipalEnv("", env)).toBe("andreas");
  });

  test("canonical name wins over both legacy names", () => {
    const env = {
      CORTEX_PRINCIPAL: "andreas",
      CORTEX_OPERATOR: "legacy-cortex",
      GROVE_OPERATOR: "legacy-grove",
    };
    expect(resolvePrincipalEnv("", env)).toBe("andreas");
  });

  test("v3.0.0 BREAKING — CORTEX_OPERATOR legacy fallback is REMOVED", () => {
    // R9 (cortex#388 / manifest PR-11) — the v2.x transition-release
    // compat shim that fell back from `CORTEX_OPERATOR*` → `CORTEX_PRINCIPAL*`
    // with a deprecation warning was deleted at v3.0.0. Principals
    // running `CORTEX_OPERATOR*` env vars rename them to
    // `CORTEX_PRINCIPAL*` before installing v3.
    const env = { CORTEX_OPERATOR: "legacy-cortex" };
    expect(resolvePrincipalEnv("", env)).toBeUndefined();
  });

  test("falls back to pre-cortex GROVE_OPERATOR without a warning", () => {
    const stderr = spyOn(process.stderr, "write").mockImplementation(() => true);
    const env = { GROVE_OPERATOR: "legacy-grove" };

    expect(resolvePrincipalEnv("", env)).toBe("legacy-grove");
    // No warning: the GROVE_* → CORTEX_* namespace rename is a separate
    // migration with its own deprecation window.
    expect(stderr).not.toHaveBeenCalled();
  });

  test("returns undefined when no tier is set", () => {
    expect(resolvePrincipalEnv("", {})).toBeUndefined();
  });

  test("honours a suffix for *_PRINCIPAL-family variables", () => {
    const env = { CORTEX_PRINCIPAL_ID: "andreas" };
    expect(resolvePrincipalEnv("_ID", env)).toBe("andreas");
  });

  test("v3.0.0 BREAKING — CORTEX_OPERATOR_<suffix> legacy fallback is REMOVED", () => {
    // Same v3.0.0 BREAKING as the bare `CORTEX_OPERATOR` test above. The
    // suffix variants are also dropped — principals rename
    // `CORTEX_OPERATOR_*` → `CORTEX_PRINCIPAL_*` before installing v3.
    const env = { CORTEX_OPERATOR_ID: "legacy" };
    expect(resolvePrincipalEnv("_ID", env)).toBeUndefined();
  });
});
