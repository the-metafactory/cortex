#!/usr/bin/env bun
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { DeskPackageLoader } from "../src/conversations/domain-adapters/package";
import {
  deskFixtureArcPackage,
  deskFixtureBackend,
  deskFixtureCalls,
  deskFixtureDeclaration,
  deskFixturePackageId,
  deskFixtureRunner,
  openDeskFixtureStore,
  writeDeskFixturePackage,
} from "../src/conversations/domain-adapters/package-fixtures";

const failures: string[] = [];
const check = (condition: boolean, label: string): void => {
  console.log(`${condition ? "✅" : "❌"} ${label}`);
  if (!condition) failures.push(label);
};

const root = mkdtempSync(join(tmpdir(), "cortex-desk-package-probe-"));
const { engine, store } = await openDeskFixtureStore(root);
try {
  const bundledDir = join(root, "bundled", "balance");
  const installedRoot = join(root, "arc");
  const installedDir = join(installedRoot, "desk-balance-arc");
  const tamperedDir = join(root, "bundled", "bad");
  const missingDir = join(root, "bundled", "missing");
  writeDeskFixturePackage(bundledDir);
  writeDeskFixturePackage(installedDir, { adapterId: "balance-arc" });
  writeDeskFixturePackage(tamperedDir, { adapterId: "bad" });
  writeFileSync(join(tamperedDir, "backend.mjs"), "export function createDeskAdapter() { return {}; }");
  writeDeskFixturePackage(missingDir, { adapterId: "missing" });
  rmSync(join(missingDir, "backend.mjs"));

  const base = {
    bundledPackages: [bundledDir, tamperedDir, missingDir],
    installedRoots: [installedRoot],
    runner: deskFixtureRunner([deskFixtureArcPackage(installedDir)]),
  };
  const preliminary = await new DeskPackageLoader(base).discover();
  const installed = preliminary.candidates.find(candidate => candidate.adapterId === "balance-arc");
  if (!installed) throw new Error(`the synthetic arc package was not discovered: ${JSON.stringify(preliminary.issues)}`);
  const loader = new DeskPackageLoader({
    ...base,
    store,
    approvals: [{ packageId: installed.packageId, origin: installed.origin, packageVersion: installed.packageVersion, releaseDigest: installed.releaseDigest }],
  });

  const calls = deskFixtureCalls();
  calls.balance = 0;
  calls["balance:connector"] = 0;
  calls["balance-arc"] = 0;
  calls["provider"] = 0;

  const bundledInstall = await loader.install(deskFixturePackageId("balance"));
  const installedInstall = await loader.install(deskFixturePackageId("balance-arc"));
  check(bundledInstall.ok && installedInstall.ok, "install reports a release digest for the bundled and approved arc package");
  check((calls.balance ?? 0) === 0 && (calls["balance-arc"] ?? 0) === 0, "install imports no backend module");

  const discovery = await loader.discover();
  const codes = discovery.candidates.flatMap(candidate => candidate.state.state === "unavailable" ? [candidate.state.code] : []);
  check(codes.includes("digest_mismatch"), "a digest-tampered package is visibly unavailable");
  check(codes.includes("missing_file"), "a package with a missing backend file is visibly unavailable");

  const bundledActivation = await loader.activate(deskFixturePackageId("balance"));
  const installedActivation = await loader.activate(deskFixturePackageId("balance-arc"));
  check(bundledActivation.ok && installedActivation.ok, "the bundled default and the approved arc package publish a generation");
  check(loader.catalog().length === 2, "both generations appear together in the active catalog");
  check((calls.balance ?? 0) === 1 && (calls["balance:connector"] ?? 0) === 0, "publication calls createDeskAdapter once and creates no connector");
  check((calls["provider"] ?? 0) === 0, "publication makes zero provider mutation calls");

  const connector = loader.connector("balance", "balance.task.create", { adapterId: "balance", connectionId: "connection-probe" });
  check(connector.ok && (calls["balance:connector"] ?? 0) === 1, "the host creates one connector per connection after publication");
  check((calls["provider"] ?? 0) === 0, "creating a connector makes zero provider mutation calls");

  const disabled = await loader.disable("balance-arc");
  check(disabled?.disabled === true && disabled.active !== null, "disable persists a durable admission fence and keeps the generation");
  check(!loader.catalog().some(entry => entry.generation.adapterId === "balance-arc"), "the disabled adapter leaves the catalog immediately");
  const fenced = loader.capability("balance-arc.task.query");
  check(fenced.support === "declared" && fenced.availability.state === "unavailable", "the disabled adapter's capability is refused for logical admission");
  check(loader.catalog().some(entry => entry.generation.adapterId === "balance"), "the bundled adapter stays usable");

  const before = (await store.read("balance"))?.active?.generationId;
  writeDeskFixturePackage(bundledDir, { packageVersion: "1.0.1", backendSource: deskFixtureBackend(deskFixtureDeclaration(), { throwOnCreate: true }) });
  const refused = await loader.activate(deskFixturePackageId("balance"));
  const after = (await store.read("balance"))?.active?.generationId;
  check(!refused.ok && after === before, "a rejected staged update keeps the last valid generation selected");
  check(loader.catalog().find(entry => entry.generation.adapterId === "balance")?.generation.generationId === before, "the catalog keeps serving the previous generation");
  check((calls["provider"] ?? 0) === 0, "a rejected update makes zero provider mutation calls");

  const admission = await store.admit("balance", { releaseDigest: "f".repeat(64) });
  check(admission.state === "upgrade_required", "mismatched stored evidence returns upgrade-required rather than downconverting");
} finally {
  await engine.close(BACKGROUND_CONTEXT);
  rmSync(root, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error(`\n${failures.length} desk package probe check(s) failed.`);
  process.exit(1);
}
console.log("\nDesk package loader probe passed: bundled + approved arc discovery, unavailable bad/missing packages, fenced disable, last-valid generation on a rejected update, zero provider mutations.");
