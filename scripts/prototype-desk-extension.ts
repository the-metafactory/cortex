import { basename, join, resolve } from "node:path";
import { rmSync } from "node:fs";
import { ExtensionHost } from "../src/conversations/domain-adapters/extension-prototype/host";

const root = join(import.meta.dir, "..");
const args = process.argv.slice(2);
const option = (name: string, fallback: string): string => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] ?? fallback : fallback; };
const port = Number(option("--port", "33594"));
const stateDir = resolve(option("--state", join(root, ".prototype-desk-extension-wipe-me")));
const samples = resolve(option("--samples", join(root, "docs/prototypes/desk-extension/packages")));
const RESTART = 75;

if (!args.includes("--worker")) {
  if (args.includes("--fresh")) rmSync(stateDir, { recursive: true, force: true });
  const forwarded = args.filter(arg => arg !== "--fresh");
  for (;;) {
    const child = Bun.spawn(["bun", import.meta.filename, "--worker", ...forwarded], { stdio: ["inherit", "inherit", "inherit"] });
    process.once("SIGTERM", () => { child.kill(); process.exit(0); });
    const code = await child.exited;
    if (code !== RESTART) process.exit(code);
  }
}

const built = await Bun.build({ entrypoints: [join(root, "src/surface/mc/dashboard-v2/desk-extension-prototype-main.tsx")], target: "browser", define: { "process.env.NODE_ENV": JSON.stringify("development") }, minify: false });
if (!built.success) throw new Error(built.logs.map(log => log.message).join("\n"));
const files = new Map(built.outputs.map(file => [`/${basename(file.path)}`, file]));
const js = [...files.keys()].find(path => path.endsWith(".js"));
const css = [...files.keys()].find(path => path.endsWith(".css"));
const origin = `http://127.0.0.1:${port}`;
const host = new ExtensionHost(stateDir, samples);
await host.start();

const received: string[] = [];
const receiver = Bun.serve({ hostname: "127.0.0.1", port: port + 1, fetch(request) { received.push(new URL(request.url).pathname); return new Response("Synthetic receiver; no provider", { headers: { "Access-Control-Allow-Origin": "*" } }); } });
const common = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" };
const parentPolicy = `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-src ${origin}/adapter-assets/; object-src 'none'; base-uri 'none'; form-action 'none'`;
const framePolicy = (digest: string): string => `default-src 'none'; script-src ${origin}/adapter-assets/${digest}/; style-src ${origin}/adapter-assets/${digest}/ 'unsafe-inline'; connect-src 'none'; img-src 'none'; font-src 'none'; frame-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'`;
const json = (value: unknown): Response => Response.json(value, { headers: common });
const managedRestart = (): Response => { setTimeout(() => process.exit(RESTART), 50); return json({ restarting: true }); };

Bun.serve({ hostname: "127.0.0.1", port, idleTimeout: 60, async fetch(request) {
  const url = new URL(request.url);
  if (request.method === "POST" && request.headers.get("Origin") !== origin) return new Response("Same origin only", { status: 403, headers: common });
  const body = (request.method === "POST" ? await request.json() : {}) as Record<string, any>;
  switch (url.pathname) {
    case "/api/view": return json(host.view());
    case "/api/say": await host.handleMessage(body.text); return json(host.view());
    case "/api/draft/edit": host.editDraft(body.id, body.revision, body.changes); return json(host.view());
    case "/api/draft/approve": await host.approve(body.id, body.revision, body.digest); return json(host.view());
    case "/api/draft/current": await host.currentResult(body.id); return json(host.view());
    case "/api/results/more": await host.loadMore(body.id, body.more); return json(host.view());
    case "/api/refresh": await host.poll(); return json(host.view());
    case "/api/frame-incident": host.frameIncident(body.adapterId, body.reason); return json({ ok: true });
    case "/api/adapters/install": host.install(body.sample); return json(host.view());
    case "/api/adapters/approve": return host.approvePackage(body.packageId, body.releaseDigest) ? managedRestart() : new Response("Unknown release", { status: 409, headers: common });
    case "/api/adapters/remove": return host.remove(body.sample) ? managedRestart() : json(host.view());
    case "/api/adapters/connect": await host.connect(body.adapterId, { account: "prototype-account" }, {}); return json(host.view());
    case "/api/adapters/disconnect": host.disconnect(body.adapterId); return json(host.view());
    case "/api/adapters/destination": host.setDestination(body.adapterId, body.id, body.kind, body.allowed); return json(host.view());
    case "/__prototype/restart": return managedRestart();
    case "/__prototype/diagnostics": return json({ ...host.diagnostics(), syntheticReceiverRequests: received });
    default:
  }
  const assetMatch = /^\/adapter-assets\/([a-f0-9]{64})\/(.+)$/.exec(url.pathname);
  if (assetMatch?.[1] && assetMatch[2]) {
    const asset = host.asset(assetMatch[1], assetMatch[2]);
    if (!asset) return new Response("Unavailable", { status: 404, headers: common });
    return new Response(Bun.file(asset.file), { headers: { ...common, "Content-Type": asset.mediaType, "Content-Security-Policy": framePolicy(assetMatch[1]) } });
  }
  const file = files.get(url.pathname);
  if (file) return new Response(file, { headers: { ...common, "Content-Security-Policy": parentPolicy } });
  if (url.pathname !== "/") return new Response("Not found", { status: 404, headers: common });
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Desk adapter extension prototype</title><link rel="stylesheet" href="${css}"></head><body><div id="root"></div><script type="module" src="${js}"></script></body></html>`, { headers: { ...common, "Content-Type": "text/html", "Content-Security-Policy": parentPolicy } });
} });
console.log(`Throwaway synthetic Desk extension prototype: ${origin}/`);
console.log(`State (wipe me): ${stateDir}. Synthetic receiver: ${receiver.url}`);
