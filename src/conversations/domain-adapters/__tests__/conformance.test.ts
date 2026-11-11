import { createHash } from "node:crypto";
import { lstatSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { describe, expect, test } from "bun:test";
import { runConformance, type CapabilityReport, type ConformanceReport } from "../../../../scripts/desk-adapter-conformance";
import { guardNetwork } from "../../../../scripts/lib/desk-conformance/network";
import { sampleValue } from "../../../../scripts/lib/desk-conformance/sample";
import { CONFORMANCE_DOMAINS, CONFORMANCE_PACKAGES, CONFORMANCE_PACKAGES_ROOT, writeConformancePackages } from "./fixtures/conformance-build";

const packageDir = (name: string): string => join(CONFORMANCE_PACKAGES_ROOT, name);
const probeOf = (report: ConformanceReport, probe: CapabilityReport["probe"]): CapabilityReport[] => report.capabilities.filter(item => item.probe === probe);

function treeDigest(root: string): string {
  const hash = createHash("sha256");
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      const stat = lstatSync(path);
      hash.update(relative(root, path));
      if (stat.isDirectory()) walk(path);
      else hash.update(stat.isSymbolicLink() ? readlinkSync(path) : readFileSync(path));
    }
  };
  walk(root);
  return hash.digest("hex");
}

describe("valid packages from different domains", () => {
  for (const name of ["greenhouse", "observatory"] as const) {
    test(`${name} reports every declared capability conformant`, async () => {
      const report = await runConformance(packageDir(name));
      expect(report.status).toBe("conformant");
      expect(report.capabilities.every(item => item.verdict === "conformant")).toBe(true);
      for (const probe of ["destinations", "query", "observation", "draft", "action", "readback"] as const) expect(probeOf(report, probe).length).toBeGreaterThan(0);
      expect(report.actions).toHaveLength(1);
      expect(report.ownerCalls.dispatch).toBe(1);
      expect(report.ownerCalls.readback).toBe(1);
    });
  }

  test("a query that returns a cursor is followed to its last page", async () => {
    const report = await runConformance(packageDir("greenhouse"));
    const query = probeOf(report, "query")[0];
    expect(query?.detail).toContain("2 page(s)");
    expect(query?.released).toBeGreaterThan(0);
  });

  test("the two packages share no domain identity", async () => {
    const [first, second] = await Promise.all([runConformance(packageDir("greenhouse")), runConformance(packageDir("observatory"))]);
    expect(first.adapterId).not.toBe(second.adapterId);
    expect(first.capabilities.map(item => item.capabilityId)).not.toEqual(second.capabilities.map(item => item.capabilityId));
  });
});

describe("a read-only package", () => {
  test("reports no action and makes zero owner calls", async () => {
    const report = await runConformance(packageDir("tideway"));
    expect(report.status).toBe("conformant");
    expect(report.actions).toEqual([]);
    expect(report.ownerCalls).toEqual({ dispatch: 0, cancel: 0, lookup: 0, readback: 0 });
    for (const probe of ["draft", "action", "readback"] as const) expect(probeOf(report, probe)).toEqual([]);
    expect(probeOf(report, "query")[0]?.verdict).toBe("conformant");
    expect(probeOf(report, "observation")[0]?.verdict).toBe("conformant");
  });
});

describe("a package the host refuses", () => {
  const refusals: [string, string][] = [
    ["broken-digest", "digest_mismatch"],
    ["broken-format", "unsupported_format"],
    ["broken-symlink", "containment_escape"],
    ["broken-throws", "module_throwing"],
    ["broken-mismatch", "module_incompatible"],
  ];
  for (const [name, code] of refusals) {
    test(`${name} is refused with ${code} and runs no capability`, async () => {
      const report = await runConformance(packageDir(name));
      expect(report.status).toBe("refused");
      expect(report.code).toBe(code);
      expect(report.capabilities).toEqual([]);
      expect(report.ownerCalls.dispatch).toBe(0);
    });
  }
});

describe("a backend whose read the host refuses", () => {
  for (const name of ["bad-annotation", "outside-destination"] as const) {
    test(`${name} is refused on its query and releases nothing`, async () => {
      const report = await runConformance(packageDir(name));
      expect(report.status).toBe("refused");
      expect(report.code).toBe("invalid_annotations");
      const query = probeOf(report, "query")[0];
      expect(query?.verdict).toBe("refused");
      expect(query?.code).toBe("invalid_annotations");
      expect(query?.released).toBe(0);
    });
  }
});

describe("a package that needs a credential the harness will not request", () => {
  for (const [name, kind] of [["token-only", "token"], ["broker-only", "broker"]] as const) {
    test(`${name} is not run, says why, and requests no credential`, async () => {
      const report = await runConformance(packageDir(name));
      expect(report.status).toBe("not-run");
      expect(report.code).toBe("authentication_unsupported");
      expect(report.reason).toContain(kind);
      expect(report.capabilities).toEqual([]);
      expect(report.credentialRequests).toBe(0);
      expect(report.ownerCalls.dispatch).toBe(0);
    });
  }
});

describe("every run", () => {
  test("makes no network request and writes nothing outside its own temporary directory", async () => {
    const names = Object.keys(CONFORMANCE_PACKAGES);
    const tempParent = mkdtempSync(join(tmpdir(), "conformance-check-"));
    const digests = new Map(names.map(name => [name, treeDigest(packageDir(name))]));
    const realFetch = globalThis.fetch;
    try {
      for (const name of names) {
        const report = await runConformance(packageDir(name), tempParent);
        expect(report.networkRequests).toBe(0);
      }
      expect(globalThis.fetch).toBe(realFetch);
      expect(readdirSync(tempParent)).toEqual([]);
      for (const name of names) expect(treeDigest(packageDir(name))).toBe(digests.get(name) ?? "");
    } finally {
      rmSync(tempParent, { recursive: true, force: true });
    }
  });

  test("the network guard refuses and counts an attempted request", async () => {
    const guard = guardNetwork();
    try {
      expect(() => fetch("https://example.invalid/")).toThrow();
      expect(guard.count()).toBe(1);
    } finally {
      guard.release();
    }
  });

  test("the committed fixture packages match what the generator writes", () => {
    const scratch = mkdtempSync(join(tmpdir(), "desk-conformance-fixture-"));
    try {
      writeConformancePackages(scratch);
      for (const name of Object.keys(CONFORMANCE_PACKAGES)) expect(treeDigest(join(scratch, name))).toBe(treeDigest(packageDir(name)));
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});

describe("the sample builder", () => {
  test("builds a value from the declared schema alone", () => {
    const schema = { type: "object", required: ["title", "count", "tags"], properties: { title: { type: "string", minLength: 3 }, count: { type: "integer", minimum: 2 }, tags: { type: "array", minItems: 1, items: { type: "string" } } } };
    const sample = { schemas: new Map(), destinations: [], adapterId: "x", connectionId: "y" };
    expect(sampleValue(schema, sample)).toEqual({ title: "conformance", count: 2, tags: ["conformance"] });
  });
});

describe("the host source", () => {
  test("contains no identifier from the fixture packages' domains", () => {
    const identifiers = Object.values(CONFORMANCE_DOMAINS).flatMap(domain => [domain.adapterId, domain.place.type, domain.item.type]);
    expect(identifiers.length).toBeGreaterThan(0);
    const roots = ["src/conversations", "src/desk-sdk", "scripts/lib/desk-conformance"];
    const files = [...roots.flatMap(root => [...new Bun.Glob("**/*.ts").scanSync({ cwd: join(import.meta.dir, "../../../..", root), absolute: true })]), join(import.meta.dir, "../../../../scripts/desk-adapter-conformance.ts")]
      .filter(file => !file.includes("/__tests__/") && !file.endsWith(".d.ts"));
    expect(files.length).toBeGreaterThan(10);
    const hits = files.flatMap(file => {
      const source = readFileSync(file, "utf8");
      return identifiers.filter(identifier => new RegExp(`\\b${identifier}\\b`, "i").test(source)).map(identifier => `${relative(process.cwd(), file)}: ${identifier}`);
    });
    expect(hits).toEqual([]);
  });
});

describe("network guard", () => {
  test("overlapping guards restore the original fetch only after the last release", () => {
    const original = globalThis.fetch;
    const first = guardNetwork();
    const second = guardNetwork();
    first.release();
    expect(globalThis.fetch).not.toBe(original);
    second.release();
    expect(globalThis.fetch).toBe(original);
  });

  test("fetch.preconnect is refused and counted", () => {
    const guard = guardNetwork();
    try {
      expect(() => (globalThis.fetch as unknown as { preconnect: (url: string) => void }).preconnect("http://example.invalid")).toThrow();
      expect(guard.count()).toBe(1);
    } finally {
      guard.release();
    }
  });
});

describe("sampled strings", () => {
  test("respect maxLength", () => {
    const context = { schemas: new Map(), destinations: [], adapterId: "a", connectionId: "c" };
    expect(String(sampleValue({ type: "string", maxLength: 3 }, context)).length).toBeLessThanOrEqual(3);
  });
});

describe("network guard attribution", () => {
  test("an attempt is counted only for the run that made it", async () => {
    const attempt = async (requests: number): Promise<number> => {
      const guard = guardNetwork();
      await Promise.resolve();
      for (let index = 0; index < requests; index++) expect(() => fetch("https://example.invalid/")).toThrow();
      await Promise.resolve();
      const count = guard.count();
      guard.release();
      return count;
    };
    const [quiet, noisy] = await Promise.all([attempt(0), attempt(2)]);
    expect(quiet).toBe(0);
    expect(noisy).toBe(2);
  });
});
