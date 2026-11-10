import { strict as assert } from "node:assert";
import { join } from "node:path";
import { chromium, type Page } from "playwright";
import { capabilities, type CreationView, type ProposalView } from "../src/conversations/creation";
import { openBalanceReadRig } from "../src/conversations/domain-adapters/__tests__/fixtures/balance-read-fixtures";
import { findNode } from "../src/balance";
import { deskFixtureOptions } from "../src/surface/mc/__tests__/fixtures/desk-options-fixture";
import { handleDeskBalanceSurfaces } from "../src/surface/mc/api/desk-balance-surfaces";
import { handleGetDesk } from "../src/surface/mc/api/desk";
import { handleDeskMyDay } from "../src/surface/mc/api/desk-my-day";
import { HandledLedger } from "../src/surface/mc/desk/actions";
import { loadMeta } from "../src/surface/mc/desk/balance-sync";
import { areaProjects, balanceDestinations } from "../src/surface/mc/desk/balance-destinations";
import { createBalanceSurfaceReader, balanceSurfaceRun } from "../src/surface/mc/desk/balance-surfaces";
import type { DeskOptions, DeskRuntime } from "../src/surface/mc/desk/compose";
import { localDay } from "../src/surface/mc/desk/time";
import { openDashboardProbe } from "./probe-dashboard-page";
import { withTempHome } from "./probe-temp-home";

const NOW = new Date(2026, 10, 10, 10).getTime();
const DATE = localDay(NOW);
const TITLE = "Probe saved card";
const NOTE = "Written through the My Day path";

const cardOf = (page: Page, title: string) => page.locator("article.dcv-proposal", { hasText: `“${title}”` });
const optionsOf = async (page: Page, card: ReturnType<typeof cardOf>, label: string): Promise<string[]> => {
  await card.getByRole("combobox", { name: label }).click();
  const labels = await card.getByRole("option").allInnerTexts();
  await page.keyboard.press("Escape");
  return labels;
};

await withTempHome(async () => {
  const rig = await openBalanceReadRig();
  let connectionOn = true;
  const reader = createBalanceSurfaceReader({
    connectionId: rig.rig.connection.connectionId,
    enabled: () => connectionOn,
    destinations: () => rig.destinations(),
    readTask: balanceSurfaceRun({ connectionId: rig.rig.connection.connectionId, runner: rig.runner, context: rig.rig.context, sink: rig.rig.sink, inputSchemaRef: rig.taskReadBinding.inputSchemaRef }),
    display: rig.taskReadBinding.display,
  });
  const desk: DeskOptions = { ...deskFixtureOptions, areas: rig.areas.map(area => ({ ...area, repos: [], goals: [] })) };
  const runtime: DeskRuntime = { options: desk, ledger: new HandledLedger() };
  const types = capabilities({ "balance-task": { create: () => Promise.reject(new Error("the probe never creates")), readback: () => Promise.resolve(null) } });
  const spec = types.find(capability => capability.type === "balance-task");
  assert.ok(spec, "balance-task capability missing");
  const at = new Date(NOW).toISOString();
  const proposal = (id: string, fields: Record<string, string>, canonicalId?: string): ProposalView => ({
    proposal: { proposalId: id, conversationId: "probe-conversation", type: "balance-task", fields, revision: 1, entryId: null, dismissed: false, createdAt: at, updatedAt: at },
    digest: "0".repeat(64), sentence: `Create a Balance task “${fields.title ?? id}”.`, capability: spec, missing: [], refusal: null,
    feedback: canonicalId ? "created" : "proposed",
    operation: canonicalId ? { operationId: `op-${id}`, conversationId: "probe-conversation", proposalId: id, revision: 1, owner: "balance-task", state: "created", canonicalId, history: [] } : null,
    earlier: [],
  });
  let savedTaskId: string | undefined;
  let deskReads = true;
  let surfacesReads = true;
  const view = (): CreationView => ({
    grants: [],
    proposals: [
      proposal("draft", { title: "Draft from the probe" }),
      proposal("saved", { area: "area-example", project: "project-glider", title: TITLE, note: NOTE, due: "2026-12-24" }, savedTaskId),
    ],
  });

  const bundle = await Bun.build({ entrypoints: [join(import.meta.dir, "desk-balance-surfaces/browser-probe.tsx")], target: "browser" });
  const script = bundle.outputs[0];
  if (!bundle.success || !script) throw new Error("The Balance surfaces browser probe did not build");
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch: async req => {
      const url = new URL(req.url);
      if (url.pathname === "/probe.js") return new Response(script, { headers: { "content-type": "text/javascript" } });
      if (url.pathname === "/fixture.json") return Response.json({ types, view: view() });
      if (url.pathname === "/api/desk") return deskReads ? handleGetDesk(rig.db, runtime, undefined) : Response.json({ error: "Desk reads are broken for this probe." }, { status: 503 });
      if (url.pathname === "/api/desk/my-day") return deskReads ? handleDeskMyDay(req, rig.db, runtime, undefined, NOW) : Response.json({ error: "Desk reads are broken for this probe." }, { status: 503 });
      if (url.pathname.startsWith("/api/desk/balance-surfaces/")) return surfacesReads ? handleDeskBalanceSurfaces(req, url, () => connectionOn ? reader : null) : Response.json({ error: "The Balance read failed for this probe." }, { status: 502 });
      return new Response('<!doctype html><html><body><div id="root"></div><script type="module" src="/probe.js"></script></body></html>', { headers: { "content-type": "text/html" } });
    },
  });

  const browser = await chromium.launch({ headless: true });
  try {
    const { page, load } = await openDashboardProbe(browser, server.url);

    await load();
    const created = await fetch(new URL("/api/desk/my-day", server.url), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ date: DATE, requestId: crypto.randomUUID(), command: { op: "outline-add", revision: loadMeta(rig.db).revision, parent: "project-glider", title: TITLE, note: NOTE, dueDate: "2026-12-24", kind: "task" } }) });
    assert.equal(created.status, 200, await created.clone().text());
    savedTaskId = (await created.json() as { outlineId?: string }).outlineId;
    assert.ok(savedTaskId, "the My Day path returned no created task id");
    console.log("save: the My Day path created one task in the temporary Desk store");

    await load();
    const draft = cardOf(page, "Draft from the probe");
    const areaChoices = await optionsOf(page, draft, "Area");
    const deskView = await page.evaluate(async () => await (await fetch("/api/desk")).json()) as { areas: { id: string; label: string }[]; myDay?: { outline: Parameters<typeof balanceDestinations>[0] } };
    assert.ok(deskView.myDay, "the Desk view served no My Day");
    const legacy = balanceDestinations(deskView.myDay.outline, deskView.areas);
    assert.deepEqual(areaChoices, deskView.areas.map(area => area.label));
    await draft.getByRole("combobox", { name: "Area" }).click();
    await draft.getByRole("option", { name: "Lab", exact: true }).click();
    const projectChoices = await optionsOf(page, draft, "Parent project");
    assert.deepEqual(projectChoices, ["Area level — no parent project", ...areaProjects(legacy, "area-example").map(option => option.label)]);
    console.log("choices: the area and project options come from balance.destinations and match what /api/desk offers today");

    deskReads = false;
    await load();
    assert.deepEqual(await optionsOf(page, cardOf(page, "Draft from the probe"), "Area"), deskView.areas.map(area => area.label));
    const withoutDesk = await cardOf(page, TITLE).locator("section.dtd-summary").innerText();
    assert.equal(await page.evaluate(async () => (await fetch("/api/desk")).status), 503);
    assert.equal(await page.evaluate(async () => (await fetch("/api/desk/my-day")).status), 503);
    deskReads = true;
    console.log("isolation: with /api/desk and /api/desk/my-day failing, the picker and the card still read through the surfaces route");

    await load();
    const savedPanel = cardOf(page, TITLE).locator("section.dtd-summary");
    await savedPanel.waitFor();
    const day = await page.evaluate(async () => await (await fetch("/api/desk/my-day")).json()) as { outline: Parameters<typeof findNode>[0] };
    const node = findNode(day.outline, savedTaskId);
    assert.ok(node, "the saved task is missing from /api/desk/my-day");
    const facts = node as { title: string; dueDate?: string; note?: string };
    const text = await savedPanel.innerText();
    assert.equal(text, withoutDesk, "the adapter card and the /api/desk/my-day card must show the same task");
    for (const value of [facts.title, facts.dueDate ?? "", facts.note ?? ""]) assert.ok(text.includes(value), `the card is missing ${value}`);
    assert.ok(!text.includes("Importance"), "the adapter read releases no importance, so the card must not claim one");
    await cardOf(page, TITLE).getByRole("button", { name: "Edit" }).click();
    await page.waitForURL(/desk=balance/);
    assert.equal(new URL(page.url()).searchParams.get("balance-item"), savedTaskId);
    console.log("card: the shared summary matches /api/desk/my-day and Edit opens the Balance item");

    surfacesReads = false;
    await load();
    const retried = cardOf(page, TITLE);
    await retried.getByText("could not be read").waitFor();
    assert.equal(await retried.locator("section.dtd-summary").count(), 0);
    await retried.getByRole("button", { name: "Retry task" }).click();
    await retried.getByText("could not be read").waitFor();
    surfacesReads = true;
    await retried.getByRole("button", { name: "Retry task" }).click();
    await retried.locator("section.dtd-summary").getByText(facts.title).waitFor();
    console.log("read failure: a failed surfaces read shows a retry instead of a deleted task, and retrying after recovery restores the card");

    connectionOn = false;
    await load();
    const offDraft = cardOf(page, "Draft from the probe");
    assert.deepEqual(await optionsOf(page, offDraft, "Area"), deskView.areas.map(area => area.label));
    await cardOf(page, TITLE).locator("section.dtd-summary").getByText(facts.title).waitFor();
    console.log("connection off: the picker and the card keep their /api/desk and /api/desk/my-day reads");

    connectionOn = true;
    rig.removeTask(savedTaskId);
    await load();
    const gone = cardOf(page, TITLE);
    await gone.getByText("is no longer available").waitFor();
    assert.equal(await gone.getByRole("button").count(), 0);
    assert.match(await gone.locator("small").innerText(), /Balance task · created/);
    console.log("deleted task: the receipt stays created, the card says the task is unavailable and offers no retry");

    rig.removeArea("area-example");
    await load();
    assert.deepEqual(await optionsOf(page, cardOf(page, "Draft from the probe"), "Area"), ["Home"]);
    const withheld = cardOf(page, TITLE);
    await withheld.getByText("content is withheld").waitFor();
    assert.equal(await withheld.locator("section.dtd-summary").count(), 0);
    assert.ok(!(await withheld.getByText("content is withheld").innerText()).includes(facts.title), "the withheld card must not carry task content");
    assert.equal(await withheld.getByRole("button").count(), 0);
    console.log("removed area: the picker omits it and the card withholds task content");
  } finally {
    await browser.close();
    void server.stop(true);
    await rig.close();
  }
});
