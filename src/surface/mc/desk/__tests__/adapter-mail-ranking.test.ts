import { afterEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { initDatabase } from "../../db/init";
import { composeDesk } from "../compose";
import { heldDuringMeeting, markInterrupts, quietAdapterInterrupts, NO_INTERRUPTIONS, type InterruptRules } from "../interrupt";
import { assertRoute, contentFrom, sourceBoundary, CloudRouteRefused } from "../source-boundary";
import type { CalendarAvailability } from "../calendar-availability";
import type { Json } from "../../../../conversations/domain-adapters/operations/types";
import { ATTENTION_DESK, attentionRig } from "../fixtures/adapter-attention-fixtures";

type Rig = Awaited<ReturnType<typeof attentionRig>>;
const live: { rigs: Rig[]; stores: Database[] } = { rigs: [], stores: [] };
afterEach(async () => {
  live.stores.splice(0).forEach(store => store.close());
  await Promise.all(live.rigs.splice(0).map(rig => rig.rig.close()));
});

async function composeRanked(objects: (item: Rig) => Json[], rules: InterruptRules = NO_INTERRUPTIONS) {
  const item = await attentionRig("local", { ranking: true });
  const db = initDatabase(":memory:");
  live.rigs.push(item);
  live.stores.push(db);
  await item.ingest(0, objects(item));
  const view = await composeDesk(db, { ...ATTENTION_DESK, interruptions: rules }, undefined, { now: item.time.clock.now(), adapterAttention: item.feature });
  return { item, view };
}

function mail(item: Rig, title: string, rank: number | null, alert: boolean | null): Json {
  const value = item.value(0, title, null) as Record<string, Json>;
  const data = value["display/data"] as Record<string, Json>;
  data.rank = rank;
  data.alert = alert;
  return value;
}

test("the adapter view shows mail in the adapter's own ranking", async () => {
  const { view } = await composeRanked(item => [mail(item, "Third", 2, null), mail(item, "First", 0, null), mail(item, "Second", 1, null)]);
  expect(view.items.filter(card => card.kind === "adapter").map(card => card.title)).toEqual(["First", "Second", "Third"]);
  const scores = view.items.map(card => card.score);
  expect(scores).toEqual([...scores].sort((a, b) => b - a));
  expect(new Set(view.items.map(card => card.urgency))).toEqual(new Set(["waiting"]));
});

test("a rank outside the adapter range hides the row and reports a safe source problem", async () => {
  const { view } = await composeRanked(item => [mail(item, "Out of range", 5000, null), mail(item, "In range", 3, null)]);
  expect(view.items.map(card => card.title)).toEqual(["In range"]);
  expect(view.sources.find(source => source.id === "adapter:synthetic-one")?.ok).toBe(false);
});

test("an interrupt request is placed by the host rules, and does nothing when interruptions are off", async () => {
  const on: InterruptRules = { ...NO_INTERRUPTIONS, transport: "discord", mail: true };
  const asked = await composeRanked(item => [mail(item, "Urgent", 0, true), mail(item, "Quiet", 1, false)], on);
  expect(asked.view.items.map(card => [card.title, card.interrupt?.delivery])).toEqual([["Urgent", "pending"], ["Quiet", undefined]]);
  const off = await composeRanked(item => [mail(item, "Urgent", 0, true)], NO_INTERRUPTIONS);
  expect(off.view.items[0]?.interrupt).toBeUndefined();
  const stale = markInterrupts(asked.view.items.map(card => ({ ...card, interrupt: undefined, freshness: "stale" as const })), on, new Map(), Date.now());
  expect(stale.every(card => card.interrupt === undefined)).toBe(true);
});

const HOUR = 3_600_000;
function meeting(now: number, busy: boolean): CalendarAvailability {
  return {
    sources: [{ id: "cal", kind: "calendar", from: now - HOUR, to: now + 4 * HOUR, readAt: now, calendars: ["c"], provenance: "test" }],
    events: [{ key: "cal:1", source: "cal", calendar: "c", calendarId: "c", title: "Standup", at: now - HOUR / 2, end: now + HOUR / 2, availability: busy ? { status: "busy", provenance: "test" } : { status: "free", provenance: "test" } }],
  };
}

test("the host holds an adapter interrupt during a meeting and releases it afterwards", async () => {
  const on: InterruptRules = { ...NO_INTERRUPTIONS, transport: "discord", mail: true };
  const { view } = await composeRanked(item => [mail(item, "Urgent", 0, true)], on);
  const now = view.generatedAt;
  expect(heldDuringMeeting(view.items, meeting(now, true), now)).toEqual([]);
  expect(heldDuringMeeting(view.items, meeting(now, false), now)).toEqual(view.items);
  expect(heldDuringMeeting(view.items, meeting(now, true), now + HOUR)).toEqual(view.items);
});

test("a busy meeting strips the adapter interrupt marker from the card, which stays listed", async () => {
  const on: InterruptRules = { ...NO_INTERRUPTIONS, transport: "discord", mail: true };
  const { view } = await composeRanked(item => [mail(item, "Urgent", 0, true)], on);
  const now = view.generatedAt;
  expect(view.items.some(i => i.interrupt !== undefined)).toBe(true);
  const quiet = quietAdapterInterrupts(view.items, meeting(now, true), now);
  expect(quiet.length).toBe(view.items.length);
  expect(quiet.some(i => i.interrupt !== undefined)).toBe(false);
  expect(quietAdapterInterrupts(view.items, meeting(now, false), now)).toEqual(view.items);
});

test("ranked rows get no actions from adapter data, only from the binding's declared capabilities", async () => {
  const { view } = await composeRanked(item => { const row = mail(item, "Act", 0, null) as Record<string, Json>; row.actions = ["send", "trash"]; return [row]; });
  expect(view.items[0]?.actions).toEqual([]);
});

test("content from a local-only area never reaches a cloud route", () => {
  const boundary = sourceBoundary({ areas: [{ id: "personal", policy: "cloud" }, { id: "work", policy: "local" }], sources: [{ id: "synthetic-personal", area: "personal" }, { id: "synthetic-work", area: "work" }] });
  expect(() => assertRoute("cloud", contentFrom(boundary, ["synthetic-work"]), "classifier")).toThrow(CloudRouteRefused);
  expect(() => assertRoute("cloud", contentFrom(boundary, ["synthetic-unconfigured"]), "classifier")).toThrow(CloudRouteRefused);
  expect(() => assertRoute("cloud", contentFrom(boundary, ["synthetic-personal"]), "classifier")).not.toThrow();
});
