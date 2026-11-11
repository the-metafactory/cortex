import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sha256Bytes } from "../../../common/registry/arc-package-inventory";
import { DESK_ADAPTER_SDK_VERSION } from "../../../desk-sdk/version";
import { openAssetRig } from "../../../surface/mc/desk/__tests__/fixtures/adapter-asset-fixtures";
import { DESK_FIXTURE_ADAPTER, deskFixtureCalls, deskFixturePackageId, deskTestWorkspace, writeDeskFixturePackage } from "./fixtures/package-fixtures";
import { DESK_UI_VIEWS, DeskAdapterPackageSchema, DeskPackageLoader, releaseDigest } from "../package";
import { DESK_UI_PROTOCOL_VERSION } from "../package-generation";

const workspace = deskTestWorkspace("cortex-desk-editor");
const tempDir = workspace.tempDir;
const openStore = workspace.openStore;

afterEach(() => workspace.cleanup());

interface CatalogBody {
  protocolVersion: string;
  adapters: { views: { objectType: string; view: string }[]; uiProtocolVersion: string }[];
}

const hex = "0".repeat(64);

const resultOnlyManifest = {
  format: "desk-adapter-package/1",
  packageId: "the-metafactory.desk-adapter-pinned",
  packageVersion: "1.0.0",
  deskSdkRange: "^1.0.0",
  domainContractVersion: "1.0.0",
  backend: { entry: "backend.mjs", sha256: hex },
  declaration: { adapterId: "pinned", label: "Pinned", contractRange: "^1.0.0", schemas: [], objectTypes: [], capabilities: [] },
  draftingBindings: [],
  readBindings: [],
  setup: {
    version: "1.0.0",
    schemas: [],
    configurationSchemaRef: { schemaId: "pinned.setup.configuration", version: "1.0.0" },
    accountScopeSchemaRef: { schemaId: "pinned.setup.account", version: "1.0.0" },
    authMethods: [{ kind: "local" }],
  },
  ui: {
    protocolVersion: "1.0.0",
    entry: "assets/app.html",
    views: [{ objectType: "task", view: "result" }],
    files: [{ path: "assets/app.html", sha256: hex, mediaType: "text/html" }],
  },
};

describe("editor views in the package manifest", () => {
  test("an editor view for a declared object type validates and activates for the catalog", async () => {
    const pkg = writeDeskFixturePackage(join(tempDir("bundled"), "balance"), { ui: true, uiViews: [{ objectType: "task", view: "editor" }] });
    const { store } = await openStore();
    const loader = new DeskPackageLoader({ bundledPackages: [pkg.dir], store });
    const installed = await loader.install(deskFixturePackageId(DESK_FIXTURE_ADAPTER));
    expect(installed.ok).toBe(true);
    const activated = await loader.activate(deskFixturePackageId(DESK_FIXTURE_ADAPTER));
    expect(activated.ok).toBe(true);
    const entry = loader.catalog()[0];
    expect(entry?.ui?.views).toEqual([{ objectType: "task", view: "editor" }]);
    expect(entry?.ui?.protocolVersion).toBe(DESK_UI_PROTOCOL_VERSION);
  });

  test("a package may declare both the result and the editor view of one object type", async () => {
    const views: { objectType: string; view: "result" | "editor" }[] = [{ objectType: "task", view: "result" }, { objectType: "task", view: "editor" }];
    const pkg = writeDeskFixturePackage(join(tempDir("bundled"), "balance"), { ui: true, uiViews: views });
    const { store } = await openStore();
    const loader = new DeskPackageLoader({ bundledPackages: [pkg.dir], store });
    expect((await loader.activate(deskFixturePackageId(DESK_FIXTURE_ADAPTER))).ok).toBe(true);
    expect(loader.catalog()[0]?.ui?.views).toEqual(views);
  });

  test("any other view value or an extra view field is refused as invalid_manifest before any module runs", async () => {
    const cases: { adapterId: string; view: unknown }[] = [
      { adapterId: "bad-value", view: { objectType: "task", view: "detail" } },
      { adapterId: "bad-mount", view: { objectType: "task", view: "result", mount: "inline" } },
      { adapterId: "bad-type", view: { objectType: "task", view: "editor", objectTypeUri: "urn:task" } },
    ];
    for (const testCase of cases) {
      const pkg = writeDeskFixturePackage(join(tempDir(`bundled-${testCase.adapterId}`), testCase.adapterId), {
        adapterId: testCase.adapterId,
        ui: true,
        uiViews: [testCase.view],
      });
      const { store } = await openStore();
      const loader = new DeskPackageLoader({ bundledPackages: [pkg.dir], store });
      const discovery = await loader.discover();
      expect(discovery.candidates).toEqual([]);
      expect(discovery.issues).toContainEqual(expect.objectContaining({ stage: "manifest", code: "invalid_manifest", packageRoot: pkg.dir }));
      const installed = await loader.install(deskFixturePackageId(testCase.adapterId));
      expect(installed.ok).toBe(false);
      if (!installed.ok) expect(installed.error.code).toBe("unknown_package");
      expect((await loader.activate(deskFixturePackageId(testCase.adapterId))).ok).toBe(false);
      expect(loader.list()).toEqual([]);
      expect(deskFixtureCalls()[testCase.adapterId]).toBeUndefined();
    }
  });

  test("an existing result-only manifest keeps its 1.1.0 release digest", () => {
    const manifest = DeskAdapterPackageSchema.parse(resultOnlyManifest);
    expect(manifest.ui?.views).toEqual([{ objectType: "task", view: "result" }]);
    expect(releaseDigest(manifest, sha256Bytes(JSON.stringify(resultOnlyManifest)))).toBe("2be06d351285e8d337977522072d0ba1c297b3cedebd66992925f65959d02477");
    expect(DESK_UI_VIEWS).toEqual(["result", "editor"]);
  });

  test("the SDK minor is 1.2.0, a ^1.1.0 package still loads and the UI protocol stays 1.0.0", async () => {
    expect(DESK_ADAPTER_SDK_VERSION).toBe("1.2.0");
    expect(DESK_UI_PROTOCOL_VERSION).toBe("1.0.0");
    expect(readFileSync(join(import.meta.dir, "../../../desk-sdk/generated/desk-sdk.d.ts"), "utf8")).toContain(`DESK_ADAPTER_SDK_VERSION = "${DESK_ADAPTER_SDK_VERSION}"`);
    const pkg = writeDeskFixturePackage(join(tempDir("bundled"), "balance"), { deskSdkRange: "^1.1.0", ui: true, uiViews: [{ objectType: "task", view: "editor" }] });
    const { store } = await openStore();
    const loader = new DeskPackageLoader({ bundledPackages: [pkg.dir], store });
    const activated = await loader.activate(deskFixturePackageId(DESK_FIXTURE_ADAPTER));
    expect(activated.ok).toBe(true);
    if (activated.ok) expect(activated.value.deskSdkRange).toBe("^1.1.0");
  });

  test("a package that needs a newer SDK than 1.2.0 is refused as incompatible", async () => {
    const pkg = writeDeskFixturePackage(join(tempDir("bundled"), "balance"), { deskSdkRange: "^1.3.0" });
    const loader = new DeskPackageLoader({ bundledPackages: [pkg.dir] });
    const discovery = await loader.discover();
    expect(discovery.candidates[0]?.state).toMatchObject({ state: "unavailable", code: "incompatible_sdk" });
  });

  test("the authenticated asset catalog lists the editor view of an activated package", async () => {
    const rig = await openAssetRig();
    try {
      const catalogOf = async (): Promise<CatalogBody> => (await rig.local("/api/desk/adapters/catalog")).json() as Promise<CatalogBody>;
      expect((await catalogOf()).adapters[0]?.views).toEqual([{ objectType: "task", view: "result" }]);
      rig.writePackage({ packageVersion: "1.0.1", uiViews: [{ objectType: "task", view: "editor" }] });
      expect((await rig.loader.activate(rig.packageId)).ok).toBe(true);
      const entry = (await catalogOf()).adapters[0];
      expect(entry?.views).toEqual([{ objectType: "task", view: "editor" }]);
      expect(entry?.uiProtocolVersion).toBe("1.0.0");
    } finally {
      await rig.close();
    }
  });
});
