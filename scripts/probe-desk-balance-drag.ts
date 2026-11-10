import assert from "node:assert/strict";
import { chromium } from "playwright";
import { balanceConnectionStack } from "../src/surface/mc/__tests__/fixtures/balance-connection";
import { runWithTemporaryHome } from "./probe-temp-home";

async function probe() {
  const stack = await balanceConnectionStack();
  const browser = await chromium.launch({ headless: true });
  try {
    const bundle = await Bun.build({ entrypoints: [new URL("./desk-balance-drag/browser.tsx", import.meta.url).pathname], target: "browser" });
    assert.ok(bundle.success, JSON.stringify(bundle.logs));
    const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
    page.setDefaultTimeout(10_000);
    page.on("pageerror", error => console.error(error.message));
    for (const output of bundle.outputs) {
      const body = await output.text();
      await page.route(`**/${output.path.split("/").at(-1)}`, route => route.fulfill({ contentType: output.type, body }));
    }
    await page.goto(`${stack.url}/health`);
    const js = bundle.outputs.find(output => output.path.endsWith(".js"));
    const css = bundle.outputs.find(output => output.path.endsWith(".css"));
    assert.ok(js);
    await page.setContent(`<html><head>${css ? `<link rel="stylesheet" href="/${css.path.split("/").at(-1)}">` : ""}</head><body style="margin:0;font-family:Arial"><div id="root"></div><script type="module" src="/${js.path.split("/").at(-1)}"></script></body></html>`);
    const source = page.locator(".dbl-row").filter({ has: page.getByText("Fold the body", { exact: true }) });
    const target = page.locator(".dbl-row").filter({ has: page.getByText("Cut the wing", { exact: true }) });
    await source.waitFor();
    const from = await source.locator("strong").boundingBox();
    const to = await target.boundingBox();
    assert.ok(from && to);
    await page.mouse.move(from.x + 35, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(to.x + 180, to.y + 2, { steps: 12 });
    await page.screenshot({ path: "/tmp/cortex-balance-drag.png" });
    assert.equal(await page.locator(".dbl-drag-preview").count(), 1, "The whole row follows the pointer during the drag");
    assert.match(await page.locator(".dbl-drag-preview").innerText(), /Fold the body/);
    assert.equal(await target.evaluate(element => element.classList.contains("drop-before")), true, "The insertion point is highlighted");
    const saved = page.waitForResponse(response => response.url().endsWith("/api/desk/my-day") && response.request().method() === "POST");
    await page.mouse.up();
    assert.equal((await saved).status(), 200);
    await page.locator(".dbl-drag-preview").waitFor({ state: "detached" });
    const current = await stack.http("/api/desk/my-day");
    assert.equal(current.body.outline.children[0].children[0].children[0].id, "task-done");
    await page.reload();
    console.log("PASS: drag from the title shows the whole row and insertion point; drop persists the reorder through the real owner.");
  } finally { await browser.close(); await stack.close(); }
}
await runWithTemporaryHome(import.meta.path, probe);
