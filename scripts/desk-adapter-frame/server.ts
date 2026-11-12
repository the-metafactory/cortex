import { buildFrameProbeAssets, forwardAssetRequest, startFrameProbeServer } from "../lib/frame-probe-shell";
import { handleDeskDrafts } from "../../src/surface/mc/api/desk-drafts";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { openFrameRig } from "../../src/surface/mc/desk/__tests__/fixtures/adapter-frame-fixtures";
import { ASSET_OWNER, enabledConnection } from "../../src/surface/mc/desk/__tests__/fixtures/adapter-asset-fixtures";
import { hostileFrameScript, type FrameAttack } from "../../src/surface/mc/desk/__tests__/fixtures/adapter-frame-ui";
import { shellFrameCsp } from "../../src/surface/mc/desk/adapter-frame-contract";
import { handleDeskAdapterFrames } from "../../src/surface/mc/api/desk-adapter-frames";
import type { MutationGuardContext } from "../../src/surface/mc/api/mutation-guard";

export async function serveFrameProbe(attack: FrameAttack, mode: "local" | "hosted", evil: string) {
  const rig = await openFrameRig({ audience: mode === "local" ? "local" : "cloud", script: hostileFrameScript(attack, evil), editor: attack.startsWith("editor-") });
  rig.assets.connections.set(ASSET_OWNER, [enabledConnection(), enabledConnection("connection-other")]);
  const assets = await buildFrameProbeAssets(join(import.meta.dir, "browser.tsx")).catch(async error => { await rig.close(); throw error; });
  const cookie = `frame-session=${randomUUID()}`;
  const { server, requests } = startFrameProbeServer(assets, rig.registered.mountId, (req, url, server) => {
    if (url.pathname.startsWith("/api/")) {
      if (mode === "hosted" && !req.headers.get("cookie")?.includes(cookie)) return new Response("Sign in", { status: 401 });
      const origin = req.headers.get("origin");
      if (origin && origin !== url.origin) return new Response("Foreign origin", { status: 403 });
      if (url.pathname.startsWith("/api/desk/adapters/frames") || url.pathname.startsWith("/api/desk/drafts")) {
        const guard: MutationGuardContext = mode === "local" ? { isLoopback: true, allowedHostnames: new Set(["127.0.0.1"]), listenPort: server.port ?? 0, principals: new Set([ASSET_OWNER]), localPrincipal: ASSET_OWNER } : { isLoopback: false, allowedHostnames: new Set(["desk.example.test"]), listenPort: 443, principals: new Set([ASSET_OWNER]), localPrincipal: ASSET_OWNER, verifyJwt: assertion => Promise.resolve(assertion === "synthetic-verified-session" ? { email: ASSET_OWNER } : null) };
        const headers = new Headers(req.headers);
        if (mode === "hosted") { headers.set("host", "desk.example.test"); headers.set("cf-access-jwt-assertion", "synthetic-verified-session"); if (origin) headers.set("origin", "https://desk.example.test"); }
        const routed = mode === "local" ? req : new Request(`https://desk.example.test${url.pathname}`, { method: req.method, headers, body: req.body });
        const response = url.pathname.startsWith("/api/desk/drafts") ? handleDeskDrafts(routed, new URL(routed.url), guard, () => rig.draftEditor ?? null) : handleDeskAdapterFrames(routed, new URL(routed.url), guard, () => rig.service);
        return response.then(async response => {
          if (response.ok && req.method !== "DELETE") {
            const body = await response.clone().json() as { messages?: { type: string }[] };
            rig.releases.push(...body.messages?.filter(message => message.type === "host:projection") ?? []);
          }
          return response;
        });
      }
      if (url.pathname.endsWith("/redirect.html")) return Response.redirect(`${evil}/redirect`, 302);
      return forwardAssetRequest(req, url, rig.assets[mode]);
    }
    return new Response(assets.shell, { headers: { "content-type": "text/html", "content-security-policy": shellFrameCsp(url.origin), "set-cookie": `${cookie}; HttpOnly; SameSite=Lax; Path=/` } });
  });
  return { rig, server, requests, async close() { await server.stop(true); await rig.close(); } };
}
