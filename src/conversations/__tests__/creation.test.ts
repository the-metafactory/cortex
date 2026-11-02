import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { scratchHosts } from "./fixtures/scratch";
import { fixtureOwner, type FixtureOwner } from "./fixtures/owner";
import { CREATABLE_TYPES } from "../catalog";
import { ConversationCreation, type Actor, type ProposalView } from "../creation";
import { ConversationError, openConversationHost, type ConversationHost } from "../host";
import { CREATION_KIND, GRANT_KIND, type OwnerWriters, type Policy } from "../types";

const LABEL = "ai.meta-factory.cortex.test";
const endpoint = { baseUrl: "http://model.invalid", model: "m", timeoutSeconds: 5 };
const PRINCIPAL = "local-principal@loopback";
const web: Actor = { principal: PRINCIPAL, transport: "web" };
const discord: Actor = { principal: PRINCIPAL, transport: "discord" };
const { dirs, hosts } = scratchHosts("conversations-creation-");

async function open(dir: string, writers: OwnerWriters = {}): Promise<ConversationHost> {
  const status = await openConversationHost({ dir, stack: "test", label: LABEL, expectedLabel: LABEL, endpoints: { local: endpoint, cloud: endpoint }, chat: () => Promise.resolve("ok") });
  if (status.state !== "ready") throw new Error(status.reason);
  hosts.push(status.host);
  await status.host.attachSources({ resolvers: {}, readbacks: {}, writers });
  return status.host;
}

async function setup(writers: (owner: FixtureOwner) => OwnerWriters = owner => ({ "graph-node": owner.writer, "balance-task": owner.writer, routine: owner.writer, "tana-note": owner.writer }), timeoutMs = 2_000) {
  const owner = fixtureOwner();
  const host = await open(await dirs.make(), writers(owner));
  const creation = new ConversationCreation(host, { timeoutMs });
  const start = async (policy: Policy = "cloud") => (await host.create({ title: "Synthetic proposals", links: [], origin: { kind: "web" }, policy }, PRINCIPAL)).id;
  return { owner, host, creation, start };
}

const node = { repository: "example/synthetic", parent: "1", title: "Synthetic node", checkpoint: "synthetic", body: "From the exchange" };
const refused = async (run: Promise<unknown>, status: ConversationError["status"]): Promise<string> => {
  const error = await run.then(() => null, (e: unknown) => e);
  expect(error).toBeInstanceOf(ConversationError);
  expect((error as ConversationError).status).toBe(status);
  return (error as ConversationError).message;
};
const confirmOf = (view: ProposalView) => ({ revision: view.proposal.revision, digest: view.digest });

describe("creation catalog", () => {
  test("lists every owner-qualified type with ready, blocked or unsupported status and never maps observation rows to a writer", async () => {
    const { creation } = await setup(owner => ({ "graph-node": owner.writer }));
    const types = creation.capabilities();
    const byType = new Map(types.map(t => [t.type, t]));
    expect(types.length).toBeGreaterThan(4);
    expect(CREATABLE_TYPES.every(type => byType.has(type))).toBe(true);
    expect(byType.get("graph-node")).toMatchObject({ row: "O01", status: "ready" });
    expect(byType.get("balance-task")).toMatchObject({ row: "O04", status: "blocked:2972" });
    expect(byType.get("balance-project")).toMatchObject({ row: "O05", status: "blocked:2972" });
    expect(byType.get("flow")).toMatchObject({ row: "O14", status: "blocked:3014" });
    expect(byType.get("routine")?.fixed.map(f => f.value).join(" ")).toContain("Created paused");
    expect(byType.get("routine")?.fields.some(f => /enable|run|resume/i.test(f.name))).toBe(false);
    expect(byType.get("desk-source-card")).toMatchObject({ row: "O22", status: "unsupported" });
    expect(byType.get("settings")).toMatchObject({ row: "O25", status: "unsupported" });
    expect(byType.has("card")).toBe(false);
  });
});

describe("conversation creation proposals", () => {
  test("an edited proposal is confirmed once: equal retries share one operation and result, stale or altered confirmations are refused", async () => {
    const { owner, host, creation, start } = await setup();
    const id = await start();
    const proposalId = randomUUID();
    const first = await creation.propose(id, { proposalId, type: "graph-node", fields: { ...node, title: "Draft" }, entryId: "7" }, web);
    expect(first.view.feedback).toBe("proposed");
    expect(first.view.proposal.revision).toBe(1);
    expect((await creation.propose(id, { proposalId, type: "graph-node", fields: { ...node, title: "Draft" }, entryId: "7" }, web)).duplicate).toBe(true);
    await refused(creation.propose(id, { proposalId, type: "graph-node", fields: node, entryId: "7" }, web), 409);
    const edited = await creation.revise(id, proposalId, { revision: 1, fields: node }, web);
    expect(edited.proposal.revision).toBe(2);
    expect(edited.sentence).toContain("Synthetic node");
    await refused(creation.confirm(id, proposalId, confirmOf(first.view), web), 409);
    await refused(creation.confirm(id, proposalId, { revision: 2, digest: first.view.digest }, web), 409);
    const done = await creation.confirm(id, proposalId, confirmOf(edited), web);
    expect(done.feedback).toBe("created");
    expect(done.operation).toMatchObject({ operationId: `${id}:${proposalId}:2`, state: "created", canonicalId: "fixture-1", url: "fixture://owner/fixture-1", authority: { kind: "confirmation", transport: "web" } });
    const again = await creation.confirm(id, proposalId, confirmOf(edited), web);
    expect(again.operation).toEqual(done.operation);
    expect(owner.effects).toHaveLength(1);
    expect(owner.calls).toHaveLength(1);
    expect(owner.effects[0]?.provenance).toEqual({ conversationId: id, proposalId, revision: 2, operationId: `${id}:${proposalId}:2`, entryId: "7", link: `?desk=conversation&conversation=${id}` });
    await refused(creation.revise(id, proposalId, { revision: 2, fields: { ...node, title: "Changed after" } }, web), 409);
    const { entries } = await host.entries(id, 100, undefined);
    expect(entries.filter(e => e.kind === CREATION_KIND).map(e => e.data)).toEqual([expect.objectContaining({ canonicalId: "fixture-1", entryId: "7", operationId: `${id}:${proposalId}:2` })]);
  });

  test("a card or unclear request asks for type and destination first; unknown and observation-only types are refused, not coerced", async () => {
    const { owner, creation, start } = await setup();
    const id = await start();
    await refused(creation.propose(id, { proposalId: randomUUID(), type: "settings", fields: {} }, web), 409);
    expect(await refused(creation.propose(id, { proposalId: randomUUID(), type: "card", fields: {} }, web), 409)).toContain("not a type in the creation catalog");
    const proposalId = randomUUID();
    const card = await creation.propose(id, { proposalId, intent: "make a card for the workshop", fields: { title: "Workshop exercise" } }, web);
    expect(card.view.feedback).toBe("choose");
    expect(await refused(creation.confirm(id, proposalId, confirmOf(card.view), web), 409)).toContain("Choose what to create");
    await refused(creation.revise(id, proposalId, { revision: 1, type: "desk-source-card" }, web), 409);
    const typed = await creation.revise(id, proposalId, { revision: 1, type: "balance-task" }, web);
    expect(typed).toMatchObject({ feedback: "proposed", missing: ["Area"], proposal: { type: "balance-task", fields: { title: "Workshop exercise" } } });
    expect(await refused(creation.confirm(id, proposalId, confirmOf(typed), web), 400)).toContain("Area");
    const placed = await creation.revise(id, proposalId, { revision: 2, fields: { title: "Workshop exercise", area: "work" } }, web);
    expect((await creation.confirm(id, proposalId, confirmOf(placed), web)).feedback).toBe("created");
    const blocked = await creation.propose(id, { proposalId: randomUUID(), type: "flow", fields: { destination: "pkg", name: "f", definition: "steps: []" } }, web);
    expect(blocked.view).toMatchObject({ feedback: "unavailable", capability: { status: "blocked:3014" } });
    await refused(creation.confirm(id, blocked.view.proposal.proposalId, confirmOf(blocked.view), web), 409);
    expect(owner.effects).toHaveLength(1);
  });

  test("standing permission defaults to this conversation and type, a global grant is explicit, and revoking keeps history and created objects", async () => {
    const { owner, host, creation, start } = await setup();
    const here = await start();
    const there = await start();
    const first = await creation.propose(here, { proposalId: randomUUID(), type: "graph-node", fields: node }, web);
    await creation.confirm(here, first.view.proposal.proposalId, { ...confirmOf(first.view), grant: { scope: "conversation" } }, web);
    const [grant] = await creation.grants();
    expect(grant).toMatchObject({ type: "graph-node", scope: "conversation", conversationId: here });
    const auto = await creation.propose(here, { proposalId: randomUUID(), type: "graph-node", fields: { ...node, title: "Second" } }, web);
    expect(auto.view.operation).toMatchObject({ state: "created", authority: { kind: "grant", scope: "conversation", grantId: grant?.grantId } });
    const otherType = await creation.propose(here, { proposalId: randomUUID(), type: "balance-task", fields: { area: "work", title: "Task" } }, web);
    expect(otherType.view.feedback).toBe("proposed");
    const elsewhere = await creation.propose(there, { proposalId: randomUUID(), type: "graph-node", fields: node }, web);
    expect(elsewhere.view.feedback).toBe("proposed");
    await creation.confirm(there, elsewhere.view.proposal.proposalId, { ...confirmOf(elsewhere.view), grant: { scope: "global" } }, web);
    const third = await start();
    expect((await creation.propose(third, { proposalId: randomUUID(), type: "graph-node", fields: node }, web)).view.feedback).toBe("created");
    for (const g of await creation.grants()) await creation.revoke(g.grantId, web);
    const after = await creation.propose(third, { proposalId: randomUUID(), type: "graph-node", fields: node }, web);
    expect(after.view.feedback).toBe("proposed");
    const grants = await creation.grants();
    expect(grants).toHaveLength(2);
    expect(grants.every(g => g.revokedAt)).toBe(true);
    expect((await creation.list(here, web)).proposals.filter(p => p.feedback === "created")).toHaveLength(2);
    expect(owner.effects).toHaveLength(4);
    const kinds = (await host.entries(here, 100, undefined)).entries.filter(e => e.kind === GRANT_KIND).map(e => (e.data as { action: string }).action);
    expect(kinds).toEqual(["granted", "revoked"]);
  });

  test("a revoked grant is rechecked before execution", async () => {
    const { owner, creation, start } = await setup();
    const id = await start();
    const first = await creation.propose(id, { proposalId: randomUUID(), type: "routine", fields: { name: "r", target: "t", schedule: "daily", timezone: "Europe/Zurich" } }, web);
    await creation.confirm(id, first.view.proposal.proposalId, { ...confirmOf(first.view), grant: { scope: "conversation" } }, web);
    const [grant] = await creation.grants();
    if (!grant) throw new Error("no grant");
    await creation.revoke(grant.grantId, web);
    const next = await creation.propose(id, { proposalId: randomUUID(), type: "routine", fields: { name: "r2", target: "t", schedule: "daily", timezone: "Europe/Zurich" } }, web);
    expect(next.view.feedback).toBe("proposed");
    expect(owner.effects).toHaveLength(1);
  });

  test("a timeout or lost answer stays uncertain, is never retried blindly, and Check settles it from the owner's readback", async () => {
    const { owner, creation, start } = await setup(undefined, 50);
    const id = await start();
    owner.mode = "hang";
    const proposal = (await creation.propose(id, { proposalId: randomUUID(), type: "graph-node", fields: node }, web)).view;
    const timed = await creation.confirm(id, proposal.proposal.proposalId, confirmOf(proposal), web);
    expect(timed.feedback).toBe("uncertain");
    expect(timed.operation?.history.at(-1)?.detail).toContain("did not answer");
    owner.mode = "create";
    expect((await creation.confirm(id, proposal.proposal.proposalId, confirmOf(proposal), web)).feedback).toBe("uncertain");
    expect(owner.calls).toHaveLength(1);
    await refused(creation.revise(id, proposal.proposal.proposalId, { revision: 1, fields: { ...node, title: "x" } }, web), 409);
    const checked = await creation.check(id, proposal.proposal.proposalId, web);
    expect(checked).toMatchObject({ feedback: "created", operation: { canonicalId: "fixture-1" } });
    expect(owner.effects).toHaveLength(1);

    owner.mode = "lose-answer";
    const lost = (await creation.propose(id, { proposalId: randomUUID(), type: "graph-node", fields: node }, web)).view;
    expect((await creation.confirm(id, lost.proposal.proposalId, confirmOf(lost), web)).feedback).toBe("uncertain");
    owner.objects.clear();
    const gone = await creation.check(id, lost.proposal.proposalId, web);
    expect(gone.feedback).toBe("failed");
    owner.mode = "create";
    const retry = await creation.revise(id, lost.proposal.proposalId, { revision: 1, fields: node }, web);
    expect(retry.proposal.revision).toBe(2);
    const created = await creation.confirm(id, lost.proposal.proposalId, confirmOf(retry), web);
    expect(created).toMatchObject({ feedback: "created", earlier: [expect.objectContaining({ revision: 1, state: "failed" })] });

    owner.mode = "no-id";
    const blank = (await creation.propose(id, { proposalId: randomUUID(), type: "graph-node", fields: node }, web)).view;
    expect((await creation.confirm(id, blank.proposal.proposalId, confirmOf(blank), web)).feedback).toBe("uncertain");
  });

  test("feedback distinguishes accepted, failed and created", async () => {
    const { owner, creation, start } = await setup();
    const id = await start();
    owner.mode = "accept";
    const queued = (await creation.propose(id, { proposalId: randomUUID(), type: "graph-node", fields: node }, web)).view;
    expect((await creation.confirm(id, queued.proposal.proposalId, confirmOf(queued), web)).feedback).toBe("accepted");
    expect((await creation.check(id, queued.proposal.proposalId, web)).feedback).toBe("accepted");
    owner.objects.set(`${id}:${queued.proposal.proposalId}:1`, "fixture-late");
    expect((await creation.check(id, queued.proposal.proposalId, web)).operation?.canonicalId).toBe("fixture-late");
    owner.mode = "fail";
    const refusedByOwner = (await creation.propose(id, { proposalId: randomUUID(), type: "graph-node", fields: node }, web)).view;
    const failed = await creation.confirm(id, refusedByOwner.proposal.proposalId, confirmOf(refusedByOwner), web);
    expect(failed).toMatchObject({ feedback: "failed", operation: { history: expect.arrayContaining([expect.objectContaining({ detail: "The fixture owner refused this payload." })]) } });
  });

  test("identity, interface and strictest-policy gates apply to every proposal, confirmation and revocation", async () => {
    const { owner, host, creation, start } = await setup();
    const id = await start();
    const other: Actor = { principal: "someone-else@example.invalid", transport: "web" };
    await refused(creation.propose(id, { proposalId: randomUUID(), type: "graph-node", fields: node }, other), 403);
    const view = (await creation.propose(id, { proposalId: randomUUID(), type: "graph-node", fields: node }, discord)).view;
    await refused(creation.list(id, other), 403);
    await refused(creation.confirm(id, view.proposal.proposalId, confirmOf(view), other), 403);
    expect((await creation.confirm(id, view.proposal.proposalId, { ...confirmOf(view), grant: { scope: "conversation" } }, discord)).operation?.authority).toEqual({ kind: "confirmation", transport: "discord" });
    const [grant] = await creation.grants();
    if (!grant) throw new Error("no grant");
    await refused(creation.revoke(grant.grantId, other), 403);

    const local = await start("local");
    await refused(creation.propose(local, { proposalId: randomUUID(), type: "balance-task", fields: { area: "a", title: "t" } }, discord), 403);
    const leaving = (await creation.propose(local, { proposalId: randomUUID(), type: "tana-note", fields: { text: "private" } }, web)).view;
    expect(leaving.refusal).toContain("local-only");
    await refused(creation.confirm(local, leaving.proposal.proposalId, confirmOf(leaving), web), 403);
    const staying = (await creation.propose(local, { proposalId: randomUUID(), type: "balance-task", fields: { area: "a", title: "t" } }, web)).view;
    await refused(creation.confirm(local, staying.proposal.proposalId, confirmOf(staying), discord), 403);
    expect((await creation.confirm(local, staying.proposal.proposalId, confirmOf(staying), web)).feedback).toBe("created");

    await host.organize(id, { state: "archived" });
    await refused(creation.propose(id, { proposalId: randomUUID(), type: "graph-node", fields: node }, web), 409);
    expect(owner.effects).toHaveLength(2);
  });
});

describe("operation journal recovery", () => {
  test("a running operation is reconciled through owner readback when the owner attaches, before new input or confirmation", async () => {
    const dir = await dirs.make();
    const owner = fixtureOwner();
    const first = await open(dir);
    const id = (await first.create({ title: "Crash", links: [], origin: { kind: "web" }, policy: "cloud" }, PRINCIPAL)).id;
    const lost = await first.propose(id, "p-lost", 1, "graph-node", "d");
    const found = await first.propose(id, "p-found", 1, "graph-node", "d");
    for (const op of [lost, found]) { await first.transition(op.operationId, "confirmed"); await first.transition(op.operationId, "running"); }
    owner.objects.set(found.operationId, "fixture-recovered");
    await first.close();
    hosts.splice(hosts.indexOf(first), 1);
    const status = await openConversationHost({ dir, stack: "test", label: LABEL, expectedLabel: LABEL, endpoints: { cloud: endpoint }, chat: () => Promise.resolve("ok") });
    if (status.state !== "ready") throw new Error(status.reason);
    hosts.push(status.host);
    expect((await status.host.operations(id)).map(o => o.state).sort()).toEqual(["uncertain", "uncertain"]);
    const reconciled = await status.host.attachSources({ resolvers: {}, readbacks: {}, writers: { "graph-node": owner.writer } });
    expect(reconciled.sort()).toEqual([found.operationId, lost.operationId].sort());
    const states = Object.fromEntries((await status.host.operations(id)).map(o => [o.proposalId, o]));
    expect(states["p-found"]).toMatchObject({ state: "created", canonicalId: "fixture-recovered" });
    expect(states["p-lost"]?.state).toBe("uncertain");
    expect(owner.calls).toHaveLength(0);
  });
});
