// glossary-ignore: run
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { initDatabase } from "../../surface/mc/db/init";
import { getVigilSubject, listVigilEvents, writeVigilTransition } from "../db";
import { ingestLedgerEnvelope } from "../ingest";
import type { SubjectClass } from "../policy";
import { createVigilRenderer } from "../render";
import { routeFor, type VigilRoute } from "../routing";
import { sweepStale } from "../staleness";
import { ENDED_AT, KEY, ledgerEnvelope } from "./fixtures";

const WORSE_ROUTES: [SubjectClass, string, VigilRoute][] = [
  ["goal", "off-track", "text"],
  ["goal-sensor", "failed", "text"],
  ["escalation", "overdue", "text"],
  ["escalation", "needs-principal", "digest"],
  ["check", "regressed", "digest"],
  ["unknown", "unrecognised", "digest"],
  ["run", "failed", "digest"],
];

describe("Vigil route classification", () => {
  let db: Database;
  beforeEach(() => { db = initDatabase(":memory:"); });
  afterEach(() => db.close());

  test.each(WORSE_ROUTES)("%s to %s routes worse transitions to %s at write time", (classification, to, route) => {
    expect(routeFor(classification, to, "worse")).toBe(route);
    const state = classification === "run" || classification === "goal-sensor" ? undefined : { subject: "G1", value: to };
    ingestLedgerEnvelope(db, ledgerEnvelope({
      outcome: "failed", ...(state ? { state } : {}),
      ...(classification === "goal-sensor" ? { serves: { goal: "G1" } } : {}),
    }), ENDED_AT, { replay: true });
    const key = state ? `state:${classification}:default:G1` : KEY;
    const event = writeVigilTransition(db, {
      subject_key: key, from_value: null, to_value: to, direction: "worse",
      run_id: "transition", occurred_at: ENDED_AT,
    }, ENDED_AT);
    expect(event).toMatchObject({ route, delivery: "pending" });
    expect(listVigilEvents(db, key)).toEqual([event]);
  });

  test.each(WORSE_ROUTES)("%s recoveries always go to digest", (classification) => {
    for (const to of ["resolved", "ok", "on-track", "succeeded", "at-risk"]) {
      expect(routeFor(classification, to, "better")).toBe("digest");
    }
  });

  test("live ingest classifies changes and rendering leaves stored rows free of goal wording", async () => {
    const observe = (value: string, minute: number) => ingestLedgerEnvelope(db, ledgerEnvelope({
      outcome: "succeeded", serves: { goal: "G1" }, state: { subject: "G1", value },
      ended_at: new Date(ENDED_AT + minute * 60_000).toISOString(),
    }), ENDED_AT + minute * 60_000);
    observe("on-track", 0);
    observe("off-track", 1);
    observe("at-risk", 2);
    observe("on-track", 3);
    const events = listVigilEvents(db, "state:goal:default:G1");
    expect(events.map(({ route, delivery }) => ({ route, delivery }))).toEqual([
      { route: "text", delivery: "pending" },
      { route: "digest", delivery: "pending" },
      { route: "digest", delivery: "pending" },
    ]);
    const row = getVigilSubject(db, "state:goal:default:G1")!;
    expect(row.value).toBe("on-track");
    const render = createVigilRenderer({ resolveGoalWording: () => "Example goal" });
    expect(await render(events[0]!, row)).toBe("Vigil: goal Example goal — on-track → off-track");
    expect(listVigilEvents(db, row.subject_key)).toEqual(events);
    expect(getVigilSubject(db, row.subject_key)).toEqual(row);
  });

  test("escalation and check ingest persist digest recoveries and text only for overdue", () => {
    for (const [vocab, values, routes] of [
      ["escalation", ["needs-principal", "overdue", "resolved"], ["digest", "text", "digest"]],
      ["check", ["regressed", "ok"], ["digest", "digest"]],
    ] as const) {
      values.forEach((value, i) => ingestLedgerEnvelope(db, ledgerEnvelope({
        outcome: "succeeded", state: { subject: vocab, value },
        ended_at: new Date(ENDED_AT + i * 60_000).toISOString(),
      }), ENDED_AT + i * 60_000));
      expect(listVigilEvents(db, `state:${vocab}:default:${vocab}`).map((event) => event.route)).toEqual([...routes]);
    }
  });

  test("staleness classifies goal sensors and goal states as text, plain jobs as digest", () => {
    for (const [ref, serves, state] of [
      ["sensor", { goal: "G1" }, { subject: "G1", value: "on-track" }],
      ["plain", undefined, undefined],
    ] as const) {
      ingestLedgerEnvelope(db, ledgerEnvelope({
        outcome: "succeeded", ran: { kind: "job", ref },
        ...(serves ? { serves } : {}), ...(state ? { state } : {}),
      }), ENDED_AT);
    }
    sweepStale(db, ENDED_AT + 52 * 3_600_000 + 1, {});
    for (const [key, route] of [["run:job:default:sensor", "text"], ["state:goal:default:G1", "text"], ["run:job:default:plain", "digest"]] as const) {
      expect(listVigilEvents(db, key)).toEqual([expect.objectContaining({ route, delivery: "pending", to_value: "stale" })]);
    }
  });

  test("a missing subject cannot create a classified event", () => {
    expect(() => writeVigilTransition(db, {
      subject_key: "missing", from_value: null, to_value: "failed", direction: "worse",
      run_id: "missing", occurred_at: ENDED_AT,
    }, ENDED_AT)).toThrow("Vigil transition has no subject: missing");
    expect(listVigilEvents(db, "missing")).toEqual([]);
  });
});
