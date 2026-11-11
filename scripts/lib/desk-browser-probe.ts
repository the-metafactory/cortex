import { join } from "node:path";

export interface DeskProbeBundle {
  script: Blob;
  css: Blob | string;
}

export interface DeskProbeRoutes {
  desk(): Promise<unknown>;
  extra?(request: Request, url: URL): Promise<Response | null> | Response | null;
}

export const deskProbeEntry = (name: string): string => join(import.meta.dir, "..", name);

export async function buildDeskProbeBundle(entry: string): Promise<DeskProbeBundle> {
  const build = await Bun.build({ entrypoints: [entry], target: "browser" });
  const script = build.outputs.find(output => output.path.endsWith(".js"));
  const css = build.outputs.find(output => output.path.endsWith(".css"));
  if (!build.success || !script) throw new Error("The Desk probe bundle does not build.");
  return { script, css: css ?? "" };
}

export function serveDeskProbe(bundle: DeskProbeBundle, routes: DeskProbeRoutes): ReturnType<typeof Bun.serve> {
  return Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/probe.js") return new Response(bundle.script, { headers: { "content-type": "text/javascript" } });
      if (url.pathname === "/probe.css") return new Response(bundle.css, { headers: { "content-type": "text/css" } });
      if (url.pathname === "/api/desk") return Response.json(await routes.desk(), { headers: { "Cache-Control": "no-store" } });
      if (url.pathname === "/api/desk/studio") return Response.json({ studio: null });
      const extra = await routes.extra?.(request, url);
      if (extra) return extra;
      if (url.pathname.startsWith("/api/")) return Response.json({ error: "This probe has no owner actions." }, { status: 404 });
      return new Response('<!doctype html><html><head><link rel="stylesheet" href="/probe.css"></head><body><div id="root"></div><script type="module" src="/probe.js"></script></body></html>', { headers: { "content-type": "text/html" } });
    },
  });
}
