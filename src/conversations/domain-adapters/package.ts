import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, resolve, sep } from "node:path";
import { satisfies, validRange } from "semver";
import { z } from "zod";
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { errorText } from "../../common/error-text";
import { verifyBundleSignature, type PluginSigningPosture } from "../../common/registry/bundle-signature";
import { canonicalJSON } from "../../common/registry/canonical-json";
import { containedRealPath, defaultArcListRunner, readArcPackageInventory, sha256Bytes, sha256FileAsync, type ArcListRunner } from "../../common/registry/arc-package-inventory";
import type { ArcPackage } from "../../common/types/plugin-manifest";
import type { DeskActionConnector, DeskAdapterBindings, DeskAdapterConnection, DeskAdapterDefinition, DeskAdapterHost, DeskConnectorFactory } from "../../desk-sdk";
import { DESK_ADAPTER_SDK_VERSION } from "../../desk-sdk/version";
import { DraftingBindingSchema, DraftingBindings, DRAFTING_BINDING_VERSION, type DraftingBinding } from "./drafting-binding";
import { DESK_ADAPTER_GENERATION_FORMAT, DeskAdapterGenerationSchema, DeskGenerationFencedError, DeskGenerationStore, DESK_UI_PROTOCOL_VERSION, FENCE_MESSAGE, generationId, type DeskAdapterGeneration, type DeskAdapterGenerationRecord, type DeskGenerationAdmission } from "./package-generation";
import { exactVersion, hex64, identifier } from "./package-primitives";
import { verifyReadBinding } from "./reads/bindings";
import { READ_BINDING_VERSION, ReadBindingSchema, type ReadBinding } from "./reads/types";
import { DOMAIN_ADAPTER_CONTRACT_VERSION, DomainAdapterRegistry } from "./registry";
import { failure, SchemaBundle, success } from "./schema-validation";
import { AdapterDeclarationSchema, SchemaRefSchema, type AdapterBindings, type AdapterDeclaration, type BoundaryError, type Result } from "./types";

export const DESK_ADAPTER_PACKAGE_FORMAT = "desk-adapter-package/1";
export const DESK_ADAPTER_PACKAGE_MANIFEST = "desk-adapter.json";
export const DESK_ADAPTER_SETUP_VERSION = "1.0.0";
export const DESK_ADAPTER_SDK_SPECIFIER = "@the-metafactory/cortex/desk-sdk";
export const DESK_ADAPTER_MAX_MANIFEST_BYTES = 512 * 1024;
export const DESK_ADAPTER_MAX_FILES = 256;
export const DESK_ADAPTER_MAX_FILE_BYTES = 8 * 1024 * 1024;
export const DESK_ADAPTER_MEDIA_TYPES = ["text/html", "text/javascript", "text/css", "image/png", "image/jpeg", "image/svg+xml", "image/webp", "font/woff", "font/woff2"] as const;
export const DESK_ADAPTER_BUILTIN_IMPORTS: ReadonlySet<string> = new Set(["node:crypto", "node:buffer", "node:util", "node:url", "node:zlib", "node:stream", "node:events", "node:string_decoder", "node:timers", "node:net", "node:tls"]);

const sdkRange = z.string().refine(value => validRange(value) !== null);
const namespaced = z.string().regex(/^[a-z0-9]+(?:[.-][a-z0-9]+)+$/);
const relativePath = z.string().min(1)
  .refine(value => !isAbsolute(value) && !/^[a-zA-Z]:[\\/]/.test(value))
  .refine(value => !value.includes("\0") && !value.includes("\\"))
  .refine(value => !value.split("/").includes("..") && !value.split("/").includes(""))
  .refine(value => !/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(value));
const setupSchema = z.object({ schemaId: identifier, version: exactVersion, schema: z.union([z.boolean(), z.record(z.string(), z.json())]) }).strict();
const authMethod = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("local") }).strict(),
  z.object({ kind: z.literal("token"), slots: z.array(z.object({ name: identifier, label: identifier, required: z.boolean() }).strict()).min(1) }).strict(),
  z.object({ kind: z.literal("broker"), brokerId: identifier }).strict(),
]);
const mediaType = z.enum(DESK_ADAPTER_MEDIA_TYPES);
const uiFile = z.object({ path: relativePath, sha256: hex64, mediaType }).strict();
const uiView = z.object({ objectType: identifier, view: z.literal("result") }).strict();
export const DeskAdapterSetupSchema = z.object({
  version: z.literal(DESK_ADAPTER_SETUP_VERSION),
  schemas: z.array(setupSchema),
  configurationSchemaRef: SchemaRefSchema,
  accountScopeSchemaRef: SchemaRefSchema,
  authMethods: z.array(authMethod).min(1),
}).strict();
export const DeskAdapterUiSchema = z.object({
  protocolVersion: z.literal(DESK_UI_PROTOCOL_VERSION),
  entry: relativePath,
  views: z.array(uiView),
  files: z.array(uiFile).min(1),
}).strict();
export const DeskAdapterBackendSchema = z.object({
  entry: relativePath.refine(value => value.endsWith(".mjs")),
  sha256: hex64,
}).strict();
export const DeskAdapterPackageSchema = z.object({
  format: z.literal(DESK_ADAPTER_PACKAGE_FORMAT),
  packageId: namespaced,
  packageVersion: exactVersion,
  deskSdkRange: sdkRange,
  domainContractVersion: z.literal(DOMAIN_ADAPTER_CONTRACT_VERSION),
  backend: DeskAdapterBackendSchema,
  declaration: AdapterDeclarationSchema,
  draftingBindings: z.array(DraftingBindingSchema),
  readBindings: z.array(ReadBindingSchema),
  setup: DeskAdapterSetupSchema,
  ui: DeskAdapterUiSchema.optional(),
}).strict();
export type DeskAdapterPackage = z.infer<typeof DeskAdapterPackageSchema>;
export type DeskAdapterSetup = z.infer<typeof DeskAdapterSetupSchema>;
export type DeskAdapterUi = z.infer<typeof DeskAdapterUiSchema>;
export type DeskPackageSource = "bundled" | "installed";

export interface DeskPackageItem {
  source: DeskPackageSource;
  root: string;
  origin: string;
  arcPackage?: ArcPackage;
}

export interface DeskAdapterApproval {
  packageId: string;
  origin: string;
  packageVersion: string;
  releaseDigest: string;
}

export interface DeskAdapterSignaturePolicy {
  posture: PluginSigningPosture;
  trustedSigners: ReadonlySet<string>;
}

export type DeskPackageCandidateState = { state: "installable" } | { state: "unavailable"; code: string; message: string };
export type DeskPackageTrust = { state: "trusted"; basis: "bundled" | "principal" } | { state: "untrusted"; code: "approval_missing"; message: string };
export type DeskAdapterAvailability = { state: "available" } | { state: "unavailable"; code: string; message: string };

export interface DeskPackageCandidate {
  packageId: string;
  packageVersion: string;
  adapterId: string;
  origin: string;
  source: DeskPackageSource;
  packageRoot: string;
  manifestSha256: string;
  backendPath: string;
  releaseDigest: string;
  manifest: DeskAdapterPackage;
  ui?: DeskAdapterUi;
  state: DeskPackageCandidateState;
  trust: DeskPackageTrust;
}

export interface DeskPackageIssue {
  packageId?: string;
  packageRoot?: string;
  stage: string;
  code: string;
  message: string;
}

export interface DeskPackageDiscovery {
  candidates: DeskPackageCandidate[];
  issues: DeskPackageIssue[];
}

export interface DeskPackageInstall {
  packageId: string;
  packageVersion: string;
  adapterId: string;
  origin: string;
  releaseDigest: string;
}

export interface DeskPackageLoaderOptions {
  bundledPackages?: readonly string[];
  installedRoots?: readonly string[];
  runner?: ArcListRunner;
  approvals?: readonly DeskAdapterApproval[];
  signature?: DeskAdapterSignaturePolicy;
  store?: DeskGenerationStore;
  now?: () => Date;
}

export interface DeskAdapterCatalogEntry {
  generation: DeskAdapterGeneration;
  declaration: AdapterDeclaration;
  readBindings: readonly ReadBinding[];
  draftingBindings: readonly DraftingBinding[];
  ui?: DeskAdapterUi;
  availability: DeskAdapterAvailability;
}

export interface DeskUiPublication {
  generation: DeskAdapterGeneration;
  ui: DeskAdapterUi;
  packageRoot: string;
  capabilityIds: string[];
}

interface PublishedAdapter {
  packageId: string;
  adapterId: string;
  candidate: DeskPackageCandidate;
  definition: DeskAdapterDefinition;
  connectors: ReadonlyMap<string, DeskConnectorFactory>;
  generation: DeskAdapterGeneration;
  readBindings: readonly ReadBinding[];
  draftingBindings: readonly DraftingBinding[];
  ui?: DeskAdapterUi;
}

interface ComposedAdapters {
  registry: DomainAdapterRegistry;
  drafting: DraftingBindings;
  reads: ReadonlyMap<string, ReadBinding>;
}

interface LoaderState extends ComposedAdapters {
  published: ReadonlyMap<string, PublishedAdapter>;
  availability: ReadonlyMap<string, DeskAdapterAvailability>;
  diagnostics: ReadonlyMap<string, DeskPackageIssue[]>;
}

const emptyState = (): LoaderState => {
  const registry = new DomainAdapterRegistry();
  return { registry, drafting: new DraftingBindings(registry), reads: new Map(), published: new Map(), availability: new Map(), diagnostics: new Map() };
};
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const readKey = (binding: ReadBinding): string => JSON.stringify([binding.adapterId, binding.capabilityId]);
const unavailable = (code: string, message: string): DeskPackageCandidateState => ({ state: "unavailable", code, message });
const sameDeclaration = (left: AdapterDeclaration, right: AdapterDeclaration): boolean => canonicalJSON(left) === canonicalJSON(right);
const fileDigest = async (path: string): Promise<string | null> => {
  try {
    return await sha256FileAsync(path);
  } catch {
    return null;
  }
};
const registryBindings = (bindings: DeskAdapterBindings): AdapterBindings => ({
  handlers: Object.fromEntries(Object.entries(bindings.handlers)),
  observations: Object.fromEntries(Object.entries(bindings.observations)),
});
const versions = (manifest: DeskAdapterPackage): { domainContractVersion: string; uiProtocolVersion?: string } => ({
  domainContractVersion: manifest.domainContractVersion,
  ...(manifest.ui ? { uiProtocolVersion: manifest.ui.protocolVersion } : {}),
});

function versionProblem(raw: unknown): BoundaryError | null {
  if (!isRecord(raw)) return { code: "invalid_manifest", message: "The package manifest is not a JSON object." };
  if (raw.format !== DESK_ADAPTER_PACKAGE_FORMAT) return { code: "unsupported_format", message: "The package format is not desk-adapter-package/1." };
  if (raw.domainContractVersion !== DOMAIN_ADAPTER_CONTRACT_VERSION) return { code: "unsupported_contract", message: "The domain contract version is not supported." };
  if (isRecord(raw.setup) && raw.setup.version !== DESK_ADAPTER_SETUP_VERSION) return { code: "unsupported_setup_version", message: "The setup descriptor version is not supported." };
  if (isRecord(raw.ui) && raw.ui.protocolVersion !== DESK_UI_PROTOCOL_VERSION) return { code: "unsupported_ui_protocol", message: "The UI protocol version is not supported." };
  if (Array.isArray(raw.readBindings) && raw.readBindings.some(binding => !isRecord(binding) || binding.version !== READ_BINDING_VERSION)) {
    return { code: "unsupported_binding_version", message: "A read binding version is not supported." };
  }
  if (Array.isArray(raw.draftingBindings) && raw.draftingBindings.some(binding => !isRecord(binding) || binding.bindingVersion !== DRAFTING_BINDING_VERSION)) {
    return { code: "unsupported_binding_version", message: "A drafting binding version is not supported." };
  }
  return null;
}

function importSpecifiers(source: string): string[] {
  const patterns = [
    /(?:^|[;{}\n])\s*(?:import|export)\s+(?:[^;'"]*?\s+from\s+)?["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
  ];
  const found = new Set<string>();
  for (const pattern of patterns) for (const match of source.matchAll(pattern)) if (match[1]) found.add(match[1]);
  return [...found];
}

export function deskPackageImportProblem(source: string): BoundaryError | null {
  if (/\beval\s*\(/.test(source) || /\bnew\s+Function\s*\(/.test(source)) return { code: "invalid_import", message: "The backend bundle may not evaluate source at runtime." };
  if (/\bimport\s*\(\s*(?!["'])/.test(source)) return { code: "invalid_import", message: "The backend bundle may not use a computed dynamic import." };
  const refused = importSpecifiers(source).filter(specifier => specifier !== DESK_ADAPTER_SDK_SPECIFIER && !DESK_ADAPTER_BUILTIN_IMPORTS.has(specifier));
  if (refused.length > 0) return { code: "invalid_import", message: `The backend bundle imports an unapproved module: ${refused.join(", ")}.` };
  return null;
}

async function verifyContainedFile(root: string, path: string, digest: string, limit: number): Promise<Result<string>> {
  const candidate = resolve(root, path);
  if (!candidate.startsWith(root + sep)) return failure("containment_escape", "A package file path escapes the package directory.");
  let stat;
  try {
    stat = lstatSync(candidate);
  } catch {
    return failure("missing_file", `A declared package file is missing: ${path}.`);
  }
  if (stat.isSymbolicLink()) return failure("containment_escape", "A package file path is a symlink and cannot be verified in place.");
  if (!stat.isFile()) return failure("missing_file", `A declared package file is not a regular file: ${path}.`);
  const contained = containedRealPath(root, candidate);
  if (!contained.ok) return failure("containment_escape", "A package file resolves outside the package directory.");
  if (stat.size > limit) return failure("file_too_large", `A package file exceeds the host size bound: ${path}.`);
  let observed: string;
  try {
    observed = await sha256FileAsync(contained.path);
  } catch {
    return failure("missing_file", `A declared package file could not be read: ${path}.`);
  }
  if (observed !== digest) return failure("digest_mismatch", `A package file digest does not match the manifest: ${path}.`);
  return success(contained.path);
}

async function uiProblem(root: string, manifest: DeskAdapterPackage): Promise<BoundaryError | null> {
  if (!manifest.ui) return null;
  const assetFiles = manifest.ui.files;
  if (assetFiles.length > DESK_ADAPTER_MAX_FILES) return { code: "too_many_files", message: "The package declares more asset files than the host accepts." };
  const paths = assetFiles.map(file => file.path);
  if (new Set(paths).size !== paths.length) return { code: "duplicate_id", message: "The UI asset paths are not unique." };
  if (!paths.includes(manifest.ui.entry)) return { code: "missing_file", message: "The declared UI entry is not listed in the package files." };
  if (assetFiles.find(file => file.path === manifest.ui?.entry)?.mediaType !== "text/html") return { code: "invalid_ui", message: "The UI entry must be an HTML asset." };
  const objectTypes = new Set(manifest.declaration.objectTypes.map(object => object.objectType));
  if (manifest.ui.views.some(view => !objectTypes.has(view.objectType))) return { code: "invalid_ui", message: "A UI view names an object type the declaration does not define." };
  for (const file of assetFiles) {
    const verified = await verifyContainedFile(root, file.path, file.sha256, DESK_ADAPTER_MAX_FILE_BYTES);
    if (!verified.ok) return verified.error;
  }
  return null;
}

function setupProblem(manifest: DeskAdapterPackage): BoundaryError | null {
  const keys = manifest.setup.schemas.map(schema => JSON.stringify([schema.schemaId, schema.version]));
  if (new Set(keys).size !== keys.length) return { code: "invalid_setup", message: "Setup schema identities are duplicated." };
  let bundle: SchemaBundle;
  try {
    bundle = new SchemaBundle(manifest.setup.schemas);
  } catch {
    return { code: "invalid_setup_schema", message: "The setup schemas are not a valid immutable bundle." };
  }
  for (const ref of [manifest.setup.configurationSchemaRef, manifest.setup.accountScopeSchemaRef]) {
    if (!bundle.validator(ref)) return { code: "invalid_setup_schema", message: "A setup schema reference does not resolve to an exact bundled schema." };
    const document = manifest.setup.schemas.find(schema => schema.schemaId === ref.schemaId && schema.version === ref.version)?.schema;
    if (typeof document !== "object" || Array.isArray(document)) return { code: "invalid_setup_schema", message: "Setup schemas must be object documents." };
  }
  const authKeys = manifest.setup.authMethods.map(method => canonicalJSON(method));
  if (new Set(authKeys).size !== authKeys.length) return { code: "invalid_setup", message: "Setup authentication alternatives are duplicated." };
  for (const method of manifest.setup.authMethods) {
    if (method.kind !== "token") continue;
    const names = method.slots.map(slot => slot.name);
    if (new Set(names).size !== names.length) return { code: "invalid_setup", message: "Token slot names must be unique." };
  }
  return null;
}

export function releaseDigest(manifest: DeskAdapterPackage, manifestSha256: string): string {
  const sortBy = <T>(items: readonly T[], key: (item: T) => string): T[] => [...items].sort((left, right) => key(left).localeCompare(key(right)));
  const identity = {
    format: manifest.format,
    packageId: manifest.packageId,
    packageVersion: manifest.packageVersion,
    deskSdkRange: manifest.deskSdkRange,
    domainContractVersion: manifest.domainContractVersion,
    manifestSha256,
    backend: manifest.backend,
    declaration: manifest.declaration,
    draftingBindings: sortBy(manifest.draftingBindings, binding => JSON.stringify([binding.adapterId, binding.capabilityId, binding.inputSchemaRef.schemaId, binding.inputSchemaRef.version])),
    readBindings: sortBy(manifest.readBindings, binding => JSON.stringify([binding.adapterId, binding.capabilityId, binding.mode, binding.objectType])),
    setup: { ...manifest.setup, schemas: sortBy(manifest.setup.schemas, schema => JSON.stringify([schema.schemaId, schema.version])) },
    ui: manifest.ui ? { ...manifest.ui, views: sortBy(manifest.ui.views, view => JSON.stringify([view.objectType, view.view])), files: sortBy(manifest.ui.files, file => file.path) } : null,
  };
  return sha256Bytes(canonicalJSON(identity));
}

function stagingBindings(declaration: AdapterDeclaration): AdapterBindings {
  return {
    handlers: Object.fromEntries(declaration.capabilities.filter(capability => capability.kind === "query").map(capability => [capability.capabilityId, () => undefined])),
    observations: Object.fromEntries(declaration.capabilities.filter(capability => capability.kind === "observation").map(capability => [capability.capabilityId, {}])),
  };
}

function connectorProblem(declaration: AdapterDeclaration, connectors: ReadonlyMap<string, DeskConnectorFactory>): BoundaryError | null {
  const actions = new Set(declaration.capabilities.filter(capability => capability.kind === "action").map(capability => capability.capabilityId));
  const exact = actions.size === connectors.size
    && [...actions].every(capabilityId => typeof connectors.get(capabilityId) === "function")
    && [...connectors.keys()].every(capabilityId => actions.has(capabilityId));
  return exact ? null : { code: "module_incompatible", message: "Every action capability needs exactly one registered connector, and no other capability may register one." };
}

function generationFor(acting: DeskPackageCandidate, selectedAt: string): DeskAdapterGeneration {
  return DeskAdapterGenerationSchema.parse({
    format: DESK_ADAPTER_GENERATION_FORMAT,
    generationId: generationId({ packageId: acting.packageId, packageVersion: acting.packageVersion, releaseDigest: acting.releaseDigest }),
    packageId: acting.packageId,
    packageVersion: acting.packageVersion,
    adapterId: acting.adapterId,
    origin: acting.origin,
    releaseDigest: acting.releaseDigest,
    deskSdkRange: acting.manifest.deskSdkRange,
    ...versions(acting.manifest),
    selectedAt,
  });
}

function relationshipTargets(declaration: AdapterDeclaration): string[] {
  const targets = declaration.objectTypes.flatMap(object => object.relationships.map(relation => relation.targetAdapterId));
  return [...new Set(targets)];
}

interface StageEntry {
  readonly adapterId: string;
  readonly candidate: DeskPackageCandidate;
  readonly declaration: AdapterDeclaration;
  readonly bindings: AdapterBindings;
  readonly draftingBindings: readonly DraftingBinding[];
  readonly readBindings: readonly ReadBinding[];
}

interface StagedRegistry {
  readonly registry: DomainAdapterRegistry;
  readonly drafting: DraftingBindings;
  readonly reads: ReadonlyMap<string, ReadBinding>;
  readonly failures: ReadonlyMap<StageEntry, BoundaryError>;
}

const registrationConflict: BoundaryError = { code: "publication_rejected", message: "Adapter declarations cannot be registered together; a relationship target or identity conflicts." };

interface Settlement<T> {
  readonly failures: ReadonlyMap<T, BoundaryError>;
  readonly pending: readonly T[];
}

async function settle<T>(
  items: readonly T[],
  attempt: (item: T) => Result<unknown> | Promise<Result<unknown>>,
  ready: (item: T) => boolean = () => true,
): Promise<Settlement<T>> {
  const pending = [...items];
  const failures = new Map<T, BoundaryError>();
  let progress = true;
  while (pending.length > 0 && progress) {
    progress = false;
    for (const item of [...pending]) {
      if (!ready(item)) continue;
      const result = await attempt(item);
      if (!result.ok) {
        failures.set(item, result.error);
        continue;
      }
      pending.splice(pending.indexOf(item), 1);
      failures.delete(item);
      progress = true;
    }
  }
  return { failures, pending };
}

async function stageRegistry(entries: readonly StageEntry[]): Promise<StagedRegistry> {
  const registry = new DomainAdapterRegistry();
  const failures = new Map((await settle(entries, entry => registry.register(entry.declaration, entry.bindings))).failures);
  const drafting = new DraftingBindings(registry);
  for (const entry of entries) {
    if (failures.has(entry)) continue;
    for (const binding of entry.draftingBindings) {
      const registered = drafting.register(binding);
      if (!registered.ok) {
        failures.set(entry, registered.error);
        break;
      }
    }
  }
  const reads = new Map<string, ReadBinding>();
  for (const entry of entries) {
    if (failures.has(entry)) continue;
    for (const binding of entry.readBindings) {
      const verified = verifyReadBinding(registry, binding);
      if (!verified.ok) {
        failures.set(entry, verified.error);
        break;
      }
      if (reads.has(readKey(binding))) {
        failures.set(entry, { code: "duplicate_binding", message: "A read binding is declared twice." });
        break;
      }
      reads.set(readKey(binding), binding);
    }
  }
  return { registry, drafting, reads, failures };
}

async function compose(published: ReadonlyMap<string, PublishedAdapter>): Promise<Result<ComposedAdapters>> {
  const staged = await stageRegistry([...published.values()].map(adapter => ({
    adapterId: adapter.adapterId,
    candidate: adapter.candidate,
    declaration: adapter.definition.declaration,
    bindings: registryBindings(adapter.definition.bindings),
    draftingBindings: adapter.draftingBindings,
    readBindings: adapter.readBindings,
  })));
  if (staged.failures.size > 0) {
    const error = [...staged.failures.values()][0] ?? registrationConflict;
    return failure(error.code, error.message);
  }
  return success({ registry: staged.registry, drafting: staged.drafting, reads: staged.reads });
}

export class DeskPackageLoader {
  private state: LoaderState = emptyState();
  private readonly options: DeskPackageLoaderOptions;
  private readonly context: Context;

  constructor(options: DeskPackageLoaderOptions = {}, context: Context = BACKGROUND_CONTEXT) {
    this.options = options;
    this.context = context;
  }

  private get store(): DeskGenerationStore | null {
    return this.options.store ?? null;
  }

  private now(): string {
    return (this.options.now?.() ?? new Date()).toISOString();
  }

  private issue(candidate: DeskPackageCandidate, code: string, message: string): DeskPackageCandidate {
    candidate.state = unavailable(code, message);
    return candidate;
  }

  private async verifyStructural(item: DeskPackageItem): Promise<DeskPackageCandidate | DeskPackageIssue> {
    let realRoot: string;
    try {
      realRoot = realpathSync(item.root);
    } catch (error) {
      return { stage: "package_root", code: "unreadable", message: `The package directory is not readable: ${errorText(error)}` };
    }
    const manifestPath = join(realRoot, DESK_ADAPTER_PACKAGE_MANIFEST);
    let stat;
    try {
      stat = lstatSync(manifestPath);
    } catch {
      return { stage: "manifest", code: "missing_manifest", message: `No ${DESK_ADAPTER_PACKAGE_MANIFEST} exists in the package directory.` };
    }
    if (stat.isSymbolicLink()) return { stage: "manifest", code: "containment_escape", message: "The package manifest is a symlink and cannot be verified in place." };
    if (!stat.isFile()) return { stage: "manifest", code: "missing_manifest", message: "The package manifest is not a regular file." };
    if (stat.size > DESK_ADAPTER_MAX_MANIFEST_BYTES) return { stage: "manifest", code: "manifest_too_large", message: "The package manifest exceeds the host size bound." };
    let text: string;
    try {
      text = readFileSync(manifestPath, "utf8");
    } catch (error) {
      return { stage: "manifest", code: "unreadable", message: `The package manifest could not be read: ${errorText(error)}` };
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      return { stage: "manifest", code: "invalid_manifest", message: "The package manifest is not valid JSON." };
    }
    const problem = versionProblem(raw);
    if (problem) return { stage: "manifest", code: problem.code, message: problem.message };
    const parsed = DeskAdapterPackageSchema.safeParse(raw);
    if (!parsed.success) {
      return { stage: "manifest", code: "invalid_manifest", message: `The package manifest does not match the strict contract: ${parsed.error.issues.map(issue => `${issue.path.join(".") || "(root)"}: ${issue.message}`).join("; ")}` };
    }
    const manifest = parsed.data;
    const manifestSha256 = sha256Bytes(text);
    const digest = releaseDigest(manifest, manifestSha256);
    const candidate: DeskPackageCandidate = {
      packageId: manifest.packageId,
      packageVersion: manifest.packageVersion,
      adapterId: manifest.declaration.adapterId,
      origin: item.origin,
      source: item.source,
      packageRoot: realRoot,
      manifestSha256,
      backendPath: "",
      releaseDigest: digest,
      manifest,
      ...(manifest.ui ? { ui: manifest.ui } : {}),
      state: { state: "installable" },
      trust: { state: "untrusted", code: "approval_missing", message: "The installed package has no principal approval for this origin, version and content digest." },
    };
    if (!satisfies(DESK_ADAPTER_SDK_VERSION, manifest.deskSdkRange)) return this.issue(candidate, "incompatible_sdk", "The package does not support the running Desk adapter SDK version.");
    const backend = await verifyContainedFile(realRoot, manifest.backend.entry, manifest.backend.sha256, DESK_ADAPTER_MAX_FILE_BYTES);
    if (!backend.ok) return this.issue(candidate, backend.error.code, backend.error.message);
    candidate.backendPath = backend.value;
    let source: string;
    try {
      source = readFileSync(backend.value, "utf8");
    } catch {
      return this.issue(candidate, "missing_file", "The backend entry could not be read.");
    }
    const importProblem = deskPackageImportProblem(source);
    if (importProblem) return this.issue(candidate, importProblem.code, importProblem.message);
    const setupError = setupProblem(manifest);
    if (setupError) return this.issue(candidate, setupError.code, setupError.message);
    const uiError = await uiProblem(realRoot, manifest);
    if (uiError) return this.issue(candidate, uiError.code, uiError.message);
    return candidate;
  }

  private async trust(candidate: DeskPackageCandidate, approvals: readonly DeskAdapterApproval[], used: Set<DeskAdapterApproval>, signature: DeskAdapterSignaturePolicy | undefined): Promise<DeskPackageCandidate> {
    if (signature && signature.posture !== "off") {
      const verified = await verifyBundleSignature({ installPath: candidate.packageRoot, trustedSigners: signature.trustedSigners });
      if (!verified.ok && signature.posture === "enforce") return this.issue(candidate, `signature_${verified.stage}`, "The package signature is missing, invalid or untrusted.");
    }
    if (candidate.source === "bundled") {
      candidate.trust = { state: "trusted", basis: "bundled" };
      return candidate;
    }
    const approval = approvals.find(item => item.packageId === candidate.packageId && item.origin.trim() === candidate.origin && item.packageVersion === candidate.packageVersion && item.releaseDigest === candidate.releaseDigest);
    if (approval) {
      used.add(approval);
      candidate.trust = { state: "trusted", basis: "principal" };
    }
    return candidate;
  }

  private async packageItems(issues: DeskPackageIssue[]): Promise<DeskPackageItem[]> {
    const items: DeskPackageItem[] = [];
    for (const root of this.options.bundledPackages ?? []) items.push({ source: "bundled", root, origin: "bundled" });
    if ((this.options.installedRoots ?? []).length === 0) return items;
    const roots = (this.options.installedRoots ?? []).flatMap(root => {
      try {
        return [realpathSync(root)];
      } catch {
        return [];
      }
    });
    const inventory = roots.length === 0 ? { packages: [], issues: [] } : await readArcPackageInventory(this.options.runner ?? defaultArcListRunner);
    for (const inventoryIssue of inventory.issues) issues.push({ stage: inventoryIssue.stage, code: "arc_inventory", message: inventoryIssue.reason });
    for (const arcPackage of inventory.packages) {
      if (arcPackage.status !== "active") continue;
      if (arcPackage.repoUrl.trim().length === 0) {
        issues.push({ packageId: arcPackage.name, stage: "identity", code: "origin_missing", message: `The arc package ${arcPackage.name} has no origin and cannot be approved.` });
        continue;
      }
      const contained = roots.map(root => containedRealPath(root, arcPackage.installPath)).find((result): result is { ok: true; path: string } => result.ok);
      if (!contained) {
        issues.push({ packageId: arcPackage.name, stage: "containment", code: "containment_escape", message: `The arc install path for ${arcPackage.name} is not inside an approved package root.` });
        continue;
      }
      items.push({ source: "installed", root: contained.path, origin: arcPackage.repoUrl.trim(), arcPackage });
    }
    return items;
  }

  private async verifyItems(items: DeskPackageItem[], issues: DeskPackageIssue[]): Promise<DeskPackageCandidate[]> {
    const seen = new Set<string>();
    const candidates: DeskPackageCandidate[] = [];
    for (const item of items) {
      let verified: DeskPackageCandidate | DeskPackageIssue;
      try {
        verified = await this.verifyStructural(item);
      } catch (error) {
        verified = { stage: "manifest", code: "invalid_manifest", message: `The package manifest could not be verified: ${errorText(error)}` };
      }
      if ("stage" in verified) {
        issues.push({ ...verified, ...(item.arcPackage ? { packageId: item.arcPackage.name } : {}), packageRoot: item.root });
        continue;
      }
      if (seen.has(verified.packageRoot)) continue;
      seen.add(verified.packageRoot);
      candidates.push(verified);
    }
    return candidates;
  }

  private async applyTrust(candidates: DeskPackageCandidate[], issues: DeskPackageIssue[]): Promise<void> {
    const usedApprovals = new Set<DeskAdapterApproval>();
    for (const candidate of candidates) await this.trust(candidate, this.options.approvals ?? [], usedApprovals, this.options.signature);
    for (const approval of this.options.approvals ?? []) {
      if (!usedApprovals.has(approval)) issues.push({ packageId: approval.packageId, stage: "approval", code: "approval_unmatched", message: "An approval does not name any discovered release with that origin, version and digest." });
    }
  }

  private markDuplicates(candidates: DeskPackageCandidate[]): void {
    const groups = new Map<string, DeskPackageCandidate[]>();
    const add = (key: string, candidate: DeskPackageCandidate): void => {
      groups.set(key, [...(groups.get(key) ?? []), candidate]);
    };
    for (const candidate of candidates) {
      if (candidate.trust.state !== "trusted") continue;
      add(`package:${candidate.packageId}`, candidate);
      add(`adapter:${candidate.adapterId}`, candidate);
    }
    for (const group of groups.values()) {
      if (group.length < 2) continue;
      for (const candidate of group) this.issue(candidate, "duplicate_identity", `The package identity ${candidate.packageId} or adapter ${candidate.adapterId} is discovered more than once.`);
    }
  }

  async discover(): Promise<DeskPackageDiscovery> {
    const issues: DeskPackageIssue[] = [];
    const candidates = await this.verifyItems(await this.packageItems(issues), issues);
    await this.applyTrust(candidates, issues);
    this.markDuplicates(candidates);
    const entryFor = (candidate: DeskPackageCandidate): StageEntry => ({
      adapterId: candidate.adapterId,
      candidate,
      declaration: candidate.manifest.declaration,
      bindings: stagingBindings(candidate.manifest.declaration),
      draftingBindings: candidate.manifest.draftingBindings,
      readBindings: candidate.manifest.readBindings,
    });
    const installable = candidates.filter(candidate => candidate.state.state === "installable");
    await this.settleInstallable(installable.map(entryFor));
    return { candidates: candidates.sort((left, right) => left.packageId.localeCompare(right.packageId)), issues };
  }

  private async settleInstallable(entries: readonly StageEntry[]): Promise<void> {
    const staged = await stageRegistry(entries);
    for (const [entry] of staged.failures) {
      const backdrop = entries.filter(other => other === entry || (
        other.candidate.packageId !== entry.candidate.packageId
        && other.adapterId !== entry.adapterId
        && (entry.candidate.trust.state !== "trusted" || other.candidate.trust.state === "trusted")
      ));
      const alone = (await stageRegistry(backdrop)).failures.get(entry);
      if (alone) this.issue(entry.candidate, alone.code, alone.message);
    }
  }

  private candidate(discovery: DeskPackageDiscovery, packageId: string, expected?: { releaseDigest?: string }): Result<DeskPackageCandidate> {
    const matches = discovery.candidates.filter(item => item.packageId === packageId);
    if (matches.length === 0) return failure("unknown_package", "No discovered package carries that identity.");
    const trusted = matches.filter(item => item.trust.state === "trusted");
    const chosen = trusted.length > 0 ? trusted : matches;
    if (chosen.length !== 1) return failure("duplicate_identity", "More than one discovered package carries that identity.");
    const [candidate] = chosen as [DeskPackageCandidate];
    if (expected?.releaseDigest && expected.releaseDigest !== candidate.releaseDigest) return failure("release_mismatch", "The approved release digest does not match the discovered package content.");
    if (candidate.state.state !== "installable") return failure(candidate.state.code, candidate.state.message);
    return success(candidate);
  }

  async install(packageId: string, expected?: { releaseDigest?: string }): Promise<Result<DeskPackageInstall>> {
    const candidate = this.candidate(await this.discover(), packageId, expected);
    if (!candidate.ok) return candidate;
    return success({ packageId: candidate.value.packageId, packageVersion: candidate.value.packageVersion, adapterId: candidate.value.adapterId, origin: candidate.value.origin, releaseDigest: candidate.value.releaseDigest });
  }

  async activate(packageId: string, expected?: { releaseDigest?: string }): Promise<Result<DeskAdapterGeneration>> {
    const candidate = this.candidate(await this.discover(), packageId, expected);
    if (!candidate.ok) return candidate;
    if (candidate.value.trust.state !== "trusted") {
      return failure(candidate.value.trust.code, "The installed package has no principal approval for this origin, version and content digest.");
    }
    return this.publish(candidate.value);
  }

  private async prepare(acting: DeskPackageCandidate): Promise<Result<PublishedAdapter>> {
    const manifestDigest = await fileDigest(join(acting.packageRoot, DESK_ADAPTER_PACKAGE_MANIFEST));
    if (acting.manifestSha256 !== manifestDigest) return failure("digest_mismatch", "The package manifest changed after discovery.");
    const backendDigest = await fileDigest(acting.backendPath);
    if (backendDigest !== acting.manifest.backend.sha256) return failure("digest_mismatch", "The backend entry changed after discovery.");
    const existing = this.state.published.get(acting.adapterId);
    if (existing && existing.packageId !== acting.packageId) return failure("duplicate_identity", "Another package already owns this adapter identity.");
    let namespace: Record<string, unknown>;
    try {
      namespace = await import(`${acting.backendPath}?desk-generation=${acting.releaseDigest}`) as Record<string, unknown>;
    } catch (error) {
      return failure("module_throwing", `The backend module threw while loading: ${errorText(error)}`);
    }
    const extra = Object.keys(namespace).filter(name => name !== "createDeskAdapter");
    if (extra.length > 0) return failure("module_incompatible", "The backend module exports more than createDeskAdapter(host).");
    const create = namespace.createDeskAdapter;
    if (typeof create !== "function") return failure("module_incompatible", "The backend module does not export createDeskAdapter(host).");
    const connectors = new Map<string, DeskConnectorFactory>();
    const host: DeskAdapterHost = {
      sdkVersion: DESK_ADAPTER_SDK_VERSION,
      registerConnector(capabilityId, factory) {
        if (connectors.has(capabilityId)) throw new Error(`Connector ${capabilityId} is already registered.`);
        connectors.set(capabilityId, factory);
      },
    };
    let definition: DeskAdapterDefinition;
    try {
      definition = (create as (host: DeskAdapterHost) => DeskAdapterDefinition)(host);
    } catch (error) {
      return failure("module_throwing", `The backend module threw while creating the adapter: ${errorText(error)}`);
    }
    if (!isRecord(definition) || !isRecord(definition.declaration) || !isRecord(definition.bindings)) return failure("module_incompatible", "createDeskAdapter did not return a declaration and bindings.");
    const declared = AdapterDeclarationSchema.safeParse(definition.declaration);
    if (!declared.success || !sameDeclaration(declared.data, acting.manifest.declaration)) return failure("module_incompatible", "The module declaration does not match the verified manifest.");
    const connectorError = connectorProblem(acting.manifest.declaration, connectors);
    if (connectorError) return failure(connectorError.code, connectorError.message);
    const generation = generationFor(acting, this.now());
    return success({
      packageId: acting.packageId,
      adapterId: acting.adapterId,
      candidate: acting,
      definition: { declaration: declared.data, bindings: definition.bindings },
      connectors,
      generation,
      readBindings: acting.manifest.readBindings,
      draftingBindings: acting.manifest.draftingBindings,
      ...(acting.ui ? { ui: acting.ui } : {}),
    });
  }

  private async publishPrepared(prepared: readonly PublishedAdapter[], options: { refuseFenced?: boolean } = {}): Promise<Result<DeskAdapterGeneration[]>> {
    const store = this.store;
    if (!store) return failure("generation_store_unavailable", "Activation requires the durable generation store.");
    const published = new Map(this.state.published);
    for (const adapter of prepared) {
      const existing = published.get(adapter.adapterId);
      if (existing && existing.packageId !== adapter.packageId) return failure("duplicate_identity", "Another package already owns this adapter identity.");
      published.set(adapter.adapterId, adapter);
    }
    const composed = await compose(published);
    if (!composed.ok) return failure(composed.error.code, composed.error.message);
    for (const adapter of prepared) {
      try {
        await store.select(adapter.generation, options);
      } catch (error) {
        if (error instanceof DeskGenerationFencedError) return failure(error.code, FENCE_MESSAGE[error.code]);
        throw error;
      }
    }
    const availability = new Map(this.state.availability);
    const diagnostics = new Map(this.state.diagnostics);
    for (const adapter of prepared) {
      availability.delete(adapter.adapterId);
      diagnostics.delete(adapter.adapterId);
    }
    this.state = { ...composed.value, published, availability, diagnostics };
    return success(prepared.map(adapter => adapter.generation));
  }

  private async publish(candidate: DeskPackageCandidate, options: { refuseFenced?: boolean } = {}): Promise<Result<DeskAdapterGeneration>> {
    const prepared = await this.prepare(candidate);
    if (!prepared.ok) return this.failed(candidate, prepared.error);
    const published = await this.publishPrepared([prepared.value], options);
    if (!published.ok) return this.failed(candidate, published.error);
    const [generation] = published.value as [DeskAdapterGeneration];
    return success(generation);
  }

  private failed(candidate: DeskPackageCandidate, reason: BoundaryError): Result<never> {
    const availability = new Map(this.state.availability);
    if (!this.state.published.has(candidate.adapterId)) availability.set(candidate.adapterId, { state: "unavailable", code: reason.code, message: reason.message });
    const diagnostics = new Map(this.state.diagnostics);
    diagnostics.set(candidate.adapterId, [{ packageId: candidate.packageId, packageRoot: candidate.packageRoot, stage: "publication", code: reason.code, message: reason.message }]);
    this.state = { ...this.state, availability, diagnostics };
    return failure(reason.code, reason.message);
  }

  async boot(): Promise<DeskPackageDiscovery> {
    const discovery = await this.discover();
    const store = this.store;
    if (!store) return discovery;
    const records = new Map((await store.all()).map(record => [record.adapterId, record]));
    const prepared: PublishedAdapter[] = [];
    for (const candidate of discovery.candidates) {
      if (candidate.state.state !== "installable" || candidate.trust.state !== "trusted") continue;
      const record = records.get(candidate.adapterId);
      if (record?.uninstalled) {
        this.fence(candidate.adapterId, "adapter_uninstalled");
        continue;
      }
      if (record?.disabled) {
        this.fence(candidate.adapterId, "adapter_disabled");
        continue;
      }
      const preparedCandidate = await this.prepare(candidate);
      if (preparedCandidate.ok) prepared.push(preparedCandidate.value);
      else this.failed(candidate, preparedCandidate.error);
    }
    if (prepared.length > 0 && !(await this.publishPrepared(prepared)).ok) await this.publishByDependency(prepared);
    return discovery;
  }

  private async publishByDependency(prepared: readonly PublishedAdapter[]): Promise<void> {
    const missing = (adapter: PublishedAdapter): string[] => relationshipTargets(adapter.definition.declaration)
      .filter(target => target !== adapter.adapterId && !this.state.published.has(target));
    const settled = await settle(
      prepared,
      adapter => this.publishPrepared([adapter]),
      adapter => missing(adapter).length === 0,
    );
    for (const [adapter, error] of settled.failures) this.failed(adapter.candidate, error);
    let held = settled.pending.filter(adapter => !settled.failures.has(adapter));
    const unheld = (adapter: PublishedAdapter, waiting: readonly PublishedAdapter[]): string[] => missing(adapter).filter(target => !waiting.some(other => other.adapterId === target));
    let progressed = true;
    while (held.length > 0 && progressed) {
      progressed = false;
      for (const adapter of [...held]) {
        const unreachable = unheld(adapter, held);
        if (unreachable.length === 0) continue;
        held = held.filter(other => other !== adapter);
        this.failed(adapter.candidate, { code: "dependency_unavailable", message: `A relationship target adapter did not publish, so this adapter stays unavailable: ${unreachable.join(", ")}.` });
        progressed = true;
      }
    }
    if (held.length === 0) return;
    if ((await this.publishPrepared(held)).ok) return;
    for (const adapter of held) {
      this.failed(adapter.candidate, { code: "dependency_unavailable", message: `The adapters that still wait do not publish together, so this adapter stays unavailable: ${missing(adapter).join(", ") || "its own relationship group"}.` });
    }
  }

  private fence(adapterId: string, code: "adapter_disabled" | "adapter_uninstalled"): void {
    const availability = new Map(this.state.availability);
    availability.set(adapterId, { state: "unavailable", code, message: FENCE_MESSAGE[code] });
    this.state = { ...this.state, availability };
  }

  async disable(adapterId: string): Promise<DeskAdapterGenerationRecord | null> {
    const store = this.store;
    if (!store) return null;
    const record = await store.fence(adapterId, "disabled");
    this.fence(adapterId, "adapter_disabled");
    return record;
  }

  async uninstall(adapterId: string): Promise<DeskAdapterGenerationRecord | null> {
    const store = this.store;
    if (!store) return null;
    const record = await store.fence(adapterId, "uninstalled");
    this.fence(adapterId, "adapter_uninstalled");
    return record;
  }

  admission(adapterId: string): DeskAdapterAvailability {
    return this.state.availability.get(adapterId) ?? { state: "available" };
  }

  async admit(adapterId: string, required: { releaseDigest: string }): Promise<DeskGenerationAdmission> {
    const store = this.store;
    if (!store) return { state: "unavailable", code: "generation_missing", message: "No durable generation store is configured." };
    return store.admit(adapterId, required);
  }

  capability(capabilityId: string) {
    const found = this.state.registry.capability(capabilityId);
    return found.support === "declared" ? this.state.registry.capability(capabilityId, this.admission(found.adapterId)) : found;
  }

  list(): DeskAdapterCatalogEntry[] {
    return [...this.state.published.values()].map(adapter => ({
      generation: structuredClone(adapter.generation),
      declaration: structuredClone(adapter.definition.declaration),
      readBindings: structuredClone(adapter.readBindings),
      draftingBindings: structuredClone(adapter.draftingBindings),
      ...(adapter.ui ? { ui: structuredClone(adapter.ui) } : {}),
      availability: this.admission(adapter.adapterId),
    })).sort((left, right) => left.generation.adapterId.localeCompare(right.generation.adapterId));
  }

  catalog(): DeskAdapterCatalogEntry[] {
    return this.list().filter(entry => entry.availability.state === "available");
  }

  uiPublications(): DeskUiPublication[] {
    const publications: DeskUiPublication[] = [];
    for (const adapter of this.state.published.values()) {
      if (!adapter.ui || this.admission(adapter.adapterId).state !== "available") continue;
      publications.push({
        generation: structuredClone(adapter.generation),
        ui: structuredClone(adapter.ui),
        packageRoot: adapter.candidate.packageRoot,
        capabilityIds: adapter.definition.declaration.capabilities.map(capability => capability.capabilityId),
      });
    }
    return publications.sort((left, right) => left.generation.adapterId.localeCompare(right.generation.adapterId));
  }

  async rollback(adapterId: string): Promise<Result<DeskAdapterGeneration>> {
    const store = this.store;
    if (!store) return failure("generation_store_unavailable", "Rollback requires the durable generation store.");
    const record = await store.read(adapterId);
    if (record?.uninstalled) return failure("adapter_uninstalled", FENCE_MESSAGE.adapter_uninstalled);
    if (record?.disabled) return failure("adapter_disabled", FENCE_MESSAGE.adapter_disabled);
    const target = record?.lastValid;
    if (!target) return failure("rollback_unavailable", "No earlier valid generation is recorded for this adapter.");
    const discovery = await this.discover();
    const candidate = discovery.candidates.find(item => item.adapterId === adapterId && item.releaseDigest === target.releaseDigest);
    if (candidate?.state.state !== "installable") return failure("rollback_unavailable", "The earlier generation is not installed and verified; install it again before rolling back.");
    if (candidate.trust.state !== "trusted") return failure(candidate.trust.code, "The earlier generation has no principal approval for this origin, version and content digest.");
    return this.publish(candidate, { refuseFenced: true });
  }

  diagnostics(): DeskPackageIssue[] {
    return [...this.state.diagnostics.values()].flat().sort((left, right) => `${left.packageId ?? ""}:${left.code}`.localeCompare(`${right.packageId ?? ""}:${right.code}`));
  }

  connector(adapterId: string, capabilityId: string, connection: DeskAdapterConnection): Result<DeskActionConnector> {
    const availability = this.admission(adapterId);
    if (availability.state !== "available") return failure(availability.code, availability.message);
    const adapter = this.state.published.get(adapterId);
    const factory = adapter?.connectors.get(capabilityId);
    if (!adapter || !factory) return failure("connector_missing", "No registered action connector exists for this capability.");
    if (connection.adapterId !== adapterId) return failure("connector_mismatch", "The connection does not belong to this adapter.");
    let connector: unknown;
    try {
      connector = factory(connection);
    } catch (error) {
      return failure("module_throwing", `The connector factory threw for this connection: ${errorText(error)}`);
    }
    if (!isRecord(connector) || connector.kind !== "action" || connector.adapterId !== adapterId || connector.connectionId !== connection.connectionId || connector.capabilityId !== capabilityId) {
      return failure("connector_mismatch", "The connector does not match the adapter, connection and capability identity.");
    }
    return success(structuredClone(connector) as unknown as DeskActionConnector);
  }
}
