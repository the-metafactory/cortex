import { describe, expect, it } from "bun:test";
import { DEFAULT_SETTINGS, findNode, nextOccurrence, shiftDays, type AppState, type OutlineNode } from "../../../balance";
import { handleDeskMyDay } from "../api/desk-my-day";
import { loadBalanceState } from "../desk/balance-store";
import { HandledLedger } from "../desk/actions";
import type { MyDayOutlineNode } from "../desk/my-day";
import { DATE, NOW, dayDatabase, desk } from "./desk-day-fixture";

const completedAt = shiftDays(DATE, -1);
const weekly = { unit: "week" as const, interval: 1 };
const leaf = (id: string, extra: Partial<OutlineNode> = {}): OutlineNode => ({ id, title: id, weight: 50, ordering: "parallel", children: [], effort: 1, ...extra });
function seed(): AppState {
  return { outline: { id: "root", title: "Outline", weight: 100, ordering: "parallel", children: [{ id: "area:work", title: "Work", weight: 50, ordering: "parallel", children: [
    leaf("water", { repeat: weekly, leadDays: 2, done: true, completedAt }),
    leaf("taxes", { repeat: { ...weekly, count: 2, timesDone: 2 }, done: true, completedAt }),
    leaf("stretch", { repeat: weekly }),
    leaf("letter"),
  ] }] }, settings: { ...DEFAULT_SETTINGS }, log: [], history: { deficits: {}, lastSurfaced: {} }, dayState: null };
}

describe("GET /api/desk/my-day recurrence projection", () => {
  const { db } = dayDatabase(seed);
  const read = async () => {
    const response = await handleDeskMyDay(new Request("http://localhost/api/desk/my-day"), db(), { options: desk, ledger: new HandledLedger() }, undefined, NOW);
    expect(response.status).toBe(200);
    return (await response.json()) as { outline: MyDayOutlineNode };
  };
  const row = (node: MyDayOutlineNode, id: string): MyDayOutlineNode | undefined => node.id === id ? node : node.children.map(child => row(child, id)).find(found => found !== undefined);

  it("gives a done repeating row its return date and the day it reappears", async () => {
    const returnsOn = nextOccurrence(completedAt, weekly);
    expect(row((await read()).outline, "water")?.recurrence).toEqual({ returnsOn, finished: false, reappearsOn: shiftDays(returnsOn, -2) });
  });
  it("marks an exhausted repeat finished with no dates", async () => {
    expect(row((await read()).outline, "taxes")?.recurrence).toEqual({ returnsOn: null, finished: true, reappearsOn: null });
  });
  it("gives an open repeating row no dates and a non-repeating row no projection", async () => {
    const { outline } = await read();
    expect(row(outline, "stretch")?.recurrence).toEqual({ returnsOn: null, finished: false, reappearsOn: null });
    expect(row(outline, "letter")).not.toHaveProperty("recurrence");
    expect(row(outline, "area:work")).not.toHaveProperty("recurrence");
  });
  it("keeps the rule in repeat and leaves the stored outline without the projection", async () => {
    expect(row((await read()).outline, "water")?.repeat).toEqual(weekly);
    const stored = loadBalanceState(db());
    if (!stored) throw new Error("The seeded outline is missing.");
    expect(findNode(stored.outline, "water")).not.toHaveProperty("recurrence");
  });
});
