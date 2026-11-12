import { join } from "node:path";

const DASHBOARD = join(import.meta.dir, "../../src/surface/mc/dashboard-v2");
const FRAME_PROBE_STYLES = ["/styles/tokens.css", "/styles/global.css", "/styles/constellation.css"];

export interface FrameProbeAssets { javascript: Blob | undefined; css: Blob | undefined; shell: string }

export async function buildFrameProbeAssets(browserEntry: string): Promise<FrameProbeAssets> {
  const bundle = await Bun.build({ entrypoints: [browserEntry], target: "browser", naming: "[name].[ext]" });
  if (!bundle.success) throw new Error(bundle.logs.join("\n"));
  const shellSource = await Bun.file(join(DASHBOARD, "index.html")).text();
  const shell = await new HTMLRewriter().on("link", { element(element) {
    if ((element.getAttribute("href") ?? "").startsWith("https://")) element.remove();
  } }).transform(new Response(shellSource.replace('src="./main.tsx"', 'src="/probe.js"').replace("</head>", '<link rel="icon" href="data:,"><link rel="stylesheet" href="/probe.css"></head>'))).text();
  return { javascript: bundle.outputs.find(item => item.path.endsWith(".js")), css: bundle.outputs.find(item => item.path.endsWith(".css")), shell };
}

export function frameProbeStatic(assets: FrameProbeAssets, pathname: string, mountId: string): Response | null {
  if (pathname === "/fixture.json") return Response.json({ mountId });
  if (pathname === "/probe.js") return new Response(assets.javascript, { headers: { "content-type": "text/javascript" } });
  if (pathname === "/probe.css") return new Response(assets.css ?? "", { headers: { "content-type": "text/css" } });
  if (FRAME_PROBE_STYLES.includes(pathname)) return new Response(Bun.file(join(DASHBOARD, pathname.slice(1))), { headers: { "content-type": "text/css" } });
  return null;
}

export function forwardAssetRequest(req: Request, url: URL, serve: (path: string, init: { method: string; headers: Record<string, string> }) => Promise<Response>): Promise<Response> {
  const protocol = req.headers.get("x-desk-ui-protocol");
  return serve(url.pathname, { method: req.method, headers: protocol === null ? {} : { "x-desk-ui-protocol": protocol } });
}

export function startFrameProbeServer(assets: FrameProbeAssets, mountId: string, handle: (req: Request, url: URL, server: Bun.Server<undefined>) => Response | Promise<Response>) {
  const requests: string[] = [];
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch(req, server) {
    const url = new URL(req.url);
    requests.push(`${req.method} ${url.pathname}`);
    return frameProbeStatic(assets, url.pathname, mountId) ?? handle(req, url, server);
  } });
  return { server, requests };
}
