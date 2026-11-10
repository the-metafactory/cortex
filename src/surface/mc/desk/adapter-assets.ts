import { lstatSync, realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { containedRealPath, sha256Bytes } from "../../../common/registry/arc-package-inventory";
import { canonicalJSON } from "../../../common/registry/canonical-json";
import { DESK_ADAPTER_MAX_FILES, DESK_ADAPTER_MAX_FILE_BYTES, type DeskUiPublication } from "../../../conversations/domain-adapters/package";
import { DESK_UI_PROTOCOL_VERSION, type DeskGenerationAdmission } from "../../../conversations/domain-adapters/package-generation";

export const DESK_ADAPTER_ASSET_PATH = "/api/desk/adapters";
export const DESK_ADAPTER_CATALOG_PATH = `${DESK_ADAPTER_ASSET_PATH}/catalog`;
export const DESK_ADAPTER_ASSET_PREFIX = `${DESK_ADAPTER_ASSET_PATH}/assets/`;
export const DESK_UI_PROTOCOL_HEADER = "x-desk-ui-protocol";
export const DESK_ADAPTER_ASSET_MAX_ADAPTERS = 64;

export const DESK_ADAPTER_ASSET_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self'",
  "font-src 'self'",
  "connect-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
  "object-src 'none'",
  "frame-ancestors 'self'",
].join("; ");

const TEXT_TYPES: ReadonlySet<string> = new Set(["text/html", "text/javascript", "text/css"]);
const RELEASE = /^[0-9a-f]{64}$/;
const CONNECTION = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export interface AssetConnection {
  connectionId: string;
  packageId: string;
  state: string;
  readCapabilityIds: readonly string[];
  writeCapabilityIds: readonly string[];
}

export interface AssetPolicy {
  connections(principal: string): Promise<readonly AssetConnection[]>;
}

export interface AssetSource {
  uiPublications(): readonly DeskUiPublication[];
  admit(adapterId: string, required: { releaseDigest: string }): Promise<DeskGenerationAdmission>;
}

export interface AssetCatalogFile {
  path: string;
  sha256: string;
  mediaType: string;
  url: string;
}

export interface AssetCatalogEntry {
  adapterId: string;
  packageId: string;
  packageVersion: string;
  releaseDigest: string;
  generationId: string;
  uiProtocolVersion: string;
  connectionId: string;
  readCapabilityIds: string[];
  writeCapabilityIds: string[];
  views: { objectType: string; view: string }[];
  entry: string;
  files: AssetCatalogFile[];
  availability: { state: "available" } | { state: "unavailable"; code: string; message: string };
}

export interface AssetCatalog {
  protocolVersion: string;
  revision: string;
  adapters: AssetCatalogEntry[];
}

export type AssetFailureCode =
  | "unsupported_ui_protocol" | "generation_mismatch" | "connection_not_authorized" | "asset_not_listed"
  | "asset_invalid_path" | "asset_unavailable" | "policy_unavailable";

export interface AssetFailure {
  ok: false;
  status: number;
  code: AssetFailureCode;
  message: string;
  recovery?: "refresh" | "upgrade";
}

export interface AssetBody {
  ok: true;
  bytes: Uint8Array<ArrayBuffer>;
  mediaType: string;
  sha256: string;
}

const failure = (status: number, code: AssetFailureCode, message: string, recovery?: "refresh" | "upgrade"): AssetFailure => ({ ok: false, status, code, message, ...(recovery ? { recovery } : {}) });

export const assetUrl = (releaseDigest: string, connectionId: string, path: string): string =>
  `${DESK_ADAPTER_ASSET_PREFIX}${releaseDigest}/${encodeURIComponent(connectionId)}/${path.split("/").map(encodeURIComponent).join("/")}`;

export function parseAssetPath(pathname: string): { releaseDigest: string; connectionId: string; path: string } | null {
  if (!pathname.startsWith(DESK_ADAPTER_ASSET_PREFIX)) return null;
  const parts = pathname.slice(DESK_ADAPTER_ASSET_PREFIX.length).split("/");
  if (parts.length < 3) return null;
  const decoded: string[] = [];
  for (const part of parts) {
    try {
      decoded.push(decodeURIComponent(part));
    } catch (_err) {
      return null;
    }
  }
  const [releaseDigest, connectionId, ...rest] = decoded;
  if (!releaseDigest || !connectionId || rest.length === 0) return null;
  if (rest.some(segment => segment === "" || segment === "." || segment === ".." || segment.includes("/") || segment.includes("\\") || segment.includes("\0"))) return null;
  return { releaseDigest, connectionId, path: rest.join("/") };
}

export function assetResponseHeaders(body: AssetBody): Record<string, string> {
  return {
    "Content-Type": TEXT_TYPES.has(body.mediaType) ? `${body.mediaType}; charset=utf-8` : body.mediaType,
    "Content-Length": String(body.bytes.length),
    ETag: `"${body.sha256}"`,
    "Cache-Control": "private, no-cache",
    Vary: "Cookie, Authorization",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": DESK_ADAPTER_ASSET_CSP,
    "Cross-Origin-Resource-Policy": "same-origin",
    "Referrer-Policy": "no-referrer",
  };
}

async function readListedFile(packageRoot: string, path: string, digest: string): Promise<AssetBody | AssetFailure> {
  const unreadable = failure(503, "asset_unavailable", "The asset is unavailable on this stack.");
  let root: string;
  try {
    root = realpathSync(packageRoot);
  } catch (_err) {
    return unreadable;
  }
  const candidate = resolve(root, path);
  if (!candidate.startsWith(root + sep)) return unreadable;
  try {
    const stat = lstatSync(candidate);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size > DESK_ADAPTER_MAX_FILE_BYTES) return unreadable;
  } catch (_err) {
    return unreadable;
  }
  const contained = containedRealPath(root, candidate);
  if (!contained.ok) return unreadable;
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    bytes = new Uint8Array(await readFile(contained.path));
  } catch (_err) {
    return unreadable;
  }
  if (bytes.length > DESK_ADAPTER_MAX_FILE_BYTES || sha256Bytes(bytes) !== digest) return unreadable;
  return { ok: true, bytes, mediaType: "", sha256: digest };
}

export class AdapterAssetService {
  constructor(private readonly source: AssetSource, private readonly policy: AssetPolicy) {}

  private async enabledFor(principal: string): Promise<AssetConnection[] | AssetFailure> {
    try {
      return (await this.policy.connections(principal)).filter(connection => connection.state === "enabled");
    } catch (_err) {
      return failure(503, "policy_unavailable", "Asset policy is unavailable on this stack.");
    }
  }

  private async available(publication: DeskUiPublication): Promise<boolean> {
    const admission = await this.source.admit(publication.generation.adapterId, { releaseDigest: publication.generation.releaseDigest });
    return admission.state === "available" && admission.generation.generationId === publication.generation.generationId;
  }

  private linked(publication: DeskUiPublication, connection: AssetConnection): boolean {
    return connection.packageId === publication.generation.packageId || connection.packageId === publication.generation.adapterId;
  }

  async catalog(principal: string, shellProtocol?: string): Promise<AssetCatalog | AssetFailure> {
    const connections = await this.enabledFor(principal);
    if (!Array.isArray(connections)) return connections;
    const supported = shellProtocol === undefined || shellProtocol === DESK_UI_PROTOCOL_VERSION;
    const adapters: AssetCatalogEntry[] = [];
    for (const publication of this.source.uiPublications()) {
      if (!(await this.available(publication))) continue;
      const declared = new Set(publication.capabilityIds);
      for (const connection of connections.filter(item => this.linked(publication, item))) {
        const { generation, ui } = publication;
        adapters.push({
          adapterId: generation.adapterId,
          packageId: generation.packageId,
          packageVersion: generation.packageVersion,
          releaseDigest: generation.releaseDigest,
          generationId: generation.generationId,
          uiProtocolVersion: ui.protocolVersion,
          connectionId: connection.connectionId,
          readCapabilityIds: connection.readCapabilityIds.filter(id => declared.has(id)),
          writeCapabilityIds: connection.writeCapabilityIds.filter(id => declared.has(id)),
          views: ui.views.map(view => ({ objectType: view.objectType, view: view.view })),
          entry: ui.entry,
          files: ui.files.map(file => ({ path: file.path, sha256: file.sha256, mediaType: file.mediaType, url: assetUrl(generation.releaseDigest, connection.connectionId, file.path) })),
          availability: supported ? { state: "available" } : { state: "unavailable", code: "unsupported_ui_protocol", message: `This shell does not support Desk UI protocol ${ui.protocolVersion}; upgrade the shell.` },
        });
      }
    }
    adapters.sort((left, right) => `${left.adapterId}/${left.connectionId}`.localeCompare(`${right.adapterId}/${right.connectionId}`));
    const bounded = adapters.slice(0, DESK_ADAPTER_ASSET_MAX_ADAPTERS);
    return { protocolVersion: DESK_UI_PROTOCOL_VERSION, revision: sha256Bytes(canonicalJSON(bounded.map(entry => [entry.adapterId, entry.connectionId, entry.generationId, entry.releaseDigest]))), adapters: bounded };
  }

  async asset(principal: string, request: { releaseDigest: string; connectionId: string; path: string }, shellProtocol?: string): Promise<AssetBody | AssetFailure> {
    if (shellProtocol !== undefined && shellProtocol !== DESK_UI_PROTOCOL_VERSION) return failure(426, "unsupported_ui_protocol", "This shell does not support the adapter UI protocol; upgrade the shell.", "upgrade");
    if (!RELEASE.test(request.releaseDigest) || !CONNECTION.test(request.connectionId)) return failure(400, "asset_invalid_path", "The asset identity is not valid.");
    const connections = await this.enabledFor(principal);
    if (!Array.isArray(connections)) return connections;
    const active = this.source.uiPublications().find(item => item.generation.releaseDigest === request.releaseDigest);
    if (!active || !(await this.available(active))) return failure(409, "generation_mismatch", "The cached adapter UI belongs to a different generation than the active backend. Refresh the catalog.", "refresh");
    if (!connections.some(connection => connection.connectionId === request.connectionId && this.linked(active, connection))) {
      return failure(403, "connection_not_authorized", "This connection is not enabled for this adapter on this stack.");
    }
    const listed = active.ui.files.slice(0, DESK_ADAPTER_MAX_FILES).find(file => file.path === request.path);
    if (!listed) return failure(404, "asset_not_listed", "That asset is not listed by the active adapter generation.");
    const read = await readListedFile(active.packageRoot, listed.path, listed.sha256);
    return read.ok ? { ...read, mediaType: listed.mediaType } : read;
  }
}
