import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { initDatabase } from "../../surface/mc/db/init";
import { channelKey, channelValue, recordChannel, type VigilChannel } from "../channels";
import { getVigilSubject, listVigilEvents } from "../db";

const NOW = Date.parse("2026-10-16T10:00:00Z");
let db: Database;
beforeEach(() => { db = initDatabase(":memory:"); });
afterEach(() => db.close());

test.each(["dm-channel", "email-channel"] as const)("%s starts healthy without a row or transition", (channel) => {
  const key = `state:check:vigil:${channel}`;
  expect(channelKey(channel)).toBe(key);
  expect(channelValue(db, channel)).toBe("ok");
  expect(getVigilSubject(db, key)).toBeNull();
  expect(recordChannel(db, channel, "ok", NOW)).toBeNull();
  expect(getVigilSubject(db, key)).toMatchObject({
    subject_kind: "state", vocab: "check", ref: `vigil:${channel}`, value: "ok", healthy: 1,
  });
  expect(listVigilEvents(db, key)).toEqual([]);
});

test.each([
  ["dm-channel", "text"], ["email-channel", "digest"],
] as const)("%s records one outage with route %s and a digest recovery", (channel, route) => {
  const outage = recordChannel(db, channel, "regressed", NOW);
  expect(outage).toMatchObject({
    subject_key: channelKey(channel), event_kind: "transition", from_value: "ok", to_value: "regressed",
    direction: "worse", occurred_at: NOW, route, delivery: "pending",
  });
  expect(channelValue(db, channel)).toBe("regressed");
  for (let i = 1; i <= 5; i++) expect(recordChannel(db, channel, "regressed", NOW + i)).toBeNull();
  expect(listVigilEvents(db, channelKey(channel))).toEqual([outage!]);
  expect(getVigilSubject(db, channelKey(channel))).toMatchObject({ healthy: 0, last_seen_at: NOW + 5 });
  const recovery = recordChannel(db, channel, "ok", NOW + 6);
  expect(recovery).toMatchObject({ from_value: "regressed", to_value: "ok", direction: "better", route: "digest" });
  expect(recordChannel(db, channel, "ok", NOW + 7)).toBeNull();
  expect(channelValue(db, channel)).toBe("ok");
  expect(listVigilEvents(db, channelKey(channel))).toHaveLength(2);
  recordChannel(db, channel, "regressed", NOW + 8);
  expect(listVigilEvents(db, channelKey(channel))).toHaveLength(3);
});

test("different channels and equal timestamps retain every actual change", () => {
  for (const channel of ["dm-channel", "email-channel"] satisfies VigilChannel[]) {
    recordChannel(db, channel, "regressed", NOW);
    recordChannel(db, channel, "ok", NOW);
    recordChannel(db, channel, "regressed", NOW);
    expect(listVigilEvents(db, channelKey(channel)).map((event) => event.to_value)).toEqual(["regressed", "ok", "regressed"]);
  }
});

test("channel state and its transition roll back together", () => {
  db.run("CREATE TRIGGER fail_transition BEFORE INSERT ON vigil_events BEGIN SELECT RAISE(ABORT, 'transition unavailable'); END");
  expect(() => recordChannel(db, "dm-channel", "regressed", NOW)).toThrow("transition unavailable");
  expect(channelValue(db, "dm-channel")).toBe("ok");
  expect(getVigilSubject(db, channelKey("dm-channel"))).toBeNull();
});
