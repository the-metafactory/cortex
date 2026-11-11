import type { Server } from "bun";

const PAGE = '<!doctype html><html><body><div id="root"></div><script type="module" src="/probe.js"></script></body></html>';

export async function buildProbePage(entrypoint: string, label: string): Promise<string> {
  const bundle = await Bun.build({ entrypoints: [entrypoint], target: "browser" });
  const script = bundle.outputs[0];
  if (!bundle.success || !script) throw new Error(`The ${label} browser probe did not build`);
  return script.text();
}

export type ProbeRoute = (req: Request, url: URL) => Promise<Response | null> | Response | null;

export function serveProbePage(script: string, routes: ProbeRoute): Server<undefined> {
  const server: Server<undefined> = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(req: Request): Promise<Response> {
      const url = new URL(req.url);
      if (url.pathname === "/probe.js") return new Response(script, { headers: { "content-type": "text/javascript" } });
      const routed = await routes(req, url);
      if (routed) return routed;
      return new Response(PAGE, { headers: { "content-type": "text/html" } });
    },
  });
  return server;
}
