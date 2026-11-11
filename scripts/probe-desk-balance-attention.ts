import assert from "node:assert/strict";
import { join } from "node:path";
import { chromium } from "playwright";
import { planBalanceToday, seedBalanceObservationOverflow } from "../src/conversations/domain-adapters/__tests__/fixtures/balance-read-fixtures";
import { openBalanceAttentionStack } from "../src/surface/mc/desk/fixtures/balance-attention";
import { ALL_AREAS, briefing, selectItems, spokenBriefing } from "../src/surface/mc/desk/present";
import { localDay } from "../src/surface/mc/desk/time";
import { catchupItems } from "../src/surface/mc/dashboard-v2/components/desk-catch-up";
import { buildDeskProbeBundle, deskProbeEntry, serveDeskProbe } from "./lib/desk-browser-probe";
import { runWithTemporaryHome } from "./probe-temp-home";

const NOW = new Date(2026, 10, 1, 10).getTime();
const DATE = localDay(NOW);

await runWithTemporaryHome(import.meta.path, async () => {
  const stack = await openBalanceAttentionStack(NOW, { rowCapabilities: { granted: false } });
  const { balance, synthetic, compose } = stack;
  planBalanceToday(balance.db, DATE, ["task-wing"]);

  const errors: string[] = [];
  let browser;
  let server;
  try {
    assert.equal((await balance.check()).status, "ok");
    assert.equal((await synthetic.ingest(0)).status, "ok");
    const view = await compose();
    const adapters = view.items.filter(item => item.kind === "adapter");
    const titles = adapters.map(item => item.title).sort();
    assert.deepEqual(titles, ["Buy glue", "Cut the wing", "Studio answer", "Synthetic review"]);
    assert.equal(catchupItems(view.items, "", "all", "adapter").length, 4);
    assert.equal(catchupItems(view.items, "", "all", "adapter").every(item => item.kind === "adapter"), true);
    const planned = adapters.find(item => item.title === "Cut the wing");
    assert.equal(planned?.badge, "In today");
    assert.equal(adapters.find(item => item.title === "Buy glue")?.badge, undefined);
    const studio = adapters.find(item => item.title === "Studio answer");
    assert.deepEqual(studio?.actions, [{ id: "studio.respond", label: "Respond in Studio", role: "primary", wired: true, target: "thread-1" }]);
    assert.equal(studio?.actions.some(action => action.label === "Done"), false);
    const syntheticRow = adapters.find(item => item.title === "Synthetic review");
    assert.equal(syntheticRow?.score, 55);
    assert.deepEqual(syntheticRow?.actions.map(action => action.label), ["Complete"]);
    console.log("Catch-up: every actionable task is one row beside mail, with In today, Respond in Studio and no Done on the Studio row.");

    const selection = selectItems(view, ALL_AREAS, new Set());
    const needsYou = selection.needsYou.filter(item => item.kind === "adapter").map(item => item.title).sort();
    assert.deepEqual(needsYou, ["Cut the wing", "Synthetic review"]);
    assert.equal(selection.rest.some(item => item.title === "Buy glue"), true);
    const written = briefing(view, selection, null).lines[0] ?? "";
    const spoken = spokenBriefing(view, selection, null);
    for (const text of [written, spoken]) {
      assert.equal(text.includes("Buy glue"), false);
      assert.equal(text.includes("Studio answer"), false);
    }
    console.log("Needs you and the summaries: only dated adapter rows enter them; undated rows stay in Catch-up.");

    server = serveDeskProbe(await buildDeskProbeBundle(deskProbeEntry("desk-attention/browser-probe.tsx")), {
      desk: compose,
      extra: async (request, url) => {
        if (url.pathname !== "/api/desk/adapter" || request.method !== "POST") return null;
        const body = await request.json() as { key: string; capability: string };
        const admission = await synthetic.rig.service.admitRowCapability(synthetic.rig.context, { adapterId: "synthetic-one", connectionId: synthetic.sources[0]!.connectionId, capabilityId: body.capability, destinations: [synthetic.restrictions[0]!.source] });
        return Response.json({ ok: false, error: admission.kind === "allowed" ? "The host admitted this change, and its owner operation is not set up on this stack yet." : "The host authority does not permit this change." }, { status: admission.kind === "allowed" ? 501 : 403 });
      },
    });
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1200 } });
    page.on("pageerror", error => { errors.push(error.message); });
    await page.goto(server.url.toString());
    await page.getByRole("region", { name: "Catch-up preview" }).waitFor();
    await page.getByRole("button", { name: /Open inbox/ }).click();
    const catchup = page.locator("main.catchup");
    for (const title of ["Cut the wing", "Buy glue", "Studio answer", "Synthetic review"]) await catchup.getByRole("button", { name: title, exact: true }).first().waitFor();
    await catchup.getByLabel("Card type").selectOption("adapter");
    assert.equal(await catchup.locator("article.desk-item").count(), 4);
    await catchup.getByText("In today", { exact: true }).waitFor();
    assert.equal(await catchup.getByRole("button", { name: "Done", exact: true }).count(), 0);
    await catchup.getByRole("button", { name: "Complete", exact: true }).click();
    await page.getByText("The host authority does not permit this change.", { exact: true }).waitFor();
    const output = process.env.DESK_BALANCE_ATTENTION_PROBE_DIR;
    if (output) { await (await import("node:fs/promises")).mkdir(output, { recursive: true }); await page.screenshot({ path: join(output, "catch-up.png"), fullPage: true }); }
    await catchup.getByRole("button", { name: "Respond in Studio", exact: true }).click();
    assert.equal(new URL(page.url()).searchParams.get("desk"), "studio");
    assert.equal(new URL(page.url()).searchParams.get("thread"), "thread-1");
    await page.getByRole("tab", { name: "Catch-up" }).click();
    await catchup.getByRole("button", { name: "Synthetic review", exact: true }).first().waitFor();
    assert.deepEqual(errors, []);
    console.log("Browser: Balance tasks and a synthetic adapter share one Catch-up list; a declared capability is denied by the host.");

    const before = synthetic.fetches;
    await page.getByRole("button", { name: "Refresh probe" }).click();
    await catchup.getByRole("button", { name: "Synthetic review", exact: true }).first().waitFor();
    assert.equal(synthetic.fetches, before, "Rendering never polls or queries the adapter.");
    console.log("Catch-up rendering never queries the synthetic adapter. Balance refresh stays on the My Day projection path.");

    await balance.allowHome();
    const actionable = seedBalanceObservationOverflow(balance);
    planBalanceToday(balance.db, DATE, [actionable[actionable.length - 1]!]);
    await balance.check();
    const overflow = await compose();
    const openRows = overflow.items.filter(item => item.source === "balance" && item.title.startsWith("Actionable "));
    assert.equal(openRows.length, actionable.length);
    assert.equal(new Set(openRows.map(item => item.key)).size, actionable.length);
    assert.equal(openRows.find(item => item.key.includes(actionable[actionable.length - 1]!))?.badge, "In today");
    assert.equal(overflow.sources.find(source => source.id === "adapter:balance")?.ok, true);
    assert.equal(openRows.every(item => item.freshness === "fresh"), true);
    await page.getByRole("button", { name: "Refresh probe" }).click();
    await catchup.getByRole("button", { name: "Actionable Home 7", exact: true }).waitFor();
    assert.equal(await catchup.getByRole("button", { name: /^Actionable / }).count(), actionable.length);
    if (output) await page.screenshot({ path: join(output, "catch-up-overflow.png"), fullPage: true });
    assert.deepEqual(errors, []);
    console.log("Paging: completed history cannot hide actionable tasks from later areas or make complete observations stale.");
    seedBalanceObservationOverflow(balance, 11);
    await balance.check();
    await page.getByRole("button", { name: "Refresh probe" }).click();
    await catchup.getByRole("button", { name: "Actionable Home 10", exact: true }).waitFor();
    assert.equal(await catchup.getByRole("button", { name: /^Actionable / }).count(), 22);
    await synthetic.store.gap(synthetic.sources[0]!);
    await page.getByRole("button", { name: "Refresh probe" }).click();
    await catchup.getByText("Adapter observations are incomplete. Some items may be missing.", { exact: true }).waitFor();
    console.log("Real gaps: an incomplete synthetic source still shows its warning beside the complete Balance rows.");
  } finally {
    await browser?.close();
    await server?.stop(true);
    await stack.close();
  }
});
