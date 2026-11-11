import { strict as assert } from "node:assert";
import { chromium, type Browser, type Page } from "playwright";
import { hostileFlowEditorScript } from "../src/surface/mc/desk/__tests__/fixtures/flow-editor-fixtures";
import { withTempHome } from "./probe-temp-home";
import { serveFlowEditorProbe } from "./desk-flow-editor/server";

const EDITED_ACTION = "A_SECOND_STEP";

async function withFixture(browser: Browser, script: string | undefined, run: (fixture: Awaited<ReturnType<typeof serveFlowEditorProbe>>, page: Page, logs: string[]) => Promise<void>) {
  const fixture = await serveFlowEditorProbe(script);
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    const logs: string[] = [];
    page.on("console", message => { if (message.text().startsWith("FRAME_PROBE:")) logs.push(message.text()); });
    await page.goto(fixture.server.url.href);
    await run(fixture, page, logs);
  } finally {
    await context.close();
    await fixture.close();
  }
}

async function readBackFromPulse(fixture: Awaited<ReturnType<typeof serveFlowEditorProbe>>, page: Page) {
  for (let tries = 0; tries < 100; tries++) {
    const shown = await fixture.rig.flow.pulse.command(["show", "F_EDITOR_DRAFT"]);
    if (shown.code === 0) return JSON.parse(shown.stdout);
    await Bun.sleep(150);
  }
  throw new Error(`Pulse never reported the confirmed Flow. Host said: ${await page.locator("section[aria-label='Review proposed action']").innerText()} | buttons: ${(await page.getByRole("button").evaluateAll(b => b.map(x => `${x.textContent}:${(x as HTMLButtonElement).disabled}`))).join(",")}`);
}

const savedFlows = (fixture: Awaited<ReturnType<typeof serveFlowEditorProbe>>) => fixture.rig.flow.saveCalls();

await withTempHome(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    await withFixture(browser, undefined, async (fixture, page) => {
      await page.locator('[data-adapter-state="ready"]').waitFor({ timeout: 10_000 });
      const editor = page.frameLocator('iframe[title="Desk view host"]').frameLocator("iframe");
      await editor.getByRole("heading", { name: "Pulse findings" }).waitFor();
      await editor.getByText("No findings.").waitFor();
      const labels = await editor.getByRole("button").allInnerTexts();
      assert.deepEqual(labels, ["Apply edit", "Review in Desk"], "the editor offers no run, schedule, delete, save or approve control");
      const before = await fixture.rig.readDraft();
      const yaml = editor.getByLabel("Definition");
      await yaml.fill(`${await yaml.inputValue()}  - ${EDITED_ACTION}\n`);
      await editor.getByRole("button", { name: "Apply edit" }).click();
      await editor.getByText("Edit applied to the draft.").waitFor();
      const edited = await fixture.rig.readDraft();
      assert.ok(edited.draft.revision > before.draft.revision);
      assert.equal(edited.draft.fields["/definition"]?.origin, "principal");
      assert.match(String(edited.draft.fields["/definition"]?.value), new RegExp(EDITED_ACTION));
      await editor.getByText(/second step/i).waitFor();
      assert.equal(savedFlows(fixture), 0, "editing saves nothing");

      await yaml.fill("name: F_EDITOR_DRAFT\nactions: []\n");
      await editor.getByRole("button", { name: "Apply edit" }).click();
      await editor.getByText("The definition needs a non-empty actions list.").waitFor();
      await yaml.fill(String(edited.draft.fields["/definition"]?.value));
      await editor.getByRole("button", { name: "Apply edit" }).click();
      await editor.getByText("No findings.").waitFor();
      assert.equal(savedFlows(fixture), 0);

      await editor.getByRole("button", { name: "Review in Desk" }).click();
      await page.getByRole("heading", { name: "Review proposed action" }).waitFor();
      assert.equal(savedFlows(fixture), 0, "asking for host review saves nothing");
      await page.getByRole("button", { name: "Confirm draft" }).click();
      const flow = await readBackFromPulse(fixture, page);
      assert.equal(flow.name, "F_EDITOR_DRAFT");
      assert.equal(flow.provenance.conversation, fixture.rig.flow.id);
      assert.equal(typeof flow.sha256, "string");
      assert.equal(typeof flow.yaml, "string", "Pulse reports the saved definition");
      assert.match(flow.yaml, new RegExp(EDITED_ACTION), "the saved Flow carries the frame's edit");
      assert.ok(flow.yaml.startsWith(String(edited.draft.fields["/definition"]?.value)), "the saved definition begins with the edited host draft");
      assert.equal(savedFlows(fixture), 1, "only the host's own Confirm saved the Flow");
      assert.ok(fixture.rig.flow.noActivationCalls(), "no run, enable or schedule call");
      console.log("Edit in frame reached the host draft as a principal edit; host Confirm saved once; Pulse readback matches.");
    });

    for (const attack of ["save", "approve", "confirm-fetch", "throw"] as const) {
      await withFixture(browser, hostileFlowEditorScript(attack), async (fixture, page, logs) => {
        const before = await fixture.rig.readDraft();
        if (attack === "confirm-fetch") {
          await page.locator('[data-adapter-state="ready"]').waitFor({ timeout: 10_000 });
          await page.waitForFunction(() => true);
          for (let tries = 0; tries < 50 && !logs.includes("FRAME_PROBE:confirm-denied"); tries++) await page.waitForTimeout(100);
          assert.ok(logs.includes("FRAME_PROBE:confirm-denied") && !logs.includes("FRAME_PROBE:confirm-allowed"), "frame cannot call the host confirmation route");
        } else {
          await page.locator('[data-adapter-state="unavailable"]').waitFor({ timeout: 10_000 });
          await page.getByText("Safe host rendering of the Flow draft remains available.").waitFor();
          assert.equal(await page.locator('iframe[title="Desk view host"]').count(), 0);
        }
        assert.ok(attack === "throw" || logs.includes(`FRAME_PROBE:${attack}`), "hostile script ran");
        assert.equal(savedFlows(fixture), 0, `${attack}: nothing saved`);
        assert.ok(!fixture.requests.some(request => request.endsWith("/confirm")), `${attack}: no confirmation request reached the host`);
        assert.deepEqual(await fixture.rig.readDraft(), before, `${attack}: draft unchanged`);
        console.log(`Hostile frame (${attack}) saved nothing and left the draft unchanged.`);
      });
    }
  } finally { await browser.close(); }
});
console.log("Flow editor browser probe passed on a disposable stack.");
