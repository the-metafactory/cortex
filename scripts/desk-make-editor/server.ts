import { chromium, type Browser, type Page } from "playwright";
import { join } from "node:path";
import type { DeskDraftEditor } from "../../src/surface/mc/desk/draft-editor";
import { handleDeskDrafts } from "../../src/surface/mc/api/desk-drafts";
import { buildAllowedHostnames } from "../../src/surface/mc/api/mutation-guard";
import { handleConversations, type ConversationAccess } from "../../src/surface/mc/api/conversations";

interface DraftBrowserOptions {
  conversations?: ConversationAccess;
  principal?: string;
  route?: string;
}

export async function serveDraftBrowserProbe(rig: { makeInput: unknown; readonly editor: DeskDraftEditor }, options: DraftBrowserOptions = {}) {
  const bundle = await Bun.build({ entrypoints: [join(import.meta.dir, "browser-probe.tsx")], target: "browser", naming: "[name].[ext]" });
  if (!bundle.success) throw new Error(`The Make editor browser probe did not build: ${bundle.logs.join("\n")}`);
  const javascript = bundle.outputs.find(item => item.path.endsWith(".js"));
  const css = bundle.outputs.find(item => item.path.endsWith(".css"));
  if (!javascript) throw new Error("Browser probe bundle missing.");
  const calls: string[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0,
    fetch(req, server) {
      const url = new URL(req.url);
      if (url.pathname === "/probe.js") return new Response(javascript, { headers: { "content-type": "text/javascript" } });
      if (url.pathname === "/probe.css") return new Response(css ?? "", { headers: { "content-type": "text/css" } });
      if (url.pathname === "/fixture.json") return Response.json(rig.makeInput);
      const guard = { isLoopback: true, allowedHostnames: buildAllowedHostnames("127.0.0.1"), listenPort: server.port ?? 0, principals: new Set<string>(), localPrincipal: options.principal };
      if (url.pathname.startsWith("/api/desk/drafts")) {
        calls.push(`${req.method} ${url.pathname}${url.search}`);
        return handleDeskDrafts(req, url, guard, () => rig.editor);
      }
      if (url.pathname.startsWith("/api/conversations") && options.conversations) {
        calls.push(`${req.method} ${url.pathname}${url.search}`);
        return handleConversations(req, url, guard, options.conversations);
      }
      return new Response('<!doctype html><html><head><link rel="stylesheet" href="/probe.css"></head><body><main id="root"></main><script type="module" src="/probe.js"></script></body></html>', { headers: { "content-type": "text/html" } });
    },
  });
  return { server, calls };
}

export async function openDraftProbePage(url: URL) {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1100, height: 1000 } });
    const errors: string[] = [];
    page.on("pageerror", error => { errors.push(error.message); });
    await page.goto(url.toString());
    return { browser, page, errors };
  } catch (error) { await browser.close(); throw error; }
}

export async function withDraftBrowserProbe(rig: { makeInput: unknown; readonly editor: DeskDraftEditor; close(): Promise<void> }, run: (probe: { page: Page; calls: string[]; errors: string[] }) => Promise<void>, options: DraftBrowserOptions = {}) {
  let server: Awaited<ReturnType<typeof serveDraftBrowserProbe>>["server"] | undefined;
  let browser: Browser | undefined;
  try {
    const serving = await serveDraftBrowserProbe(rig, options);
    server = serving.server;
    const opened = await openDraftProbePage(new URL(options.route ?? "/", server.url));
    browser = opened.browser;
    await run({ ...opened, calls: serving.calls });
  } catch (error) {
    for (const page of browser?.contexts().flatMap(context => context.pages()) ?? []) {
      console.error(await page.locator("body").innerText());
      await page.screenshot({ path: "/tmp/desk-draft-probe-failure.png", fullPage: true });
    }
    throw error;
  } finally { await browser?.close(); await server?.stop(true); await rig.close(); }
}
