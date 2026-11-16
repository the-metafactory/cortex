import { describe, expect, test } from "bun:test";
import { deskApiTypesBumpMissing, deskApiTypesVersion } from "../check-desk-api-types";
import { checkDeskApiExport, importsCortex } from "../check-desk-api-export";

const BASE = [
  "export declare const DESK_API_VERSION = \"1.0.0\";",
  "export interface DeskView {",
  "  timeZone: string;",
  "}",
].join("\n");

describe("deskApiTypesBumpMissing", () => {
  test("reads the declared version", () => {
    expect(deskApiTypesVersion(BASE)).toBe("1.0.0");
  });

  test("a changed shape without a version bump is refused", () => {
    expect(deskApiTypesBumpMissing(BASE, BASE.replace("timeZone: string;", "timeZone: string;\n  zone: string;"))).toBe(true);
  });

  test("a changed shape with a version bump is accepted", () => {
    expect(deskApiTypesBumpMissing(BASE, BASE.replace("1.0.0", "1.1.0").replace("timeZone: string;", "timeZone: string;\n  zone: string;"))).toBe(false);
  });

  test("an unchanged shape needs no bump", () => {
    expect(deskApiTypesBumpMissing(BASE, BASE)).toBe(false);
  });
});

describe("the desk-api export", () => {
  test("an import-type-only consumer type-checks and compiles to code that does not import Cortex", async () => {
    const result = await checkDeskApiExport();
    expect(result.stdout + result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    expect(Object.keys(result.emitted).length).toBeGreaterThan(0);
    expect(importsCortex(result.emitted)).toEqual([]);
  }, 90_000);
});
