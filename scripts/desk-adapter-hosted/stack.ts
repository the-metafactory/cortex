import { CF_ACCESS_JWT_HEADER } from "../../src/surface/mc/api/networks-admission";
import type { MutationGuardContext } from "../../src/surface/mc/api/mutation-guard";
import { handleDeskDrafts } from "../../src/surface/mc/api/desk-drafts";
import { handleDeskAdapterAssets } from "../../src/surface/mc/api/desk-adapter-assets";
import { openDraftEditorRig } from "../../src/surface/mc/__tests__/fixtures/draft-editor";
import { ASSET_OWNER, openAssetRig } from "../../src/surface/mc/desk/__tests__/fixtures/adapter-asset-fixtures";

export async function openSyntheticStack(hostname: string) {
  const drafts = await openDraftEditorRig();
  const assets = await openAssetRig();
  const guard: MutationGuardContext = {
    isLoopback: false, allowedHostnames: new Set([hostname]), listenPort: 443,
    principals: new Set([ASSET_OWNER]), localPrincipal: ASSET_OWNER,
    verifyJwt: assertion => Promise.resolve(assertion.length > 0 ? { email: ASSET_OWNER } : null),
  };
  let hits = 0;
  function handle(req: Request): Promise<Response> | Response {
    hits++;
    const url = new URL(req.url);
    if (!req.headers.get(CF_ACCESS_JWT_HEADER)) return new Response("Access assertion required", { status: 401 });
    if (url.pathname === "/__probe/ready") return new Response("ready");
    if (url.pathname.startsWith("/api/desk/drafts")) return handleDeskDrafts(req, url, guard, () => drafts.editor);
    if (url.pathname.startsWith("/api/desk/adapters")) return handleDeskAdapterAssets(req, url, guard, () => assets.service);
    return new Response("Not found", { status: 404 });
  }
  return {
    drafts, handle,
    get originHits() { return hits; },
    async close() { await drafts.close(); await assets.close(); },
  };
}

export type SyntheticStack = Awaited<ReturnType<typeof openSyntheticStack>>;
