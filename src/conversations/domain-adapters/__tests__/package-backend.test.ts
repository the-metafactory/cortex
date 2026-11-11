import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { TrustedConnector } from "../../authority";
import { authorityRig } from "../../authority-fixtures";
import { balanceDeclaration, objectRef } from "../fixtures";
import { support as baseSupport } from "../operations/fixtures";
import { observationBinding, observationDeclaration, observationRig, observationViews, syntheticObservation } from "../reads/observation-fixtures";
import { queryBinding, queryDeclaration, queryRig, syntheticQueryPage } from "../reads/query-fixtures";
import type { AdapterDeclaration } from "../types";
import { DeskPackageLoader, type DeskTrustedConnectorOptions } from "../package";
import { DeskBackendUnavailableError } from "../package-backend";
import { DESK_FIXTURE_ADAPTER, deskBackendFixtureSource, deskFixtureCalls, deskFixturePackageId, openDeskFixtureStore, writeDeskFixturePackage, type DeskBackendFixtureOptions } from "./fixtures/package-fixtures";

const CONNECTION = { adapterId: DESK_FIXTURE_ADAPTER, connectionId: "connection-example" };
const ACTION = "balance.task.create";
const roots: string[] = [];
const engines: { close(context: typeof BACKGROUND_CONTEXT): Promise<void> }[] = [];
const rigs: { close(): Promise<void> }[] = [];

const tempDir = (name: string): string => {
  const dir = mkdtempSync(join(tmpdir(), `cortex-desk-backend-${name}-`));
  roots.push(dir);
  return dir;
};

beforeEach(() => {
  credential.available = true;
  Object.assign(globalThis, { __deskPackageCalls: {} });
});

afterEach(async () => {
  for (const rig of rigs.splice(0)) await rig.close();
  for (const engine of engines.splice(0)) await engine.close(BACKGROUND_CONTEXT);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const credential = { available: true };
const authorizeConnection: DeskTrustedConnectorOptions["authorizeConnection"] = current =>
  Promise.resolve({ version: 1, available: credential.available && current.credentialHandle === "synthetic-credential-handle", revision: "package-credential-1" });
const readableDeclaration = (): AdapterDeclaration => {
  const declaration = queryDeclaration();
  for (const capability of declaration.capabilities) if (capability.kind === "query") capability.objectTypes = ["task", "area", "project"];
  return declaration;
};

const supportOf = { ...baseSupport, cancellation: "best-effort", operationLookup: "historical" };

async function loadPackage(declaration: AdapterDeclaration, backend: Omit<DeskBackendFixtureOptions, "declaration">, readBindings: unknown[]) {
  const pkg = writeDeskFixturePackage(join(tempDir("package"), DESK_FIXTURE_ADAPTER), {
    adapterId: DESK_FIXTURE_ADAPTER,
    declaration,
    readBindings,
    draftingBindings: [],
    backendSource: deskBackendFixtureSource({ declaration, ...backend }),
  });
  const { engine, store } = await openDeskFixtureStore(tempDir("store"));
  engines.push(engine);
  const loader = new DeskPackageLoader({ bundledPackages: [pkg.dir], store });
  const activated = await loader.activate(deskFixturePackageId(DESK_FIXTURE_ADAPTER));
  if (!activated.ok) throw new Error(`${activated.error.code}: ${activated.error.message}`);
  return loader;
}

async function openRig(loader: DeskPackageLoader, connector: TrustedConnector) {
  const rig = await authorityRig({}, "local", { registry: loader.registry(), binding: queryBinding, connector });
  rigs.push(rig);
  return rig;
}

const fullBackend = (omit: DeskBackendFixtureOptions["omit"] = []): Omit<DeskBackendFixtureOptions, "declaration"> => ({
  actionCapabilityId: ACTION,
  writerOwner: "synthetic-owner",
  support: supportOf,
  readbackCapabilityId: queryBinding.capabilityId,
  query: { capabilityId: queryBinding.capabilityId, page: syntheticQueryPage(["task-from-package"]) },
  omit,
});

async function trusted(loader: DeskPackageLoader): Promise<{ connector: TrustedConnector; paths: ReturnType<DeskPackageLoader["trustedConnector"]> extends infer R ? R extends { ok: true; value: { paths: infer P } } ? P : never : never }> {
  const built = loader.trustedConnector(DESK_FIXTURE_ADAPTER, CONNECTION, { authorizeConnection });
  if (!built.ok) throw new Error(built.error.code);
  return built.value;
}

describe("a loaded Desk package backend reaches the host paths", () => {
  test("serves a query page through the host query runner and its authority checks", async () => {
    const loader = await loadPackage(readableDeclaration(), fullBackend(), [queryBinding]);
    const { connector, paths } = await trusted(loader);
    expect(paths.query).toEqual({ available: true });
    const item = await queryRig(undefined, "local", { setup: { registry: loader.registry(), connector } });
    rigs.push(item.rig);
    const request = await item.runner.create(item.rig.context, [item.source], item.rig.sink);
    const result = await item.runner.run(item.rig.context, request, item.rig.sink);
    expect(result.status).toBe("ok");
    expect(deskFixtureCalls()["balance:query"]).toBe(1);
    expect(item.rig.calls.sends).toHaveLength(1);
    expect(JSON.stringify(item.rig.calls.sends[0])).toContain("task-from-package");
    expect(item.rig.calls.read).toBe(0);
  });

  test("refuses a query once the connection credential is no longer available", async () => {
    const loader = await loadPackage(readableDeclaration(), fullBackend(), [queryBinding]);
    const { connector } = await trusted(loader);
    const item = await queryRig(undefined, "local", { setup: { registry: loader.registry(), connector } });
    rigs.push(item.rig);
    credential.available = false;
    const request = await item.runner.create(item.rig.context, [item.source], item.rig.sink).catch(() => undefined);
    const result = request ? await item.runner.run(item.rig.context, request, item.rig.sink).catch(() => undefined) : undefined;
    expect(result?.status).not.toBe("ok");
    expect(deskFixtureCalls()["balance:query"] ?? 0).toBe(0);
    expect(item.rig.calls.sends).toHaveLength(0);
  });

  test("dispatches a confirmed operation to the package backend and reads back through it", async () => {
    const loader = await loadPackage(readableDeclaration(), fullBackend(), [queryBinding]);
    const { connector, paths } = await trusted(loader);
    expect(paths.dispatch).toEqual({ available: true });
    expect(paths.readback).toEqual({ available: true });
    expect(paths.cancel).toEqual({ available: true });
    expect(paths.lookup).toEqual({ available: true });
    const rig = await openRig(loader, connector);
    expect((await rig.service.dispatch(rig.context, await rig.prepare(), rig.lease)).kind).toBe("admitted");
    expect(deskFixtureCalls()["balance:dispatch"]).toBe(1);

    const ref = rig.objectRestriction.source;
    const projection = await rig.service.readback(rig.context, { lifecycleVersion: "1.0.0", ref }, rig.sink);
    expect(projection.kind).toBe("released");
    expect(deskFixtureCalls()["balance:readback"]).toBe(1);
    expect(rig.calls).toMatchObject({ dispatch: 0, cancel: 0, lookup: 0, readback: 0, read: 0 });
  });

  test("polls observations through the host observation store", async () => {
    const declaration = observationDeclaration();
    const loader = await loadPackage(declaration, {
      actionCapabilityId: ACTION,
      support: supportOf,
      omit: ["dispatch", "cancel", "lookup", "readback"],
      observation: { capabilityId: observationBinding.capabilityId, batch: syntheticObservation(), orderingId: "synthetic-integers" },
    }, [observationBinding]);
    const { connector, paths } = await trusted(loader);
    expect(paths.observation).toEqual({ available: true });
    expect(paths.dispatch.available).toBe(false);
    const item = await observationRig(observationBinding, { registry: loader.registry(), connector });
    rigs.push(item.rig);
    const checked = await item.store.check(item.rig.context, item.source, item.rig.sink, "poll");
    expect(checked.changed).toBe(1);
    expect(deskFixtureCalls()["balance:observation"]).toBe(1);
    expect(item.requests).toHaveLength(0);
    expect((await observationViews(item))[0]?.ref).toEqual(objectRef("balance", "task", "task-example"));
  });
});

describe("a call the package omits is unavailable and says so", () => {
  test("reports each omitted call and never reaches the synthetic connector", async () => {
    const loader = await loadPackage(readableDeclaration(), fullBackend(["dispatch", "cancel", "lookup", "readback"]), [queryBinding]);
    const { connector, paths } = await trusted(loader);
    for (const path of ["dispatch", "cancel", "lookup", "readback"] as const) {
      const state = paths[path];
      expect(state.available).toBe(false);
      if (!state.available) expect(state.error.code).toBe(`${path}_unavailable`);
    }
    expect(paths.query.available).toBe(true);
    expect(connector.cancel).toBeUndefined();
    expect(connector.lookup).toBeUndefined();
    expect(connector.readback).toBeUndefined();
    await expect(connector.dispatch({} as never, new AbortController().signal)).rejects.toBeInstanceOf(DeskBackendUnavailableError);

    const rig = await openRig(loader, connector);
    expect((await rig.service.dispatch(rig.context, await rig.prepare(), rig.lease)).kind).toBe("denied");
    const projection = await rig.service.readback(rig.context, { lifecycleVersion: "1.0.0", ref: rig.objectRestriction.source }, rig.sink);
    expect(projection.kind).toBe("withheld");
    expect(deskFixtureCalls()["balance:dispatch"] ?? 0).toBe(0);
    expect(rig.calls).toMatchObject({ dispatch: 0, cancel: 0, lookup: 0, readback: 0, read: 0 });
  });

  test("reports query and observation as unavailable when the package binds none", async () => {
    const loader = await loadPackage(balanceDeclaration(), { actionCapabilityId: ACTION, support: supportOf }, []);
    const { connector, paths } = await trusted(loader);
    expect(paths.query.available).toBe(false);
    expect(paths.observation.available).toBe(false);
    expect(connector.query).toBeUndefined();
    expect(connector.observation).toBeUndefined();
  });

  test("refuses dispatch when the owner support names another capability", async () => {
    const loader = await loadPackage(readableDeclaration(), { ...fullBackend(), support: { ...supportOf, capabilityId: "balance.object.read" } }, [queryBinding]);
    const { paths } = await trusted(loader);
    expect(paths.dispatch.available).toBe(false);
    if (!paths.dispatch.available) expect(paths.dispatch.error.code).toBe("dispatch_unavailable");
  });

  test("offers readback and lookup when the package omits dispatch", async () => {
    const loader = await loadPackage(readableDeclaration(), fullBackend(["dispatch"]), [queryBinding]);
    const { connector, paths } = await trusted(loader);
    expect(paths.dispatch.available).toBe(false);
    expect(paths.readback).toEqual({ available: true });
    expect(paths.lookup).toEqual({ available: true });
    expect(typeof connector.readback).toBe("function");
  });

  test("refuses a readback capability the declaration does not list as a query", async () => {
    const loader = await loadPackage(queryDeclaration(), { ...fullBackend(), readbackCapabilityId: "balance.unknown" }, [queryBinding]);
    const { connector, paths } = await trusted(loader);
    expect(paths.readback.available).toBe(false);
    expect(connector.readback).toBeUndefined();
  });
});

describe("the loader keeps the backend behind the published generation", () => {
  test("fences every call once the adapter is disabled", async () => {
    const loader = await loadPackage(readableDeclaration(), fullBackend(), [queryBinding]);
    const { connector } = await trusted(loader);
    const signal = new AbortController().signal;
    const page = await connector.query?.({ readVersion: "1.0.0", queryId: crypto.randomUUID(), capabilityId: queryBinding.capabilityId, input: {}, destinations: [], limit: 20 }, signal);
    expect(page).toBeDefined();
    await loader.disable(DESK_FIXTURE_ADAPTER);
    await expect(connector.query?.({ readVersion: "1.0.0", queryId: crypto.randomUUID(), capabilityId: queryBinding.capabilityId, input: {}, destinations: [], limit: 20 }, signal)).rejects.toBeInstanceOf(DeskBackendUnavailableError);
    expect((await connector.authorizeConnection({} as never)).available).toBe(false);
    expect(loader.trustedConnector(DESK_FIXTURE_ADAPTER, CONNECTION, { authorizeConnection }).ok).toBe(false);
    expect(deskFixtureCalls()["balance:query"]).toBe(1);
  });

  test("rejects a query result that is not a QueryPage", async () => {
    const loader = await loadPackage(queryDeclaration(), { ...fullBackend(), query: { capabilityId: queryBinding.capabilityId, page: { objects: [] } } }, [queryBinding]);
    const { connector } = await trusted(loader);
    await expect(connector.query?.({ readVersion: "1.0.0", queryId: crypto.randomUUID(), capabilityId: queryBinding.capabilityId, input: {}, destinations: [], limit: 20 }, new AbortController().signal)).rejects.toThrow();
  });

  test("keeps the action connector identity free of backend calls", async () => {
    const loader = await loadPackage(readableDeclaration(), fullBackend(), [queryBinding]);
    const identity = loader.connector(DESK_FIXTURE_ADAPTER, ACTION, CONNECTION);
    expect(identity.ok && identity.value).toEqual({ kind: "action", adapterId: DESK_FIXTURE_ADAPTER, connectionId: CONNECTION.connectionId, capabilityId: ACTION });
  });
});
