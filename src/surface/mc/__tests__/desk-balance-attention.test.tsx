import { afterEach, describe, expect, it } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { findNode } from "../../../balance";
import { planBalanceToday, seedBalanceObservationOverflow } from "../../../conversations/domain-adapters/__tests__/fixtures/balance-read-fixtures";
import { handleDeskAdapterAction } from "../api/desk-adapter";
import { handleDeskMyDay } from "../api/desk-my-day";
import { loadBalanceState, saveBalanceState } from "../desk/balance-store";
import { loadMeta, saveMeta } from "../desk/balance-sync";
import { composeDesk } from "../desk/compose";
import type { DeskItem, DeskView } from "../desk/types";
import type { AttentionOptions } from "../desk/fixtures/adapter-attention-fixtures";
import { ALL_AREAS, briefing, selectItems, spokenBriefing } from "../desk/present";
import { catchupItems } from "../dashboard-v2/components/desk-catch-up";
import { DeskItemRow } from "../dashboard-v2/components/desk-view";
import { SourceCache } from "../desk/sources/command";
import { localDay } from "../desk/time";
import { BALANCE_ATTENTION_MAIL as MAIL, openBalanceAttentionStack } from "../desk/fixtures/balance-attention";

const NOW = Date.parse("2026-11-01T09:00:00.000Z");
const DATE = localDay(NOW);

type Stack = Awaited<ReturnType<typeof openBalanceAttentionStack>>;
const opened: Stack[] = [];
afterEach(async () => { for (const stack of opened.splice(0)) await stack.close(); });

async function build(options: AttentionOptions = {}, studioLink = true): Promise<Stack> {
  const stack = await openBalanceAttentionStack(NOW, options, studioLink);
  opened.push(stack);
  return stack;
}

const adapterRows = (view: DeskView): DeskItem[] => view.items.filter(item => item.kind === "adapter");
const row = (view: DeskView, title: string): DeskItem | undefined => adapterRows(view).find(item => item.title === title);
const balanceState = (stack: Stack) => {
  const state = loadBalanceState(stack.balance.db);
  if (!state) throw new Error("the owner store is missing");
  return state;
};

describe("Catch-up lists actionable adapter tasks beside mail", () => {
  it("observes open tasks across areas before completed tasks can consume the batch", async () => {
    const stack = await build();
    await stack.balance.allowHome();
    const actionable = seedBalanceObservationOverflow(stack.balance);
    const planned = actionable.at(-1);
    if (!planned) throw new Error("the overflow fixture has no actionable task");
    planBalanceToday(stack.db, DATE, [planned]);
    const view = await stack.compose();
    const rows = adapterRows(view);
    expect(rows).toHaveLength(actionable.length);
    expect(new Set(rows.map(item => item.key)).size).toBe(actionable.length);
    for (const id of actionable) expect(rows.some(item => item.key.includes(id))).toBe(true);
    expect(rows.find(item => item.key.includes(planned))?.badge).toBe("In today");
    expect(rows.every(item => item.freshness === "fresh")).toBe(true);
    expect(view.sources.find(source => source.id === "adapter:balance")?.ok).toBe(true);
  });

  it("pages past the batch limit without losing actionable tasks or reporting completed-task gaps", async () => {
    const stack = await build();
    await stack.balance.allowHome();
    seedBalanceObservationOverflow(stack.balance, 11);
    const view = await stack.compose();
    expect(adapterRows(view)).toHaveLength(22);
    expect(adapterRows(view).every(item => item.freshness === "fresh")).toBe(true);
    expect(view.sources.find(source => source.id === "adapter:balance")).toEqual({ id: "adapter:balance", ok: true });
    expect(view.systems).not.toContain("The adapter:balance source is unreachable.");
    expect(await stack.balance.store().needsResync(stack.balance.rig.context, stack.balance.source, stack.balance.rig.sink)).toBe(false);
  });

  it("refreshes completion beyond the first page without deleting completed history", async () => {
    const stack = await build();
    await stack.balance.allowHome();
    const ids = seedBalanceObservationOverflow(stack.balance, 11);
    expect(adapterRows(await stack.compose())).toHaveLength(22);
    const state = balanceState(stack);
    const task = findNode(state.outline, ids[0] ?? "");
    if (!task) throw new Error("the overflow task is missing");
    task.done = true;
    saveBalanceState(stack.db, state);
    const view = await stack.compose();
    expect(adapterRows(view)).toHaveLength(21);
    expect(row(view, task.title)).toBeUndefined();
    expect(view.sources.find(source => source.id === "adapter:balance")?.ok).toBe(true);
  });

  it("badges follow a person's draft rather than the engine's proposal", async () => {
    const stack = await build();
    saveMeta(stack.db, { ...loadMeta(stack.db), draft: { date: DATE, ids: ["task-glue"], origin: "person" } });
    const view = await stack.compose();
    expect(view.myDay?.items.map(item => item.task.id)).toEqual(["task-glue"]);
    expect(row(view, "Buy glue")?.badge).toBe("In today");
    expect(row(view, "Cut the wing")?.badge).toBeUndefined();
  });

  it("clears the incomplete source after a complete reconciliation", async () => {
    const stack = await build();
    await stack.balance.allowHome();
    seedBalanceObservationOverflow(stack.balance, 11);
    await stack.compose();
    await stack.balance.store().gap(stack.balance.source);
    const state = balanceState(stack);
    const home = state.outline.children[1];
    if (!home) throw new Error("the overflow area is missing");
    for (const task of home.children.slice(-2)) task.done = true;
    saveBalanceState(stack.db, state);
    expect((await stack.balance.check("reconcile")).status).toBe("ok");
    const view = await stack.compose();
    expect(view.sources.find(source => source.id === "adapter:balance")).toEqual({ id: "adapter:balance", ok: true });
    expect(adapterRows(view)).toHaveLength(20);
    expect(adapterRows(view).every(item => item.freshness === "fresh")).toBe(true);
  });

  it("shows one row per actionable Balance task and the kind filter narrows to them", async () => {
    const stack = await build();
    await stack.balance.check();
    const view = await stack.compose();
    expect(adapterRows(view).map(item => item.title).sort()).toEqual(["Buy glue", "Cut the wing", "Studio answer"]);
    expect(new Set(adapterRows(view).map(item => item.key)).size).toBe(3);
    expect(view.items.filter(item => item.kind === "mail")).toHaveLength(1);
    expect(catchupItems(view.items, "", "all", "adapter").map(item => item.title).sort()).toEqual(["Buy glue", "Cut the wing", "Studio answer"]);
    expect(catchupItems(view.items, "", "all", "adapter").every(item => item.kind === "adapter")).toBe(true);
    expect(catchupItems(view.items, "area-example", "all", "adapter").length).toBe(3);
    expect(catchupItems(view.items, "", "all", "mail").map(item => item.kind)).toEqual(["mail"]);
    expect(row(view, "Fold the body")).toBeUndefined();
  });

  it("keeps a planned task in Catch-up with its In today badge and leaves My Day order alone", async () => {
    const stack = await build();
    planBalanceToday(stack.db, DATE, ["task-wing"]);
    await stack.balance.check();
    const withAdapters = await stack.compose();
    const withoutAdapters = await composeDesk(stack.db, stack.desk, undefined, { now: NOW, sourceCache: new SourceCache(() => Promise.resolve(JSON.stringify({ items: [MAIL] }))) });
    expect(row(withAdapters, "Cut the wing")?.badge).toBe("In today");
    expect(row(withAdapters, "Buy glue")?.badge).toBeUndefined();
    expect(withoutAdapters.myDay?.items.map(item => item.task.id)).toEqual(["task-wing"]);
    expect(withAdapters.myDay?.items.map(item => item.task.id)).toEqual(withoutAdapters.myDay?.items.map(item => item.task.id));
    expect(balanceState(stack).dayState?.confirmed).toEqual(["task-wing"]);
    const state = balanceState(stack);
    state.dayState = null;
    saveBalanceState(stack.db, state);
    saveMeta(stack.balance.db, { ...loadMeta(stack.balance.db), draft: { date: DATE, ids: ["task-glue", "task-wing"], origin: "person" } });
    const drafted = await stack.compose();
    expect(drafted.myDay?.items.map(item => item.task.id)).toEqual(["task-glue", "task-wing"]);
    expect(row(drafted, "Cut the wing")?.badge).toBe("In today");
  });

  it("keeps an undated adapter row out of Needs you and the written and spoken summaries", async () => {
    const stack = await build();
    await stack.balance.check();
    const view = await stack.compose();
    const selection = selectItems(view, ALL_AREAS, new Set());
    expect(selection.needsYou.filter(item => item.kind === "adapter").map(item => item.title)).toEqual(["Cut the wing"]);
    expect(selection.needsYou.some(item => item.title === "Buy glue")).toBe(false);
    expect(selection.rest.some(item => item.title === "Buy glue")).toBe(true);
    const attentionLine = briefing(view, selection, null).lines[0] ?? "";
    expect(attentionLine).not.toContain("Buy glue");
    expect(attentionLine).not.toContain("Studio answer");
    expect(attentionLine).toContain("First: Cut the wing");
    expect(spokenBriefing(view, selection, null)).toContain("First: Cut the wing");
  });

  it("lets an overdue adapter row into Needs you and both summaries", async () => {
    const stack = await build();
    const state = balanceState(stack);
    const wing = findNode(state.outline, "task-wing");
    if (!wing) throw new Error("the Balance fixture is missing its task");
    wing.dueDate = "2026-10-30";
    saveBalanceState(stack.db, state);
    await stack.balance.check();
    const view = await composeDesk(stack.db, { ...stack.desk, sources: [] }, undefined, { now: NOW, adapterAttention: [() => stack.balance.attentionAccess(), stack.synthetic.feature] });
    expect(row(view, "Cut the wing")).toMatchObject({ dueAt: "2026-10-30", urgency: "today", score: 55 });
    const selection = selectItems(view, ALL_AREAS, new Set());
    expect(selection.needsYou.map(item => item.title)).toEqual(["Cut the wing"]);
    expect(briefing(view, selection, null).lines[0] ?? "").toContain("First: Cut the wing");
    expect(spokenBriefing(view, selection, null)).toContain("First: Cut the wing");
  });

  it("turns a filed mail into its Balance task once", async () => {
    const stack = await build();
    await stack.balance.check();
    const before = await stack.compose();
    const mail = before.items.find(item => item.kind === "mail");
    if (!mail || !before.myDay) throw new Error("the mail fixture is incomplete");
    const response = await handleDeskMyDay(new Request("http://localhost/api/desk/my-day", { method: "POST", body: JSON.stringify({ date: DATE, requestId: crypto.randomUUID(), command: { op: "source-plan", revision: before.myDay.revision, key: mail.key, fingerprint: mail.todoFingerprint, parent: "area:area-example" } }) }), stack.db, stack.runtime, undefined, NOW);
    expect(response.status).toBe(200);
    const filed = await response.json() as { outlineId: string };
    await stack.balance.check();
    const after = await stack.compose();
    expect(after.items.filter(item => item.kind === "mail")).toHaveLength(0);
    const tasks = adapterRows(after).filter(item => item.title === mail.title);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.key).toContain(filed.outlineId);
  });

  it("shows a Studio-owned row as Respond in Studio with no Done", async () => {
    const stack = await build();
    await stack.balance.check();
    const view = await stack.compose();
    const studio = row(view, "Studio answer");
    expect(studio?.actions).toMatchObject([{ id: "studio.respond", label: "Respond in Studio", role: "primary", wired: true, target: "thread-1" }]);
    expect(studio?.actions.some(action => action.label === "Done")).toBe(false);
    expect(studio?.readOnly).toBe(true);
  });

  it("does not wire Respond in Studio when the Studio thread is unknown", async () => {
    const stack = await build({}, false);
    await stack.balance.check();
    const studio = row(await stack.compose(), "Studio answer");
    expect(studio?.actions).toMatchObject([{ id: "studio.respond", label: "Respond in Studio", wired: false }]);
    expect(studio?.actions[0]?.target).toBeUndefined();
  });

  it("reads adapter rows after the shared projection refresh", async () => {
    const stack = await build();
    expect(adapterRows(await stack.compose()).map(item => item.title).sort()).toEqual(["Buy glue", "Cut the wing", "Studio answer"]);
    const state = balanceState(stack);
    const glue = findNode(state.outline, "task-glue");
    if (!glue) throw new Error("the Balance fixture is missing its task");
    glue.done = true;
    saveBalanceState(stack.db, state);
    expect(row(await stack.compose(), "Buy glue")).toBeUndefined();
  });

  it("gives a synthetic adapter the same row and rules with no domain branch and no owner-raised score", async () => {
    const stack = await build();
    await stack.balance.check();
    await stack.synthetic.ingest(0, [{ ...(stack.synthetic.value(0) as Record<string, unknown>), score: 9999, urgency: "now" }]);
    const view = await stack.compose();
    const synthetic = row(view, "Synthetic review");
    expect(synthetic).toMatchObject({ source: "synthetic-one", actions: [], readOnly: true, dueAt: "2026-11-01", urgency: "today", score: 55 });
    expect(synthetic?.attention).toBeUndefined();
    expect(synthetic?.interrupt).toBeUndefined();
    expect(selectItems(view, ALL_AREAS, new Set()).needsYou.map(item => item.title)).toContain("Synthetic review");
    expect(catchupItems(view.items, "", "all", "adapter", "synthetic-one").map(item => item.title)).toEqual(["Synthetic review"]);
  });
});

describe("an adapter row leaves when its source leaves", () => {
  it("keeps a stale projection with its stale status", async () => {
    const stack = await build();
    await stack.balance.check();
    await stack.synthetic.ingest(0);
    stack.balance.time.advance(720000);
    stack.synthetic.time.advance(720000);
    stack.balance.unavailable(true);
    const view = await stack.compose(NOW);
    const wing = row(view, "Cut the wing");
    if (!wing) throw new Error("the stale Balance row is missing");
    expect(wing.freshness).toBe("stale");
    expect(row(view, "Synthetic review")?.freshness).toBe("stale");
    const html = renderToStaticMarkup(createElement(DeskItemRow, { item: wing, rank: 1, onOpen: () => undefined, onAction: () => undefined, sending: null, onFocusEvent: () => undefined, onCorrect: () => undefined }));
    expect(html).toContain("Stale observation");
    expect(html).toContain("Cut the wing");
  });

  it("drops a revoked read, a removed area and an owner-evidenced deletion", async () => {
    const stack = await build();
    await stack.balance.check();
    await stack.synthetic.ingest(0);
    expect(adapterRows(await stack.compose()).length).toBe(4);
    await stack.synthetic.remove(0);
    expect(row(await stack.compose(), "Synthetic review")).toBeUndefined();
    stack.balance.removeArea("area-example");
    const removed = await stack.compose();
    expect(adapterRows(removed)).toHaveLength(0);
    expect(JSON.stringify(removed.items)).not.toContain("Cut the wing");
    expect(JSON.stringify(removed.sources)).not.toContain("adapter:balance");
  });

  it("drops a row when the read is revoked", async () => {
    const stack = await build();
    await stack.balance.check();
    await stack.synthetic.ingest(0);
    expect(row(await stack.compose(), "Synthetic review")).toBeDefined();
    await stack.synthetic.revoke(0);
    expect(row(await stack.compose(), "Synthetic review")).toBeUndefined();
  });
});

describe("a row capability reaches host authority", () => {
  const post = (key: string, capability: string): Request => new Request("http://localhost/api/desk/adapter", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key, capability }) });

  it("denies a declared capability that the connection lacks authority for", async () => {
    const stack = await build({ rowCapabilities: { granted: false } });
    await stack.balance.check();
    await stack.synthetic.ingest(0);
    const view = await stack.compose();
    const synthetic = row(view, "Synthetic review");
    expect(synthetic?.actions).toMatchObject([{ id: "adapter.capability:synthetic-one.complete", label: "Complete", target: stack.synthetic.capabilityOf(0) }]);
    const response = await handleDeskAdapterAction(post(synthetic?.key ?? "", stack.synthetic.capabilityOf(0)), stack.runtime, NOW);
    expect(response.status).toBe(403);
    expect(stack.synthetic.rig.calls.dispatch).toBe(0);
  });

  it("checking a row capability fetches no unrelated Desk source", async () => {
    const stack = await build({ rowCapabilities: { granted: false } });
    await stack.synthetic.ingest(0);
    const item = row(await stack.compose(), "Synthetic review");
    if (!item) throw new Error("the synthetic row is missing");
    let unrelatedFetches = 0;
    stack.runtime.sourceCache = new SourceCache(() => { unrelatedFetches++; return Promise.resolve('{"items":[]}'); });
    expect((await handleDeskAdapterAction(post(item.key, stack.synthetic.capabilityOf(0)), stack.runtime, NOW)).status).toBe(403);
    expect(unrelatedFetches).toBe(0);
  });

  it("admits the press through the host only when the connection carries the capability", async () => {
    const stack = await build({ rowCapabilities: { granted: true } });
    await stack.balance.check();
    await stack.synthetic.ingest(0);
    const view = await stack.compose();
    const synthetic = row(view, "Synthetic review");
    const response = await handleDeskAdapterAction(post(synthetic?.key ?? "", stack.synthetic.capabilityOf(0)), stack.runtime, NOW);
    expect(response.status).toBe(501);
    expect(stack.synthetic.rig.calls.dispatch).toBe(0);
  });

  it("refuses a capability a row does not declare and a row that is gone", async () => {
    const stack = await build();
    await stack.balance.check();
    await stack.synthetic.ingest(0);
    const view = await stack.compose();
    const synthetic = row(view, "Synthetic review");
    expect((await handleDeskAdapterAction(post(synthetic?.key ?? "", "synthetic-one.complete"), stack.runtime, NOW)).status).toBe(409);
    expect((await handleDeskAdapterAction(post("adapter:nothing", "synthetic-one.complete"), stack.runtime, NOW)).status).toBe(409);
  });
});
