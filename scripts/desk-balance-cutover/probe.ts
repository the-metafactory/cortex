import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { findNode } from "../../src/balance";
import { openConversationHost, type HostStatus } from "../../src/conversations/host";
import type { TurnCall } from "../../src/conversations/model";
import { BALANCE_TASK_CONTRACT } from "../../src/conversations/domain-adapters/balance/task-binding";
import { BALANCE_PROJECT_CONTRACT } from "../../src/conversations/domain-adapters/balance/project-binding";
import { ProposalSchema } from "../../src/conversations/creation";
import { readOperationEvidence } from "../../src/conversations/domain-adapters/operations/legacy";
import { operationUuid } from "../../src/conversations/conversation-ids";
import { DomainAdapterRegistry } from "../../src/conversations/domain-adapters/registry";
import { balanceTaskState } from "../../src/conversations/domain-adapters/__tests__/fixtures/balance-task-fixtures";
import { handleConversations } from "../../src/surface/mc/api/conversations";
import { handleGetDesk } from "../../src/surface/mc/api/desk";
import { buildAllowedHostnames, type MutationGuardContext } from "../../src/surface/mc/api/mutation-guard";
import { initDatabase } from "../../src/surface/mc/db/init";
import { HandledLedger } from "../../src/surface/mc/desk/actions";
import { loadBalanceState, saveBalanceState } from "../../src/surface/mc/desk/balance-store";
import type { DeskOptions, DeskRuntime } from "../../src/surface/mc/desk/compose";
import { conversationSources } from "../../src/surface/mc/desk/conversation-sources";
import { BALANCE_CUTOVER_INBOX_ITEM, balanceCutoverFixture, balanceTasks as tasks, legacyInFlightCutover } from "../../src/surface/mc/desk/fixtures/balance-cutover";
import { loadMeta } from "../../src/surface/mc/desk/my-day";
import type { Grant, ProposalView } from "../../src/conversations/creation";
import { buildProbePage, serveProbePage } from "../lib/probe-page";
import { openDashboardProbe } from "../probe-dashboard-page";
import { withTempHome } from "../probe-temp-home";

const LABEL = "ai.meta-factory.cortex.balance-cutover-probe";
const AREA = "area-example";
const PORT = 8767;
const UNSAVED = "Saved before the cutover";
const DRAFT = "Draft through the cutover";
const EDITED_NOTE = "Edited before the cutover";

interface Reply { ok: boolean; error?: string; conversation?: { id: string }; proposal?: ProposalView; grants?: Grant[] }
interface Call { status: number; body: Reply }

const answering = (): TurnCall => async request => ({ text: "ok", session: request.session, resumed: false });

function deskOptions(): DeskOptions {
  return { enabled: true, displayName: "Cutover probe", topN: 5, rangerUrl: "", areas: [{ id: AREA, label: "Lab", color: "", repos: [], goals: [], policy: "local" }, { id: "area-home", label: "Home", color: "", repos: [], goals: [] }], sources: [] };
}

export async function runBalanceCutoverProbe(kind: "task" | "project"): Promise<void> {
  const contract = kind === "task" ? BALANCE_TASK_CONTRACT : BALANCE_PROJECT_CONTRACT;
  const owner = contract.owner;
  await withTempHome(async () => {
    const root = await mkdtemp(join(tmpdir(), "balance-cutover-probe-"));
    const db = initDatabase(join(root, "desk.sqlite"));
    saveBalanceState(db, balanceTaskState());
    const desk = deskOptions();
    const runtime: DeskRuntime = { ledger: new HandledLedger(), options: desk };
    const status = await openConversationHost({ dir: join(root, "conversations"), stack: "test", label: LABEL, expectedLabel: LABEL, lanes: { local: { provider: "test", model: "test-model" }, cloud: { provider: "test", model: "test-model" } }, turns: answering() });
    assert.equal(status.state, "ready", status.state === "unavailable" ? status.reason : "the conversation host did not open");
    const host = status.host;
    const registry = new DomainAdapterRegistry();
    const registered = registry.register(contract.declaration(), { handlers: {}, observations: {} });
    assert.ok(registered.ok, registered.ok ? "" : registered.error.code);
    const journal = host.lifecycleJournal(registry);
    const writers = host.lifecycleWriters();
    const cutoverFixture = balanceCutoverFixture({ db, desk: () => desk, journal, writers, contract, fences: host.lifecycleFences() });
    await host.attachSources(conversationSources({ db, desk: () => desk, [kind === "task" ? "balanceTaskCutover" : "balanceProjectCutover"]: () => cutoverFixture.cutover, deskItems: () => Promise.resolve([BALANCE_CUTOVER_INBOX_ITEM]) }));

    const guard: MutationGuardContext = { isLoopback: true, allowedHostnames: buildAllowedHostnames("127.0.0.1"), listenPort: PORT, principals: new Set() };
    const access = () => status as HostStatus;
    const call = async (method: string, path: string, body?: unknown): Promise<Call> => {
      const res = await handleConversations(new Request(`http://127.0.0.1:${PORT}${path}`, { method, headers: { host: `127.0.0.1:${PORT}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), new URL(`http://127.0.0.1:${PORT}${path}`), guard, access, { db, runtime });
      return { status: res.status, body: await res.json() as Reply };
    };
    const conversationId = (await call("POST", "/api/conversations", { title: "Balance cutover", origin: { kind: "web" } })).body.conversation?.id ?? "";
    assert.ok(conversationId, "the probe conversation was not created");
    const propose = async (title: string, fields: Record<string, string> = {}): Promise<Reply> => (await call("POST", `/api/conversations/${conversationId}/proposals`, { proposalId: randomUUID(), type: owner, fields: { area: AREA, title, ...fields } })).body;
    const revise = async (proposalId: string, revision: number, title: string): Promise<Reply> => (await call("PATCH", `/api/conversations/${conversationId}/proposals/${proposalId}`, { revision, fields: { area: AREA, title, note: EDITED_NOTE } })).body;
    const confirm = async (proposalId: string, revision: number, digest: string, grant?: { scope: "conversation" }) => call("POST", `/api/conversations/${conversationId}/proposals/${proposalId}/confirm`, { revision, digest, ...(grant ? { grant } : {}) });

    const saved = await propose(UNSAVED);
    const savedCard = saved.proposal;
    assert.ok(savedCard);
    const seededLegacy = await confirm(savedCard.proposal.proposalId, savedCard.proposal.revision, savedCard.digest);
    assert.equal(seededLegacy.body.proposal?.feedback, "created");
    const [savedTask] = tasks(db, UNSAVED);
    assert.ok(savedTask, "the pre-cutover legacy write created no Balance task");
    assert.equal(seededLegacy.body.proposal?.operation?.canonicalId, savedTask.id);
    assert.ok(loadMeta(db).receipts.some(receipt => receipt.outlineId === savedTask.id), "the pre-cutover task has no receipt");
    console.log(`legacy: one proposal was approved before the cutover and Balance keeps its ${kind} and receipt`);

    const draft = await propose(DRAFT);
    const draftCard = draft.proposal;
    assert.ok(draftCard);
    const edited = await revise(draftCard.proposal.proposalId, draftCard.proposal.revision, DRAFT);
    assert.equal(edited.proposal?.proposal.revision, draftCard.proposal.revision + 1, JSON.stringify(edited));

    const standing = await propose("Under a standing grant");
    const standingCard = standing.proposal;
    assert.ok(standingCard);
    assert.equal((await confirm(standingCard.proposal.proposalId, standingCard.proposal.revision, standingCard.digest, { scope: "conversation" })).body.proposal?.feedback, "created");
    const unbound = ((await call("GET", `/api/conversations/${conversationId}/proposals`)).body as unknown as { grants: Grant[] }).grants.find(grant => grant.connectionId === undefined);
    assert.ok(unbound, "the pre-cutover standing grant is already bound to a connection");
    console.log(`grant: a standing ${owner} permission was created before the cutover and carries no connection yet`);

    const creation = await host.creation();
    const sources = (await host.operations(conversationId)).filter(record => record.owner === owner && record.state === "created").map(record => ({ proposal: ProposalSchema.parse(creation.proposals[record.proposalId]), record, ownerReceipts: loadMeta(db).receipts.filter(item => item.id === operationUuid(record.operationId)) }));
    const inFlight = legacyInFlightCutover(journal, { kind, sources });
    const begun = await writers.begin(inFlight.plan, 0);
    const active = await writers.resume(begun.bindingKey, inFlight.steps);
    assert.equal(active.phase, "active");
    assert.equal((await journal.read(inFlight.source.record.operationId))?.journal.state, "uncertain");
    for (const source of sources) {
      const imported = readOperationEvidence(await journal.read(source.record.operationId));
      assert.equal(imported.kind, "legacy");
      assert.deepEqual(imported.kind === "legacy" && imported.source, source);
    }
    assert.equal((await confirm(draftCard.proposal.proposalId, edited.proposal!.proposal.revision, edited.proposal!.digest)).status, 409, "pre-cutover approval was accepted without fresh review");
    const native = (await call("POST", `/api/conversations/${conversationId}/proposals`, { proposalId: randomUUID(), type: "balance-inbox-task", fields: { item: BALANCE_CUTOVER_INBOX_ITEM.key, title: BALANCE_CUTOVER_INBOX_ITEM.title } })).body.proposal;
    assert.ok(native);
    const lapsed = (await call("GET", `/api/conversations/${conversationId}/proposals`)).body as unknown as { grants: Grant[] };
    assert.ok(lapsed.grants.find(grant => grant.grantId === unbound.grantId)?.renewal, "the old standing grant was not marked for renewal at cutover");
    console.log("cutover: the approved sequence is active, the in-flight operation imported uncertain and the old grant needs renewal");

    const script = await buildProbePage(join(import.meta.dir, "browser-probe.tsx"), "Balance cutover");
    const server = serveProbePage(script, (req, url) => {
      if (url.pathname === "/fixture.json") return Response.json({ conversationId });
      if (url.pathname === "/api/desk/balance-surfaces/destinations") return Response.json({ enabled: false });
      if (url.pathname === "/api/desk") return handleGetDesk(db, runtime, undefined);
      if (url.pathname.startsWith("/api/conversations")) return handleConversations(req, url, { ...guard, listenPort: server.port ?? PORT }, access, { db, runtime });
      return null;
    });
    const browser = await chromium.launch({ headless: true });
    try {
      const { page, load } = await openDashboardProbe(browser, server.url);
      await load();
      const card = page.locator("article.dcv-proposal", { hasText: DRAFT });
      await card.getByRole("button", { name: "Confirm creation" }).waitFor();
      assert.equal(await card.getByLabel("note").inputValue(), EDITED_NOTE, "the pre-cutover edit did not survive the cutover");
      await page.getByText("needs renewal before the next creation").waitFor();
      await card.getByRole("checkbox").check();
      await card.getByRole("button", { name: "Confirm creation" }).click();
      await card.getByText(new RegExp(`Created balance ${kind}`)).waitFor();
      const nativeCard = page.locator("article.dcv-proposal", { hasText: BALANCE_CUTOVER_INBOX_ITEM.title });
      await nativeCard.getByRole("button", { name: "Confirm creation" }).click();
      await nativeCard.getByText(/Created inbox task/i).waitFor();
      assert.ok(loadMeta(db).inbox.some(item => item.title === BALANCE_CUTOVER_INBOX_ITEM.title));
      console.log("browser: the migrated card and a native Inbox task were approved in the same conversation, and the old grant showed its renewal notice");
      await page.screenshot({ path: process.argv[2] ?? `/tmp/desk-balance-${kind}-cutover.png`, fullPage: true });

      const [created] = tasks(db, DRAFT);
      assert.ok(created, "the browser approval created no Balance task");
      assert.equal(created.note, EDITED_NOTE);
      const after = (await call("GET", `/api/conversations/${conversationId}/proposals`)).body as unknown as { proposals: ProposalView[] };
      const confirmed = after.proposals.find(item => item.proposal.proposalId === draftCard.proposal.proposalId);
      assert.equal(confirmed?.feedback, "created");
      const confirmedNative = after.proposals.find(item => item.proposal.proposalId === native.proposal.proposalId);
      assert.equal(confirmedNative?.feedback, "created");
      assert.ok(loadMeta(db).inbox.some(item => item.id === confirmedNative?.operation?.canonicalId && item.title === BALANCE_CUTOVER_INBOX_ITEM.title), "the Inbox task does not match the approved native card");
      for (const view of [confirmed, confirmedNative]) {
        const operation = view?.operation;
        assert.ok(operation?.canonicalId, "the approved card has no canonical object identity");
        const receipt = loadMeta(db).receipts.find(item => item.id === operationUuid(operation.operationId));
        assert.ok(receipt, "the approved card has no Balance transaction receipt");
        assert.equal(receipt.outlineId, operation.canonicalId, "the Balance transaction receipt belongs to a different object");
      }
      const grants = ((await call("GET", `/api/conversations/${conversationId}/proposals`)).body as unknown as { grants: Grant[] }).grants;
      assert.ok(grants.some(grant => grant.grantId !== unbound.grantId && grant.renewalRequired === false && grant.connectionId === active.plan.binding.connectionId && grant.destinations?.some(destination => destination.objectType === "area" && destination.canonicalId === AREA)), "the renewed grant is not bound to the project connection and area");
      assert.equal(confirmed?.operation?.canonicalId, created.id);
      assert.ok(findNode(loadBalanceState(db)!.outline, `area:${AREA}`)?.children.some(child => child.id === created.id), "the task is not under the approved area");
      const repeated = await confirm(confirmed!.proposal.proposalId, confirmed!.proposal.revision, confirmed!.digest);
      assert.equal(repeated.body.proposal?.operation?.canonicalId, created.id);
      assert.deepEqual(tasks(db, DRAFT).length, 1);
      assert.ok(tasks(db, UNSAVED)[0]);
      assert.equal((await propose("Under the renewed bound grant")).proposal?.feedback, "created", "renewed permission did not authorize the next creation in its bound area");
      assert.equal(tasks(db, "Under the renewed bound grant").length, 1);
      console.log(`readback: both approved cards match their Balance objects and transaction receipts, including the ${kind}, and the pre-cutover object is unchanged`);
      console.log(JSON.stringify({ binding: contract.capabilityId, cutover: active.epoch, connection: active.plan.binding.connectionId, created: created.id, grants: grants.length, temporaryStore: true }));
    } finally {
      await browser.close();
      void server.stop(true);
      await host.close();
      db.close();
      await rm(root, { recursive: true, force: true });
    }
  });

}
