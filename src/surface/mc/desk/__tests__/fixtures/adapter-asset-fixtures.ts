import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { DESK_FIXTURE_ADAPTER, deskFixturePackageId, openDeskFixtureStore, writeDeskFixturePackage, type DeskFixturePackageOptions } from "../../../../../conversations/domain-adapters/__tests__/fixtures/package-fixtures";
import { DeskPackageLoader } from "../../../../../conversations/domain-adapters/package";
import type { DeskGenerationStore } from "../../../../../conversations/domain-adapters/package-generation";
import { handleDeskAdapterAssets } from "../../../api/desk-adapter-assets";
import type { MutationGuardContext } from "../../../api/mutation-guard";
import { CF_ACCESS_EMAIL_HEADER, CF_ACCESS_JWT_HEADER } from "../../../api/networks-admission";
import { AdapterAssetService, type AssetConnection } from "../../adapter-assets";

export const ASSET_OWNER = "principal-example";
export const ASSET_OTHER = "principal-other";
export const ASSET_CONNECTION = "connection-example";
const HOSTED_HOST = "desk.example.test";

export interface AssetRequestInit {
  principal?: string | null;
  headers?: Record<string, string>;
  method?: string;
}

export interface AssetRig {
  root: string;
  packageDir: string;
  packageId: string;
  loader: DeskPackageLoader;
  store: DeskGenerationStore;
  service: AdapterAssetService;
  connections: Map<string, AssetConnection[]>;
  writePackage(options?: DeskFixturePackageOptions): void;
  local(path: string, init?: AssetRequestInit): Promise<Response>;
  hosted(path: string, init?: AssetRequestInit): Promise<Response>;
  close(): Promise<void>;
}

export const enabledConnection = (connectionId = ASSET_CONNECTION): AssetConnection => ({
  connectionId,
  packageId: deskFixturePackageId(DESK_FIXTURE_ADAPTER),
  state: "enabled",
  readCapabilityIds: [`${DESK_FIXTURE_ADAPTER}.task.query`, "unrelated.capability"],
  writeCapabilityIds: [`${DESK_FIXTURE_ADAPTER}.task.create`],
});

export async function openAssetRig(options: { service?: boolean } = {}): Promise<AssetRig> {
  const root = mkdtempSync(join(tmpdir(), "cortex-desk-assets-"));
  const { engine, store } = await openDeskFixtureStore(join(root, "store"));
  const packageDir = join(root, "packages", DESK_FIXTURE_ADAPTER);
  const writePackage = (extra: DeskFixturePackageOptions = {}): void => { writeDeskFixturePackage(packageDir, { ui: true, ...extra }); };
  writePackage();
  const packageId = deskFixturePackageId(DESK_FIXTURE_ADAPTER);
  const loader = new DeskPackageLoader({ bundledPackages: [packageDir], store });
  const activated = await loader.activate(packageId);
  if (!activated.ok) throw new Error(`fixture activation failed: ${activated.error.message}`);
  const connections = new Map<string, AssetConnection[]>([[ASSET_OWNER, [enabledConnection()]]]);
  const service = new AdapterAssetService(loader, { connections: principal => Promise.resolve(connections.get(principal) ?? []) });
  const access = options.service === false ? () => null : () => service;

  let port = 0;
  const localGuard = (): MutationGuardContext => ({ isLoopback: true, allowedHostnames: new Set(["127.0.0.1", "localhost"]), listenPort: port, principals: new Set(), localPrincipal: ASSET_OWNER });
  const hostedGuard: MutationGuardContext = {
    isLoopback: false, allowedHostnames: new Set([HOSTED_HOST]), listenPort: 443, principals: new Set([ASSET_OWNER, ASSET_OTHER]), localPrincipal: ASSET_OWNER,
    verifyJwt: assertion => Promise.resolve(assertion.startsWith("verified:") ? { email: assertion.slice("verified:".length) } : null),
  };
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: req => handleDeskAdapterAssets(req, new URL(req.url), localGuard(), access) });
  port = server.port ?? 0;
  const localUrl = `http://127.0.0.1:${port}`;

  return {
    root, packageDir, packageId, loader, store, service, connections, writePackage,
    local(path, init = {}) {
      const headers: Record<string, string> = { ...init.headers };
      if (init.principal !== null) headers[CF_ACCESS_EMAIL_HEADER] = init.principal ?? ASSET_OWNER;
      return fetch(`${localUrl}${path}`, { method: init.method ?? "GET", headers, redirect: "manual" });
    },
    hosted(path, init = {}) {
      const headers: Record<string, string> = { host: HOSTED_HOST, ...init.headers };
      if (init.principal !== null) headers[CF_ACCESS_JWT_HEADER] = `verified:${init.principal ?? ASSET_OWNER}`;
      const req = new Request(`https://${HOSTED_HOST}${path}`, { method: init.method ?? "GET", headers });
      return handleDeskAdapterAssets(req, new URL(req.url), hostedGuard, access);
    },
    async close() {
      await server.stop(true);
      await engine.close(BACKGROUND_CONTEXT);
      rmSync(root, { recursive: true, force: true });
    },
  };
}
