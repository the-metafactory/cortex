import { describe, expect, test } from "bun:test";
import { deskContractShape, deskSdkBumpMissing, deskSdkVersion } from "../check-desk-sdk";

const BASE = [
  "export declare const DESK_ADAPTER_SDK_VERSION = \"1.0.0\";",
  "export interface DeskAdapterHost {",
  "  readonly sdkVersion: string;",
  "  registerConnector(capabilityId: string): void;",
  "}",
].join("\n");

describe("deskSdkVersion", () => {
  test("reads the declared Desk adapter SDK version", () => {
    expect(deskSdkVersion(BASE)).toBe("1.0.0");
  });

  test("returns undefined when the artifact carries no version constant", () => {
    expect(deskSdkVersion("export interface DeskAdapterHost {}")).toBeUndefined();
  });
});

describe("deskSdkBumpMissing", () => {
  test("a changed exported contract without a version bump is refused", () => {
    const head = BASE.replace("registerConnector(capabilityId: string): void;", "registerConnector(capabilityId: string, create: unknown): void;");
    expect(deskSdkBumpMissing(BASE, head)).toBe(true);
  });

  test("a changed contract with a version bump is accepted", () => {
    const head = BASE
      .replace("1.0.0", "1.1.0")
      .replace("registerConnector(capabilityId: string): void;", "registerConnector(capabilityId: string, create: unknown): void;");
    expect(deskSdkBumpMissing(BASE, head)).toBe(false);
  });

  test("an unchanged contract is accepted", () => {
    expect(deskSdkBumpMissing(BASE, BASE.replace("1.0.0", "1.0.1"))).toBe(false);
  });

  test("comments and the version constant do not count as contract shape", () => {
    const head = `/** Docs. */\n${BASE.replace("1.0.0", "1.1.0")}`;
    expect(deskContractShape(head)).toBe(deskContractShape(BASE));
    expect(deskSdkBumpMissing(BASE, head)).toBe(false);
  });
});

describe("conformance contract versioning", () => {
  const conformance = 'export declare function runConformance(packageDir: string): Promise<ConformanceReport>;';

  test("publishing the entry requires a Desk SDK bump", () => {
    expect(deskSdkBumpMissing(BASE, BASE, undefined, conformance)).toBe(true);
    expect(deskSdkBumpMissing(BASE, BASE.replace("1.0.0", "1.1.0"), undefined, conformance)).toBe(false);
  });

  test("a harness-only contract change requires a Desk SDK bump", () => {
    const changed = conformance.replace("packageDir: string", "packageDir: string, failures: boolean");
    expect(deskSdkBumpMissing(BASE, BASE, conformance, changed)).toBe(true);
    expect(deskSdkBumpMissing(BASE, BASE.replace("1.0.0", "1.1.0"), conformance, changed)).toBe(false);
  });

  test("a report field change requires a Desk SDK bump", () => {
    const report = conformance + '\nexport interface ConformanceReport { status: string; }';
    expect(deskSdkBumpMissing(BASE, BASE, report, report.replace("status: string", "status: number"))).toBe(true);
    expect(deskSdkBumpMissing(BASE, BASE, report, '/** Description. */\n' + report)).toBe(false);
  });
});
