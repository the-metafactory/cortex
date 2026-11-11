import { join } from "node:path";
import { buildFrameProbeAssets, startFrameProbeServer } from "../lib/frame-probe-shell";
import { openFlowEditorRig } from "../../src/surface/mc/desk/__tests__/fixtures/flow-editor-fixtures";
import { ASSET_OWNER } from "../../src/surface/mc/desk/__tests__/fixtures/adapter-asset-fixtures";
import { shellFrameCsp } from "../../src/surface/mc/desk/adapter-frame-contract";
import { handleDeskAdapterFrames } from "../../src/surface/mc/api/desk-adapter-frames";
import { handleDeskDrafts } from "../../src/surface/mc/api/desk-drafts";
import type { MutationGuardContext } from "../../src/surface/mc/api/mutation-guard";

export async function serveFlowEditorProbe(script?: string) {
  const rig = await openFlowEditorRig(script ? { script } : {});
  const assets = await buildFrameProbeAssets(join(import.meta.dir, "browser.tsx")).catch(async error => { await rig.close(); throw error; });
  const { server, requests } = startFrameProbeServer(assets, rig.registered.mountId, (req, url, server) => {
    if (url.pathname.startsWith("/api/")) {
      const guard: MutationGuardContext = { isLoopback: true, allowedHostnames: new Set(["127.0.0.1"]), listenPort: server.port ?? 0, principals: new Set([ASSET_OWNER]), localPrincipal: ASSET_OWNER };
      if (url.pathname.startsWith("/api/desk/drafts")) return handleDeskDrafts(req, url, guard, () => rig.draftEditor);
      if (url.pathname.startsWith("/api/desk/adapters/frames")) return handleDeskAdapterFrames(req, url, guard, () => rig.frames);
      return rig.assets.local(url.pathname, { method: req.method, headers: req.headers.has("x-desk-ui-protocol") ? { "x-desk-ui-protocol": req.headers.get("x-desk-ui-protocol")! } : {} });
    }
    return new Response(assets.shell, { headers: { "content-type": "text/html", "content-security-policy": shellFrameCsp(url.origin) } });
  });
  return { rig, server, requests, async close() { await server.stop(true); await rig.close(); } };
}
