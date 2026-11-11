#!/usr/bin/env bun
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { authorityRig } from "../src/conversations/authority-fixtures";
import { balanceDeclaration, objectRef } from "../src/conversations/domain-adapters/fixtures";
import { DeskPackageLoader } from "../src/conversations/domain-adapters/package";
import { support as baseSupport } from "../src/conversations/domain-adapters/operations/fixtures";
import { observationBinding, observationDeclaration, observationRig, observationViews, syntheticObservation } from "../src/conversations/domain-adapters/reads/observation-fixtures";
import { queryBinding, queryDeclaration, queryRig, syntheticQueryPage } from "../src/conversations/domain-adapters/reads/query-fixtures";
import type { AdapterDeclaration } from "../src/conversations/domain-adapters/types";
import { DESK_FIXTURE_ADAPTER, deskBackendFixtureSource, deskFixtureCalls, deskFixturePackageId, openDeskFixtureStore, writeDeskFixturePackage, type DeskBackendFixtureOptions } from "../src/conversations/domain-adapters/__tests__/fixtures/package-fixtures";
import { runWithTemporaryHome } from "./probe-temp-home";

const CONNECTION = { adapterId: DESK_FIXTURE_ADAPTER, connectionId: "connection-example" };
const ACTION = "balance.task.create";
const support = { ...baseSupport, cancellation: "best-effort", operationLookup: "historical" };

async function probe(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "cortex-desk-backend-probe-"));
  const closers: (() => Promise<void>)[] = [];
  const authorizeConnection = (current: { credentialHandle: string }) => Promise.resolve({ version: 1 as const, available: current.credentialHandle === "synthetic-credential-handle", revision: "probe-credential-1" });

  async function load(name: string, declaration: AdapterDeclaration, backend: Omit<DeskBackendFixtureOptions, "declaration">, readBindings: unknown[]) {
    const pkg = writeDeskFixturePackage(join(root, name, DESK_FIXTURE_ADAPTER), {
      adapterId: DESK_FIXTURE_ADAPTER, declaration, readBindings, draftingBindings: [],
      backendSource: deskBackendFixtureSource({ declaration, ...backend }),
    });
    const { engine, store } = await openDeskFixtureStore(join(root, `${name}-store`));
    closers.push(() => engine.close(BACKGROUND_CONTEXT));
    const loader = new DeskPackageLoader({ bundledPackages: [pkg.dir], store });
    const activated = await loader.activate(deskFixturePackageId(DESK_FIXTURE_ADAPTER));
    assert.ok(activated.ok, "the fixture package activates");
    const built = loader.trustedConnector(DESK_FIXTURE_ADAPTER, CONNECTION, { authorizeConnection });
    assert.ok(built.ok, "the host builds a connector from the loaded package");
    return { loader, ...built.value };
  }

  try {
    const readable = queryDeclaration();
    for (const capability of readable.capabilities) if (capability.kind === "query") capability.objectTypes = ["task", "area", "project"];
    const full = await load("full", readable, {
      actionCapabilityId: ACTION, writerOwner: "synthetic-owner", support, readbackCapabilityId: queryBinding.capabilityId,
      query: { capabilityId: queryBinding.capabilityId, page: syntheticQueryPage(["task-from-package"]) },
    }, [queryBinding]);

    const queried = await queryRig(undefined, "local", { setup: { registry: full.loader.registry(), connector: full.connector } });
    closers.push(() => queried.rig.close());
    const request = await queried.runner.create(queried.rig.context, [queried.source], queried.rig.sink);
    assert.equal((await queried.runner.run(queried.rig.context, request, queried.rig.sink)).status, "ok");
    assert.equal(deskFixtureCalls()["balance:query"], 1);
    assert.equal(queried.rig.calls.read, 0);
    console.log("query: the host query runner reached the package handler and released its page");

    const rig = await authorityRig({}, "local", { registry: full.loader.registry(), binding: queryBinding, connector: full.connector });
    closers.push(() => rig.close());
    const prepared = await rig.prepare();
    assert.equal((await rig.service.dispatch(rig.context, prepared, rig.lease)).kind, "admitted");
    assert.equal(deskFixtureCalls()["balance:dispatch"], 1);
    console.log("dispatch: a confirmed, prepared operation reached the package dispatch call once");

    const readback = await rig.service.readback(rig.context, { lifecycleVersion: "1.0.0", ref: rig.objectRestriction.source }, rig.sink);
    assert.equal(readback.kind, "released");
    assert.equal(deskFixtureCalls()["balance:readback"], 1);
    assert.equal(rig.calls.dispatch + rig.calls.readback + rig.calls.read, 0);
    console.log("readback: the host released the package readback; no synthetic connector call was made");

    const feed = await load("feed", observationDeclaration(), {
      actionCapabilityId: ACTION, writerOwner: "synthetic-owner", support, omit: ["dispatch", "cancel", "lookup", "readback"],
      observation: { capabilityId: observationBinding.capabilityId, batch: syntheticObservation(), orderingId: "synthetic-integers" },
    }, [observationBinding]);
    const observed = await observationRig(observationBinding, { registry: feed.loader.registry(), connector: feed.connector });
    closers.push(() => observed.rig.close());
    assert.equal((await observed.store.check(observed.rig.context, observed.source, observed.rig.sink, "poll")).changed, 1);
    assert.deepEqual((await observationViews(observed))[0]?.ref, objectRef("balance", "task", "task-example"));
    assert.equal(deskFixtureCalls()["balance:observation"], 1);
    console.log("observation: the host observation store polled the package and stored one current object");

    for (const path of ["dispatch", "cancel", "lookup", "readback"] as const) {
      const state = feed.paths[path];
      assert.equal(state.available, false);
      if (!state.available) console.log(`omitted ${path}: unavailable (${state.error.code})`);
    }

    const readOnly = await load("read-only", balanceDeclaration(), { actionCapabilityId: ACTION, writerOwner: "synthetic-owner", support }, []);
    assert.equal(readOnly.paths.query.available, false);
    assert.equal(readOnly.paths.observation.available, false);
    assert.equal(readOnly.connector.query, undefined);
    console.log("omitted query and observation: unavailable; nothing falls back to a synthetic connector");

    await full.loader.disable(DESK_FIXTURE_ADAPTER);
    await assert.rejects(() => full.connector.query?.({ readVersion: "1.0.0", queryId: crypto.randomUUID(), capabilityId: queryBinding.capabilityId, input: {}, destinations: [], limit: 20 }, new AbortController().signal) ?? Promise.resolve());
    console.log("disable: every call on the old connector is fenced");
  } finally {
    for (const close of closers.reverse()) await close();
    rmSync(root, { recursive: true, force: true });
  }
}

await runWithTemporaryHome(import.meta.path, probe);
