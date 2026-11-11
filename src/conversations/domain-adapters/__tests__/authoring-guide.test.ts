import { resolve } from "node:path";
import { expect, test } from "bun:test";
import { runConformance } from "../../../../scripts/desk-adapter-conformance";

for (const name of ["domain-adapter", "blind-domain-adapter"]) test(`${name} conforms across every declared capability`, async () => {
  const packageDir = resolve(import.meta.dir, "../../../../docs/desk/examples", name);
  const manifest = await Bun.file(resolve(packageDir, "desk-adapter.json")).json() as { declaration: { capabilities: { capabilityId: string }[] } };
  const report = await runConformance(packageDir);
  expect(report.status).toBe("conformant");
  expect(report.capabilities.every(item => item.verdict === "conformant")).toBe(true);
  expect(new Set(report.capabilities.map(item => item.probe))).toEqual(new Set(["destinations", "query", "observation", "draft", "action", "readback"]));
  expect(new Set(report.capabilities.map(item => item.capabilityId))).toEqual(new Set(manifest.declaration.capabilities.map(item => item.capabilityId)));
  expect(report.capabilities.find(item => item.probe === "query")?.detail).toContain("2 page(s)");
  expect(report.ownerCalls).toEqual({ dispatch: 1, cancel: 0, lookup: 0, readback: 1 });
  expect(report.networkRequests).toBe(0);
  expect(report.credentialRequests).toBe(0);
});
