import { strict as assert } from "node:assert";
import { join } from "node:path";
import { chromium, type Page } from "playwright";
import { capabilities, type Capability, type CreationView, type ProposalView } from "../src/conversations/creation";
import { CLOSED_NODE, CORTEX, CORTEX_MAP, CORTEX_NODE, GRAPH_NODE_BODIES, MISSING_NODE, UNTICKED, openGraphReadRig } from "../src/conversations/domain-adapters/__tests__/fixtures/graph-read-fixtures";
import { handleDeskGraphSurfaces } from "../src/surface/mc/api/desk-graph-surfaces";
import { createGraphSurfaceReader, graphSurfaceRun } from "../src/surface/mc/desk/graph-surfaces";

const LEGACY_REPOSITORY = "github:github.com/example/legacy-only";
const UNTICKED_NODE = `${UNTICKED}#7`;
const rig = await openGraphReadRig();
let connectionOn = true;
const reader = createGraphSurfaceReader({
  connectionId: rig.connectionId,
  enabled: () => connectionOn,
  destinations: () => rig.adapter.destinations(),
  readNode: graphSurfaceRun({ connectionId: rig.connectionId, runner: rig.runner, context: rig.rig.context, sink: rig.rig.sink, inputSchemaRef: rig.nodeReadBinding.inputSchemaRef }),
  display: rig.nodeReadBinding.display,
});

const types: Capability[] = capabilities({ "graph-node": { create: () => Promise.reject(new Error("the probe never creates")), readback: () => Promise.resolve(null) } });
const spec = types.find(t => t.type === "graph-node");
assert.ok(spec, "graph-node capability missing");
const at = "2026-11-10T00:00:00.000Z";
const proposal = (id: string, fields: Record<string, string>, canonicalId?: string): ProposalView => ({
  proposal: { proposalId: id, conversationId: "probe-conversation", type: "graph-node", fields, revision: 1, entryId: null, dismissed: false, createdAt: at, updatedAt: at },
  digest: "0".repeat(64), sentence: `Create a graph node “${fields.title ?? id}”.`, capability: spec, missing: [], refusal: null,
  feedback: canonicalId ? "created" : "proposed",
  operation: canonicalId ? { operationId: `op-${id}`, conversationId: "probe-conversation", proposalId: id, revision: 1, owner: "graph-node", state: "created", canonicalId, history: [] } : null,
  earlier: [],
});
const draftFields = { repository: CORTEX, parent: "", title: "Draft from the probe", checkpoint: "The principal accepts it." };
const view: CreationView = {
  grants: [],
  proposals: [
    proposal("draft", draftFields),
    proposal("saved-open", { repository: CORTEX, parent: "", title: "Open" }, CORTEX_NODE),
    proposal("saved-closed", { repository: CORTEX, parent: "", title: "Closed" }, CLOSED_NODE),
    proposal("saved-missing", { repository: CORTEX, parent: "", title: "Missing" }, MISSING_NODE),
    proposal("saved-unticked", { repository: UNTICKED, parent: "", title: "Unticked" }, UNTICKED_NODE),
  ],
};

const bundle = await Bun.build({ entrypoints: [join(import.meta.dir, "desk-graph-surfaces/browser-probe.tsx")], target: "browser" });
const script = bundle.outputs[0];
if (!bundle.success || !script) throw new Error("The graph surfaces browser probe did not build");
const server = Bun.serve({
  hostname: "127.0.0.1", port: 0,
  fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/probe.js") return new Response(script, { headers: { "content-type": "text/javascript" } });
    if (url.pathname === "/fixture.json") return Response.json({ types, view });
    if (url.pathname.startsWith("/api/desk/graph-surfaces/")) return handleDeskGraphSurfaces(req, url, () => connectionOn ? reader : null);
    if (url.pathname === "/api/desk/graph-repositories") return Response.json({ repositories: [{ ref: LEGACY_REPOSITORY, label: LEGACY_REPOSITORY, forge: "github", enabled: true }] });
    return new Response('<!doctype html><html><body><div id="root"></div><script type="module" src="/probe.js"></script></body></html>', { headers: { "content-type": "text/html" } });
  },
});

const cardOf = (page: Page, title: string) => page.locator("article.dcv-proposal", { hasText: `“${title}”` });
const options = (page: Page, suffix: string): Promise<string[]> => page.$$eval(`datalist[id$="${suffix}"] option`, found => found.map(option => (option as HTMLOptionElement).value));
const soma = (target: string): { node: { title: string; kind: string }; status: string; url: string } => GRAPH_NODE_BODIES[target] as never;

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  page.on("pageerror", error => { throw error; });
  const load = async (): Promise<void> => { await page.goto(server.url.toString()); await page.waitForSelector("body[data-mounted]", { state: "attached" }); };

  await load();
  const draft = cardOf(page, "Draft from the probe");
  await page.waitForFunction(() => document.querySelectorAll('datalist[id$="-repositories"] option').length > 0);
  assert.deepEqual(await options(page, "-repositories"), [CORTEX, "gitlab:gitlab.example.org/claw/crisis-simulator"]);
  assert.ok((await options(page, "-nodes")).includes(CORTEX_MAP) && (await options(page, "-nodes")).includes(CORTEX_NODE));
  console.log("choosing: repository and parent choices come from work-graph.destinations; the legacy-only repository is not offered.");

  const confirm = draft.getByRole("button", { name: "Confirm creation" });
  const parent = draft.getByLabel("Parent node");
  await parent.fill(CLOSED_NODE);
  assert.equal(await confirm.isDisabled(), true);
  await draft.getByRole("button", { name: "Check reference" }).click();
  await draft.getByText(`Found: ${soma(`${CORTEX}#3350`).node.title} (closed).`).waitFor();
  assert.equal(await confirm.isDisabled(), false);
  await parent.fill(MISSING_NODE);
  await draft.getByRole("button", { name: "Check reference" }).click();
  await draft.getByText("That reference was not found.").waitFor();
  assert.equal(await confirm.isDisabled(), true);
  await parent.fill(UNTICKED_NODE);
  await draft.getByRole("button", { name: "Check reference" }).click();
  await draft.getByText("That reference is in a repository that is not ticked.").waitFor();
  assert.equal(await confirm.isDisabled(), true);
  console.log("exact reference: an entered reference is checked before Confirm enables; a closed node passes, missing and unticked ones do not.");

  const open = cardOf(page, "Open").locator("aside.dcv-card");
  await open.waitFor();
  const openFacts = soma(`${CORTEX}#3348`);
  assert.match(await open.innerText(), new RegExp(`${openFacts.node.title}[\\s\\S]*Open[\\s\\S]*Build`));
  assert.equal(await open.getByRole("link", { name: "Open" }).getAttribute("href"), openFacts.url);
  const closed = cardOf(page, "Closed").locator("aside.dcv-card");
  await closed.waitFor();
  const closedFacts = soma(`${CORTEX}#3350`);
  assert.match(await closed.innerText(), new RegExp(`${closedFacts.node.title}[\\s\\S]*Closed`));
  const missing = cardOf(page, "Missing").locator("aside.dcv-card");
  await missing.waitFor();
  assert.match(await missing.innerText(), /This item is unavailable/);
  assert.equal(await missing.getByRole("button").count(), 0);
  const unticked = cardOf(page, "Unticked").locator("aside.dcv-card");
  await unticked.waitFor();
  assert.match(await unticked.innerText(), /Content withheld/);
  assert.equal(await unticked.getByRole("link").count(), 0);
  assert.ok(!(await unticked.innerText()).includes("7"), "the unticked card must not carry node content");
  const argv = rig.calls.argv.map(call => call.join(" "));
  assert.ok(argv.every(line => !line.includes("/other")), "soma was never asked about the unticked repository");
  assert.equal(argv.filter(line => line === `soma graph node ${CORTEX}#9999 --read-repo ${CORTEX} --json`).length >= 1, true);
  console.log("cards: open and closed match soma graph node --json (title, status, kind, link); the missing node is unavailable with no retry; the unticked one withholds and soma never ran for it.");

  await rig.untick(CORTEX);
  await load();
  await cardOf(page, "Open").getByText("Content withheld").waitFor();
  await page.waitForFunction(() => document.querySelectorAll('datalist[id$="-repositories"] option').length > 0);
  assert.ok(!(await options(page, "-repositories")).includes(CORTEX));
  assert.ok(!(await options(page, "-nodes")).includes(CORTEX_NODE));
  console.log("unticked: the repository choice and its parents disappear, and its saved card withholds content.");

  connectionOn = false;
  await load();
  await page.waitForFunction(() => document.querySelectorAll('datalist[id$="-repositories"] option').length > 0);
  assert.deepEqual(await options(page, "-repositories"), [LEGACY_REPOSITORY]);
  await page.waitForTimeout(300);
  assert.equal(await page.locator("aside.dcv-card").count(), 0);
  assert.equal(await page.getByRole("button", { name: "Check reference" }).count(), 0);
  await draft.getByLabel("Parent node").fill("anything typed");
  assert.equal(await draft.getByRole("button", { name: "Confirm creation" }).isDisabled(), false);
  console.log("connection off: free-text fields and the legacy choices stay as they were; no card and no reference check appear.");
} finally {
  await browser.close();
  void server.stop(true);
  await rig.close();
}
