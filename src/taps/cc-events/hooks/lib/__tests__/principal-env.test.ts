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

  test("falls back to legacy CORTEX_OPERATOR and emits a deprecation warning", () => {
    const stderr = spyOn(process.stderr, "write").mockImplementation(() => true);
    const env = { CORTEX_OPERATOR: "legacy-cortex" };

    expect(resolvePrincipalEnv("", env)).toBe("legacy-cortex");

    expect(stderr).toHaveBeenCalledTimes(1);
    const msg = String(stderr.mock.calls[0]![0]);
    expect(msg).toContain("CORTEX_OPERATOR is deprecated");
    expect(msg).toContain("CORTEX_PRINCIPAL");
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

  test("suffix fallback resolves the legacy CORTEX_OPERATOR_<suffix>", () => {
    const stderr = spyOn(process.stderr, "write").mockImplementation(() => true);
    const env = { CORTEX_OPERATOR_ID: "legacy" };

    expect(resolvePrincipalEnv("_ID", env)).toBe("legacy");
    const msg = String(stderr.mock.calls[0]![0]);
    expect(msg).toContain("CORTEX_OPERATOR_ID is deprecated");
    expect(msg).toContain("CORTEX_PRINCIPAL_ID");
  });
});
