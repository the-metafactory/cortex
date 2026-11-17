import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { BALANCE_INBOX_TASK_CONTRACT } from "../../../conversations/domain-adapters/balance/inbox-binding";
import { readOperationEvidence } from "../../../conversations/domain-adapters/operations/legacy";
import { DomainAdapterRegistry } from "../../../conversations/domain-adapters/registry";
import type { WriterCutoverSteps, WriterPlan, WriterRecord } from "../../../conversations/domain-adapters/operations/writer-authority";
import type { Grant, ProposalView } from "../../../conversations/creation";
import { BALANCE_TASK_CONNECTION, balanceTaskState } from "../../../conversations/domain-adapters/__tests__/fixtures/balance-task-fixtures";
import { HandledLedger } from "../desk/actions";
import { saveBalanceState } from "../desk/balance-store";
import { balanceInboxRoute } from "../desk/balance-inbox-cutover";
import type { DeskOptions, DeskRuntime } from "../desk/compose";
import { conversationSources, operationUuid } from "../desk/conversation-sources";
import { balanceCutoverFixture, legacyInFlightCutover } from "../desk/fixtures/balance-cutover";
import type { ListedMail } from "../desk/mail-actions";
import { queryMailLog } from "../desk/mail-log";
import { loadMeta } from "../desk/my-day";
import type { DeskItem } from "../desk/types";
import { conversationWriterRig } from "./conversation-writer-rig";
import { cutoverRunner, openBalanceCutoverBase } from "./balance-cutover-rig";

const writerRig = conversationWriterRig("conversation-balance-inbox-cutover-", "ai.meta-factory.cortex.balance-inbox-cutover-test");

interface Reply { ok: boolean; error: string; proposal: ProposalView; conversation: { id: string } }

const OWNER = BALANCE_INBOX_TASK_CONTRACT.owner;
const MAIL: DeskItem = { key: "mail:cutover-1@example.test", kind: "mail", source: "work-mail", area: "area-example", urgency: "today", title: "Quote for the glider kit", why: "Unread", score: 1, actions: [], detail: { summary: "Can you confirm the order?", history: [], refs: [], links: [{ kind: "mail", label: "Open", url: "message://cutover-1" }] } };
const LISTED: ListedMail = { kind: "mail", id: "cutover-1@example.test", from: { name: "Kit Shop", address: "Sales@Kits.Example" }, subject: MAIL.title, receivedAt: "2026-11-02T08:00:00.000Z", unread: true, account: "work", sourceId: "work-mail" };
const SENSOR: DeskItem = { ...MAIL, key: "sensor:cutover-2", kind: "sensor", source: "synthetic", title: "Water the seedlings" };

function deskOptions(): DeskOptions {
  return { enabled: true, displayName: "", topN: 5, rangerUrl: "", areas: [{ id: "area-example", label: "Lab", color: "", repos: [], goals: [], policy: "local" }], sources: [] };
}

async function openRig() {
  const desk = deskOptions();
  const { db, opened, journal, writers } = await openBalanceCutoverBase<Reply>(writerRig, desk, BALANCE_INBOX_TASK_CONTRACT.declaration());
  let items: DeskItem[] = [{ ...MAIL }, { ...SENSOR }];
  const deskItems = () => Promise.resolve(items);
  const listedMail = (key: string) => key === MAIL.key ? LISTED : null;
  const fixture = balanceCutoverFixture({ db, desk: () => desk, journal, writers, contract: BALANCE_INBOX_TASK_CONTRACT, fences: opened.host.lifecycleFences(), deskItems, listedMail });
  await opened.host.attachSources(conversationSources({ db, desk: () => desk, balanceInboxCutover: () => fixture.cutover, deskItems, listedMail }));
  const conversationId = await opened.start("Inbox cutover conversation");
  const propose = async (item: DeskItem, title = item.title): Promise<ProposalView> => (await opened.call("POST", `/api/conversations/${conversationId}/proposals`, { proposalId: randomUUID(), type: OWNER, fields: { item: item.key, title } })).body.proposal;
  const confirm = (view: ProposalView, extra: Record<string, unknown> = {}) => opened.call("POST", `/api/conversations/${conversationId}/proposals/${view.proposal.proposalId}/confirm`, { revision: view.proposal.revision, digest: view.digest, ...extra });
  const list = async (): Promise<{ proposals: ProposalView[]; grants: Grant[] }> => (await opened.call("GET", `/api/conversations/${conversationId}/proposals`)).body as unknown as { proposals: ProposalView[]; grants: Grant[] };
  const runCutover = cutoverRunner(writers);
  const activate = async () => {
    const inFlight = legacyInFlightCutover(journal, { kind: "inbox" });
    return { inFlight, active: await runCutover(inFlight.steps, inFlight.plan) };
  };
  const inbox = () => loadMeta(db).inbox;
  const mailRows = () => queryMailLog(db).filter(row => row.messageId === LISTED.id).map(({ action, where }) => ({ action, where }));
  return { db, desk, host: opened.host, journal, writers, fixture, conversationId, propose, confirm, list, runCutover, activate, inbox, mailRows, setItems: (next: DeskItem[]) => { items = next; }, receipts: () => loadMeta(db).receipts };
}

describe("Balance Inbox task creation after its own cutover", () => {
  test("a matching Day item becomes one Inbox task keeping its source, logs the mail once, and a repeated approval changes nothing", async () => {
    const rig = await openRig();
    await rig.activate();
    const card = await rig.propose(MAIL);
    const approved = (await rig.confirm(card)).body.proposal;
    expect(approved.feedback).toBe("created");
    const id = approved.operation?.canonicalId ?? "";
    expect(rig.inbox().filter(task => task.title === MAIL.title).map(task => task.id)).toEqual([id]);
    expect(loadMeta(rig.db).sources).toMatchObject([{ taskId: id, key: MAIL.key }]);
    expect(rig.mailRows()).toEqual([{ action: "todo", where: "conversation" }]);
    const stored = await rig.journal.read(approved.operation!.operationId);
    expect(stored?.journal.state).toBe("succeeded");
    expect(rig.receipts().find(receipt => receipt.id === operationUuid(approved.operation!.operationId))?.outlineId).toBe(id);

    const again = (await rig.confirm(approved)).body.proposal;
    expect(again.operation?.canonicalId).toBe(id);
    expect(rig.inbox().filter(task => task.title === MAIL.title)).toHaveLength(1);
    expect(rig.mailRows()).toHaveLength(1);
  });

  test("a changed or removed Day item is refused and nothing is created", async () => {
    const rig = await openRig();
    await rig.activate();
    const changed = await rig.propose(SENSOR);
    rig.setItems([{ ...MAIL }, { ...SENSOR, title: "Water the seedlings twice" }]);
    expect((await rig.confirm(changed)).body.proposal.feedback).toBe("failed");
    const removed = await rig.propose(MAIL);
    rig.setItems([]);
    expect((await rig.confirm(removed)).body.proposal.feedback).toBe("failed");
    expect(rig.inbox()).toHaveLength(0);
    expect(rig.mailRows()).toEqual([]);
  });

  test("a proposal and task from before the cutover keep their identities, edits and receipts, and the in-flight call imports uncertain", async () => {
    const rig = await openRig();
    const before = (await rig.confirm(await rig.propose(MAIL))).body.proposal;
    expect(before.feedback).toBe("created");
    const draft = await rig.propose(SENSOR);
    const receipt = rig.receipts().find(item => item.id === operationUuid(before.operation!.operationId));

    const { inFlight, active } = await rig.activate();
    expect(active.phase).toBe("active");
    const imported = await rig.journal.read(inFlight.source.record.operationId);
    expect(imported?.journal.state).toBe("uncertain");
    const evidence = readOperationEvidence(imported);
    expect(evidence.kind === "legacy" && evidence.retryAllowed).toBe(false);
    expect(await rig.writers.legacyOwnerAllowed("test", OWNER)).toBe(false);
    expect(await rig.writers.legacyOwnerAllowed("test", "balance-task")).toBe(true);

    const after = await rig.list();
    expect(after.proposals.find(item => item.proposal.proposalId === before.proposal.proposalId)?.feedback).toBe("created");
    const kept = after.proposals.find(item => item.proposal.proposalId === draft.proposal.proposalId);
    expect(kept?.proposal.fields).toEqual(draft.proposal.fields);
    expect(kept?.feedback).toBe("proposed");
    expect(rig.receipts().find(item => item.id === operationUuid(before.operation!.operationId))).toEqual(receipt);
    expect((await rig.confirm(draft)).status).toBe(409);
    const fresh = (await rig.confirm(kept!)).body.proposal;
    expect(fresh.feedback).toBe("created");
    expect(rig.inbox().map(task => task.id)).toContain(fresh.operation?.canonicalId ?? "");
    expect((await rig.journal.read(fresh.operation!.operationId))?.journal.state).toBe("succeeded");
  });

  test("a standing grant lapses visibly at cutover and is offered again bound to the connection and the Inbox", async () => {
    const rig = await openRig();
    const standing = await rig.propose(MAIL);
    expect((await rig.confirm(standing, { grant: { scope: "conversation" } })).body.proposal.feedback).toBe("created");
    const old = (await rig.list()).grants.find(grant => grant.type === OWNER);
    expect(old?.connectionId).toBeUndefined();

    await rig.activate();
    const lapsed = (await rig.list()).grants.find(grant => grant.grantId === old?.grantId);
    expect(lapsed?.renewal?.reason).toContain("Confirm one creation again");

    const asks = await rig.propose(SENSOR);
    expect(asks.feedback).toBe("proposed");
    expect(rig.inbox()).toHaveLength(1);
    expect((await rig.confirm(asks, { grant: { scope: "conversation" } })).body.proposal.feedback).toBe("created");
    const fresh = (await rig.list()).grants.find(grant => grant.type === OWNER && grant.grantId !== old?.grantId);
    expect(fresh?.connectionId).toBe(BALANCE_TASK_CONNECTION);
    expect(fresh?.renewalRequired).toBe(false);
    expect(fresh?.destinations).toEqual([{ objectType: "inbox", canonicalId: "inbox" }]);
  });

  test("a read-only downgrade disables Inbox creation and keeps the sidecar evidence", async () => {
    const rig = await openRig();
    const { inFlight, active } = await rig.activate();
    const retired = await rig.writers.begin({ ...inFlight.plan, cutoverId: "read-only-downgrade" }, active.revision);
    expect(retired.phase).toBe("disabled");
    expect((await balanceInboxRoute(rig.writers, "test")).kind).toBe("disabled");
    expect((await rig.confirm(await rig.propose(MAIL))).body.proposal.feedback).toBe("failed");
    expect(rig.inbox()).toHaveLength(0);
    expect(readOperationEvidence(await rig.journal.read(inFlight.source.record.operationId)).kind).toBe("legacy");
  });
});
