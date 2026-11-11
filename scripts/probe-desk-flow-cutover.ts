import { strict as assert } from "node:assert";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { chromium, type Browser } from "playwright";
import { openFlowCutoverRig } from "../src/conversations/domain-adapters/__tests__/fixtures/flow-cutover-fixtures";
import { readOperationEvidence } from "../src/conversations/domain-adapters/operations/legacy";
import { handleConversations } from "../src/surface/mc/api/conversations";
import { buildAllowedHostnames, type MutationGuardContext } from "../src/surface/mc/api/mutation-guard";
import { buildDeskProbeBundle, deskProbeEntry, serveDeskProbe } from "./lib/desk-browser-probe";
import { withTempHome } from "./probe-temp-home";

await withTempHome(async () => {
  const rig = await openFlowCutoverRig();
  let server: ReturnType<typeof serveDeskProbe> | undefined;
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({ headless: true });
    const seeded = await rig.seed();
    const legacyFlow = JSON.parse((await rig.pulse.command(["show", "F_LEGACY_SAVED"])).stdout);
    await rig.cutover.cutover(await rig.plan(), rig.steps(), 0);
    assert.deepEqual(JSON.parse((await rig.pulse.command(["show", "F_LEGACY_SAVED"])).stdout), legacyFlow);
    assert.deepEqual((await rig.creation.list(rig.id, rig.actor)).proposals.find(view => view.proposal.proposalId === seeded.saved.proposal.proposalId)?.operation, seeded.saved.operation);
    const note = await rig.propose("Native note after Flow cutover", "desk-note");
    const guard: MutationGuardContext = { isLoopback: true, allowedHostnames: buildAllowedHostnames("127.0.0.1"), listenPort: 0, principals: new Set([rig.actor.principal]), localPrincipal: rig.actor.principal };
    const bundle = await buildDeskProbeBundle(deskProbeEntry("desk-flow-cutover/browser.tsx"));
    server = serveDeskProbe(bundle, {
      desk: () => Promise.resolve({}),
      async extra(request, url) {
        if (url.pathname === "/fixture") return Response.json({ id: rig.id, types: rig.creation.capabilities(), view: await rig.creation.list(rig.id, rig.actor) });
        if (url.pathname.startsWith("/api/conversations")) return handleConversations(request, url, guard, () => ({ state: "ready", host: rig.host, tookOver: null, resumed: [], reconciled: [] }));
        if (url.pathname.startsWith("/api/desk/flows")) return Response.json({ enabled: false });
        return null;
      },
    });
    guard.listenPort = server.port ?? 0;
    const page = await browser.newPage();
    await page.goto(server.url.toString());
    await page.waitForSelector("body[data-mounted]", { state: "attached" });
    assert.match(await page.getByLabel("Standing creation permissions").innerText(), /Flow permission needs renewal/);
    const draft = page.getByRole("article").filter({ has: page.getByText(/F_LEGACY_EDITED/) });
    await draft.getByRole("checkbox").check();
    const saves = rig.pulse.calls.filter(argv => argv.includes("save")).length;
    await draft.getByRole("button", { name: "Approve", exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll("article.created").length === 2);
    const saved = (await rig.creation.list(rig.id, rig.actor)).proposals.find(view => view.proposal.proposalId === seeded.draft.proposal.proposalId);
    assert.ok(saved);
    assert.equal(saved.feedback, "created");
    assert.deepEqual(saved.proposal, seeded.draft.proposal);
    const repeated = await page.evaluate(async ({ id, proposalId, revision, digest }) => {
      const response = await fetch(`/api/conversations/${id}/proposals/${proposalId}/confirm`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ revision, digest }) });
      return response.json();
    }, { id: rig.id, proposalId: saved.proposal.proposalId, revision: saved.proposal.revision, digest: saved.digest });
    assert.equal(repeated.proposal.operation.operationId, saved.operation?.operationId);
    assert.equal(rig.pulse.calls.filter(argv => argv.includes("save")).length, saves + 1);
    const flow = JSON.parse((await rig.pulse.command(["show", "F_LEGACY_EDITED"])).stdout);
    assert.equal(flow.name, "F_LEGACY_EDITED");
    assert.equal(flow.provenance.conversation, rig.id);
    assert.equal(typeof flow.sha256, "string");
    const running = page.getByRole("article").filter({ has: page.getByText(/F_LEGACY_RUNNING/) });
    await running.getByRole("button", { name: "Check", exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll("article.created").length === 3);
    const evidence = readOperationEvidence(await rig.cutover.journal.read(seeded.running.operationId));
    assert.equal(evidence.kind, "legacy");
    assert.equal(evidence.kind === "legacy" && evidence.retryAllowed, false);
    const native = page.getByRole("article").filter({ has: page.getByText(/Native note after Flow cutover/) });
    await native.getByRole("button", { name: "Confirm creation", exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll("article.created").length === 4);
    assert.equal((await rig.creation.list(rig.id, rig.actor)).proposals.find(view => view.proposal.proposalId === note.proposal.proposalId)?.feedback, "created");
    assert.equal((await rig.propose("F_GRANTED_SAVE")).feedback, "created");
    assert.ok(rig.pulse.calls.every(argv => !argv.some(arg => ["run", "enable", "routine", "schedule"].includes(arg))));
    const screenshots = process.env.DESK_ADAPTER_BROWSER_SHOTS;
    if (screenshots) {
      await mkdir(screenshots, { recursive: true });
      await page.screenshot({ path: join(screenshots, "flow-cutover.png"), fullPage: true });
    }
    console.log("Flow cutover browser probe passed: edited legacy draft and saved receipt preserved; renewed connection-only save grant; Approve repeats one result; Pulse name/hash/conversation readback; imported running request Check; native Desk note in the same conversation. Disposable stack only.");
  } finally {
    await browser?.close();
    await server?.stop(true);
    await rig.close();
  }
});
