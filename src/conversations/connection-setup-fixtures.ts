import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openSyntheticHost, removeSyntheticRig, syntheticLive } from "../common/config/desk-credential-broker-fixtures";
import { createArcFileSecretStore, type ArcSecretStore } from "../common/config/desk-credential-arc-file-store";
import type { ConnectionHead, SetupDescriptor, SetupPrincipal } from "../common/config/desk-credential-broker";
import { TOKEN_DESCRIPTOR, LOCAL_DESCRIPTOR } from "../common/config/desk-credential-broker-fixtures";
import type { AuthorityBindings } from "./authority";
import { ConnectionSetupService, type SetupCatalogEntry } from "./connection-setup";
import type { ConversationHost } from "./host";
import { registryFixture } from "./domain-adapters/operations/fixtures";
import type { MutationGuardContext } from "../surface/mc/api/mutation-guard";
import { CF_ACCESS_EMAIL_HEADER, CF_ACCESS_JWT_HEADER } from "../surface/mc/api/networks-admission";
import { handleDeskConnections } from "../surface/mc/api/desk-connections";

export { SYNTHETIC_TOKEN } from "../common/config/desk-credential-broker-fixtures";
export const OWNER = "principal-example";
export const OTHER = "principal-other";
const DESTINATION = { adapterId: "example-package", connectionId: "example-connection", objectType: "area", canonicalId: "area-example" };
const SECOND_DESTINATION = { ...DESTINATION, canonicalId: "area-second" };

const entry = (setup: SetupDescriptor, packageId: string): SetupCatalogEntry => ({
  packageId, label: `Example ${setup.authKind}`, setup: { ...setup, packageId }, connectorId: "synthetic-connector", executionBindingRef: "synthetic-binding", registryRevision: "registry-1",
  scopeFields: [{ name: "account", label: "Account" }, { name: "resource", label: "Resource" }],
  capabilities: [{ capabilityId: "example.object.read", label: "Read objects", access: "read" }, { capabilityId: "example.object.create", label: "Create objects", access: "write" }],
  destinations: [{ ref: DESTINATION, label: "Example area" }, { ref: SECOND_DESTINATION, label: "Second area" }],
});

export const CATALOG: SetupCatalogEntry[] = [
  entry(TOKEN_DESCRIPTOR, "example-package"),
  entry(LOCAL_DESCRIPTOR, "example-local-package"),
  entry({ ...TOKEN_DESCRIPTOR, setupSchemaId: "example-oauth", authKind: "oauth", broker: "unknown-broker", slots: [{ slot: "grant", kind: "token" }] }, "example-oauth-package"),
];

export const SELECTION = { scope: { account: "synthetic-account", resource: "area-example" }, readCapabilityIds: ["example.object.read"], writeCapabilityIds: [] as string[], readDestinations: [DESTINATION], writeDestinations: [] as typeof DESTINATION[] };

export interface ConnectionSetupRig {
  dir: string;
  service(): ConnectionSetupService;
  host(): ConversationHost;
  catalog: SetupCatalogEntry[];
  env: Record<string, string>;
  hooks: { storeUnavailable?: boolean; publishFails?: boolean };
  counts: { secretWrites: number; headUpdates: number; authorityPublishes: number; ownerMutations: number; bridgesClosed: string[] };
  heads: ConnectionHead[];
  principals: Map<string, SetupPrincipal>;
  http(mode: "local" | "hosted", method: string, path: string, body: unknown, as?: string): Promise<{ status: number; body: Record<string, unknown>; text: string }>;
  reopen(): Promise<void>;
  close(): Promise<void>;
}

export async function connectionSetupRig(): Promise<ConnectionSetupRig> {
  const dir = await mkdtemp(join(tmpdir(), "desk-connection-setup-"));
  const inner = createArcFileSecretStore({ configRoot: join(dir, "arc") });
  const hooks: ConnectionSetupRig["hooks"] = {};
  const counts: ConnectionSetupRig["counts"] = { secretWrites: 0, headUpdates: 0, authorityPublishes: 0, ownerMutations: 0, bridgesClosed: [] };
  const heads: ConnectionHead[] = [];
  const store: ArcSecretStore = {
    id: inner.id,
    available: async () => !hooks.storeUnavailable && inner.available(),
    writeIfAbsent: async (identity, value) => { const outcome = await inner.writeIfAbsent(identity, value); if (outcome === "created") counts.secretWrites++; return outcome; },
    matches: (identity, value) => inner.matches(identity, value),
    present: identity => inner.present(identity),
  };
  const env: Record<string, string> = { EXAMPLE_API_KEY: "synthetic-env-secret" };
  const principals = new Map<string, SetupPrincipal>();
  for (const name of [OWNER, OTHER]) principals.set(name, { principalRef: randomUUID(), principal: name, stack: "test", expiresAt: "2999-01-01T00:00:00.000Z" });
  let host: ConversationHost | undefined;
  let service: ConnectionSetupService | undefined;
  const live = syntheticLive;
  const open = async (): Promise<void> => {
    host = await openSyntheticHost(dir);
    const bindings = { currentRevision: () => "rev", authenticate: () => Promise.resolve(null), policy: () => Promise.reject(new Error("unused")), writer: () => Promise.resolve(false), restrictions: new Map(), connectors: new Map(), sinks: new Map() } as unknown as AuthorityBindings;
    const authority = host.lifecycleAuthority(registryFixture(), bindings);
    for (const person of principals.values()) {
      if (!(await authority.inspectHostRecords()).heads[`principal:${person.principalRef}`]) await authority.publishHostRecord({ kind: "principal", value: { version: 1, status: "active", principalRef: person.principalRef, principal: person.principal, stack: person.stack, identityBindingRevision: "1" } }, 0);
    }
    const counted = { inspectHostRecords: () => authority.inspectHostRecords(), publishHostRecord: (...args: Parameters<typeof authority.publishHostRecord>) => { counts.authorityPublishes++; return authority.publishHostRecord(...args); } };
    const broker = host.credentialBroker({
      store,
      authenticate: sessionRef => Promise.resolve(principals.get(sessionRef) ?? null),
      publishConnection: async head => {
        if (hooks.publishFails) throw new Error("synthetic interruption before connection publication");
        counts.headUpdates++;
        heads.push(head);
        await live(service).recordHead(head);
      },
      references: { authorized: (principalRef, name) => principals.get(OWNER)?.principalRef === principalRef && name === "EXAMPLE_API_KEY", present: name => name in env },
      approvedBrokers: new Set(["approved-broker"]),
    });
    service = live(host).connectionSetup(broker, counted, {
      stack: "test", catalog: () => rig.catalog,
      principalFor: (principal, stack) => Promise.resolve(principals.get(principal)?.stack === stack ? principals.get(principal) ?? null : null),
      references: principalRef => principals.get(OWNER)?.principalRef === principalRef ? Object.keys(env) : [],
      approvedBrokers: new Set(["approved-broker"]),
      closeBridges: id => { counts.bridgesClosed.push(id); return Promise.resolve(); },
    });
    service.registerCatalog();
  };
  const guard = (mode: "local" | "hosted"): MutationGuardContext => ({
    isLoopback: mode === "local", allowedHostnames: new Set(["127.0.0.1", "localhost", "desk.example.test"]), listenPort: 8767, principals: mode === "hosted" ? new Set([OWNER]) : new Set(), localPrincipal: OWNER,
    ...(mode === "hosted" ? { verifyJwt: (token: string) => Promise.resolve(token.startsWith("verified:") ? { email: token.slice("verified:".length) } : null) } : {}),
  });
  const rig: ConnectionSetupRig = {
    dir, catalog: CATALOG.map(item => structuredClone(item)), env, hooks, counts, heads, principals,
    service: () => live(service), host: () => live(host),
    async http(mode, method, path, body, as = OWNER) {
      const headers: Record<string, string> = { host: mode === "local" ? "127.0.0.1:8767" : "desk.example.test", "content-type": "application/json" };
      if (mode === "local") headers[CF_ACCESS_EMAIL_HEADER] = as; else headers[CF_ACCESS_JWT_HEADER] = `verified:${as}`;
      const req = new Request(`http://${headers.host}${path}`, { method, headers, ...(method === "GET" ? {} : { body: JSON.stringify(body) }) });
      const res = await handleDeskConnections(req, new URL(req.url), guard(mode), () => service ?? null);
      const text = await res.text();
      return { status: res.status, body: text ? JSON.parse(text) as Record<string, unknown> : {}, text };
    },
    async reopen() { await host?.close(); await open(); },
    close: () => removeSyntheticRig(dir, host),
  };
  await open();
  return rig;
}
