import { strict as assert } from "node:assert";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium, type Page } from "playwright";
import { capabilities, type CreationView, type ProposalView } from "../src/conversations/creation";
import { flowPulseRunner, openFlowReadRig } from "../src/conversations/domain-adapters/__tests__/fixtures/flow-read-fixtures";
import { flowSaveDefinition, flowSaveRequest, openFlowSaveRig } from "../src/conversations/domain-adapters/__tests__/fixtures/flow-save-fixtures";
import { flowSaveReceipt } from "../src/conversations/domain-adapters/flow/save-binding";
import { handleDeskFlows } from "../src/surface/mc/api/desk-flows";
import { HandledLedger } from "../src/surface/mc/desk/actions";
import type { DeskRuntime } from "../src/surface/mc/desk/compose";
import { flowSurfaceQueries, createFlowSurfaceReader } from "../src/surface/mc/desk/flow-surfaces";
import { openDashboardProbe } from "./probe-dashboard-page";
import { withTempHome } from "./probe-temp-home";

const NAME = "F_SAVE_EXAMPLE";
const OPERATION = flowSaveRequest().operationId;
const CHANGED = (): string => flowSaveDefinition().replace("text: example", "text: saved again under the same name");

const files = async (entrypoint: string): Promise<{ script: string; css: string | null }> => {
  const bundle = await Bun.build({ entrypoints: [join(import.meta.dir, entrypoint)], target: "browser" });
  const script = bundle.outputs.find(output => output.path.endsWith(".js"));
  const css = bundle.outputs.find(output => output.path.endsWith(".css"));
  if (!bundle.success || !script) throw new Error(`The ${entrypoint} bundle did not build`);
  return { script: await script.text(), css: css ? await css.text() : null };
};

const html = (src: string, css: string | null): string =>
  `<!doctype html><html><head>${css === null ? "" : `<style>${css}</style>`}</head><body><div id="root"></div><script type="module" src="${src}"></script></body></html>`;

const panelText = async (page: Page): Promise<string> => await page.locator("section[aria-label='Saved flows']").innerText();

await withTempHome(async () => {
  const saved = await openFlowSaveRig();
  try {
    const created = await saved.create();
    assert.equal(created.result.state, "created", JSON.stringify(created.result));
    const read = await openFlowReadRig({ flowsDir: saved.flowsDir });
    let connectionOn = true;
    let readBroken = false;
    const reader = createFlowSurfaceReader({
      connectionId: read.source.connectionId,
      destination: read.adapter.destination,
      enabled: () => connectionOn,
      ...flowSurfaceQueries({ connectionId: read.source.connectionId, destination: read.adapter.destination, runner: read.runner, context: read.rig.context, sink: read.rig.sink }),
      receipt: operationId => flowSaveReceipt(saved.journal, { operationId, connectionId: read.source.connectionId }),
    });
    const broken = createFlowSurfaceReader({
      connectionId: read.source.connectionId,
      destination: read.adapter.destination,
      enabled: () => true,
      query: () => Promise.reject(new Error("Pulse did not answer this probe.")),
      read: () => Promise.reject(new Error("Pulse did not answer this probe.")),
    });
    const legacy = flowPulseRunner({ flowsDir: saved.flowsDir, env: saved.env });
    const runtime: DeskRuntime = { options: { enabled: true, displayName: "", topN: 5, rangerUrl: "", areas: [], sources: [], flows: { pulse: saved.pulse } }, ledger: new HandledLedger() };
    const access = () => readBroken ? broken : connectionOn ? reader : null;

    let server: ReturnType<typeof Bun.serve> | undefined;
    try {
      const shown = JSON.parse((await saved.command(["show", NAME])).stdout) as { name: string; sha256: string; yaml: string };
      const listed = JSON.parse((await saved.command(["list", "--saved"])).stdout) as { flows: { name: string; source: string }[] };
      const tab = await files("desk-flow-tab/browser-probe.tsx");
      const card = await files("desk-flow-tab/card-probe.tsx");
      const at = new Date("2026-11-11T09:00:00Z").toISOString();
      const types = capabilities({ flow: { create: () => Promise.reject(new Error("the probe never creates")), readback: () => Promise.resolve(null) } });
      const spec = types.find(capability => capability.type === "flow");
      assert.ok(spec, "the flow capability is missing");
      const proposal: ProposalView = {
        proposal: { proposalId: "probe-flow", conversationId: "probe-conversation", type: "flow", fields: { name: NAME }, revision: 1, entryId: null, dismissed: false, createdAt: at, updatedAt: at },
        digest: "0".repeat(64), sentence: `Save the Flow “${NAME}”.`, capability: spec, missing: [], refusal: null, feedback: "created",
        operation: { operationId: OPERATION, conversationId: "probe-conversation", proposalId: "probe-flow", revision: 1, owner: "flow", state: "created", canonicalId: NAME, history: [] },
        earlier: [],
      };
      const view: CreationView = { grants: [], proposals: [proposal] };

      server = Bun.serve({
        hostname: "127.0.0.1", port: 0,
        fetch: async req => {
          const url = new URL(req.url);
          if (url.pathname === "/tab.js") return new Response(tab.script, { headers: { "content-type": "text/javascript" } });
          if (url.pathname === "/card.js") return new Response(card.script, { headers: { "content-type": "text/javascript" } });
          if (url.pathname === "/card-fixture.json") return Response.json({ types, view });
          if (url.pathname === "/api/desk/routine-editor") return Response.json([]);
          if (url.pathname === "/api/desk/routine-display") return Response.json({ error: "Routine display is not part of this probe." }, { status: 404 });
          if (url.pathname === "/api/desk/flows" || url.pathname.startsWith("/api/desk/flows/")) return handleDeskFlows(req, runtime, legacy, access);
          if (url.pathname === "/card") return new Response(html("/card.js", card.css), { headers: { "content-type": "text/html" } });
          return new Response(html("/tab.js", tab.css), { headers: { "content-type": "text/html" } });
        },
      });

      const browser = await chromium.launch({ headless: true });
      try {
        const tabPage = await openDashboardProbe(browser, server.url);
        await tabPage.load();
        const row = tabPage.page.locator("li.saved-flow-row", { hasText: NAME });
        await row.waitFor();
        const names = await tabPage.page.locator("li.saved-flow-row h3").allInnerTexts();
        assert.deepEqual(names, listed.flows.filter(flow => flow.source === "saved").map(flow => flow.name));
        const provenance = await row.locator("p.soft").innerText();
        assert.match(provenance, /From a conversation/);
        assert.equal(await row.locator("a").getAttribute("href"), "/conversations/conversation-example");
        console.log("tab: the list and its provenance match `pulse flow list --saved`");
        const withAdapter = await panelText(tabPage.page);

        await row.getByRole("button", { name: "Show definition" }).click();
        const yaml = await row.locator("pre.saved-flow-yaml").innerText();
        assert.equal(yaml, shown.yaml);
        console.log("definition: the expanded YAML matches `pulse flow show`");

        connectionOn = false;
        await tabPage.load();
        await tabPage.page.locator("li.saved-flow-row", { hasText: NAME }).waitFor();
        assert.equal(await panelText(tabPage.page), withAdapter);
        console.log("connection off: the tab answers exactly as the current Pulse path does");

        connectionOn = true;
        readBroken = true;
        await tabPage.load();
        await tabPage.page.getByText("Pulse could not read the saved flows.").waitFor();
        assert.equal(await tabPage.page.getByText("No saved flows yet").count(), 0);
        readBroken = false;
        console.log("read failure: the existing error shows and no empty list stands in for it");

        const cardPage = await openDashboardProbe(browser, new URL("/card", server.url));
        const savedCard = cardPage.page.locator("aside.dcv-card[aria-label='Saved flow card']");
        await cardPage.load();
        await savedCard.waitFor();
        const same = await savedCard.innerText();
        assert.match(same, /still matches the receipt/);
        assert.ok(same.includes(shown.sha256.slice(0, 12)), "the card must show the receipt's sha256");
        console.log("card: the saved Flow shows its receipt and that the content still matches it");

        await saved.command(["delete", NAME, "--expected-sha256", shown.sha256]);
        await cardPage.load();
        await savedCard.waitFor();
        const gone = await savedCard.innerText();
        assert.match(gone, /no longer available/);
        assert.ok(gone.includes(shown.sha256.slice(0, 12)), "the card must keep the historic receipt after deletion");
        console.log("deleted Flow: the card keeps the receipt and reads the current object as unavailable");

        const second = join(saved.dir, "second.yaml");
        await writeFile(second, CHANGED());
        const answered = await saved.command(["save", "--file", second, "--request-id", crypto.randomUUID(), "--conversation", "conversation-example"]);
        assert.equal(answered.code ?? 0, 0, JSON.stringify(answered));
        const again = JSON.parse((await saved.command(["show", NAME])).stdout) as { sha256: string };
        assert.notEqual(again.sha256, shown.sha256);
        await cardPage.load();
        await savedCard.waitFor();
        const changed = await savedCard.innerText();
        assert.match(changed, /differs from the receipt/);
        assert.ok(changed.includes(shown.sha256.slice(0, 12)), "the card must show the receipt's sha256");
        assert.ok(changed.includes(again.sha256.slice(0, 12)), "the card must show the current sha256");
        console.log("changed content: the card shows that the current sha256 differs from the receipt's");

        connectionOn = false;
        await cardPage.load();
        await cardPage.page.getByText(`Created flow ${NAME}`).waitFor();
        assert.equal(await cardPage.page.locator("aside[aria-label='Saved flow card']").count(), 0);
        console.log("connection off: the conversation card stays as it is today");
      } finally {
        await browser.close();
      }
    } finally {
      void server?.stop(true);
      await read.close();
    }
  } finally {
    await saved.close();
  }
});
