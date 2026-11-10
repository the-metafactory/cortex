import assert from "node:assert/strict";
import { join } from "node:path";
import { chromium, type Browser } from "playwright";
import { openDraftEditorRig, shelfRef } from "../src/surface/mc/__tests__/fixtures/draft-editor";
import { handleDeskDrafts } from "../src/surface/mc/api/desk-drafts";
import { buildAllowedHostnames } from "../src/surface/mc/api/mutation-guard";

const rig = await openDraftEditorRig();
const bundle = await Bun.build({ entrypoints: [join(import.meta.dir, "desk-make-editor/browser-probe.tsx")], target: "browser", naming: "[name].[ext]" });
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
    if (url.pathname.startsWith("/api/desk/drafts")) {
      calls.push(`${req.method} ${url.pathname}${url.search}`);
      return handleDeskDrafts(req, url, { isLoopback: true, allowedHostnames: buildAllowedHostnames("127.0.0.1"), listenPort: server.port ?? 0, principals: new Set() }, () => rig.editor);
    }
    return new Response('<!doctype html><html><head><link rel="stylesheet" href="/probe.css"></head><body><main id="root"></main><script type="module" src="/probe.js"></script></body></html>', { headers: { "content-type": "text/html" } });
  },
});
let browser: Browser | undefined;
try {
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1100, height: 1000 } });
  const errors: string[] = [];
  page.on("pageerror", error => { errors.push(error.message); });
  await page.goto(server.url.toString());
  await page.getByRole("button", { name: "Make", exact: true }).click();
  const editor = page.getByRole("article", { name: "Draft editor" });
  await page.getByLabel("Headline (required)", { exact: true }).waitFor();
  assert.equal(await page.getByLabel("Headline (required)", { exact: true }).inputValue(), "A synthetic draft");
  const shelf = editor.locator("fieldset", { has: page.locator("legend", { hasText: "shelf" }) });
  await shelf.getByText("Suggested", { exact: true }).waitFor();
  assert.equal(calls.filter(call => call.includes("/details")).length, 0);
  await shelf.getByRole("button", { name: "Sources for shelf", exact: true }).click();
  await shelf.getByText("turn: turn-1, revision 1").waitFor();
  assert.equal(calls.filter(call => call.includes("/details")).length, 1);
  console.log("Make: unfamiliar schema fields, suggested destination and on-demand source details rendered through host.drafts.");

  const revision = async () => Number(await editor.getAttribute("data-revision"));
  const changed = async (before: number) => { await page.waitForFunction(value => Number(document.querySelector('[aria-label="Draft editor"]')?.getAttribute("data-revision")) > value, before); };
  await page.getByLabel("Headline (required)", { exact: true }).fill("Principal headline");
  let before = await revision();
  await page.getByRole("button", { name: "Save Headline", exact: true }).click();
  await changed(before);
  before = await revision();
  await page.getByRole("button", { name: "Clear Notes", exact: true }).click();
  await changed(before);
  await page.getByText("Edited by you · Cleared").waitFor();
  rig.state.head = "2";
  rig.state.destinations.set("Specimen shelf", { kind: "unique", ref: shelfRef("shelf-b") });
  before = await revision();
  await page.getByRole("button", { name: "Refresh draft", exact: true }).click();
  await changed(before);
  assert.equal(await page.getByLabel("Headline (required)", { exact: true }).inputValue(), "Principal headline");
  assert.equal(await page.getByLabel("Notes", { exact: true }).inputValue(), "");
  const changes = page.getByRole("complementary", { name: "Destination changes" });
  await changes.waitFor();
  assert.match(await changes.innerText(), /shelf-a[\s\S]*shelf-b/);
  assert.equal(await page.getByRole("button", { name: "Confirm draft" }).isDisabled(), true);
  await page.getByLabel("I reviewed the destination changes").check();
  await page.screenshot({ path: process.argv[2] ?? join(rig.root, "make-editor.png"), fullPage: true });
  console.log("Edit, clear and refresh: principal fields survive; changed suggested destination shows old and new values before confirmation.");

  await rig.reopen();
  await page.reload();
  await page.getByRole("button", { name: "Make", exact: true }).click();
  await page.getByLabel("Headline (required)", { exact: true }).waitFor();
  assert.equal(await page.getByLabel("Headline (required)", { exact: true }).inputValue(), "Principal headline");
  assert.equal(await page.getByLabel("Notes", { exact: true }).inputValue(), "");
  const generations = rig.state.requests.length;
  await page.getByRole("button", { name: "Reopen draft", exact: true }).click();
  await page.getByRole("button", { name: "Confirm draft" }).click();
  await page.getByText("Policy blocks creation for this connection. The draft is saved; nothing was created.").waitFor();
  assert.equal(rig.state.requests.length, generations);
  assert.equal(rig.owner.admissions, 1);
  assert.equal(rig.owner.mutations, 0);
  assert.deepEqual(errors, []);
  console.log("Reopen after host restart preserves edits and clears without generation; blocked confirmation explains policy. Owner mutation calls: 0.");
} finally {
  await browser?.close();
  await server.stop(true);
  await rig.close();
}
