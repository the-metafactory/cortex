import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { DEFAULT_SETTINGS, findNode, findParent, type AppState, type OutlineNode } from "../../../balance";
import type { ProposalView } from "../../../conversations/creation";
import type { ConversationEntry, OperationRecord, OwnerWriter } from "../../../conversations/types";
import { HandledLedger } from "../desk/actions";
import { loadBalanceState, saveBalanceState } from "../desk/balance-store";
import type { DeskRuntime } from "../desk/compose";
import { conversationSources, operationUuid } from "../desk/conversation-sources";
import type { ListedMail } from "../desk/mail-actions";
import { historySentence, logMailDecision, mailFeatures, queryMailLog } from "../desk/mail-log";
import { changeMyDay, loadMeta, localDay, readMyDay } from "../desk/my-day";
import type { DeskItem } from "../desk/types";
import { conversationWriterRig } from "./conversation-writer-rig";

const writerRig = conversationWriterRig("conversation-balance-", "ai.meta-factory.cortex.balance-writer-test");

const leaf = (id: string, title: string, extra: Partial<OutlineNode> = {}): OutlineNode => ({ id, title, weight: 50, ordering: "parallel", children: [], effort: 1, ...extra });
const outline = (lab: OutlineNode[]): AppState => ({
  outline: { id: "desk:outline", title: "Outline", weight: 100, ordering: "parallel", children: [
    { id: "area:lab", title: "Lab", weight: 50, ordering: "parallel", children: lab },
    { id: "area:home", title: "Home", weight: 50, ordering: "parallel", children: [] },
  ] },
  settings: { ...DEFAULT_SETTINGS }, log: [], history: { deficits: {}, lastSurfaced: {} }, dayState: null,
});
const GLIDER = { id: "project-glider", title: "Glider", weight: 50, ordering: "parallel" as const, children: [leaf("task-wing", "Cut the wing")] };

interface Reply { ok: boolean; error: string; proposal: ProposalView; conversation: { id: string }; entries: ConversationEntry[]; types: { type: string; status: string }[] }

async function rig(state: AppState | null = outline([GLIDER]), wrap?: (writer: OwnerWriter) => OwnerWriter, view: DeskItem[] = [], mails: ListedMail[] = []) {
  const db = writerRig.database();
  if (state) saveBalanceState(db, state);
  const options = { enabled: true, displayName: "", topN: 5, rangerUrl: "", areas: [{ id: "lab", label: "Lab", color: "", repos: [], goals: [], policy: "local" as "cloud" | "local" }, { id: "home", label: "Home", color: "", repos: [], goals: [] }], sources: [] };
  const runtime: DeskRuntime = { ledger: new HandledLedger(), options };
  const { host, call, ...rigCalls } = await writerRig.open<Reply>(db, runtime);
  const sources = conversationSources({ db, desk: () => options, deskItems: () => Promise.resolve(view), listedMail: key => mails.find(m => `mail:${m.id}` === key) ?? null });
  const writer = sources.writers?.["balance-task"];
  await host.attachSources(wrap && writer ? { ...sources, writers: { "balance-task": wrap(writer) } } : sources);
  const start = (): Promise<string> => rigCalls.start("Synthetic task");
  const propose = (id: string, fields: Record<string, string>, type = "balance-task") => rigCalls.propose(id, type, fields);
  const { confirm, check } = rigCalls;
  const tasks = (title: string): OutlineNode[] => {
    const found: OutlineNode[] = [];
    const visit = (node: OutlineNode): void => { if (node.title === title) found.push(node); node.children.forEach(visit); };
    visit(readMyDay(db, options, Date.now()).outline);
    return found;
  };
  const confirmCreated = async (id: string, view: ProposalView, title: string): Promise<{ operation: OperationRecord; node: OutlineNode | undefined }> => {
    const first = await confirm(id, view);
    expect(first.status).toBe(200);
    expect(first.body.proposal.feedback).toBe("created");
    const operation = operationOf(first.body.proposal);
    const [node] = tasks(title);
    expect(operation.canonicalId).toBe(node?.id);
    return { operation, node };
  };
  return { db, options, call, start, propose, confirm, check, confirmCreated, tasks, host };
}

function operationOf(view: ProposalView): OperationRecord {
  if (!view.operation) throw new Error("the proposal has no operation");
  return view.operation;
}
const today = (): string => new Date().toISOString().slice(0, 10);

describe("Balance task writer for conversation proposals", () => {
  test("operationUuid is stable for one operation and passes the owner's uuid check", () => {
    const op = "c0ffee00-0000-4000-8000-000000000001:c0ffee00-0000-4000-8000-000000000002:3";
    expect(operationUuid(op)).toBe(operationUuid(op));
    expect(z.uuid().safeParse(operationUuid(op)).success).toBe(true);
    expect(operationUuid(op)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(operationUuid(`${op}x`)).not.toBe(operationUuid(op));
  });

  test("the type is ready only with the Desk enabled and Balance state saved", async () => {
    const ready = await rig();
    expect((await ready.call("GET", "/api/conversations/capabilities")).body.types.find(c => c.type === "balance-task")?.status).toBe("ready");
    ready.options.enabled = false;
    expect((await ready.call("GET", "/api/conversations/capabilities")).body.types.find(c => c.type === "balance-task")?.status).toBe("blocked:3030");
    const empty = await rig(null);
    expect((await empty.call("GET", "/api/conversations/capabilities")).body.types.find(c => c.type === "balance-task")?.status).toBe("blocked:3030");
  });

  test("a confirmed proposal adds one task with note and due under the area, and an equal retry adds nothing", async () => {
    const r = await rig();
    const id = await r.start();
    const view = await r.propose(id, { area: "lab", title: "Fold a test glider", note: "Use A4 paper", due: "2026-12-01" });
    const { operation, node: task } = await r.confirmCreated(id, view, "Fold a test glider");
    expect(task).toMatchObject({ note: "Use A4 paper", dueDate: "2026-12-01", effort: 1 });
    expect(findParent(readMyDay(r.db, r.options, Date.now()).outline, task?.id ?? "")?.id).toBe("area:lab");
    const entries = (await r.call("GET", `/api/conversations/${id}/entries?limit=100`)).body.entries;
    expect(entries.filter(e => e.kind === "cortex.creation").map(e => (e.data as { canonicalId: string }).canonicalId)).toEqual([task?.id ?? ""]);
    const again = await r.confirm(id, view);
    expect(again.status).toBe(200);
    expect(again.body.proposal.operation).toMatchObject({ operationId: operation.operationId, canonicalId: operation.canonicalId });
    expect(r.tasks("Fold a test glider")).toHaveLength(1);
    expect(loadMeta(r.db).receipts.filter(receipt => receipt.id === operationUuid(operation.operationId))).toHaveLength(1);
  });

  test("a named open project in the area becomes the task's parent, by title or id", async () => {
    const r = await rig();
    const id = await r.start();
    const byTitle = await r.confirm(id, await r.propose(id, { area: "lab", project: " glider ", title: "Tape the nose" }));
    expect(byTitle.body.proposal.feedback).toBe("created");
    const byId = await r.confirm(id, await r.propose(id, { area: "lab", project: "project-glider", title: "Test the tail" }));
    expect(byId.body.proposal.feedback).toBe("created");
    const glider = findNode(readMyDay(r.db, r.options, Date.now()).outline, "project-glider");
    expect(glider?.children.map(c => c.title)).toEqual(["Cut the wing", "Tape the nose", "Test the tail"]);
  });

  test("an unconfigured area or a project outside the area is refused before Balance changes", async () => {
    const r = await rig();
    const id = await r.start();
    const before = JSON.stringify(loadBalanceState(r.db));
    const area = await r.confirm(id, await r.propose(id, { area: "garden", title: "Plant seeds" }));
    expect(area.status).toBe(409);
    expect(area.body.proposal.feedback).toBe("failed");
    expect(area.body.error).toBe("garden is not a configured area. Nothing was created.");
    const project = await r.confirm(id, await r.propose(id, { area: "home", project: "Glider", title: "Plant seeds" }));
    expect(project.status).toBe(409);
    expect(project.body.error).toBe("That project is not open in Home. Nothing was created.");
    const task = await r.confirm(id, await r.propose(id, { area: "lab", project: "Cut the wing", title: "Plant seeds" }));
    expect(task.body.error).toBe("That project is not open in Lab. Nothing was created.");
    const due = await r.confirm(id, await r.propose(id, { area: "lab", title: "Plant seeds", due: "next week" }));
    expect(due.body.error).toBe("next week is not a due date in the form YYYY-MM-DD. Nothing was created.");
    expect(JSON.stringify(loadBalanceState(r.db))).toBe(before);
  });

  test("ambiguous project titles and stale UUIDs that match another title fail before the owner writes", async () => {
    const stale = "d5bd709e-9b83-4000-8000-4e91f1ba4d11";
    const r = await rig(outline([GLIDER, { ...GLIDER, id: "second-glider", children: [leaf("second-wing", "Second wing")] }, { ...GLIDER, id: "other-project", title: stale, children: [leaf("other-wing", "Other wing")] }]));
    const id = await r.start();
    const before = loadBalanceState(r.db);
    for (const project of ["Glider", stale]) {
      const reply = await r.confirm(id, await r.propose(id, { area: "lab", project, title: "Refused ambiguous destination" }));
      expect(reply.status).toBe(409);
      expect(reply.body.proposal.feedback).toBe("failed");
      expect(loadBalanceState(r.db)).toEqual(before);
    }
    expect(r.tasks("Refused ambiguous destination")).toHaveLength(0);
  });

  for (const mutation of ["closed", "moved", "deleted"] as const) test(`a saved project selection that is ${mutation} cannot confirm or create a task`, async () => {
    const empty: OutlineNode = { id: "empty-project", title: "Empty project", weight: 50, ordering: "parallel", children: [], done: true };
    const r = await rig(outline([GLIDER, empty]));
    const id = await r.start();
    const project = mutation === "deleted" ? empty.id : GLIDER.id;
    const proposal = await r.propose(id, { area: "lab", project, title: "A stale selection" });
    const now = Date.now();
    const revision = readMyDay(r.db, r.options, now).revision;
    const common = { db: r.db, desk: r.options, now, date: localDay(now), requestId: randomUUID() };
    const command = mutation === "closed" ? { op: "outline-complete", id: project, revision, confirm: true } as const : mutation === "moved" ? { op: "outline-move", id: project, revision, parent: "area:home" } as const : { op: "outline-remove", id: project, revision, confirm: true } as const;
    changeMyDay({ ...common, command });
    const before = loadBalanceState(r.db);
    const response = await r.confirm(id, proposal);
    expect(response.status).toBe(409);
    expect(response.body.proposal.feedback).toBe("failed");
    expect(response.body.error).toContain("Nothing was created");
    expect(loadBalanceState(r.db)).toEqual(before);
    expect(r.tasks("A stale selection")).toHaveLength(0);
  });

  test("a writer that throws after Balance saved the task leaves the operation uncertain, and Check finds the same task through the receipt", async () => {
    const r = await rig(outline([GLIDER]), writer => ({ ...writer, create: async request => { await writer.create(request); throw new Error("connection reset after write"); } }));
    const id = await r.start();
    const view = await r.propose(id, { area: "lab", title: "Weigh the glider" });
    const confirmed = await r.confirm(id, view);
    expect(confirmed.status).toBe(202);
    expect(confirmed.body.proposal.feedback).toBe("uncertain");
    const checked = await r.check(id, view);
    expect(checked.body.proposal.feedback).toBe("created");
    const [task] = r.tasks("Weigh the glider");
    expect(checked.body.proposal.operation?.canonicalId).toBe(task?.id);
    expect(r.tasks("Weigh the glider")).toHaveLength(1);
  });

  test("Check reports nothing found when the receipt's task was removed", async () => {
    const r = await rig();
    const writer = conversationSources({ db: r.db, desk: () => r.options }).writers?.["balance-task"];
    const id = await r.start();
    const view = await r.propose(id, { area: "lab", title: "Short-lived" });
    const operation = operationOf((await r.confirm(id, view)).body.proposal);
    expect(await writer?.readback(operation)).toEqual({ found: true, canonicalId: operation.canonicalId ?? "" });
    const state = loadBalanceState(r.db);
    const lab = state?.outline.children.find(n => n.id === "area:lab");
    if (!state || !lab) throw new Error("fixture outline missing");
    lab.children = lab.children.filter(c => c.id !== operation.canonicalId);
    saveBalanceState(r.db, state);
    expect(await writer?.readback(operation)).toEqual({ found: false });
    expect(await writer?.readback({ ...operation, operationId: `${operation.operationId}9` })).toEqual({ found: false });
  });

  test("a stale stored revision is read again through My day and the add succeeds once", async () => {
    const r = await rig(outline([GLIDER, leaf("task-daily", "Stretch", { done: true, repeat: { unit: "day", interval: 1 } })]));
    const id = await r.start();
    const created = await r.confirm(id, await r.propose(id, { area: "lab", title: "After a respawn", due: today() }));
    expect(created.body.proposal.feedback).toBe("created");
    expect(r.tasks("After a respawn")).toHaveLength(1);
    expect(findNode(readMyDay(r.db, r.options, Date.now()).outline, "task-daily")?.done).toBe(false);
  });
});

describe("Balance project writer for conversation proposals", () => {
  const statusOf = async (r: Awaited<ReturnType<typeof rig>>): Promise<string | undefined> => (await r.call("GET", "/api/conversations/capabilities")).body.types.find(c => c.type === "balance-project")?.status;

  test("the type is ready only with the Desk enabled and Balance state saved", async () => {
    const ready = await rig();
    expect(await statusOf(ready)).toBe("ready");
    ready.options.enabled = false;
    expect(await statusOf(ready)).toBe("blocked:3031");
    expect(await statusOf(await rig(null))).toBe("blocked:3031");
  });

  test("a confirmed proposal adds one empty project with its note to the area, and an equal retry adds nothing", async () => {
    const r = await rig();
    const id = await r.start();
    const view = await r.propose(id, { area: "lab", title: "Build a kite", note: "Paper and string" }, "balance-project");
    const { operation, node: project } = await r.confirmCreated(id, view, "Build a kite");
    expect(project).toMatchObject({ note: "Paper and string", done: true, children: [] });
    expect(project?.effort).toBeUndefined();
    expect(findParent(readMyDay(r.db, r.options, Date.now()).outline, project?.id ?? "")?.id).toBe("area:lab");
    const again = await r.confirm(id, view);
    expect(again.status).toBe(200);
    expect(again.body.proposal.operation).toMatchObject({ operationId: operation.operationId, canonicalId: operation.canonicalId });
    expect(r.tasks("Build a kite")).toHaveLength(1);
    const writer = conversationSources({ db: r.db, desk: () => r.options }).writers?.["balance-project"];
    expect(await writer?.readback(operation)).toEqual({ found: true, canonicalId: operation.canonicalId ?? "" });
  });

  test("a later task proposal naming the project by id becomes its child and opens the project", async () => {
    const r = await rig();
    const id = await r.start();
    const projectId = operationOf((await r.confirm(id, await r.propose(id, { area: "lab", title: "Build a kite" }, "balance-project"))).body.proposal).canonicalId ?? "";
    const task = await r.confirm(id, await r.propose(id, { area: "lab", project: projectId, title: "Cut the sail" }));
    expect(task.body.proposal.feedback).toBe("created");
    const project = findNode(readMyDay(r.db, r.options, Date.now()).outline, projectId);
    expect(project?.children.map(c => c.title)).toEqual(["Cut the sail"]);
    expect(project?.done).toBeUndefined();
  });

  test("an unconfigured area is refused with 409 and Balance is unchanged", async () => {
    const r = await rig();
    const id = await r.start();
    const before = JSON.stringify(loadBalanceState(r.db));
    const refused = await r.confirm(id, await r.propose(id, { area: "garden", title: "Build a kite" }, "balance-project"));
    expect(refused.status).toBe(409);
    expect(refused.body.proposal.feedback).toBe("failed");
    expect(refused.body.error).toBe("garden is not a configured area. Nothing was created.");
    expect(JSON.stringify(loadBalanceState(r.db))).toBe(before);
  });
});

describe("Balance Inbox writer for conversation proposals", () => {
  const MAIL: DeskItem = { key: "mail:probe-1@example.test", kind: "mail", source: "work-mail", area: "lab", urgency: "today", title: "Quote for the glider kit", why: "Unread", score: 1, actions: [], detail: { summary: "Can you confirm the order?", history: [], refs: [], links: [{ label: "Open", url: "message://probe-1" }] } };
  const LISTED: ListedMail = { kind: "mail", id: "probe-1@example.test", from: { name: "Kit Shop", address: "Sales@Kits.Example" }, subject: "Quote for the glider kit", receivedAt: "2026-11-02T08:00:00.000Z", unread: true, account: "work", sourceId: "work-mail" };
  const inboxRig = (view: DeskItem[] = [{ ...MAIL }]) => rig(outline([GLIDER]), undefined, view, [LISTED]);
  const inbox = (r: Awaited<ReturnType<typeof rig>>) => readMyDay(r.db, r.options, Date.now()).inbox;
  const mailRows = (r: Awaited<ReturnType<typeof rig>>) => queryMailLog(r.db).map(({ messageId, action, where, sender }) => ({ messageId, action, where, sender }));
  const CONVERSATION_TODO = { messageId: LISTED.id, action: "todo" as const, where: "conversation" as const, sender: "sales@kits.example" };

  test("the type is ready with a Desk view, and stays blocked without one", async () => {
    const r = await inboxRig();
    expect((await r.call("GET", "/api/conversations/capabilities")).body.types.find(c => c.type === "balance-inbox-task")?.status).toBe("ready");
    expect(conversationSources({ db: r.db, desk: () => r.options }).writers?.["balance-inbox-task"]).toBeUndefined();
    r.options.enabled = false;
    expect((await r.call("GET", "/api/conversations/capabilities")).body.types.find(c => c.type === "balance-inbox-task")?.status).toBe("blocked:3032");
  });

  test("a confirmed proposal moves the Day item into the Inbox linked to its source, and an equal retry adds nothing", async () => {
    const r = await inboxRig();
    const id = await r.start();
    const view = await r.propose(id, { item: MAIL.key, title: MAIL.title }, "balance-inbox-task");
    const first = await r.confirm(id, view);
    expect(first.status).toBe(200);
    expect(first.body.proposal.feedback).toBe("created");
    const operation = operationOf(first.body.proposal);
    expect(inbox(r)).toHaveLength(1);
    expect(inbox(r)[0]).toMatchObject({ id: operation.canonicalId, title: MAIL.title, note: `From work-mail: ${MAIL.key}\nmessage://probe-1` });
    expect(loadMeta(r.db).sources).toMatchObject([{ taskId: operation.canonicalId, key: MAIL.key }]);
    const again = await r.confirm(id, view);
    expect(again.status).toBe(200);
    expect(again.body.proposal.operation).toMatchObject({ operationId: operation.operationId, canonicalId: operation.canonicalId });
    expect(inbox(r)).toHaveLength(1);
    const writer = conversationSources({ db: r.db, desk: () => r.options, deskItems: () => Promise.resolve([]) }).writers?.["balance-inbox-task"];
    expect(await writer?.readback(operation)).toEqual({ found: true, canonicalId: operation.canonicalId ?? "" });
    expect(await writer?.readback({ ...operation, operationId: `${operation.operationId}9` })).toEqual({ found: false });
  });

  test("a second proposal for an item already in the Inbox answers the same task", async () => {
    const r = await inboxRig();
    const id = await r.start();
    const first = operationOf((await r.confirm(id, await r.propose(id, { item: MAIL.key, title: MAIL.title }, "balance-inbox-task"))).body.proposal);
    const second = await r.confirm(id, await r.propose(id, { item: MAIL.key, title: MAIL.title }, "balance-inbox-task"));
    expect(second.body.proposal.feedback).toBe("created");
    expect(operationOf(second.body.proposal).canonicalId).toBe(first.canonicalId);
    expect(inbox(r)).toHaveLength(1);
  });

  test("a title that differs from the item's own is refused with 409 and the Inbox is unchanged", async () => {
    const r = await inboxRig();
    const id = await r.start();
    const before = JSON.stringify(loadMeta(r.db));
    const refused = await r.confirm(id, await r.propose(id, { item: MAIL.key, title: "Order the glider kit" }, "balance-inbox-task"));
    expect(refused.status).toBe(409);
    expect(refused.body.proposal.feedback).toBe("failed");
    expect(refused.body.error).toBe("The Day item changed since it was proposed, or its title was edited; the Inbox task takes the item's own title. Nothing was created.");
    expect(JSON.stringify(loadMeta(r.db))).toBe(before);
    expect(mailRows(r)).toEqual([]);
  });

  test("an item that left the Desk is refused with 409 and nothing is created", async () => {
    const view = [{ ...MAIL }];
    const r = await inboxRig(view);
    const id = await r.start();
    const proposal = await r.propose(id, { item: MAIL.key, title: MAIL.title }, "balance-inbox-task");
    view.splice(0);
    const before = JSON.stringify(loadMeta(r.db));
    const refused = await r.confirm(id, proposal);
    expect(refused.status).toBe(409);
    expect(refused.body.error).toBe("That Day item is no longer on the Desk. Nothing was created.");
    expect(JSON.stringify(loadMeta(r.db))).toBe(before);
    expect(inbox(r)).toHaveLength(0);
    expect(mailRows(r)).toEqual([]);
  });

  test("a mail moved to the Inbox logs one to-do from the conversation, and an equal retry or a second proposal logs no other", async () => {
    const r = await inboxRig();
    const id = await r.start();
    const view = await r.propose(id, { item: MAIL.key, title: MAIL.title }, "balance-inbox-task");
    expect((await r.confirm(id, view)).body.proposal.feedback).toBe("created");
    expect(mailRows(r)).toEqual([CONVERSATION_TODO]);
    expect((await r.confirm(id, view)).status).toBe(200);
    expect((await r.confirm(id, await r.propose(id, { item: MAIL.key, title: MAIL.title }, "balance-inbox-task"))).body.proposal.feedback).toBe("created");
    expect(mailRows(r)).toEqual([CONVERSATION_TODO]);
    const [row] = queryMailLog(r.db);
    expect(row ? historySentence(row, row.at) : "").toMatch(/^You made it a to-do in a conversation \(today at \d\d:\d\d\)\.$/);
  });

  test("a conversation to-do already logged for the mail is not logged again", async () => {
    const r = await inboxRig();
    logMailDecision(r.db, mailFeatures(r.db, LISTED), "todo", "conversation", Date.now() - 60_000);
    const id = await r.start();
    expect((await r.confirm(id, await r.propose(id, { item: MAIL.key, title: MAIL.title }, "balance-inbox-task"))).body.proposal.feedback).toBe("created");
    expect(inbox(r)).toHaveLength(1);
    expect(mailRows(r)).toEqual([CONVERSATION_TODO]);
  });

  test("a Day item that is not a mail moves to the Inbox and writes nothing to the mail log", async () => {
    const blocked: DeskItem = { ...MAIL, kind: "agent-blocked", source: "ranger", title: "Ranger waits on the glider review" };
    const r = await rig(outline([GLIDER]), undefined, [blocked], [LISTED]);
    const id = await r.start();
    expect((await r.confirm(id, await r.propose(id, { item: blocked.key, title: blocked.title }, "balance-inbox-task"))).body.proposal.feedback).toBe("created");
    expect(inbox(r)).toHaveLength(1);
    expect(mailRows(r)).toEqual([]);
  });
});
