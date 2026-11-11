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

interface ObjectReference { adapterId: string; connectionId: string; objectType: string; canonicalId: string }
interface ArchiveItem { title: string; shelf: ObjectReference }
interface ArchivePage { payload: { items: ArchiveItem[] }; snapshot: { kind: string; id?: string }; cursor?: string }
interface ArchiveConnector {
  dispatch(request: { operationId: string; attemptId: string; ownerRequestId: string; snapshot: { input: unknown; digest: string } }, signal: AbortSignal): { result: { kind: string; output?: { ref: ObjectReference } } };
  readback(request: { ref: ObjectReference }, signal: AbortSignal): { result: { kind: string; value?: ArchiveItem } };
}
type ArchiveFactory = (connection: { adapterId: string; connectionId: string }) => ArchiveConnector;
interface ArchiveAdapter {
  bindings: {
    handlers: Record<string, (request: { destinations: ObjectReference[]; limit: number; cursor?: string }, signal: AbortSignal) => ArchivePage>;
    observations: Record<string, { fetch(request: { source: { connectionId: string; destinations: ObjectReference[] } }, signal: AbortSignal): { payload: { items: ArchiveItem[] } } }>;
  };
}

const adapterId = "archive";
const reference = (connectionId: string, objectType: string): ObjectReference => ({ adapterId, connectionId, objectType, canonicalId: objectType === "shelf" ? "main" : "root" });
const signal = new AbortController().signal;

async function guideExample(): Promise<{ adapter: ArchiveAdapter; connectors: Map<string, ArchiveFactory> }> {
  const module = await import(resolve(import.meta.dir, "../../../../docs/desk/examples/domain-adapter/backend.mjs")) as { createDeskAdapter: (host: { sdkVersion: string; registerConnector: (id: string, factory: ArchiveFactory) => void }) => ArchiveAdapter };
  const connectors = new Map<string, ArchiveFactory>();
  const adapter = module.createDeskAdapter({ sdkVersion: "1.2.0", registerConnector: (id, factory) => connectors.set(id, factory) });
  return { adapter, connectors };
}

test("the guide's archive example retains query snapshots and isolates connections", async () => {
  const { adapter, connectors } = await guideExample();
  const handler = (id: string) => {
    const found = adapter.bindings.handlers[id];
    if (found === undefined) throw new Error(`The example declares no ${id} handler.`);
    return found;
  };
  const factory = (id: string, connectionId: string) => {
    const found = connectors.get(id);
    if (found === undefined) throw new Error(`The example registers no ${id} connector.`);
    return found({ adapterId, connectionId });
  };
  const observation = adapter.bindings.observations["archive.record.watch"];
  if (observation === undefined) throw new Error("The example declares no archive.record.watch observation.");

  const firstA = handler("archive.record.list")({ destinations: [reference("connection-a", "shelf")], limit: 2 }, signal);
  expect(firstA.payload.items.map(item => item.title)).toEqual(["Index", "Ledger"]);
  if (firstA.cursor === undefined) throw new Error("The example returned no cursor for its first page.");

  const written = factory("archive.record.create", "connection-a").dispatch({ operationId: "operation-1", attemptId: "attempt-1", ownerRequestId: "request-1", snapshot: { input: { title: "Written through A", shelf: reference("connection-a", "shelf") }, digest: "digest-1" } }, signal);
  const created = written.result.output?.ref;
  if (created === undefined) throw new Error("The example returned no created reference.");

  const secondA = handler("archive.record.list")({ destinations: [reference("connection-a", "shelf")], limit: 2, cursor: firstA.cursor }, signal);
  expect(secondA.snapshot.id).toBe(firstA.snapshot.id);
  expect(secondA.payload.items.map(item => item.title)).toEqual(["Register"]);

  const freshA = handler("archive.record.list")({ destinations: [reference("connection-a", "shelf")], limit: 10 }, signal);
  expect(freshA.payload.items.map(item => item.title)).toEqual(["Index", "Ledger", "Register", "Written through A"]);

  const pageB = handler("archive.record.list")({ destinations: [reference("connection-b", "shelf")], limit: 10 }, signal);
  expect(pageB.payload.items.map(item => item.title)).toEqual(["Index", "Ledger", "Register"]);
  const observedB = observation.fetch({ source: { connectionId: "connection-b", destinations: [reference("connection-b", "shelf")] } }, signal);
  expect(observedB.payload.items.map(item => item.title)).toEqual(["Index", "Ledger", "Register"]);

  expect(factory("archive.record.create", "connection-a").readback({ ref: created }, signal).result.kind).toBe("present");
  expect(factory("archive.record.create", "connection-b").readback({ ref: created }, signal).result.kind).toBe("unknown");
});
