import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  DESK_FIXTURE_ADAPTER,
  DESK_FIXTURE_ORIGIN,
  deskFixtureArcPackage,
  deskFixtureBackend,
  deskFixtureCalls,
  deskFixtureDeclaration,
  deskFixtureDraftingBinding,
  deskFixturePackageId,
  deskFixtureReadBinding,
  deskFixtureRunner,
  deskFixtureSetup,
  openDeskFixtureStore,
  writeDeskFixturePackage,
} from "../package-fixtures";
import { DeskPackageLoader, type DeskAdapterApproval, type DeskPackageLoaderOptions } from "../package";
import { DeskGenerationStore } from "../package-generation";

const schemaRef = (schemaId: string) => ({ schemaId, version: "1.0.0" });
const roots: string[] = [];
const engines: { close(context: typeof BACKGROUND_CONTEXT): Promise<void> }[] = [];

const tempDir = (name: string): string => {
  const dir = mkdtempSync(join(tmpdir(), `cortex-desk-${name}-`));
  roots.push(dir);
  return dir;
};

afterEach(async () => {
  for (const engine of engines.splice(0)) await engine.close(BACKGROUND_CONTEXT);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const approvalUnit = (adapterId = DESK_FIXTURE_ADAPTER): DeskAdapterApproval => ({ packageId: deskFixturePackageId(adapterId), origin: DESK_FIXTURE_ORIGIN, packageVersion: "1.0.0", releaseDigest: "0".repeat(64) });

async function openStore(): Promise<{ store: DeskGenerationStore; dir: string }> {
  const dir = tempDir("store");
  const { engine, store } = await openDeskFixtureStore(dir);
  engines.push(engine);
  return { store, dir };
}

async function activatedFixture(): Promise<{ loader: DeskPackageLoader; store: DeskGenerationStore; dir: string }> {
  const pkg = writeDeskFixturePackage(join(tempDir("bundled"), "balance"));
  const { store } = await openStore();
  const loader = loaderFor({ bundledPackages: [pkg.dir], store });
  expect((await loader.activate(deskFixturePackageId(DESK_FIXTURE_ADAPTER))).ok).toBe(true);
  return { loader, store, dir: pkg.dir };
}

const loaderFor = (options: DeskPackageLoaderOptions): DeskPackageLoader => new DeskPackageLoader(options);

async function expectDuplicateIdentity(options: DeskPackageLoaderOptions, packageId: string): Promise<void> {
  const loader = loaderFor(options);
  const discovery = await loader.discover();
  expect(discovery.candidates).toHaveLength(2);
  expect(discovery.candidates.every(candidate => candidate.state.state === "unavailable" && candidate.state.code === "duplicate_identity")).toBe(true);
  const install = await loader.install(packageId);
  expect(install.ok).toBe(false);
  if (!install.ok) expect(install.error.code).toBe("duplicate_identity");
}

async function approvalFor(options: DeskPackageLoaderOptions, adapterId = DESK_FIXTURE_ADAPTER): Promise<DeskAdapterApproval> {
  const discovery = await loaderFor(options).discover();
  const candidate = discovery.candidates.find(item => item.adapterId === adapterId);
  if (!candidate) throw new Error(`fixture package ${adapterId} was not discovered: ${JSON.stringify(discovery.issues)}`);
  return { packageId: candidate.packageId, origin: candidate.origin, packageVersion: candidate.packageVersion, releaseDigest: candidate.releaseDigest };
}

describe("Desk adapter package discovery", () => {
  test("discovers a bundled default and an approved arc package without importing either backend", async () => {
    const bundled = writeDeskFixturePackage(join(tempDir("bundled"), "balance"));
    const installedRoot = tempDir("arc");
    const installed = writeDeskFixturePackage(join(installedRoot, "balance-arc"), { adapterId: "balance-arc" });
    const base: DeskPackageLoaderOptions = { bundledPackages: [bundled.dir], installedRoots: [installedRoot], runner: deskFixtureRunner([deskFixtureArcPackage(installed.dir)]) };
    const approval = await approvalFor(base, "balance-arc");
    const loader = loaderFor({ ...base, approvals: [approval] });
    const discovery = await loader.discover();
    expect(discovery.issues).toEqual([]);
    expect(discovery.candidates).toHaveLength(2);
    expect(discovery.candidates.map(candidate => candidate.source).sort()).toEqual(["bundled", "installed"]);
    expect(discovery.candidates.find(candidate => candidate.source === "bundled")?.trust).toEqual({ state: "trusted", basis: "bundled" });
    expect(discovery.candidates.find(candidate => candidate.source === "installed")?.trust).toEqual({ state: "trusted", basis: "principal" });
    const calls = deskFixtureCalls();
    expect(calls[DESK_FIXTURE_ADAPTER] ?? 0).toBe(0);
    const install = await loader.install(deskFixturePackageId(DESK_FIXTURE_ADAPTER));
    expect(install.ok).toBe(true);
    if (install.ok) {
      expect(install.value.origin).toBe("bundled");
      expect(install.value.releaseDigest).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(calls[DESK_FIXTURE_ADAPTER] ?? 0).toBe(0);
    expect(calls["balance-arc"] ?? 0).toBe(0);
  });

  test("refuses an unapproved arc package for activation while install still reports its release digest", async () => {
    const installedRoot = tempDir("arc");
    const installed = writeDeskFixturePackage(join(installedRoot, "desk-balance"));
    const { store } = await openStore();
    const loader = loaderFor({ installedRoots: [installedRoot], runner: deskFixtureRunner([deskFixtureArcPackage(installed.dir)]), store });
    const discovery = await loader.discover();
    expect(discovery.candidates[0]?.trust).toEqual({ state: "untrusted", code: "approval_missing", message: expect.any(String) });
    const install = await loader.install(deskFixturePackageId(DESK_FIXTURE_ADAPTER));
    expect(install.ok).toBe(true);
    const activation = await loader.activate(deskFixturePackageId(DESK_FIXTURE_ADAPTER));
    expect(activation.ok).toBe(false);
    if (!activation.ok) expect(activation.error.code).toBe("approval_missing");
    expect(loader.catalog()).toEqual([]);
    expect(await store.read(DESK_FIXTURE_ADAPTER)).toBeNull();
  });

  test("refuses an approval that does not match the discovered release digest", async () => {
    const installedRoot = tempDir("arc");
    const installed = writeDeskFixturePackage(join(installedRoot, "desk-balance"));
    const loader = loaderFor({ installedRoots: [installedRoot], runner: deskFixtureRunner([deskFixtureArcPackage(installed.dir)]), approvals: [approvalUnit()] });
    const discovery = await loader.discover();
    expect(discovery.issues.some(issue => issue.code === "approval_unmatched")).toBe(true);
    expect(discovery.candidates[0]?.trust.state).toBe("untrusted");
  });

  test("refuses an arc install path outside every approved package root", async () => {
    const installedRoot = tempDir("arc");
    const elsewhere = writeDeskFixturePackage(join(tempDir("outside"), "desk-balance"));
    const loader = loaderFor({ installedRoots: [installedRoot], runner: deskFixtureRunner([deskFixtureArcPackage(elsewhere.dir)]) });
    const discovery = await loader.discover();
    expect(discovery.candidates).toEqual([]);
    expect(discovery.issues.some(issue => issue.code === "containment_escape")).toBe(true);
  });

  test("fails closed on unknown manifest fields, versions and binding versions", async () => {
    const root = tempDir("bundled");
    writeDeskFixturePackage(join(root, "unknown"), { adapterId: "unknown", extra: { unexpected: true } });
    writeDeskFixturePackage(join(root, "format"), { adapterId: "format", extra: { format: "desk-adapter-package/2" } });
    writeDeskFixturePackage(join(root, "contract"), { adapterId: "contract", extra: { domainContractVersion: "2.0.0" } });
    writeDeskFixturePackage(join(root, "remote"), { adapterId: "remote", backendEntry: "https://evil.example/backend.mjs" });
    writeDeskFixturePackage(join(root, "read"), { adapterId: "read", readBindings: [{ ...deskFixtureReadBinding("read"), version: "2.0.0" }] });
    writeDeskFixturePackage(join(root, "drafting"), { adapterId: "drafting", draftingBindings: [{ ...deskFixtureDraftingBinding("drafting"), bindingVersion: "2.0.0" }] });
    const sdk = writeDeskFixturePackage(join(root, "sdk"), { adapterId: "sdk", deskSdkRange: "^2.0.0" });
    const setup = writeDeskFixturePackage(join(root, "setup"), { adapterId: "setup", setup: { ...deskFixtureSetup("setup"), configurationSchemaRef: schemaRef("setup.setup.missing") } });
    const loader = loaderFor({ bundledPackages: ["unknown", "format", "contract", "remote", "read", "drafting", "sdk", "setup"].map(name => join(root, name)) });
    const discovery = await loader.discover();
    const codes = discovery.issues.map(issue => issue.code);
    expect(codes).toContain("invalid_manifest");
    expect(codes).toContain("unsupported_format");
    expect(codes).toContain("unsupported_contract");
    expect(codes.filter(code => code === "invalid_manifest")).toHaveLength(2);
    expect(codes.filter(code => code === "unsupported_binding_version")).toHaveLength(2);
    expect(discovery.candidates.find(candidate => candidate.packageRoot === sdk.dir)?.state).toEqual({ state: "unavailable", code: "incompatible_sdk", message: expect.any(String) });
    expect(discovery.candidates.find(candidate => candidate.packageRoot === setup.dir)?.state).toEqual({ state: "unavailable", code: "invalid_setup_schema", message: expect.any(String) });
  });

  test("fails closed on a tampered backend digest, a missing backend file and a symlink escape", async () => {
    const root = tempDir("bundled");
    const tampered = writeDeskFixturePackage(join(root, "tampered"), { adapterId: "tampered" });
    writeFileSync(join(tampered.dir, "backend.mjs"), "export function createDeskAdapter() { return {}; }");
    const missing = writeDeskFixturePackage(join(root, "missing"), { adapterId: "missing" });
    rmSync(join(missing.dir, "backend.mjs"));
    const outside = writeDeskFixturePackage(join(tempDir("outside-file"), "payload"), { adapterId: "outside" });
    const escaped = writeDeskFixturePackage(join(root, "escaped"), { adapterId: "escaped", backendEntry: "linked.mjs" });
    symlinkSync(join(outside.dir, "backend.mjs"), join(escaped.dir, "linked.mjs"));
    const loader = loaderFor({ bundledPackages: [tampered.dir, missing.dir, escaped.dir] });
    const discovery = await loader.discover();
    expect(discovery.candidates.every(candidate => candidate.state.state === "unavailable")).toBe(true);
    const codes = discovery.candidates.map(candidate => candidate.state.state === "unavailable" ? candidate.state.code : "installable");
    expect(codes).toContain("digest_mismatch");
    expect(codes).toContain("missing_file");
    expect(codes).toContain("containment_escape");
  });

  test("fails closed on a symlinked manifest and on a backend that imports an unapproved package", async () => {
    const root = tempDir("bundled");
    const outside = writeDeskFixturePackage(join(tempDir("outside-manifest"), "payload"), { adapterId: "outside" });
    const linked = join(root, "linked");
    mkdirSync(linked, { recursive: true });
    symlinkSync(join(outside.dir, "desk-adapter.json"), join(linked, "desk-adapter.json"));
    const unapproved = writeDeskFixturePackage(join(root, "unapproved"), { adapterId: "unapproved", backendSource: 'import { readFileSync } from "node:fs";\nexport function createDeskAdapter() { return {}; }' });
    const loader = loaderFor({ bundledPackages: [linked, unapproved.dir] });
    const discovery = await loader.discover();
    expect(discovery.issues.some(issue => issue.code === "containment_escape")).toBe(true);
    expect(discovery.candidates[0]?.state).toEqual({ state: "unavailable", code: "invalid_import", message: expect.any(String) });
  });

  test("makes duplicate package or adapter identities unavailable instead of picking one", async () => {
    const root = tempDir("bundled");
    const first = writeDeskFixturePackage(join(root, "first"));
    const second = writeDeskFixturePackage(join(root, "second"), { packageVersion: "1.0.1" });
    await expectDuplicateIdentity({ bundledPackages: [first.dir, second.dir] }, deskFixturePackageId(DESK_FIXTURE_ADAPTER));
  });

  test("makes one packageId at two versions unavailable even when the adapter IDs differ", async () => {
    const root = tempDir("bundled");
    const first = writeDeskFixturePackage(join(root, "first"), { packageId: "the-metafactory.desk-adapter-balance", adapterId: "balance" });
    const second = writeDeskFixturePackage(join(root, "second"), { packageId: "the-metafactory.desk-adapter-balance", packageVersion: "1.0.1", adapterId: "balance-two" });
    await expectDuplicateIdentity({ bundledPackages: [first.dir, second.dir] }, "the-metafactory.desk-adapter-balance");
  });

  test("an unapproved arc package listed before the approved release of the same adapter cannot block it", async () => {
    const installedRoot = tempDir("arc");
    const unapproved = writeDeskFixturePackage(join(installedRoot, "a-unapproved"), { packageVersion: "9.0.0" });
    const approved = writeDeskFixturePackage(join(installedRoot, "b-approved"), { packageVersion: "1.0.1" });
    const base: DeskPackageLoaderOptions = {
      installedRoots: [installedRoot],
      runner: deskFixtureRunner([deskFixtureArcPackage(unapproved.dir, { name: "desk-balance-unapproved" }), deskFixtureArcPackage(approved.dir, { name: "desk-balance-approved" })]),
    };
    const discovery = await loaderFor(base).discover();
    expect(discovery.candidates.every(candidate => candidate.state.state === "installable")).toBe(true);
    expect(discovery.candidates.find(candidate => candidate.packageVersion === "9.0.0")?.trust.state).toBe("untrusted");
    const approvedRelease = discovery.candidates.find(candidate => candidate.packageVersion === "1.0.1");
    if (!approvedRelease) throw new Error("the approved release was not discovered");
    expect(approvedRelease.trust.state).toBe("untrusted");
    const { store } = await openStore();
    const loader = loaderFor({
      ...base,
      store,
      approvals: [{ packageId: approvedRelease.packageId, origin: approvedRelease.origin, packageVersion: approvedRelease.packageVersion, releaseDigest: approvedRelease.releaseDigest }],
    });
    const activation = await loader.activate(approvedRelease.packageId);
    expect(activation.ok).toBe(true);
    expect(loader.catalog()[0]?.generation.packageVersion).toBe("1.0.1");
  });

  test("an unapproved installed package cannot disable a bundled adapter", async () => {
    const bundledRoot = tempDir("bundled");
    const bundled = writeDeskFixturePackage(join(bundledRoot, "balance"));
    const installedRoot = tempDir("arc");
    const installed = writeDeskFixturePackage(join(installedRoot, "desk-balance"));
    const { store } = await openStore();
    const loader = loaderFor({ bundledPackages: [bundled.dir], installedRoots: [installedRoot], runner: deskFixtureRunner([deskFixtureArcPackage(installed.dir)]), store });
    const discovery = await loader.discover();
    expect(discovery.candidates.find(candidate => candidate.source === "bundled")?.state).toEqual({ state: "installable" });
    expect(discovery.candidates.find(candidate => candidate.source === "installed")?.trust).toEqual({ state: "untrusted", code: "approval_missing", message: expect.any(String) });
    expect((await loader.activate(deskFixturePackageId(DESK_FIXTURE_ADAPTER))).ok).toBe(true);
    expect(loader.catalog().some(entry => entry.generation.adapterId === DESK_FIXTURE_ADAPTER)).toBe(true);
  });
});

describe("Desk adapter generation publication", () => {
  test("publishes one generation atomically and leaves an unrelated adapter usable when another module throws", async () => {
    const root = tempDir("bundled");
    const healthy = writeDeskFixturePackage(join(root, "healthy"));
    const broken = writeDeskFixturePackage(join(root, "broken"), { adapterId: "broken", backendSource: 'export function createDeskAdapter() { throw new Error("synthetic creation failure"); }' });
    const { store } = await openStore();
    const loader = loaderFor({ bundledPackages: [healthy.dir, broken.dir], store });
    expect((await loader.activate(deskFixturePackageId(DESK_FIXTURE_ADAPTER))).ok).toBe(true);
    const brokenActivation = await loader.activate(deskFixturePackageId("broken"));
    expect(brokenActivation.ok).toBe(false);
    if (!brokenActivation.ok) expect(brokenActivation.error.code).toBe("module_throwing");
    expect(loader.catalog().map(entry => entry.generation.adapterId)).toEqual([DESK_FIXTURE_ADAPTER]);
    expect(loader.capability(`${DESK_FIXTURE_ADAPTER}.task.query`).support).toBe("declared");
    expect(loader.capability("broken.task.query").support).toBe("unsupported");
    expect(loader.diagnostics().some(issue => issue.packageId === deskFixturePackageId("broken"))).toBe(true);
    expect(loader.connector(DESK_FIXTURE_ADAPTER, `${DESK_FIXTURE_ADAPTER}.task.create`, { adapterId: DESK_FIXTURE_ADAPTER, connectionId: "connection-one" }).ok).toBe(true);
  });

  test("refuses a module that is missing createDeskAdapter, exports extra names, changes the declaration or omits an action connector", async () => {
    const root = tempDir("bundled");
    const noCreate = writeDeskFixturePackage(join(root, "no-create"), { adapterId: "no-create", backendSource: "export const createDeskAdapter = 1;" });
    const extra = writeDeskFixturePackage(join(root, "extra"), { adapterId: "extra", backendSource: deskFixtureBackend(deskFixtureDeclaration("extra"), { extraExport: true }) });
    const changedDeclaration = { ...deskFixtureDeclaration("changed"), label: "Changed" };
    const changed = writeDeskFixturePackage(join(root, "changed"), { adapterId: "changed", backendSource: deskFixtureBackend(changedDeclaration) });
    const noConnector = writeDeskFixturePackage(join(root, "no-connector"), { adapterId: "no-connector", backendSource: deskFixtureBackend(deskFixtureDeclaration("no-connector"), { omitConnector: true }) });
    const { store } = await openStore();
    const loader = loaderFor({ bundledPackages: [noCreate.dir, extra.dir, changed.dir, noConnector.dir], store });
    for (const packageId of [deskFixturePackageId("no-create"), deskFixturePackageId("extra"), deskFixturePackageId("changed"), deskFixturePackageId("no-connector")]) {
      const result = await loader.activate(packageId);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("module_incompatible");
    }
    expect(loader.catalog()).toEqual([]);
    expect(await store.read("changed")).toBeNull();
  });

  test("refuses a module whose factory is only a default export", async () => {
    const root = tempDir("bundled");
    const pkg = writeDeskFixturePackage(join(root, "default-export"), { adapterId: "default-export", backendSource: 'export default function createDeskAdapter() { return { declaration: {}, bindings: {} }; }' });
    const { store } = await openStore();
    const loader = loaderFor({ bundledPackages: [pkg.dir], store });
    const result = await loader.activate(deskFixturePackageId("default-export"));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("module_incompatible");
    expect(loader.catalog()).toEqual([]);
  });

  test("clears an early registration failure once a later adapter owns the relationship target", async () => {
    const root = tempDir("bundled");
    const dependent = writeDeskFixturePackage(join(root, "dependent"), { adapterId: "dependent", declaration: deskFixtureDeclaration("dependent", { relationship: { targetAdapterId: "target" } }) });
    const target = writeDeskFixturePackage(join(root, "target"), { adapterId: "target" });
    const { store } = await openStore();
    const loader = loaderFor({ bundledPackages: [dependent.dir, target.dir], store });
    const discovery = await loader.discover();
    expect(discovery.candidates.map(candidate => candidate.state.state)).toEqual(["installable", "installable"]);
    expect((await loader.activate(deskFixturePackageId("target"))).ok).toBe(true);
    const dependentActivation = await loader.activate(deskFixturePackageId("dependent"));
    expect(dependentActivation.ok).toBe(true);
    expect(loader.catalog().map(entry => entry.generation.adapterId)).toEqual(["dependent", "target"]);
  });

  test("keeps the previous validated generation selected when a staged update is rejected", async () => {
    const { loader, store, dir } = await activatedFixture();
    const generation = loader.catalog()[0]?.generation;
    expect(generation?.packageVersion).toBe("1.0.0");
    writeDeskFixturePackage(dir, { packageVersion: "1.0.1", backendSource: deskFixtureBackend(deskFixtureDeclaration(), { throwOnCreate: true }) });
    const refused = await loader.activate(deskFixturePackageId(DESK_FIXTURE_ADAPTER));
    expect(refused.ok).toBe(false);
    const record = await store.read(DESK_FIXTURE_ADAPTER);
    expect(record?.active?.generationId).toBe(generation?.generationId);
    expect(loader.catalog()[0]?.generation.generationId).toBe(generation?.generationId);
    expect(loader.catalog()[0]?.availability).toEqual({ state: "available" });
    expect(loader.diagnostics().some(issue => issue.packageId === deskFixturePackageId(DESK_FIXTURE_ADAPTER))).toBe(true);
  });

  test("retains the previous generation as lastValid after a later successful update", async () => {
    const dir = join(tempDir("bundled"), "balance");
    writeDeskFixturePackage(dir);
    const { store } = await openStore();
    const loader = loaderFor({ bundledPackages: [dir], store });
    expect((await loader.activate(deskFixturePackageId(DESK_FIXTURE_ADAPTER))).ok).toBe(true);
    const first = await store.read(DESK_FIXTURE_ADAPTER);
    writeDeskFixturePackage(dir, { packageVersion: "1.0.1" });
    expect((await loader.activate(deskFixturePackageId(DESK_FIXTURE_ADAPTER))).ok).toBe(true);
    const second = await store.read(DESK_FIXTURE_ADAPTER);
    expect(second?.active?.packageVersion).toBe("1.0.1");
    expect(second?.lastValid?.generationId).toBe(first?.active?.generationId);
    expect(second?.history.map(entry => entry.packageVersion)).toEqual(["1.0.0", "1.0.1"]);
  });

  test("keeps action connectors per connection without creating one or calling a provider at publication", async () => {
    const pkg = writeDeskFixturePackage(join(tempDir("bundled"), "balance"));
    const { store } = await openStore();
    const loader = loaderFor({ bundledPackages: [pkg.dir], store });
    const calls = deskFixtureCalls();
    calls[DESK_FIXTURE_ADAPTER] = 0;
    calls[`${DESK_FIXTURE_ADAPTER}:connector`] = 0;
    expect((await loader.activate(deskFixturePackageId(DESK_FIXTURE_ADAPTER))).ok).toBe(true);
    expect(calls[DESK_FIXTURE_ADAPTER]).toBe(1);
    expect(calls[`${DESK_FIXTURE_ADAPTER}:connector`]).toBe(0);
    const connector = loader.connector(DESK_FIXTURE_ADAPTER, `${DESK_FIXTURE_ADAPTER}.task.create`, { adapterId: DESK_FIXTURE_ADAPTER, connectionId: "connection-one" });
    expect(connector.ok).toBe(true);
    if (connector.ok) expect(connector.value).toEqual({ kind: "action", adapterId: DESK_FIXTURE_ADAPTER, connectionId: "connection-one", capabilityId: `${DESK_FIXTURE_ADAPTER}.task.create` });
    expect(calls[`${DESK_FIXTURE_ADAPTER}:connector`]).toBe(1);
    expect(loader.connector(DESK_FIXTURE_ADAPTER, `${DESK_FIXTURE_ADAPTER}.task.create`, { adapterId: "other", connectionId: "connection-one" }).ok).toBe(false);
    expect(loader.connector(DESK_FIXTURE_ADAPTER, `${DESK_FIXTURE_ADAPTER}.task.query`, { adapterId: DESK_FIXTURE_ADAPTER, connectionId: "connection-one" }).ok).toBe(false);
  });

  test("disable fences logical admission and the catalog immediately while keeping the durable generation", async () => {
    const { loader } = await activatedFixture();
    const record = await loader.disable(DESK_FIXTURE_ADAPTER);
    expect(record?.disabled).toBe(true);
    expect(record?.active).not.toBeNull();
    expect(loader.catalog()).toEqual([]);
    expect(loader.list()[0]?.availability.state).toBe("unavailable");
    const capability = loader.capability(`${DESK_FIXTURE_ADAPTER}.task.query`);
    expect(capability.support === "declared" && capability.availability.state).toBe("unavailable");
    const admission = await loader.admit(DESK_FIXTURE_ADAPTER, { releaseDigest: record?.active?.releaseDigest ?? "" });
    expect(admission.state).toBe("unavailable");
  });

  test("uninstall fences admission, keeps last-valid evidence and does not publish after a managed restart", async () => {
    const dir = join(tempDir("bundled"), "balance");
    writeDeskFixturePackage(dir);
    const { store } = await openStore();
    const first = loaderFor({ bundledPackages: [dir], store });
    expect((await first.activate(deskFixturePackageId(DESK_FIXTURE_ADAPTER))).ok).toBe(true);
    writeDeskFixturePackage(dir, { packageVersion: "1.0.1" });
    expect((await first.activate(deskFixturePackageId(DESK_FIXTURE_ADAPTER))).ok).toBe(true);
    const record = await first.uninstall(DESK_FIXTURE_ADAPTER);
    expect(record?.uninstalled).toBe(true);
    expect(record?.lastValid).not.toBeNull();
    expect(first.catalog()).toEqual([]);
    const restarted = loaderFor({ bundledPackages: [dir], store });
    const discovery = await restarted.boot();
    expect(discovery.candidates.length).toBe(1);
    expect(restarted.catalog()).toEqual([]);
    expect(restarted.list()).toEqual([]);
    const reopened = await store.read(DESK_FIXTURE_ADAPTER);
    expect(reopened?.active?.generationId).toBe(record?.active?.generationId);
    expect(reopened?.lastValid?.generationId).toBe(record?.lastValid?.generationId);
  });

  test("returns upgrade-required for stored evidence that belongs to a different generation", async () => {
    const { store } = await activatedFixture();
    const active = (await store.read(DESK_FIXTURE_ADAPTER))?.active;
    if (!active) throw new Error("generation missing");
    const admission = await store.admit(DESK_FIXTURE_ADAPTER, { releaseDigest: "f".repeat(64) });
    expect(admission.state).toBe("upgrade_required");
    if (admission.state === "upgrade_required") expect(admission.activeReleaseDigest).toBe(active.releaseDigest);
    expect((await store.admit(DESK_FIXTURE_ADAPTER, { releaseDigest: active.releaseDigest })).state).toBe("available");
  });

  test("validates manifest read and drafting bindings against the declaration before publication", async () => {
    const root = tempDir("bundled");
    const badRead = writeDeskFixturePackage(join(root, "bad-read"), { adapterId: "bad-read", readBindings: [{ ...deskFixtureReadBinding("bad-read"), outputSchemaRef: schemaRef("bad-read.task.create.output") }] });
    const badDrafting = writeDeskFixturePackage(join(root, "bad-drafting"), { adapterId: "bad-drafting", draftingBindings: [{ ...deskFixtureDraftingBinding("bad-drafting"), capabilityId: "bad-drafting.unknown.create" }] });
    const loader = loaderFor({ bundledPackages: [badRead.dir, badDrafting.dir] });
    const discovery = await loader.discover();
    expect(discovery.candidates.every(candidate => candidate.state.state === "unavailable")).toBe(true);
    const codes = discovery.candidates.map(candidate => candidate.state.state === "unavailable" ? candidate.state.code : "");
    expect(codes).toEqual(["binding_mismatch", "binding_mismatch"]);
  });

  test("a rejected signature posture refuses the package before any import and a disabled posture does not", async () => {
    const pkg = writeDeskFixturePackage(join(tempDir("bundled"), "balance"));
    const refused = await loaderFor({ bundledPackages: [pkg.dir], signature: { posture: "enforce", trustedSigners: new Set() } }).discover();
    const refusedState = refused.candidates[0]?.state;
    expect(refusedState?.state === "unavailable" && refusedState.code.startsWith("signature_")).toBe(true);
    const accepted = await loaderFor({ bundledPackages: [pkg.dir], signature: { posture: "off", trustedSigners: new Set() } }).discover();
    expect(accepted.candidates[0]?.state).toEqual({ state: "installable" });
  });

  test("publishes declared UI assets for an adapter view without exposing a filesystem path", async () => {
    const pkg = writeDeskFixturePackage(join(tempDir("bundled"), "balance"), { ui: true });
    const { store } = await openStore();
    const loader = loaderFor({ bundledPackages: [pkg.dir], store });
    expect((await loader.activate(deskFixturePackageId(DESK_FIXTURE_ADAPTER))).ok).toBe(true);
    const entry = loader.catalog()[0];
    expect(entry?.ui?.protocolVersion).toBe("1.0.0");
    expect(entry?.ui?.views).toEqual([{ objectType: "task", view: "result" }]);
    expect(JSON.stringify(entry?.ui)).not.toContain(pkg.dir);
  });
});
