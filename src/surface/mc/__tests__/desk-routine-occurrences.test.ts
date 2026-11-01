import { describe, expect, it } from "bun:test";
import { handleDeskRoutineOccurrences } from "../api/desk-routine-occurrences";
import { readRoutineOccurrences } from "../desk/routine-occurrences";
import { HandledLedger } from "../desk/actions";
import type { DeskRuntime } from "../desk/compose";
import type { RoutineRunner } from "../desk/routine-command";

const options = { reflex: ["owner-wrapper", "--configured-stack"], composer: ["compose"], target: "@test/pulse-flow", timeZone: "UTC", timeoutSeconds: 120, readTimeoutSeconds: 1 };
const scope = { principal: "test", stack: "default" };
const runtime: DeskRuntime = { ledger: new HandledLedger(), options: { routineScope: scope, enabled: true, displayName: "Test", topN: 5, rangerUrl: "", areas: [], sources: [], routines: options } };
const query = { start: "2026-11-01T00:00:00Z", end: "2026-11-02T00:00:00Z", timezone: "Europe/Zurich", limit: 2 };
const record = { routineId: "external", scheduledFor: "2026-11-01T09:00:00Z", sourceTimezone: "UTC", schedule: "0 9 * * *", lifecycle: "active", handlingPolicy: "approval", readOnly: true, capabilities: { editParameters: false, editSchedule: false, pause: false, delete: false, setPolicy: false } };
const page = { owner: "reflex", principal: "test", stack: "default", ...query, meaning: "planned-trigger", occurrences: [record], complete: true, nextCursor: null, counts: { scope: "page", total: 1, active: 1, disabled: 0 } };
const { limit: _limit, ...wire } = page;
const response = (data: unknown, code = 0) => Promise.resolve({ stdout: JSON.stringify(data), stderr: "", code });
const url = "http://localhost/api/desk/routine-occurrences?" + new URLSearchParams({ ...query, limit: String(query.limit) }).toString();

describe("routine occurrence read transport", () => {
  it("uses only configured owner command, read timeout and bounded arguments", async () => {
    let calls = 0;
    const run: RoutineRunner = async (argv, stdin, timeout) => {
      calls++;
      expect(argv).toEqual(["owner-wrapper", "--configured-stack", "routine", "occurrences", "--principal", "test", "--stack", "default", "--start", query.start, "--end", query.end, "--timezone", query.timezone, "--limit", "2", "--json"]);
      expect(stdin).toBe(""); expect(timeout).toBe(1000);
      return response(wire);
    };
    const result = await handleDeskRoutineOccurrences(new Request(url), runtime, run);
    expect(result.status).toBe(200); expect(result.headers.get("cache-control")).toBe("no-store");
    expect(await result.json()).toEqual(wire); expect(calls).toBe(1);
  });
  it("rejects invalid range, timezone, limits, unknown owner input and methods before calling owner", async () => {
    const run: RoutineRunner = () => { throw new Error("must not call"); };
    for (const suffix of ["&limit=0", "&timezone=Invalid/Zone", "&principal=foreign", "&start=bad", "&end=2027-01-01T00%3A00%3A00Z"]) expect((await handleDeskRoutineOccurrences(new Request(url + suffix), runtime, run)).status).toBe(400);
    expect((await handleDeskRoutineOccurrences(new Request(url, { method: "POST" }), runtime, run)).status).toBe(405);
    expect((await handleDeskRoutineOccurrences(new Request(url), undefined, run)).status).toBe(409);
  });
  it("surfaces owner failure and malformed or inconsistent pages instead of an empty calendar", async () => {
    for (const invalid of [null, { ...wire, complete: false }, { ...wire, principal: "foreign" }, { ...wire, stack: "foreign" }, { ...wire, counts: { ...wire.counts, active: 2 } }, { ...wire, timezone: "UTC" }, { ...wire, occurrences: [{ ...record, scheduledFor: query.end }] }, { ...wire, occurrences: [record, record] }, { ...wire, occurrences: [{ ...record, capabilities: { ...record.capabilities, delete: true } }] }]) {
      expect((await handleDeskRoutineOccurrences(new Request(url), runtime, () => response(invalid))).status).toBe(502);
    }
    expect((await handleDeskRoutineOccurrences(new Request(url), runtime, () => response({ error: "unavailable" }, 2))).status).toBe(502);
  });
  it("preserves bounded incomplete pages and forwards continuation tokens without interpreting schedules", async () => {
    const partial = { ...wire, complete: false, nextCursor: "opaque-owner-cursor" };
    const result = await readRoutineOccurrences(options, { ...query, cursor: "previous-owner-cursor" }, scope, async (argv) => {
      expect(argv).toContain("previous-owner-cursor"); return response(partial);
    });
    expect(result.complete).toBe(false); expect(result.counts.scope).toBe("page");
  });
});
