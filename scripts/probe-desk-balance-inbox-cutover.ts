import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HostStatus } from "../src/conversations/host";
import { openProbeHost } from "./desk-balance-cutover/host";
import { BALANCE_INBOX_TASK_CONTRACT } from "../src/conversations/domain-adapters/balance/inbox-binding";
import { DomainAdapterRegistry } from "../src/conversations/domain-adapters/registry";
import { balanceTaskState } from "../src/conversations/domain-adapters/__tests__/fixtures/balance-task-fixtures";
import { operationUuid } from "../src/conversations/conversation-ids";
import type { ProposalView } from "../src/conversations/creation";
import { handleConversations } from "../src/surface/mc/api/conversations";
import { buildAllowedHostnames, type MutationGuardContext } from "../src/surface/mc/api/mutation-guard";
import { initDatabase } from "../src/surface/mc/db/init";
import { HandledLedger } from "../src/surface/mc/desk/actions";
import { saveBalanceState } from "../src/surface/mc/desk/balance-store";
import type { DeskOptions, DeskRuntime } from "../src/surface/mc/desk/compose";
import { conversationSources } from "../src/surface/mc/desk/conversation-sources";
import { balanceCutoverFixture, legacyInFlightCutover } from "../src/surface/mc/desk/fixtures/balance-cutover";
import type { ListedMail } from "../src/surface/mc/desk/mail-actions";
import { queryMailLog } from "../src/surface/mc/desk/mail-log";
import { loadMeta } from "../src/surface/mc/desk/my-day";
import type { DeskItem } from "../src/surface/mc/desk/types";
import { withTempHome } from "./probe-temp-home";

const LABEL = "ai.meta-factory.cortex.balance-inbox-cutover-probe";
const PORT = 8768;
const MAIL: DeskItem = { key: "mail:probe-1@example.test", kind: "mail", source: "work-mail", area: "area-example", urgency: "today", title: "Quote for the glider kit", why: "Unread", score: 1, actions: [], detail: { summary: "Can you confirm the order?", history: [], refs: [], links: [{ kind: "mail", label: "Open", url: "message://probe-1" }] } };
const LISTED: ListedMail = { kind: "mail", id: "probe-1@example.test", from: { name: "Kit Shop", address: "Sales@Kits.Example" }, subject: MAIL.title, receivedAt: "2026-11-02T08:00:00.000Z", unread: true, account: "work", sourceId: "work-mail" };
const SENSOR: DeskItem = { ...MAIL, key: "sensor:probe-2", kind: "sensor", source: "synthetic", title: "Water the seedlings" };

interface Reply { ok: boolean; error?: string; conversation?: { id: string }; proposal?: ProposalView }

await withTempHome(async () => {
  const root = await mkdtemp(join(tmpdir(), "balance-inbox-cutover-probe-"));
  const db = initDatabase(join(root, "desk.sqlite"));
  saveBalanceState(db, balanceTaskState());
  const desk: DeskOptions = { enabled: true, displayName: "Inbox cutover probe", topN: 5, rangerUrl: "", areas: [{ id: "area-example", label: "Lab", color: "", repos: [], goals: [], policy: "local" }], sources: [] };
  const runtime: DeskRuntime = { ledger: new HandledLedger(), options: desk };
  const status = await openProbeHost(root, LABEL);
  const host = status.host;
  try {
    const registry = new DomainAdapterRegistry();
    const registered = registry.register(BALANCE_INBOX_TASK_CONTRACT.declaration(), { handlers: {}, observations: {} });
    assert.ok(registered.ok, registered.ok ? "" : registered.error.code);
    const journal = host.lifecycleJournal(registry);
    const writers = host.lifecycleWriters();
    let items: DeskItem[] = [{ ...MAIL }, { ...SENSOR }];
    const deskItems = () => Promise.resolve(items);
    const listedMail = (key: string) => key === MAIL.key ? LISTED : null;
    const fixture = balanceCutoverFixture({ db, desk: () => desk, journal, writers, contract: BALANCE_INBOX_TASK_CONTRACT, fences: host.lifecycleFences(), deskItems, listedMail });
    await host.attachSources(conversationSources({ db, desk: () => desk, balanceInboxCutover: () => fixture.cutover, deskItems, listedMail }));
    const guard: MutationGuardContext = { isLoopback: true, allowedHostnames: buildAllowedHostnames("127.0.0.1"), listenPort: PORT, principals: new Set() };
    const access = () => status as HostStatus;
    const call = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: Reply }> => {
      const res = await handleConversations(new Request(`http://127.0.0.1:${PORT}${path}`, { method, headers: { host: `127.0.0.1:${PORT}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), new URL(`http://127.0.0.1:${PORT}${path}`), guard, access, { db, runtime });
      return { status: res.status, body: await res.json() as Reply };
    };
    const conversationId = (await call("POST", "/api/conversations", { title: "Inbox cutover", origin: { kind: "web" } })).body.conversation?.id ?? "";
    assert.ok(conversationId, "the probe conversation was not created");
    const propose = async (item: DeskItem): Promise<ProposalView> => {
      const view = (await call("POST", `/api/conversations/${conversationId}/proposals`, { proposalId: randomUUID(), type: "balance-inbox-task", fields: { item: item.key, title: item.title } })).body.proposal;
      assert.ok(view, "the Inbox card was not proposed");
      return view;
    };
    const approve = (view: ProposalView) => call("POST", `/api/conversations/${conversationId}/proposals/${view.proposal.proposalId}/confirm`, { revision: view.proposal.revision, digest: view.digest });

    const inFlight = legacyInFlightCutover(journal, { kind: "inbox" });
    const begun = await writers.begin(inFlight.plan, 0);
    const active = await writers.resume(begun.bindingKey, inFlight.steps);
    assert.equal(active.phase, "active");
    console.log("cutover: the approved sequence is active for balance-inbox-task on a disposable stack");

    const matching = await propose(MAIL);
    const created = (await approve(matching)).body.proposal;
    assert.equal(created?.feedback, "created");
    const canonicalId = created?.operation?.canonicalId ?? "";
    const task = loadMeta(db).inbox.filter(item => item.title === MAIL.title);
    assert.deepEqual(task.map(item => item.id), [canonicalId]);
    assert.ok(loadMeta(db).sources.some(source => source.taskId === canonicalId && source.key === MAIL.key), "the Inbox task lost its source identity");
    assert.equal(loadMeta(db).receipts.find(receipt => receipt.id === operationUuid(created?.operation?.operationId ?? ""))?.outlineId, canonicalId);
    assert.deepEqual(queryMailLog(db).filter(row => row.messageId === LISTED.id).map(({ action, where }) => ({ action, where })), [{ action: "todo", where: "conversation" }]);
    console.log("matching: one Inbox task with its source identity, one mail log entry and a matching receipt");

    const repeated = (await approve(created!)).body.proposal;
    assert.equal(repeated?.operation?.canonicalId, canonicalId);
    assert.equal(loadMeta(db).inbox.filter(item => item.title === MAIL.title).length, 1);
    assert.equal(queryMailLog(db).filter(row => row.messageId === LISTED.id).length, 1);
    console.log("repeat: Approve again leaves one task and one mail log entry");

    const changed = await propose(SENSOR);
    items = [{ ...MAIL }, { ...SENSOR, title: `${SENSOR.title} twice` }];
    assert.equal((await approve(changed)).body.proposal?.feedback, "failed");
    const removed = await propose(SENSOR);
    items = [];
    assert.equal((await approve(removed)).body.proposal?.feedback, "failed");
    assert.equal(loadMeta(db).inbox.length, 1);
    console.log("changed and removed: both approvals were refused and nothing was created");
    console.log(JSON.stringify({ binding: BALANCE_INBOX_TASK_CONTRACT.capabilityId, cutover: active.epoch, created: canonicalId, temporaryStore: true }));
  } finally {
    await host.close();
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});
