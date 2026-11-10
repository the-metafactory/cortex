import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { chromium } from "playwright";
import { initDatabase } from "../src/surface/mc/db/init";
import { composeDesk } from "../src/surface/mc/desk/compose";
import { ATTENTION_DESK, attentionRig } from "../src/surface/mc/desk/__tests__/fixtures/adapter-attention-fixtures";
import { runWithTemporaryHome } from "./probe-temp-home";

async function probe() {
  const item = await attentionRig();
  const db = initDatabase(":memory:");
  const errors: string[] = [];
  let browser;
  let server;
  try {
    assert.equal((await item.ingest(0)).status, "ok");
    item.time.advance(720000);
    const fetched = item.fetches;
    const build = await Bun.build({ entrypoints: [join(import.meta.dir, "desk-attention/browser-probe.tsx")], target: "browser" });
    const script = build.outputs.find(output => output.path.endsWith(".js"));
    assert.ok(build.success && script, "Browser bundle builds.");
    server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/probe.js") return new Response(script, { headers: { "content-type": "text/javascript" } });
      if (url.pathname === "/probe.css") return new Response(build.outputs.find(output => output.path.endsWith(".css")) ?? "", { headers: { "content-type": "text/css" } });
      if (url.pathname === "/api/desk") return Response.json(await composeDesk(db, ATTENTION_DESK, undefined, { now: item.time.clock.now(), adapterAttention: item.feature }), { headers: { "Cache-Control": "no-store" } });
      if (url.pathname === "/api/desk/studio") return Response.json({ studio: null });
      if (url.pathname.startsWith("/api/")) return Response.json({ error: "This synthetic probe has no owner actions." }, { status: 404 });
      return new Response('<!doctype html><html><head><link rel="stylesheet" href="/probe.css"></head><body><div id="root"></div><script type="module" src="/probe.js"></script></body></html>', { headers: { "content-type": "text/html" } });
    } });
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    page.on("pageerror", error => { errors.push(error.message); });
    await page.goto(server.url.toString());
    const preview = page.getByRole("region", { name: "Catch-up preview" });
    await preview.getByText("Synthetic review", { exact: true }).waitFor();
    await preview.getByText("Stale observation", { exact: false }).waitFor();
    const output = process.env.DESK_ATTENTION_PROBE_DIR;
    if (output) { await mkdir(output, { recursive: true }); await page.screenshot({ path: join(output, "day.png"), fullPage: true }); }
    console.log("Day: permitted synthetic item and stale observation label are visible.");
    await preview.getByRole("button", { name: /Open inbox/ }).click();
    const catchup = page.locator("main.catchup");
    await catchup.getByRole("button", { name: "Synthetic review", exact: true }).waitFor();
    await catchup.getByText("Stale observation", { exact: true }).waitFor();
    await catchup.getByLabel("Card type").selectOption("adapter");
    await catchup.getByLabel("Search cards").fill("synthetic-one");
    assert.equal(await catchup.locator("article.desk-item").count(), 1);
    assert.equal(await catchup.getByRole("button", { name: "Plan this" }).count(), 0);
    if (output) await page.screenshot({ path: join(output, "catch-up.png"), fullPage: true });
    await catchup.getByRole("button", { name: "Synthetic review", exact: true }).click();
    const panel = page.locator("aside.desk-panel");
    const link = panel.getByRole("link", { name: /Open source/ });
    await link.waitFor();
    assert.equal(await link.getAttribute("href"), "https://example.test/synthetic");
    assert.equal(await panel.getByRole("button", { name: "Plan this" }).count(), 0);
    console.log("Catch-up: the generic type and text filters preserve the item; the source link is visible with no action controls.");
    await item.revoke();
    await page.getByRole("button", { name: "Refresh probe" }).evaluate((button: HTMLButtonElement) => { button.click(); });
    await page.waitForFunction(() => !document.body.textContent?.includes("Synthetic review"));
    assert.equal(await page.getByRole("link", { name: /Open source/ }).count(), 0);
    const revokedView = await (await page.request.get(new URL("/api/desk", server.url).toString())).json();
    assert.ok(!JSON.stringify(revokedView).includes("synthetic-one"));
    await page.goto(server.url.toString());
    await page.getByRole("region", { name: "Catch-up preview" }).waitFor();
    assert.ok(!(await page.locator("body").innerText()).includes("Synthetic review"));
    if (output) await page.screenshot({ path: join(output, "revoked.png"), fullPage: true });
    assert.equal(item.fetches, fetched, "Rendering never polls or queries the adapter.");
    assert.deepEqual(errors, []);
    console.log("Revoked: Day, Catch-up, the open detail and API omit the item, link and source identity; no provider fetch or owner effect.");
  } finally { await browser?.close(); await server?.stop(true); db.close(); await item.rig.close(); }
}

await runWithTemporaryHome(import.meta.path, probe);
