import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { openDraftEditorRig, shelfRef } from "../src/surface/mc/__tests__/fixtures/draft-editor";
import { withDraftBrowserProbe } from "./desk-make-editor/server";
import { serveFrameProbe } from "./desk-adapter-frame/server";
import type { FrameAttack } from "../src/surface/mc/desk/__tests__/fixtures/adapter-frame-ui";

const shots = process.argv[2] ?? process.env.DESK_ADAPTER_BROWSER_SHOTS ?? await mkdtemp(join(tmpdir(), "desk-adapter-browser-"));
const draftRevision = (editor: { getAttribute(name: string): Promise<string | null> }) => editor.getAttribute("data-revision").then(Number);

async function cardApprovedEditedRefreshed(): Promise<void> {
  const rig = await openDraftEditorRig();
  await withDraftBrowserProbe(rig, async ({ page, errors }) => {
    await page.getByRole("button", { name: "Make", exact: true }).click();
    const editor = page.getByRole("article", { name: "Draft editor" });
    await page.getByLabel("Headline (required)", { exact: true }).waitFor();
    const headline = page.getByLabel("Headline (required)", { exact: true });
    await headline.fill("Principal headline");
    let before = await draftRevision(editor);
    await page.getByRole("button", { name: "Save Headline", exact: true }).click();
    await page.waitForFunction(value => Number(document.querySelector('[aria-label="Draft editor"]')?.getAttribute("data-revision")) > value, before);
    rig.state.head = "2";
    rig.state.destinations.set("Specimen shelf", { kind: "unique", ref: shelfRef("shelf-b") });
    before = await draftRevision(editor);
    await page.getByRole("button", { name: "Refresh draft", exact: true }).click();
    await page.waitForFunction(value => Number(document.querySelector('[aria-label="Draft editor"]')?.getAttribute("data-revision")) > value, before);
    assert.equal(await headline.inputValue(), "Principal headline", "edit survives refresh");
    await page.getByLabel("I reviewed the destination changes").check();
    const confirming = page.waitForRequest(request => request.method() === "POST" && request.url().endsWith("/confirm"));
    await page.getByRole("button", { name: "Confirm draft" }).click();
    const confirmation = await confirming;
    const accepted = await (await confirmation.response())?.json() as { confirmation?: { kind?: string; operationId?: string } };
    assert.deepEqual(accepted.confirmation, { kind: "accepted", operationId: "synthetic-operation" });
    await page.waitForLoadState("networkidle");
    await page.screenshot({ path: join(shots, "card-approved.png"), fullPage: true });
    const path = new URL(confirmation.url()).pathname;
    const approve = async () => (await rig.call("POST", path, confirmation.postDataJSON())).json();
    const first = await approve();
    const second = await approve();
    assert.deepEqual(first, second, "repeated Approve returns the same result");
    assert.deepEqual(errors, []);
    console.log("Card: edit kept through refresh, Approve accepted, repeated Approve returned the same result.");
  });
}

async function deniedDestination(): Promise<void> {
  const rig = await openDraftEditorRig();
  await withDraftBrowserProbe(rig, async ({ page }) => {
    await page.getByRole("button", { name: "Make", exact: true }).click();
    await page.getByLabel("Headline (required)", { exact: true }).waitFor();
    rig.state.localOnly.add("turn-1");
    rig.editor.audience = "cloud";
    await page.getByRole("button", { name: "Reopen draft", exact: true }).click();
    await page.getByRole("button", { name: "Confirm draft" }).click();
    await page.getByText("Policy withholds draft fields in this context.", { exact: false }).waitFor();
    await page.screenshot({ path: join(shots, "card-denied.png"), fullPage: true });
    assert.equal(rig.owner.admissions, 0);
    assert.equal(rig.owner.mutations, 0);
    console.log("Denied destination: Approve created nothing; owner call count 0.");
  });
}

async function hostileFrames(): Promise<void> {
  const attacked: string[] = [];
  const attacker = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch(req) { attacked.push(req.url); return new Response("attacker"); } });
  const browser = await chromium.launch({ headless: true });
  try {
    const cases: { attack: FrameAttack; state: "ready" | "unavailable" }[] = [
      { attack: "good", state: "ready" }, { attack: "fetch", state: "ready" }, { attack: "parent", state: "ready" },
      { attack: "forged", state: "unavailable" }, { attack: "ambient", state: "ready" }, { attack: "wrong-generation", state: "unavailable" },
    ];
    for (const { attack, state } of cases) {
      const fixture = await serveFrameProbe(attack, "local", attacker.url.origin);
      const context = await browser.newContext();
      try {
        const page = await context.newPage();
        const ran: string[] = [];
        page.on("console", message => { if (message.text().startsWith("FRAME_PROBE:")) ran.push(message.text()); });
        const start = attacked.length;
        await page.goto(fixture.server.url.href);
        await page.locator(`[data-adapter-state="${state}"]`).waitFor({ timeout: 8000 });
        await page.waitForTimeout(150);
        assert.ok(ran.includes(`FRAME_PROBE:${attack}`), `${attack}: attack script ran`);
        if (attack === "fetch") assert.ok(ran.includes("FRAME_PROBE:fetch-denied") && !ran.includes("FRAME_PROBE:fetch-allowed"), "network access blocked and reported");
        if (attack === "parent") assert.ok(ran.includes("FRAME_PROBE:parent-denied"), "parent access blocked and reported");
        assert.equal(await page.locator("body").getAttribute("data-compromised"), null);
        assert.equal(attacked.length, start, "zero attacker requests");
        assert.equal(fixture.rig.authority.calls.dispatch + fixture.rig.authority.calls.cancel, 0, "zero owner mutations");
        if (state === "unavailable") await page.getByText("Safe host history remains available.").waitFor();
        await page.screenshot({ path: join(shots, `frame-${attack}.png`), fullPage: true });
        console.log(`Frame ${attack}: ${state}; blocked and reported.`);
      } finally { await context.close(); await fixture.close(); }
    }
  } finally { await browser.close(); await attacker.stop(true); }
}

await cardApprovedEditedRefreshed();
await deniedDestination();
await hostileFrames();
console.log(`Screenshots (synthetic data only): ${shots}`);
