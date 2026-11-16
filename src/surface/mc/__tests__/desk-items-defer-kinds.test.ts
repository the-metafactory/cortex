import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { DEFERRABLE_ITEM_KINDS } from "../desk/item-defer";
import { DESK_ITEM_KINDS } from "../desk/types";
import { openMailRoundRig, roundAt, roundEvent, type MailRoundRig } from "./fixtures/mail-round-rig";

const NOW = roundAt(16, 10);
const RANGER = {
  current: [],
  needsYou: [{ key: "example/app#1", repo: "example/app", nodeId: "12", title: "Fix the login timeout", status: "failed", endedAt: new Date(NOW - 3_600_000).toISOString(), reason: { class: "worker failed", detail: "tests failed" } }],
  maps: [{ key: "example/app#1", repo: "example/app", decisions: [{ id: "30", title: "Adopt the new date library" }], grillings: [{ id: "31", title: "Which cache should we use?" }] }],
};

let rig: MailRoundRig;
let ranger: ReturnType<typeof Bun.serve>;
let reminderKey: string;

const post = (body: unknown): Promise<Response> => rig.defer(body);
const rows = (): number => rig.database().query<{ n: number }, []>("SELECT COUNT(*) AS n FROM desk_item_defers").get()?.n ?? -1;
const keyOf = async (kind: string): Promise<string> => {
  const item = (await rig.get()).items.find((entry) => entry.kind === kind);
  if (!item) throw new Error(`fixture has no ${kind} item`);
  return item.key;
};

beforeEach(async () => {
  ranger = Bun.serve({ port: 0, fetch: () => Response.json(RANGER) });
  rig = await openMailRoundRig(NOW, { rangerUrl: `http://127.0.0.1:${ranger.port}`, mailDigest: undefined, mailInvitations: undefined });
  rig.setState({ mail: [], events: [roundEvent("next", roundAt(16, 14), roundAt(16, 15))] });
  const id = rig.database().query<{ id: number }, [number, number]>("INSERT INTO desk_notes (kind, text, due_at, created_at) VALUES ('reminder', 'Call the bank', ?, ?) RETURNING id").get(NOW - 60_000, NOW - 3_600_000)?.id;
  reminderKey = `reminder:${id}`;
  await rig.get();
});

afterEach(async () => {
  ranger.stop(true);
  await rig.close();
});

describe("deferring work items", () => {
  it("every accepted kind is a Desk item kind and no alarm is accepted", () => {
    for (const kind of DEFERRABLE_ITEM_KINDS) expect(DESK_ITEM_KINDS as readonly string[]).toContain(kind);
    for (const kind of ["meeting", "agent-failed", "agent-blocked", "escalation", "sensor", "adapter", "goal"]) expect(DEFERRABLE_ITEM_KINDS as readonly string[]).not.toContain(kind);
  });

  it.each([["reminder"], ["decision"], ["grilling"]])("puts a %s away, lists it in deferred[] and cancels without a back line", async (kind) => {
    const key = kind === "reminder" ? reminderKey : await keyOf(kind);
    const response = await post({ action: "defer", key, until: { kind: "tomorrow" } });
    expect(response.status).toBe(200);
    const away = await rig.get();
    expect(away.items.some((item) => item.key === key)).toBe(false);
    expect(away.deferred.find((entry) => entry.key === key)?.until).toBe("until tomorrow at 08:00");

    expect((await post({ action: "defer.cancel", key })).status).toBe(200);
    const back = await rig.get();
    const item = back.items.find((entry) => entry.key === key);
    expect(item).toBeDefined();
    expect(item?.back).toBeUndefined();
    expect(item?.why).not.toContain("Back because");
    expect(back.deferred.some((entry) => entry.key === key)).toBe(false);
    expect(rows()).toBe(0);
  });

  it("brings an item back when its time passes, for one day, at urgency today or higher and without interrupt", async () => {
    const key = await keyOf("decision");
    expect((await post({ action: "defer", key, until: { kind: "tomorrow" } })).status).toBe(200);
    rig.setNow(roundAt(17, 9));
    const back = (await rig.get()).items.find((entry) => entry.key === key);
    expect(back?.why.startsWith("Back because you snoozed it until")).toBe(true);
    expect(back?.back?.line).toContain("Back because");
    expect(["now", "today"]).toContain(back?.urgency ?? "");
    expect(back?.interrupt).toBeUndefined();
    rig.setNow(roundAt(18, 10));
    expect((await rig.get()).items.find((entry) => entry.key === key)?.back).toBeUndefined();
  });

  it("returns an item when the chosen meeting ends", async () => {
    expect((await post({ action: "defer", key: reminderKey, until: { kind: "meeting", event: "cal:round-source:next" } })).status).toBe(200);
    expect((await rig.get()).deferred.find((entry) => entry.key === reminderKey)?.until).toBe("until “Meeting next” ends");
    rig.setNow(roundAt(16, 15, 30));
    const back = (await rig.get()).items.find((entry) => entry.key === reminderKey);
    expect(back?.back?.line).toBe("Back because “Meeting next” has ended.");
  });

  it("drops the deferral when the source no longer produces the item", async () => {
    expect((await post({ action: "defer", key: reminderKey, until: { kind: "tomorrow" } })).status).toBe(200);
    rig.database().query("UPDATE desk_notes SET done_at = ?").run(NOW);
    const view = await rig.get();
    expect(view.items.some((item) => item.key === reminderKey)).toBe(false);
    expect(view.deferred).toEqual([]);
    expect(rows()).toBe(0);
  });

  it.each([["agent-failed", "an alarm stays on the Desk"]])("refuses a %s with its reason and stores nothing", async (kind, reason) => {
    const key = await keyOf(kind);
    const response = await post({ action: "defer", key, until: { kind: "tomorrow" } });
    expect(response.status).toBe(400);
    expect((await response.json() as { error: string }).error).toContain(reason);
    expect(rows()).toBe(0);
    expect((await rig.get()).items.some((item) => item.key === key)).toBe(true);
  });

  it("refuses a person choice on a work item and an unlisted key", async () => {
    const person = await post({ action: "defer", key: reminderKey, until: { kind: "person", address: "someone@example.org" } });
    expect(person.status).toBe(400);
    expect((await person.json() as { error: string }).error).toContain("Only mail can wait for a person");
    expect((await post({ action: "defer", key: "reminder:9999", until: { kind: "tomorrow" } })).status).toBe(400);
    expect(rows()).toBe(0);
  });
});
