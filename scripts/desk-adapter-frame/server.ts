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
  const bundle = await Bun.build({ entrypoints: [join(import.meta.dir, "browser.tsx")], target: "browser", naming: "[name].[ext]" });
  if (!bundle.success) { await rig.close(); throw new Error(bundle.logs.join("\n")); }
  const javascript = bundle.outputs.find(item => item.path.endsWith(".js"));
  const css = bundle.outputs.find(item => item.path.endsWith(".css"));
  const shellSource = await Bun.file(join(import.meta.dir, "../../src/surface/mc/dashboard-v2/index.html")).text();
  const shell = await new HTMLRewriter().on("link", { element(element) {
    const href = element.getAttribute("href") ?? "";
    if (href.startsWith("https://")) element.remove();
  } }).transform(new Response(shellSource.replace('src="./main.tsx"', 'src="/probe.js"').replace("</head>", '<link rel="icon" href="data:,"><link rel="stylesheet" href="/probe.css"></head>'))).text();
  const cookie = `frame-session=${randomUUID()}`;
  const requests: string[] = [];
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch(req, server) {
    const url = new URL(req.url);
    requests.push(`${req.method} ${url.pathname}`);
    if (url.pathname === "/probe.js") return new Response(javascript, { headers: { "content-type": "text/javascript" } });
    if (["/styles/tokens.css", "/styles/global.css", "/styles/constellation.css"].includes(url.pathname)) return new Response(Bun.file(join(import.meta.dir, "../../src/surface/mc/dashboard-v2", url.pathname.slice(1))), { headers: { "content-type": "text/css" } });
    if (url.pathname === "/probe.css") return new Response(css ?? "", { headers: { "content-type": "text/css" } });
    if (url.pathname === "/fixture.json") return Response.json({ mountId: rig.registered.mountId });
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
      return rig.assets[mode](url.pathname, { method: req.method, headers: req.headers.has("x-desk-ui-protocol") ? { "x-desk-ui-protocol": req.headers.get("x-desk-ui-protocol")! } : {} });
    }
    return new Response(shell, { headers: { "content-type": "text/html", "content-security-policy": shellFrameCsp(url.origin), "set-cookie": `${cookie}; HttpOnly; SameSite=Lax; Path=/` } });
  } });
  return { rig, server, requests, async close() { await server.stop(true); await rig.close(); } };
}
