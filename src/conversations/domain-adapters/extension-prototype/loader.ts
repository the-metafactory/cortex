import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { join, sep } from "node:path";
import { satisfies, validRange } from "semver";
import { canonicalSchema } from "../schema-validation";
import { DomainAdapterRegistry } from "../registry";
import { DESK_ADAPTER_SDK_VERSION, PackageManifestSchema, type ConnectionForConnector, type CreateDeskAdapter, type PackagedConnector, type PackageManifest } from "./contract";

export interface LoadedPackage { manifest: PackageManifest; dir: string; releaseDigest: string; connectors: Map<string, (connection: ConnectionForConnector) => PackagedConnector>; bindings: { handlers: Record<string, (input: unknown, context: unknown) => unknown>; observations: Record<string, object> } }
export interface PackageDiagnostic { dir: string; packageId: string; state: "active" | "awaiting-approval" | "unavailable"; code?: string; message?: string; releaseDigest?: string; packageVersion?: string; label?: string }
export interface LoadResult { registry: DomainAdapterRegistry; active: LoadedPackage[]; diagnostics: PackageDiagnostic[] }

const MAX_FILE = 2 * 1024 * 1024;
const sha256 = (value: Buffer | string): string => createHash("sha256").update(value).digest("hex");
class Refused extends Error { constructor(readonly code: string, message: string) { super(message); } }

export function containedFile(dir: string, relative: string): string {
  const root = realpathSync(dir);
  const candidate = join(root, relative);
  if (!existsSync(candidate)) throw new Refused("missing_file", `Package file ${relative} is missing.`);
  if (lstatSync(candidate).isSymbolicLink() || !realpathSync(candidate).startsWith(root + sep)) throw new Refused("path_escape", `Package file ${relative} leaves the package.`);
  if (lstatSync(candidate).size > MAX_FILE) throw new Refused("too_large", `Package file ${relative} exceeds the host bound.`);
  return candidate;
}

function verifiedManifest(dir: string): { manifest: PackageManifest; releaseDigest: string } {
  const path = join(dir, "desk-adapter.json");
  if (!existsSync(path)) throw new Refused("missing_manifest", "The package has no desk-adapter.json.");
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(path, "utf8")); } catch { throw new Refused("invalid_manifest", "The manifest is not JSON."); }
  const parsed = PackageManifestSchema.safeParse(raw);
  if (!parsed.success) throw new Refused("unsupported_manifest", `The manifest does not match desk-adapter-package/1 (${parsed.error.issues[0]?.path.join("/") ?? "root"}).`);
  const manifest = parsed.data;
  if (validRange(manifest.deskSdkRange) === null || !satisfies(DESK_ADAPTER_SDK_VERSION, manifest.deskSdkRange)) throw new Refused("incompatible_sdk", "The package does not support this Desk adapter SDK.");
  const verify = (relative: string, expected: string): void => { if (sha256(readFileSync(containedFile(dir, relative))) !== expected) throw new Refused("digest_mismatch", `Package file ${relative} does not match its digest.`); };
  verify(manifest.backend.entry, manifest.backend.sha256);
  if (!manifest.backend.entry.endsWith(".mjs")) throw new Refused("invalid_backend", "The backend entry must be a prebuilt .mjs bundle.");
  if (manifest.ui) {
    if (!manifest.ui.files.some(file => file.path === manifest.ui?.entry)) throw new Refused("invalid_ui", "The UI entry is not a listed file.");
    for (const file of manifest.ui.files) verify(file.path, file.sha256);
  }
  return { manifest, releaseDigest: sha256(canonicalSchema(raw)) };
}

async function stage(dir: string, manifest: PackageManifest, releaseDigest: string, registry: DomainAdapterRegistry): Promise<LoadedPackage> {
  const adapterModule = await import(`${containedFile(dir, manifest.backend.entry)}?release=${releaseDigest}`) as { createDeskAdapter?: CreateDeskAdapter };
  if (typeof adapterModule.createDeskAdapter !== "function") throw new Refused("missing_entrypoint", "The backend does not export createDeskAdapter.");
  const connectors = new Map<string, (connection: ConnectionForConnector) => PackagedConnector>();
  const created = adapterModule.createDeskAdapter({ sdkVersion: DESK_ADAPTER_SDK_VERSION, registerConnector(capabilityId, connect) { connectors.set(capabilityId, connect); } });
  if (canonicalSchema(created.declaration) !== canonicalSchema(manifest.declaration)) throw new Refused("declaration_mismatch", "The backend's declaration differs from its manifest.");
  const capabilities = new Set(manifest.declaration.capabilities.map(capability => capability.capabilityId));
  for (const binding of [...manifest.draftingBindings, ...manifest.readBindings]) {
    if (binding.adapterId !== manifest.declaration.adapterId || !capabilities.has(binding.capabilityId)) throw new Refused("invalid_binding", "A binding refers to an undeclared capability.");
  }
  const registered = registry.register(manifest.declaration, created.bindings);
  if (!registered.ok) throw new Refused(registered.error.code, registered.error.message);
  return { manifest, dir, releaseDigest, connectors, bindings: created.bindings as LoadedPackage["bindings"] };
}

export function inspectPackage(root: string, name: string, claimedAdapters: Set<string>): PackageDiagnostic {
  const dir = join(root, name);
  try {
    const { manifest, releaseDigest } = verifiedManifest(dir);
    const base = { dir: name, packageId: manifest.packageId, releaseDigest, packageVersion: manifest.packageVersion, label: manifest.declaration.label };
    if (claimedAdapters.has(manifest.declaration.adapterId)) return { ...base, state: "unavailable", code: "duplicate_adapter", message: "Another installed package claims the same adapter identity; neither is used." };
    return { ...base, state: "awaiting-approval", message: "Approve this exact release before Desk runs its code." };
  } catch (error) {
    return { dir: name, packageId: name, state: "unavailable", code: error instanceof Refused ? error.code : "load_failed", message: error instanceof Refused ? error.message : "The package could not be read." };
  }
}

export async function loadPackages(root: string, approvals: Record<string, string>): Promise<LoadResult> {
  const registry = new DomainAdapterRegistry();
  const diagnostics: PackageDiagnostic[] = [];
  const candidates: { dir: string; manifest: PackageManifest; releaseDigest: string; packageId: string }[] = [];
  const entries = existsSync(root) ? readdirSync(root, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name).sort() : [];
  for (const name of entries) {
    const dir = join(root, name);
    try { const verified = verifiedManifest(dir); candidates.push({ dir, packageId: verified.manifest.packageId, ...verified }); }
    catch (error) { diagnostics.push({ dir: name, packageId: name, state: "unavailable", code: error instanceof Refused ? error.code : "load_failed", message: error instanceof Refused ? error.message : "The package could not be read." }); }
  }
  const adapterCount = new Map<string, number>();
  for (const candidate of candidates) adapterCount.set(candidate.manifest.declaration.adapterId, (adapterCount.get(candidate.manifest.declaration.adapterId) ?? 0) + 1);
  const active: LoadedPackage[] = [];
  for (const candidate of candidates) {
    const base = { dir: candidate.dir.split(sep).pop() ?? candidate.packageId, packageId: candidate.packageId, releaseDigest: candidate.releaseDigest, packageVersion: candidate.manifest.packageVersion, label: candidate.manifest.declaration.label };
    if ((adapterCount.get(candidate.manifest.declaration.adapterId) ?? 0) > 1) { diagnostics.push({ ...base, state: "unavailable", code: "duplicate_adapter", message: "Another installed package claims the same adapter identity; neither is used." }); continue; }
    if (approvals[candidate.packageId] !== candidate.releaseDigest) { diagnostics.push({ ...base, state: "awaiting-approval", message: "Approve this exact release before Desk runs its code." }); continue; }
    try { active.push(await stage(candidate.dir, candidate.manifest, candidate.releaseDigest, registry)); diagnostics.push({ ...base, state: "active" }); }
    catch (error) { diagnostics.push({ ...base, state: "unavailable", code: error instanceof Refused ? error.code : "module_failed", message: error instanceof Refused ? error.message : "The adapter module failed while registering." }); }
  }
  return { registry, active, diagnostics };
}
