import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { DEFAULT_SETTINGS, balanceDestinations, type AppState, type OutlineNode } from "../../../balance";
import { DESK_BALANCE_DESTINATIONS_PATH, handleDeskBalanceDestinations } from "../api/desk-balance-destinations";
import { initDatabase } from "../db/init";
import { HandledLedger } from "../desk/actions";
import { saveBalanceState } from "../desk/balance-store";
import { desk } from "./desk-day-fixture";

const node = (id: string, title: string, children: OutlineNode[] = [], extra: Partial<OutlineNode> = {}): OutlineNode => ({ id, title, weight: 50, ordering: "parallel", children, ...extra });
const task = (id: string, title: string): OutlineNode => node(id, title, [], { effort: 1 });
const state: AppState = {
  outline: node("desk:outline", "Outline", [
    node("area:work", "Work", [
      node("p-alpha", "Alpha", [task("t1", "Write")]),
      node("p-beta", "Shared", [task("t2", "Plan")]),
      node("p-gamma", "shared", []),
      node("p-done", "Finished", [task("t3", "Old")], { done: true }),
      node("studio-response:x", "Reply", []),
    ]),
  ]),
  log: [], settings: { ...DEFAULT_SETTINGS }, dayState: null, history: { deficits: {}, lastSurfaced: {} },
};

describe("GET /api/desk/balance/destinations", () => {
  let db: Database;
  const call = async (query: string, enabled = true, method = "GET") => {
    const response = handleDeskBalanceDestinations(new Request(`http://x${DESK_BALANCE_DESTINATIONS_PATH}${query}`, { method }), db, { options: { ...desk, enabled }, ledger: new HandledLedger() });
    return { status: response.status, body: response.status === 405 ? null : await response.json() as Record<string, unknown> };
  };
  beforeEach(() => { db = initDatabase(":memory:"); saveBalanceState(db, state); });
  afterEach(() => db.close());

  it("serves the outline destinations as balanceDestinations does", async () => {
    const res = await call("");
    expect(res.body).toEqual({ destinations: balanceDestinations(state.outline, desk.areas) });
    const ids = (res.body!.destinations as { id: string }[]).map(d => d.id);
    expect(ids).not.toContain("p-done");
    expect(ids).not.toContain("studio-response:x");
    expect(ids).not.toContain("t1");
  });

  it("includes tasks with tasks=1", async () => {
    const ids = ((await call("?tasks=1")).body!.destinations as { id: string }[]).map(d => d.id);
    expect(ids).toContain("t1");
  });

  it("filters by area", async () => {
    expect(((await call("?area=work")).body!.destinations as unknown[]).length).toBe(3);
    expect((await call("?area=none")).body!.destinations).toEqual([]);
  });

  it("resolves a match by id or unique title", async () => {
    expect((await call("?match=p-alpha")).body!.resolved).toEqual({ id: "p-alpha" });
    expect((await call("?match=ALPHA")).body!.resolved).toEqual({ id: "p-alpha" });
  });

  it("reports why a match did not resolve", async () => {
    expect((await call("?match=nothing")).body!.resolved).toEqual({ none: true, reason: "none" });
    expect((await call("?match=shared")).body!.resolved).toEqual({ none: true, reason: "ambiguous" });
    expect((await call("?match=area:other")).body!.resolved).toEqual({ none: true, reason: "id-shaped" });
  });

  it("answers the disabled response when the Desk is off", async () => {
    expect((await call("", false)).status).toBe(409);
  });

  it("refuses other methods", async () => {
    expect((await call("", true, "POST")).status).toBe(405);
  });
});
