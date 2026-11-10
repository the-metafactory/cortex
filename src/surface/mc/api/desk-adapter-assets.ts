import { AdapterAssetService, assetResponseHeaders, DESK_ADAPTER_ASSET_PATH, DESK_ADAPTER_CATALOG_PATH, DESK_UI_PROTOCOL_HEADER, parseAssetPath, type AssetFailure } from "../desk/adapter-assets";
import { fail, notAllowed, reply } from "./conversations";
import { stackPrincipalOf } from "./desk-connections";
import type { MutationGuardContext } from "./mutation-guard";

export { DESK_ADAPTER_ASSET_PATH };
export type AdapterAssetAccess = () => AdapterAssetService | null;

const refusal = (failed: AssetFailure): Response => reply(failed.status, { ok: false, code: failed.code, error: failed.message, ...(failed.recovery ? { recovery: failed.recovery } : {}) });

export async function handleDeskAdapterAssets(req: Request, url: URL, guard: MutationGuardContext, access: AdapterAssetAccess | undefined): Promise<Response> {
  if (req.method !== "GET" && req.method !== "HEAD") return notAllowed("GET, HEAD");
  const who = await stackPrincipalOf(req, guard);
  if (who instanceof Response) return who;
  const service = access?.() ?? null;
  if (!service) return fail(503, "Adapter assets are unavailable on this stack.");
  if (url.search !== "") return fail(400, "Adapter asset routes take no query string.");
  const shellProtocol = req.headers.get(DESK_UI_PROTOCOL_HEADER) ?? undefined;
  if (url.pathname === DESK_ADAPTER_CATALOG_PATH) {
    const catalog = await service.catalog(who, shellProtocol);
    return "ok" in catalog ? refusal(catalog) : reply(200, { ok: true, ...catalog });
  }
  const parsed = parseAssetPath(url.pathname);
  if (!parsed) return fail(404, "Unknown adapter asset route.");
  const asset = await service.asset(who, parsed, shellProtocol);
  if (!asset.ok) return refusal(asset);
  const headers = assetResponseHeaders(asset);
  const etag = `"${asset.sha256}"`;
  if (req.headers.get("if-none-match") === etag) {
    return new Response(null, { status: 304, headers: { ETag: etag, "Cache-Control": "private, no-cache", Vary: "Cookie, Authorization" } });
  }
  return new Response(req.method === "HEAD" ? null : asset.bytes, { status: 200, headers });
}
