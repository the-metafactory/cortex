import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { sha256Bytes } from "../../../../common/registry/arc-package-inventory";
import type { ArcPackage } from "../../../../common/types/plugin-manifest";
import type { DeskAdapterApproval, DeskPackageCandidate } from "../../package";
import { DeskGenerationStore } from "../../package-generation";

export const DESK_FIXTURE_ORIGIN = "https://github.com/example/desk-balance";
export const DESK_FIXTURE_ADAPTER = "balance";

export const deskFixturePackageId = (adapterId: string): string => `the-metafactory.desk-adapter-${adapterId}`;

const schemaRef = (schemaId: string) => ({ schemaId, version: "1.0.0" });
const objectSchema = (properties: Record<string, unknown>, required: string[] = []) => ({ type: "object", additionalProperties: false, required, properties });

export interface DeskFixtureRelationship {
  targetAdapterId: string;
  targetObjectType?: string;
}

export interface DeskFixtureDeclarationOptions {
  relationship?: DeskFixtureRelationship;
}

const referenceProperties = (relationship: DeskFixtureRelationship): Record<string, unknown> => ({
  parent: {
    type: "object",
    additionalProperties: false,
    required: ["adapterId", "connectionId", "objectType", "canonicalId"],
    properties: {
      adapterId: { type: "string", const: relationship.targetAdapterId },
      connectionId: { type: "string", minLength: 1 },
      objectType: { type: "string", const: relationship.targetObjectType ?? "task" },
      canonicalId: { type: "string", minLength: 1 },
    },
  },
});

export function deskFixtureDeclaration(adapterId = DESK_FIXTURE_ADAPTER, options: DeskFixtureDeclarationOptions = {}) {
  const relationship = options.relationship;
  return {
    adapterId,
    label: adapterId,
    contractRange: "^1.0.0",
    schemas: [
      { schemaId: `${adapterId}.task`, version: "1.0.0", schema: objectSchema({ title: { type: "string", minLength: 1 }, ...(relationship ? referenceProperties(relationship) : {}) }, ["title"]) },
      { schemaId: `${adapterId}.task.create.input`, version: "1.0.0", schema: objectSchema({ title: { type: "string", minLength: 1 } }, ["title"]) },
      { schemaId: `${adapterId}.task.create.output`, version: "1.0.0", schema: objectSchema({ ref: { type: "string", minLength: 1 } }, ["ref"]) },
      { schemaId: `${adapterId}.task.query.input`, version: "1.0.0", schema: objectSchema({}) },
      { schemaId: `${adapterId}.task.query.output`, version: "1.0.0", schema: objectSchema({ objects: { type: "array", items: { type: "object" } } }, ["objects"]) },
      { schemaId: `${adapterId}.error`, version: "1.0.0", schema: { type: "object" } },
    ],
    objectTypes: [{
      objectType: "task",
      label: "Task",
      schemaRef: schemaRef(`${adapterId}.task`),
      relationships: relationship ? [{ fieldPath: "/parent", cardinality: "one", targetAdapterId: relationship.targetAdapterId, targetObjectType: relationship.targetObjectType ?? "task" }] : [],
    }],
    capabilities: [
      { capabilityId: `${adapterId}.task.create`, label: "Create task", kind: "action", objectTypes: ["task"], inputSchemaRef: schemaRef(`${adapterId}.task.create.input`), outputSchemaRef: schemaRef(`${adapterId}.task.create.output`), errorSchemaRef: schemaRef(`${adapterId}.error`) },
      { capabilityId: `${adapterId}.task.query`, label: "Query tasks", kind: "query", objectTypes: ["task"], inputSchemaRef: schemaRef(`${adapterId}.task.query.input`), outputSchemaRef: schemaRef(`${adapterId}.task.query.output`), errorSchemaRef: schemaRef(`${adapterId}.error`) },
    ],
  };
}

export function deskFixtureSetup(adapterId = DESK_FIXTURE_ADAPTER) {
  return {
    version: "1.0.0",
    schemas: [
      { schemaId: `${adapterId}.setup.configuration`, version: "1.0.0", schema: objectSchema({ workspace: { type: "string" } }) },
      { schemaId: `${adapterId}.setup.account`, version: "1.0.0", schema: objectSchema({ account: { type: "string" } }) },
    ],
    configurationSchemaRef: schemaRef(`${adapterId}.setup.configuration`),
    accountScopeSchemaRef: schemaRef(`${adapterId}.setup.account`),
    authMethods: [{ kind: "local" }, { kind: "token", slots: [{ name: "token", label: "API token", required: true }] }],
  };
}

export function deskFixtureReadBinding(adapterId = DESK_FIXTURE_ADAPTER) {
  return {
    version: "1.0.0",
    adapterId,
    capabilityId: `${adapterId}.task.query`,
    mode: "query",
    objectType: "task",
    inputSchemaRef: schemaRef(`${adapterId}.task.query.input`),
    outputSchemaRef: schemaRef(`${adapterId}.task.query.output`),
    display: { title: "/objects" },
  };
}

export function deskFixtureDraftingBinding(adapterId = DESK_FIXTURE_ADAPTER) {
  return {
    bindingVersion: "1.0.0",
    adapterId,
    capabilityId: `${adapterId}.task.create`,
    inputSchemaRef: schemaRef(`${adapterId}.task.create.input`),
    guidance: { guidanceId: `${adapterId}.create`, version: "1.0.0", instructions: "Create a task from the conversation." },
    fieldHints: [{ pointer: "/title", role: "title" }],
  };
}

export interface DeskFixtureBackendOptions {
  throwOnCreate?: boolean;
  omitConnector?: boolean;
  extraExport?: boolean;
  misplacedHandler?: boolean;
}

export type DeskFixtureCallLog = Record<string, number>;

export function deskFixtureCalls(): DeskFixtureCallLog {
  const holder = globalThis as { __deskPackageCalls?: DeskFixtureCallLog };
  holder.__deskPackageCalls ??= {};
  return holder.__deskPackageCalls;
}

export function deskFixtureBackend(declaration: { adapterId: string }, options: DeskFixtureBackendOptions = {}): string {
  const adapterId = declaration.adapterId;
  const connectorId = `${adapterId}:connector`;
  return [
    "const calls = globalThis.__deskPackageCalls ??= {};",
    "export function createDeskAdapter(host) {",
    `  calls[${JSON.stringify(adapterId)}] = (calls[${JSON.stringify(adapterId)}] ?? 0) + 1;`,
    options.throwOnCreate ? '  throw new Error("synthetic adapter creation failure");' : "",
    options.omitConnector ? "" : `  host.registerConnector(${JSON.stringify(`${adapterId}.task.create`)}, connection => { calls[${JSON.stringify(connectorId)}] = (calls[${JSON.stringify(connectorId)}] ?? 0) + 1; return { kind: "action", adapterId: ${JSON.stringify(adapterId)}, connectionId: connection.connectionId, capabilityId: ${JSON.stringify(`${adapterId}.task.create`)} }; });`,
    `  return { declaration: ${JSON.stringify(declaration)}, bindings: { handlers: { ${JSON.stringify(`${adapterId}.task.query`)}: (input) => { const key = input && input.mutation ? "provider:mutation" : "provider:read"; calls[key] = (calls[key] ?? 0) + 1; return { objects: [] }; }${options.misplacedHandler ? `, ${JSON.stringify(`${adapterId}.task.create`)}: () => ({ objects: [] })` : ""} }, observations: {} } };`,
    "}",
    options.extraExport ? "export const leaked = true;" : "",
  ].join("\n");
}

export interface DeskFixturePackageOptions {
  packageId?: string;
  packageVersion?: string;
  adapterId?: string;
  deskSdkRange?: string;
  declaration?: object;
  readBindings?: unknown[];
  draftingBindings?: unknown[];
  setup?: object;
  backendSource?: string;
  backendEntry?: string;
  backendSha?: string;
  ui?: boolean;
  uiViews?: unknown[];
  extra?: Record<string, unknown>;
}

export function writeDeskFixturePackage(dir: string, options: DeskFixturePackageOptions = {}) {
  mkdirSync(dir, { recursive: true });
  const adapterId = options.adapterId ?? DESK_FIXTURE_ADAPTER;
  const declaration = options.declaration ?? deskFixtureDeclaration(adapterId);
  const source = options.backendSource ?? deskFixtureBackend(declaration as { adapterId: string });
  writeFileSync(join(dir, "backend.mjs"), source);
  const html = `<html><body>${adapterId}</body></html>`;
  const js = "console.log('desk');";
  const files = options.ui
    ? [
        { path: "app.html", sha256: sha256Bytes(html), mediaType: "text/html" },
        { path: "app.js", sha256: sha256Bytes(js), mediaType: "text/javascript" },
      ]
    : undefined;
  if (files) {
    writeFileSync(join(dir, "app.html"), html);
    writeFileSync(join(dir, "app.js"), js);
  }
  const manifest = {
    format: "desk-adapter-package/1",
    packageId: options.packageId ?? deskFixturePackageId(adapterId),
    packageVersion: options.packageVersion ?? "1.0.0",
    deskSdkRange: options.deskSdkRange ?? "^1.0.0",
    domainContractVersion: "1.0.0",
    backend: { entry: options.backendEntry ?? "backend.mjs", sha256: options.backendSha ?? sha256Bytes(source) },
    declaration,
    draftingBindings: options.draftingBindings ?? [deskFixtureDraftingBinding(adapterId)],
    readBindings: options.readBindings ?? [deskFixtureReadBinding(adapterId)],
    setup: options.setup ?? deskFixtureSetup(adapterId),
    ...(files ? { ui: { protocolVersion: "1.0.0", entry: "app.html", views: options.uiViews ?? [{ objectType: "task", view: "result" }], files } } : {}),
    ...options.extra,
  };
  writeFileSync(join(dir, "desk-adapter.json"), JSON.stringify(manifest, null, 2));
  return { dir, manifest, declaration };
}

export const deskFixtureArcPackage = (installPath: string, overrides: Partial<ArcPackage> = {}): ArcPackage => ({
  name: "desk-balance",
  version: "1.0.0",
  type: "component",
  status: "active",
  tier: "custom",
  repoUrl: DESK_FIXTURE_ORIGIN,
  installPath,
  ...overrides,
});

export const deskFixtureRunner = (packages: ArcPackage[]) => () => Promise.resolve({ stdout: JSON.stringify({ packages }), stderr: "", exitCode: 0 });

export const approvalOf = (candidate: Pick<DeskPackageCandidate, "packageId" | "origin" | "packageVersion" | "releaseDigest">): DeskAdapterApproval => ({
  packageId: candidate.packageId,
  origin: candidate.origin,
  packageVersion: candidate.packageVersion,
  releaseDigest: candidate.releaseDigest,
});

export async function openDeskFixtureStore(dir: string): Promise<{ engine: Harness; store: DeskGenerationStore }> {
  mkdirSync(dir, { recursive: true });
  const engine = await Harness.open(await openNodeSqliteStorage(join(dir, "durable.sqlite")), { registry: createRegistry(), models: createModels() }, BACKGROUND_CONTEXT);
  return { engine, store: new DeskGenerationStore(engine) };
}

export interface DeskTestWorkspace {
  tempDir(name: string): string;
  openStore(): Promise<{ store: DeskGenerationStore; dir: string }>;
  cleanup(): Promise<void>;
}

export function deskTestWorkspace(prefix = "cortex-desk"): DeskTestWorkspace {
  const roots: string[] = [];
  const engines: Harness[] = [];
  const tempDir = (name: string): string => {
    const dir = mkdtempSync(join(tmpdir(), `${prefix}-${name}-`));
    roots.push(dir);
    return dir;
  };
  const openStore = async (): Promise<{ store: DeskGenerationStore; dir: string }> => {
    const dir = tempDir("store");
    const { engine, store } = await openDeskFixtureStore(dir);
    engines.push(engine);
    return { store, dir };
  };
  const cleanup = async (): Promise<void> => {
    for (const engine of engines.splice(0)) await engine.close(BACKGROUND_CONTEXT);
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  };
  return { tempDir, openStore, cleanup };
}

export type DeskBackendCall = "dispatch" | "cancel" | "lookup" | "readback";

export interface DeskBackendFixtureOptions {
  declaration: { adapterId: string };
  actionCapabilityId?: string;
  writerOwner?: string;
  support?: object;
  omit?: readonly DeskBackendCall[];
  query?: { capabilityId: string; page: unknown };
  observation?: { capabilityId: string; batch: unknown; modes?: readonly string[]; orderingId?: string };
  readbackCapabilityId?: string;
  readbackRef?: unknown;
}

const BACKEND_AT = "2026-11-01T00:00:00.000Z";

export function deskBackendFixtureSource(options: DeskBackendFixtureOptions): string {
  const adapterId = options.declaration.adapterId;
  const omitted = new Set<string>(options.omit ?? []);
  const keep = (call: DeskBackendCall, source: string): string => (omitted.has(call) ? "" : source);
  const log = (name: string): string => `calls[${JSON.stringify(`${adapterId}:${name}`)}] = (calls[${JSON.stringify(`${adapterId}:${name}`)}] ?? 0) + 1;`;
  const ref = JSON.stringify({ adapterId, connectionId: "connection-example", objectType: "task", canonicalId: "task-example" });
  const connector = options.actionCapabilityId === undefined ? "" : `  host.registerConnector(${JSON.stringify(options.actionCapabilityId)}, connection => ({
    kind: "action", adapterId: connection.adapterId, connectionId: connection.connectionId, capabilityId: ${JSON.stringify(options.actionCapabilityId)},
    writerOwner: ${JSON.stringify(options.writerOwner ?? "package-owner")}, support: ${JSON.stringify(options.support ?? {})},
    ${keep("dispatch", `dispatch(request) { ${log("dispatch")} return { lifecycleVersion: "1.0.0", operationId: request.operationId, attemptId: request.attemptId, snapshotDigest: request.snapshot.digest, resultId: "result-succeeded", reportedAt: ${JSON.stringify(BACKEND_AT)}, result: { kind: "succeeded", output: { ref: ${ref} }, evidence: { kind: "effect", evidenceId: "evidence-example", observedAt: ${JSON.stringify(BACKEND_AT)}, ownerRequestId: request.ownerRequestId, receipt: { committed: true }, refs: [${ref}] } } }; },`)}
    ${keep("cancel", `cancel(request) { ${log("cancel")} return { lifecycleVersion: "1.0.0", operationId: request.operationId, checkedAt: ${JSON.stringify(BACKEND_AT)}, result: { kind: "unknown", reason: { code: "package_unknown", message: "No cancellation evidence." } } }; },`)}
    ${keep("lookup", `lookup(request) { ${log("lookup")} return { lifecycleVersion: "1.0.0", operationId: request.operationId, checkedAt: ${JSON.stringify(BACKEND_AT)}, result: { kind: "unknown", reason: { code: "package_unknown", message: "No historical evidence." } } }; },`)}
    ${keep("readback", `readbackCapabilityId: ${JSON.stringify(options.readbackCapabilityId ?? "")}, readback(request) { ${log("readback")} return { lifecycleVersion: "1.0.0", ref: request.ref, checkedAt: ${JSON.stringify(BACKEND_AT)}, provenance: { adapterId: request.ref.adapterId, connectionId: request.ref.connectionId, evidenceId: "package-readback" }, result: { kind: "deleted", evidenceId: "package-tombstone" } }; },`)}
  }));`;
  const handlers = options.query ? `${JSON.stringify(options.query.capabilityId)}: () => { ${log("query")} return ${JSON.stringify(options.query.page)}; }` : "";
  const observations = options.observation ? `${JSON.stringify(options.observation.capabilityId)}: { modes: ${JSON.stringify(options.observation.modes ?? ["poll", "subscription"])}, ${options.observation.orderingId ? `ordering: { id: ${JSON.stringify(options.observation.orderingId)}, compare: (left, right) => (left === right ? "same" : Number(left) < Number(right) ? "older" : "newer") },` : ""} fetch(request) { ${log("observation")} return ${JSON.stringify(options.observation.batch)}; } }` : "";
  return [
    "const calls = globalThis.__deskPackageCalls ??= {};",
    "export function createDeskAdapter(host) {",
    connector,
    `  return { declaration: ${JSON.stringify(options.declaration)}, bindings: { handlers: { ${handlers} }, observations: { ${observations} } } };`,
    "}",
  ].join("\n");
}
