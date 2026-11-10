#!/usr/bin/env bun
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { probeChecks } from "./lib/probe-checks";
import { sha256Bytes } from "../src/common/registry/arc-package-inventory";
import { assetUrl, type AssetCatalogEntry } from "../src/surface/mc/desk/adapter-assets";
import { ASSET_CONNECTION, ASSET_OTHER, enabledConnection, openAssetRig } from "../src/surface/mc/desk/__tests__/fixtures/adapter-asset-fixtures";

const { check, finish } = probeChecks();
interface Catalog { adapters: AssetCatalogEntry[] }

const rig = await openAssetRig();
try {
  const catalogOf = async (): Promise<Catalog> => (await rig.local("/api/desk/adapters/catalog")).json() as Promise<Catalog>;
  const a = (await catalogOf()).adapters[0];
  if (!a) throw new Error("the synthetic catalog is empty");
  const urls = a.files.map(file => file.url);

  for (const file of a.files) {
    const local = new Uint8Array(await (await rig.local(file.url)).arrayBuffer());
    const hosted = new Uint8Array(await (await rig.hosted(file.url)).arrayBuffer());
    check(sha256Bytes(local) === file.sha256 && sha256Bytes(hosted) === file.sha256, `local and hosted serve the exact active ${file.path}`);
  }

  check((await rig.hosted(urls[0] ?? "", { principal: null })).status === 401, "an unauthenticated hosted request is denied");
  check((await rig.local(`${urls[0] ?? ""}?access=x`)).status === 400, "a query token is refused");
  check((await rig.local(`/api/desk/adapters/assets/${a.releaseDigest}/${ASSET_CONNECTION}/..%2F..%2Fdesk-adapter.json`)).status === 404, "traversal is refused");
  check((await rig.local(assetUrl(a.releaseDigest, ASSET_CONNECTION, "backend.mjs"))).status === 404, "a non-listed asset is refused");
  check((await rig.local(assetUrl(a.releaseDigest, "foreign-connection", "app.js"))).status === 403, "a foreign connection is denied");
  check((await rig.local(assetUrl("f".repeat(64), ASSET_CONNECTION, "app.js"))).status === 409, "a foreign release is refused with refresh recovery");
  rig.connections.set(ASSET_OTHER, [enabledConnection("other-connection")]);
  check((await rig.hosted(urls[0] ?? "", { principal: ASSET_OTHER })).status === 403, "a cross-principal request for the owner's release is denied");

  writeFileSync(join(rig.packageDir, "app.js"), "tampered");
  check((await rig.local(urls[1] ?? "")).status === 503, "a tampered asset is unavailable, not served");

  rig.writePackage();
  rig.writePackage({ packageVersion: "1.0.1", backendSha: "0".repeat(64) });
  check(!(await rig.loader.activate(rig.packageId)).ok, "an invalid staged update B is rejected");
  check((await catalogOf()).adapters[0]?.releaseDigest === a.releaseDigest, "the last valid generation A stays in the catalog");

  rig.writePackage({ packageVersion: "1.0.1" });
  check((await rig.loader.activate(rig.packageId)).ok, "a valid update B activates");
  const b = (await catalogOf()).adapters[0];
  check(b !== undefined && b.releaseDigest !== a.releaseDigest, "the catalog moves to B atomically");
  const cached = await rig.local(urls[0] ?? "");
  check(cached.status === 409 && (await cached.json() as { recovery?: string }).recovery === "refresh", "cached A against active B is rejected with refresh recovery");

  rig.writePackage({ packageVersion: "1.0.0" });
  check((await rig.loader.rollback("balance")).ok, "explicit rollback restores A");
  check((await catalogOf()).adapters[0]?.releaseDigest === a.releaseDigest && (await rig.local(urls[0] ?? "")).status === 200, "the catalog and assets are the matched A pair again");
  const record = await rig.store.read("balance");
  check(record?.history.length === 2 && record.lastValid?.releaseDigest === b?.releaseDigest, "host generation history is preserved across rollback");
  check((await rig.store.admit("balance", { releaseDigest: b?.releaseDigest ?? "" })).state === "upgrade_required", "stored data B cannot read stays protected, never downgraded");

  await rig.loader.disable("balance");
  check((await catalogOf()).adapters.length === 0 && (await rig.local(urls[0] ?? "")).status === 409, "disable removes catalog and asset availability immediately");
  check(!(await rig.loader.rollback("balance")).ok, "rollback does not resurrect a disabled adapter");
} finally {
  await rig.close();
}

finish("desk adapter asset probe check(s) failed.", "Desk adapter asset probe passed: matched local and hosted delivery, denials, A to B activation, rollback and preserved records. No real deployment, restart or provider effect.");
