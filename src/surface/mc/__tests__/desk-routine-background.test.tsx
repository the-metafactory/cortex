import { beforeEach, describe, expect, it } from "bun:test";
import type { Database } from "bun:sqlite";
import { renderToStaticMarkup } from "react-dom/server";
import { initDatabase } from "../db/init";
import { handleDeskRoutineDisplay } from "../api/desk-routine-display";
import type { DeskRuntime } from "../desk/compose";
import type { RoutineEvidenceRecord } from "../desk/routine-evidence-contract";
import type { RoutineInventory } from "../desk/routine-editor-contract";
import { readRoutineDisplay } from "../desk/routine-display";
import { backgroundLane, type CalendarOccurrence } from "../dashboard-v2/lib/routine-calendar";
import { saveDisplay, withDisplay } from "../dashboard-v2/lib/routine-display";
import { attentionGroups, attentionMaxPages, readPeriodHistory } from "../dashboard-v2/lib/routine-attention";
import { BackgroundRow } from "../dashboard-v2/components/desk-routine-calendar";
import { AttentionSummary, coverageText } from "../dashboard-v2/components/desk-routine-attention";
import { RoutineDisplayChoice } from "../dashboard-v2/components/desk-routine-display";
import { routineAnswer, routineTestRuntime } from "./routine-owner-fixture";

const scope = { principal: "jc", stack: "default" };
const runtime: DeskRuntime = { ...routineTestRuntime, options: routineTestRuntime.options ? { ...routineTestRuntime.options, routineScope: scope } : undefined };
const inventory: RoutineInventory = [
  { id: "studio-overseer", name: "Overseer", schedule: "*/15 * * * *", timezone: "UTC", target: "t", policy: "auto", paused: false, runtimeConfirmed: true, readOnly: true, capabilities: { editSchedule: false, pause: false } },
  { id: "morning-briefing", name: "Morning briefing", schedule: "0 9 * * *", timezone: "Europe/Zurich", target: "t", policy: "approval", paused: false, runtimeConfirmed: true, readOnly: false, capabilities: { editSchedule: true, pause: true } },
];
const calls: string[][] = [];
const owner = (answer: "inventory" | "failure" = "inventory") => (argv: string[]) => { calls.push(argv); return Promise.resolve(answer === "failure" ? routineAnswer({}, 2) : routineAnswer(inventory)); };
const post = (body: unknown) => new Request("http://mc.local/api/desk/routine-display", { method: "POST", body: JSON.stringify(body) });
const get = () => new Request("http://mc.local/api/desk/routine-display");
let db: Database;
async function rejection(promise: Promise<unknown>): Promise<string> {
  try { await promise; } catch (error) { return error instanceof Error ? error.message : String(error); }
  return "resolved";
}
beforeEach(() => { db = initDatabase(":memory:"); calls.length = 0; });

const occurrence = (routineId: string, scheduledFor: string, schedule = "*/15 * * * *"): CalendarOccurrence => ({ routineId, schedule, sourceTimezone: "UTC", lifecycle: "active", handlingPolicy: "auto", readOnly: true, scheduledFor, capabilities: { editParameters: false, editSchedule: false, pause: false, delete: false, setPolicy: false } });
const quarterHours = Array.from({ length: 96 }, (_, i) => occurrence("studio-overseer", new Date(Date.parse("2026-11-02T00:00:00Z") + i * 900000).toISOString()));

const base: RoutineEvidenceRecord = { routineId: "studio-overseer", routineName: "Overseer", nameSource: "recorded", definitionPresent: true, target: null, decisionId: "11111111-1111-4111-8111-111111111111", decision: "fired", at: "2026-11-02T12:00:00Z", impulseKind: "schedule", correlationId: "22222222-2222-4222-8222-222222222222", resolutionOf: null, approval: null, execution: { kind: "unavailable", reason: "Missing or delayed", evidence: "missing-or-delayed" } };
const failed = (n: number, at: string): RoutineEvidenceRecord => ({ ...base, decisionId: `11111111-1111-4111-8111-${String(n).padStart(12, "0")}`, at, execution: { kind: "observed", owner: "cortex-process", executionId: "a".repeat(64), state: "failed", freshness: "recorded", startedAt: at, endedAt: at, durationMs: 10, files: [] } });

describe("routine display preference API", () => {
  it("stores Background per principal, stack and routine, and restores Scheduled starts, without owner writes", async () => {
    expect((await (await handleDeskRoutineDisplay(get(), db, runtime, owner())).json() as { preferences: unknown[] }).preferences).toEqual([]);
    const saved = await handleDeskRoutineDisplay(post({ ...scope, routineId: "studio-overseer", mode: "background" }), db, runtime, owner());
    expect(saved.status).toBe(200);
    expect(await saved.json()).toEqual({ owner: "reflex", ...scope, routineId: "studio-overseer", mode: "background" });
    expect(readRoutineDisplay(db, scope).preferences.map((entry) => entry.routineId)).toEqual(["studio-overseer"]);
    expect(readRoutineDisplay(db, { ...scope, stack: "other" }).preferences).toEqual([]);
    await handleDeskRoutineDisplay(post({ ...scope, routineId: "studio-overseer", mode: "scheduled" }), db, runtime, owner());
    expect(readRoutineDisplay(db, scope).preferences).toEqual([]);
    expect(calls.every((argv) => argv.join(" ") === "reflex routine list --json")).toBe(true);
  });
  it("refuses a foreign scope, an unknown routine, an owner failure and malformed input, keeping the prior display", async () => {
    await handleDeskRoutineDisplay(post({ ...scope, routineId: "studio-overseer", mode: "background" }), db, runtime, owner());
    const foreign = await handleDeskRoutineDisplay(post({ ...scope, stack: "other", routineId: "studio-overseer", mode: "scheduled" }), db, runtime, owner());
    expect(foreign.status).toBe(409);
    expect((await handleDeskRoutineDisplay(post({ ...scope, routineId: "gone", mode: "background" }), db, runtime, owner())).status).toBe(404);
    expect((await handleDeskRoutineDisplay(post({ ...scope, routineId: "studio-overseer", mode: "scheduled" }), db, runtime, owner("failure"))).status).toBe(502);
    expect((await handleDeskRoutineDisplay(post({ ...scope, routineId: "studio-overseer", mode: "folded" }), db, runtime, owner())).status).toBe(400);
    expect((await handleDeskRoutineDisplay(new Request("http://mc.local/api/desk/routine-display", { method: "DELETE" }), db, runtime, owner())).status).toBe(405);
    expect(readRoutineDisplay(db, scope).preferences.map((entry) => entry.routineId)).toEqual(["studio-overseer"]);
    expect((await handleDeskRoutineDisplay(get(), db, routineTestRuntime, owner())).status).toBe(409);
  });
});

describe("browser display preference handling", () => {
  it("rejects an answer for a different routine or scope and ignores late foreign results", async () => {
    expect(await rejection(saveDisplay(scope, "studio-overseer", "background", () => Promise.resolve({ owner: "reflex", ...scope, routineId: "morning-briefing", mode: "background" })))).toContain("different routine");
    expect(await rejection(saveDisplay(scope, "studio-overseer", "background", () => Promise.resolve({ owner: "reflex", ...scope, stack: "other", routineId: "studio-overseer", mode: "background" })))).toContain("different routine");
    const preferences = { scope, background: new Set(["studio-overseer"]) };
    expect(withDisplay(preferences, { owner: "reflex", ...scope, stack: "other", routineId: "studio-overseer", mode: "scheduled" })).toBe(preferences);
    expect(withDisplay(preferences, { owner: "reflex", ...scope, routineId: "studio-overseer", mode: "scheduled" }).background.has("studio-overseer")).toBe(false);
  });
  it("shows the prior display and the unsaved proposed choice after a failed write", () => {
    const html = renderToStaticMarkup(<RoutineDisplayChoice routineId="studio-overseer" saved="scheduled" available pending={{ mode: "background", busy: false, error: "The routine owner could not confirm this routine." }} onChange={() => undefined} onDismiss={() => undefined} />);
    expect(html).toContain("still shows Scheduled starts");
    expect(html).toContain("Your choice of Background was not saved");
    expect(html).toMatch(/checked="" value="background"/);
    expect(html).toContain("Display only");
  });
});

describe("Background routines lane", () => {
  const ordinary = occurrence("morning-briefing", "2026-11-02T08:00:00Z", "0 9 * * *");
  it("represents a quarter-hour routine once with its planned count while ordinary routines keep their starts", () => {
    const rows = backgroundLane({ occurrences: [...quarterHours, ordinary], background: new Set(["studio-overseer"]), inventory, showPaused: false, policy: "all" });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: "studio-overseer", name: "Overseer", schedule: "*/15 * * * *", timezone: "UTC" });
    expect(rows[0]?.entries).toHaveLength(96);
    expect(backgroundLane({ occurrences: [...quarterHours, ordinary], background: new Set(), inventory, showPaused: false, policy: "all" })).toEqual([]);
  });
  it("keeps background occurrences visible when the inventory is unavailable", () => {
    const rows = backgroundLane({ occurrences: quarterHours, background: new Set(["studio-overseer"]), inventory: null, showPaused: false, policy: "all" });
    expect(rows.map((row) => [row.id, row.entries.length])).toEqual([["studio-overseer", 96]]);
  });
  it("labels counts as partial when owner coverage is incomplete", () => {
    const row = (complete: boolean, entries: CalendarOccurrence[]) => renderToStaticMarkup(<BackgroundRow routineId="studio-overseer" name="Overseer" schedule="*/15 * * * *" timezone="UTC" entries={entries} complete={complete} period="in this view" displayTimezone="UTC" onSelect={() => undefined} />);
    expect(row(true, quarterHours)).toContain("96 planned in this view");
    expect(row(false, quarterHours)).toContain("At least 96 planned in this view");
    expect(row(false, [])).toContain("Planned starts unavailable in the incomplete result");
    expect(row(true, quarterHours)).toContain("*/15 * * * *");
  });
});

describe("needs-attention evidence", () => {
  it("groups repeated failures by routine and reason with loaded count and latest time, and never treats dispatch as failure", () => {
    const records = [failed(3, "2026-11-02T12:30:00Z"), failed(2, "2026-11-02T12:15:00Z"), failed(1, "2026-11-02T12:00:00Z"), { ...base, decisionId: "11111111-1111-4111-8111-000000000009" }];
    const groups = attentionGroups({ pending: [{ decisionId: "d1", blueprintId: "morning-briefing", matchedAt: "2026-11-02T08:00:00Z", expiresAt: "2026-11-02T09:00:00Z", impulseSummary: "s" }], records, inventory: [...inventory, { ...inventory[1], id: "unsure", name: "Unsure", runtimeConfirmed: false } as RoutineInventory[number]] });
    expect(groups.map((group) => [group.kind, group.routineId, group.count])).toEqual([["approval", "morning-briefing", 1], ["failure", "studio-overseer", 3], ["scheduling", "unsure", 1]]);
    expect(groups[1]).toMatchObject({ name: "Overseer", reason: "Recorded execution failure", latest: "2026-11-02T12:30:00Z" });
  });
  it("labels stale and conflicting evidence explicitly", () => {
    const stale: RoutineEvidenceRecord = { ...base, execution: { kind: "observed", owner: "cortex-process", executionId: "a".repeat(64), state: "running", freshness: "stale", startedAt: base.at, endedAt: null, durationMs: null, files: [] } };
    const conflicting: RoutineEvidenceRecord = { ...base, decisionId: "11111111-1111-4111-8111-000000000008", execution: { kind: "unavailable", reason: "Conflicting", evidence: "conflicting" } };
    const groups = attentionGroups({ pending: [], records: [stale, conflicting], inventory });
    expect(groups.map((group) => [group.kind, group.reason]).sort()).toEqual([["evidence", "Execution evidence conflicts"], ["evidence", "Running observation is stale; current state unconfirmed"]]);
  });
  it("never presents absent loaded failures as healthy and marks unavailable evidence as unknown", () => {
    const empty = renderToStaticMarkup(<AttentionSummary groups={[]} history={{ key: "k", kind: "ready", records: [], coverage: "complete", reachedStart: false, oldest: null, checked: 0 }} view={{ installed: [], pending: [], done: [], changes: [] }} inventoryError={false} timezone="UTC" />);
    expect(empty).toContain("This is not a health check");
    expect(empty.toLowerCase()).not.toMatch(/healthy|all clear/);
    const retained = renderToStaticMarkup(<AttentionSummary groups={[]} history={{ key: "k", kind: "ready", records: [], coverage: "complete", reachedStart: false, oldest: "2026-11-02T06:00:00Z", checked: 40 }} view={{ installed: [], pending: [], done: [], changes: [] }} inventoryError={false} timezone="UTC" />);
    expect(retained).toContain("the owner retains no records before");
    expect(retained).not.toContain("history is covered");
    const beforePeriod = coverageText({ key: "k", kind: "ready", records: [], coverage: "partial", reachedStart: false, oldest: "2026-11-20T00:00:00Z", checked: 1000 }, "UTC");
    expect(beforePeriod).toContain("before any of this period's records");
    expect(beforePeriod).toContain("Failures in this period are unknown");
    const failure = renderToStaticMarkup(<AttentionSummary groups={[]} history={{ key: "k", kind: "error", message: "Owner down." }} view={undefined} inventoryError timezone="UTC" />);
    expect(failure).toContain("Failures in this period are unknown");
    expect(failure).toContain("Pending approvals not loaded");
    expect(failure).toContain("scheduling uncertainty is unknown");
    expect(failure).not.toContain("not a health check");
  });
});

describe("bounded period history", () => {
  const page = (records: RoutineEvidenceRecord[], nextCursor: string | null, principal = "jc") => ({ owner: "reflex", principal, stack: "default", routineId: null, executionOwner: "cortex-process", records, complete: nextCursor === null, nextCursor });
  it("reads newest-first pages until it passes the period start and keeps only records inside the period", async () => {
    const pages = [page([failed(5, "2026-11-03T01:00:00Z"), failed(4, "2026-11-02T12:00:00Z")], "c1"), page([failed(3, "2026-11-02T01:00:00Z"), failed(2, "2026-11-01T23:00:00Z")], "c2")];
    let reads = 0;
    const result = await readPeriodHistory("2026-11-02T00:00:00Z", "2026-11-03T00:00:00Z", new AbortController().signal, () => Promise.resolve(pages[reads++]));
    expect(reads).toBe(2);
    expect(result).toMatchObject({ coverage: "complete", reachedStart: true, checked: 4 });
    expect(result.records.map((record) => record.at)).toEqual(["2026-11-02T12:00:00Z", "2026-11-02T01:00:00Z"]);
  });
  it("stops at its page bound and reports partial coverage", async () => {
    let reads = 0;
    const result = await readPeriodHistory("2026-10-01T00:00:00Z", "2026-11-03T00:00:00Z", new AbortController().signal, () => { reads++; return Promise.resolve(page([failed(100 - reads, new Date(Date.parse("2026-11-02T12:00:00Z") - reads * 60000).toISOString())], `c${reads}`)); });
    expect(reads).toBe(attentionMaxPages);
    expect(result.coverage).toBe("partial");
    expect(result.records).toHaveLength(attentionMaxPages);
  });
  it("rejects repeated cursors and a changed owner scope", async () => {
    expect(await rejection(readPeriodHistory("2026-10-01T00:00:00Z", "2026-11-03T00:00:00Z", new AbortController().signal, () => Promise.resolve(page([failed(1, "2026-11-02T12:00:00Z")], "same"))))).not.toBe("resolved");
    let reads = 0;
    expect(await rejection(readPeriodHistory("2026-10-01T00:00:00Z", "2026-11-03T00:00:00Z", new AbortController().signal, () => Promise.resolve(reads++ === 0 ? page([failed(2, "2026-11-02T12:00:00Z")], "c1") : page([failed(1, "2026-11-02T11:00:00Z")], null, "someone-else"))))).toContain("inconsistent");
  });
});
