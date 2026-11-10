import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sha256Bytes } from "../../../../common/registry/arc-package-inventory";
import { assetUrl, parseAssetPath, type AssetCatalogEntry } from "../adapter-assets";
import { ASSET_CONNECTION, ASSET_OTHER, ASSET_OWNER, enabledConnection, openAssetRig, type AssetRig } from "./fixtures/adapter-asset-fixtures";

const rigs: AssetRig[] = [];
const open = async (options?: { service?: boolean }): Promise<AssetRig> => {
  const rig = await openAssetRig(options);
  rigs.push(rig);
  return rig;
};
afterEach(async () => {
  for (const rig of rigs.splice(0)) await rig.close();
});

interface CatalogBody { ok: boolean; revision: string; protocolVersion: string; adapters: AssetCatalogEntry[] }
const catalogOf = async (rig: AssetRig, mode: "local" | "hosted" = "local", headers?: Record<string, string>): Promise<CatalogBody> =>
  (await rig[mode]("/api/desk/adapters/catalog", headers ? { headers } : {})).json() as Promise<CatalogBody>;
const first = (catalog: CatalogBody): AssetCatalogEntry => {
  const entry = catalog.adapters[0];
  if (!entry) throw new Error("catalog is empty");
  return entry;
};
const urlOf = (entry: AssetCatalogEntry, index = 0): string => entry.files[index]?.url ?? "";

describe("catalog", () => {
  test("publishes exact identity, filtered to declared capabilities, with no private values", async () => {
    const rig = await open();
    const catalog = await catalogOf(rig);
    const entry = first(catalog);
    expect(catalog.protocolVersion).toBe("1.0.0");
    expect(entry).toMatchObject({ adapterId: "balance", connectionId: ASSET_CONNECTION, uiProtocolVersion: "1.0.0", packageVersion: "1.0.0", availability: { state: "available" } });
    expect(entry.releaseDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(entry.readCapabilityIds).toEqual(["balance.task.query"]);
    expect(entry.writeCapabilityIds).toEqual(["balance.task.create"]);
    expect(entry.files.map(file => file.path)).toEqual(["app.html", "app.js"]);
    expect(JSON.stringify(catalog)).not.toContain(rig.root);
    expect(entry.files.every(file => file.url.startsWith("/api/desk/adapters/assets/"))).toBe(true);
  });

  test("current policy filters other principals, disabled connections and revocation", async () => {
    const rig = await open();
    expect((await catalogOf(rig)).adapters).toHaveLength(1);
    rig.connections.set(ASSET_OTHER, [{ ...enabledConnection("other-connection"), state: "disabled" }]);
    const other = await (await rig.hosted("/api/desk/adapters/catalog", { principal: ASSET_OTHER })).json() as CatalogBody;
    expect(other.adapters).toHaveLength(0);
    rig.connections.set(ASSET_OWNER, [{ ...enabledConnection(), state: "disabled" }]);
    expect((await catalogOf(rig)).adapters).toHaveLength(0);
  });

  test("an unsupported shell protocol is visibly unavailable", async () => {
    const rig = await open();
    const entry = first(await catalogOf(rig, "hosted", { "x-desk-ui-protocol": "2.0.0" }));
    expect(entry.availability).toMatchObject({ state: "unavailable", code: "unsupported_ui_protocol" });
    const asset = await rig.hosted(urlOf(entry), { headers: { "x-desk-ui-protocol": "2.0.0" } });
    expect(asset.status).toBe(426);
  });
});

describe("asset delivery", () => {
  test("local and hosted serve identical verified bytes with restrictive headers", async () => {
    const rig = await open();
    const entry = first(await catalogOf(rig));
    for (const file of entry.files) {
      const local = await rig.local(file.url);
      const hosted = await rig.hosted(file.url);
      const bytes = new Uint8Array(await local.arrayBuffer());
      expect(sha256Bytes(bytes)).toBe(file.sha256);
      expect(new Uint8Array(await hosted.arrayBuffer())).toEqual(bytes);
      for (const response of [local, hosted]) {
        expect(response.status).toBe(200);
        expect(response.headers.get("etag")).toBe(`"${file.sha256}"`);
        expect(response.headers.get("x-content-type-options")).toBe("nosniff");
        expect(response.headers.get("content-security-policy")).toContain("connect-src 'none'");
        expect(response.headers.get("cache-control")).toBe("private, no-cache");
        expect(response.headers.get("access-control-allow-origin")).toBeNull();
        expect(response.headers.get("location")).toBeNull();
      }
      expect(local.headers.get("content-type")).toBe(file.mediaType.startsWith("text/") ? `${file.mediaType}; charset=utf-8` : file.mediaType);
    }
  });

  test("conditional and HEAD requests are authorized first", async () => {
    const rig = await open();
    const entry = first(await catalogOf(rig));
    const url = urlOf(entry);
    const etag = `"${entry.files[0]?.sha256 ?? ""}"`;
    expect((await rig.local(url, { headers: { "if-none-match": etag } })).status).toBe(304);
    expect((await rig.hosted(url, { headers: { "if-none-match": etag }, principal: null })).status).toBe(401);
    const head = await rig.local(url, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect((await head.arrayBuffer()).byteLength).toBe(0);
    expect((await rig.local(url, { method: "POST" })).status).toBe(405);
  });

  test("unauthenticated, foreign and query requests are refused", async () => {
    const rig = await open();
    const entry = first(await catalogOf(rig));
    const url = urlOf(entry);
    expect((await rig.hosted(url, { principal: null })).status).toBe(401);
    expect((await rig.hosted(url, { headers: { "cf-access-jwt-assertion": "forged" }, principal: null })).status).toBe(401);
    expect((await rig.local(`${url}?access=abc`)).status).toBe(400);
    rig.connections.set(ASSET_OTHER, [enabledConnection("other-connection")]);
    expect((await rig.hosted(url, { principal: ASSET_OTHER })).status).toBe(403);
    const foreign = await rig.local(assetUrl(entry.releaseDigest, "someone-elses", "app.js"));
    expect(foreign.status).toBe(403);
    expect(((await foreign.json()) as { code: string }).code).toBe("connection_not_authorized");
    const stale = await rig.local(assetUrl("a".repeat(64), ASSET_CONNECTION, "app.js"));
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ code: "generation_mismatch", recovery: "refresh" });
  });

  test("traversal, absolute and unlisted paths never reach the filesystem", async () => {
    const rig = await open();
    writeFileSync(join(rig.root, "private.txt"), "private");
    writeFileSync(join(rig.packageDir, "unlisted.js"), "x");
    const entry = first(await catalogOf(rig));
    const base = `/api/desk/adapters/assets/${entry.releaseDigest}/${ASSET_CONNECTION}`;
    for (const path of ["..%2F..%2Fprivate.txt", "%2e%2e/private.txt", "../private.txt", "%2Fetc%2Fpasswd", "app.js%00", "a%5Cb", "unlisted.js", "desk-adapter.json", "backend.mjs"]) {
      const response = await rig.local(`${base}/${path}`);
      expect([400, 404]).toContain(response.status);
    }
    expect(parseAssetPath("/api/desk/adapters/assets/x/y/%2e%2e/z")).toBeNull();
    expect(parseAssetPath("/api/desk/adapters/assets/x/y")).toBeNull();
  });

  test("a tampered or symlinked file is unavailable, never served", async () => {
    const rig = await open();
    const entry = first(await catalogOf(rig));
    writeFileSync(join(rig.packageDir, "app.js"), "tampered");
    expect((await rig.local(urlOf(entry, 1))).status).toBe(503);
    expect((await rig.local(urlOf(entry, 0))).status).toBe(200);
    writeFileSync(join(rig.root, "outside.html"), readFileSync(join(rig.packageDir, "app.html")));
    rmSync(join(rig.packageDir, "app.html"));
    symlinkSync(join(rig.root, "outside.html"), join(rig.packageDir, "app.html"));
    expect((await rig.local(urlOf(entry, 0))).status).toBe(503);
  });

  test("a missing service is unavailable with no fallback", async () => {
    const rig = await open({ service: false });
    expect((await rig.local("/api/desk/adapters/catalog")).status).toBe(503);
    expect((await rig.hosted("/api/desk/adapters/catalog")).status).toBe(503);
  });
});

describe("generations", () => {
  test("disable removes catalog and asset availability immediately", async () => {
    const rig = await open();
    const url = urlOf(first(await catalogOf(rig)));
    await rig.loader.disable("balance");
    expect((await catalogOf(rig)).adapters).toHaveLength(0);
    expect((await rig.local(url)).status).toBe(409);
  });

  test("activating B rejects cached A, a bad update keeps A, and rollback restores the matched pair", async () => {
    const rig = await open();
    const a = first(await catalogOf(rig));
    const aUrl = urlOf(a);

    rig.writePackage({ packageVersion: "1.0.1", backendSha: "0".repeat(64) });
    expect((await rig.loader.activate(rig.packageId)).ok).toBe(false);
    expect(first(await catalogOf(rig)).releaseDigest).toBe(a.releaseDigest);
    expect((await rig.local(aUrl)).status).toBe(200);

    rig.writePackage({ packageVersion: "1.0.1" });
    expect((await rig.loader.activate(rig.packageId)).ok).toBe(true);
    const b = first(await catalogOf(rig));
    expect(b.releaseDigest).not.toBe(a.releaseDigest);
    const cached = await rig.local(aUrl);
    expect(cached.status).toBe(409);
    expect(await cached.json()).toMatchObject({ recovery: "refresh" });
    expect((await rig.local(urlOf(b))).status).toBe(200);
    expect((await rig.store.admit("balance", { releaseDigest: a.releaseDigest })).state).toBe("upgrade_required");

    rig.writePackage({ packageVersion: "1.0.0" });
    expect((await rig.loader.rollback("balance")).ok).toBe(true);
    expect(first(await catalogOf(rig)).releaseDigest).toBe(a.releaseDigest);
    expect((await rig.local(aUrl)).status).toBe(200);
    expect((await rig.local(urlOf(b))).status).toBe(409);
    const record = await rig.store.read("balance");
    expect(record?.history.map(entry => entry.releaseDigest)).toEqual([a.releaseDigest, b.releaseDigest]);
    expect(record?.lastValid?.releaseDigest).toBe(b.releaseDigest);
    expect((await rig.store.admit("balance", { releaseDigest: b.releaseDigest })).state).toBe("upgrade_required");
  });

  test("rollback never resurrects a disabled adapter or a revoked connection", async () => {
    const rig = await open();
    rig.writePackage({ packageVersion: "1.0.1" });
    await rig.loader.activate(rig.packageId);
    rig.writePackage({ packageVersion: "1.0.0" });
    await rig.loader.disable("balance");
    expect((await rig.loader.rollback("balance")).ok).toBe(false);
    expect((await catalogOf(rig)).adapters).toHaveLength(0);
    expect((await rig.store.read("balance"))?.disabled).toBe(true);
  });

  test("rollback with nothing earlier, or an earlier generation not reinstalled, is refused", async () => {
    const rig = await open();
    expect((await rig.loader.rollback("balance")).ok).toBe(false);
    rig.writePackage({ packageVersion: "1.0.1" });
    await rig.loader.activate(rig.packageId);
    expect((await rig.loader.rollback("balance")).ok).toBe(false);
    expect(first(await catalogOf(rig)).packageVersion).toBe("1.0.1");
  });
});
