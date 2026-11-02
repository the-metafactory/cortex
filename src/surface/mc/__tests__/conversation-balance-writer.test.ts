import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { DEFAULT_SETTINGS, findNode, findParent, type AppState, type OutlineNode } from "../../../balance";
import { openConversationHost, type ConversationHost, type HostStatus } from "../../../conversations/host";
import { answering, scratchDirs } from "../../../conversations/__tests__/fixtures/scratch";
import type { ProposalView } from "../../../conversations/creation";
import type { ConversationEntry, OperationRecord, OwnerWriter } from "../../../conversations/types";
import { handleConversations } from "../api/conversations";
import { buildAllowedHostnames, type MutationGuardContext } from "../api/mutation-guard";
import { HandledLedger } from "../desk/actions";
import { loadBalanceState, saveBalanceState } from "../desk/balance-store";
import type { DeskRuntime } from "../desk/compose";
import { conversationSources, operationUuid } from "../desk/conversation-sources";
import { loadMeta, readMyDay } from "../desk/my-day";
import { SCHEMA_SQL } from "../db/schema";

const LABEL = "ai.meta-factory.cortex.balance-writer-test";
const dirs = scratchDirs("conversation-balance-");
const hosts: ConversationHost[] = [];
const databases: Database[] = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close().catch(() => undefined);
  for (const db of databases.splice(0)) db.close();
  await dirs.clean();
});

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

async function rig(state: AppState | null = outline([GLIDER]), wrap?: (writer: OwnerWriter) => OwnerWriter) {
  const db = new Database(":memory:"); databases.push(db); for (const sql of SCHEMA_SQL) db.run(sql);
  if (state) saveBalanceState(db, state);
  const options = { enabled: true, displayName: "", topN: 5, rangerUrl: "", areas: [{ id: "lab", label: "Lab", color: "", repos: [], goals: [], policy: "local" as "cloud" | "local" }, { id: "home", label: "Home", color: "", repos: [], goals: [] }], sources: [] };
  const runtime: DeskRuntime = { ledger: new HandledLedger(), options };
  const lane = { provider: "test", model: "test-model" };
  const status: HostStatus = await openConversationHost({ dir: await dirs.make(), stack: "test", label: LABEL, expectedLabel: LABEL, lanes: { local: lane, cloud: lane }, turns: answering(() => "ok") });
  if (status.state !== "ready") throw new Error(status.reason);
  hosts.push(status.host);
  const sources = conversationSources({ db, desk: () => options });
  const writer = sources.writers?.["balance-task"];
  await status.host.attachSources(wrap && writer ? { ...sources, writers: { "balance-task": wrap(writer) } } : sources);
  const guard: MutationGuardContext = { isLoopback: true, allowedHostnames: buildAllowedHostnames("127.0.0.1"), listenPort: 8767, principals: new Set() };
  const call = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: Reply }> => {
    const res = await handleConversations(new Request(`http://127.0.0.1:8767${path}`, { method, headers: { host: "127.0.0.1:8767", "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), new URL(`http://127.0.0.1:8767${path}`), guard, () => status, { db, runtime });
    return { status: res.status, body: await res.json() as Reply };
  };
  const start = async (): Promise<string> => (await call("POST", "/api/conversations", { title: "Synthetic task", origin: { kind: "web" }, policy: "local" })).body.conversation.id;
  const propose = async (id: string, fields: Record<string, string>) => (await call("POST", `/api/conversations/${id}/proposals`, { proposalId: randomUUID(), type: "balance-task", fields })).body.proposal;
  const confirm = (id: string, view: ProposalView, extra: Record<string, unknown> = {}) => call("POST", `/api/conversations/${id}/proposals/${view.proposal.proposalId}/confirm`, { revision: view.proposal.revision, digest: view.digest, ...extra });
  const tasks = (title: string): OutlineNode[] => {
    const found: OutlineNode[] = [];
    const visit = (node: OutlineNode): void => { if (node.title === title) found.push(node); node.children.forEach(visit); };
    visit(readMyDay(db, options, Date.now()).outline);
    return found;
  };
  return { db, options, call, start, propose, confirm, tasks, host: status.host };
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
    const first = await r.confirm(id, view);
    expect(first.status).toBe(200);
    expect(first.body.proposal.feedback).toBe("created");
    const operation = operationOf(first.body.proposal);
    const [task] = r.tasks("Fold a test glider");
    expect(operation.canonicalId).toBe(task?.id);
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

  test("a writer that throws after Balance saved the task leaves the operation uncertain, and Check finds the same task through the receipt", async () => {
    const r = await rig(outline([GLIDER]), writer => ({ ...writer, create: async request => { await writer.create(request); throw new Error("connection reset after write"); } }));
    const id = await r.start();
    const view = await r.propose(id, { area: "lab", title: "Weigh the glider" });
    const confirmed = await r.confirm(id, view);
    expect(confirmed.status).toBe(202);
    expect(confirmed.body.proposal.feedback).toBe("uncertain");
    const checked = await r.call("POST", `/api/conversations/${id}/proposals/${view.proposal.proposalId}/check`);
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
