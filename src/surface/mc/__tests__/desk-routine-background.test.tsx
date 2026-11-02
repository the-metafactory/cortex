import { beforeEach, describe, expect, it } from "bun:test";
import type { Database } from "bun:sqlite";
import { renderToStaticMarkup } from "react-dom/server";
import { initDatabase } from "../db/init";
import { handleDeskRoutineDisplay } from "../api/desk-routine-display";
import type { DeskRuntime } from "../desk/compose";
import type { RoutineEvidenceRecord } from "../desk/routine-evidence-contract";
import type { RoutineInventory } from "../desk/routine-editor-contract";
import { displayEntry, maxStartsInWindow, readRoutineDisplay, RoutineDisplayPageSchema, type RoutineDisplayPage } from "../desk/routine-display";
import { backgroundLane, type CalendarOccurrence } from "../dashboard-v2/lib/routine-calendar";
import { readDisplay, saveDisplay, storedChoice, withDisplay } from "../dashboard-v2/lib/routine-display";
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

const saturday = Date.parse("2026-11-07T00:00:00Z");
const hours = (id: string, schedule: string, list: number[], minute = 0, weekdays = false): CalendarOccurrence[] => Array.from({ length: 8 }, (_, day) => day).flatMap((day) => {
  const date = new Date(saturday + day * 86400000);
  if (weekdays && (date.getUTCDay() === 0 || date.getUTCDay() === 6)) return [];
  return list.map((hour) => occurrence(id, new Date(saturday + day * 86400000 + hour * 3600000 + minute * 60000).toISOString(), schedule));
});
const range = (from: number, to: number, step = 1): number[] => Array.from({ length: Math.floor((to - from) / step) + 1 }, (_, i) => from + i * step);
const planned = [
  ...hours("studio-overseer", "*/15 * * * *", range(0, 23.75, 0.25)),
  ...hours("hourly-watch", "0 * * * *", range(0, 23)),
  ...hours("morning-briefing", "0 9 * * *", [9]),
  ...hours("four-hourly", "0 */4 * * *", range(0, 20, 4)),
  ...hours("weekday-watch", "10 8-21 * * 1-5", range(8, 21), 10, true),
  ...hours("shadow-watch", "20 8-20/2 * * *", range(8, 20, 2), 20),
].sort((a, b) => a.scheduledFor.localeCompare(b.scheduledFor) || a.routineId.localeCompare(b.routineId));
const installed: RoutineInventory = [...inventory, ...["hourly-watch", "four-hourly", "weekday-watch", "shadow-watch"].map((id) => ({ ...inventory[1], id, name: id }) as RoutineInventory[number])];
type OwnerMode = "ok" | "inventory-failure" | "occurrence-failure" | "incomplete";
function routineOwner(mode: OwnerMode = "ok") {
  return (argv: string[]) => {
    calls.push(argv);
    const flag = (name: string): string => argv[argv.indexOf(name) + 1] ?? "";
    if (argv[2] === "list") return Promise.resolve(mode === "inventory-failure" ? routineAnswer({}, 2) : routineAnswer(installed));
    if (mode === "occurrence-failure") return Promise.resolve(routineAnswer({}, 2));
    const inside = planned.filter((entry) => entry.scheduledFor >= flag("--start") && entry.scheduledFor < flag("--end"));
    const offset = argv.includes("--cursor") ? Number(flag("--cursor")) : 0; const limit = Number(flag("--limit"));
    const records = mode === "incomplete" ? inside.slice(0, 1) : inside.slice(offset, offset + limit);
    const nextCursor = mode === "incomplete" ? "again" : offset + limit < inside.length ? String(offset + limit) : null;
    return Promise.resolve(routineAnswer({ owner: "reflex", ...scope, start: flag("--start"), end: flag("--end"), timezone: flag("--timezone"), meaning: "planned-trigger", occurrences: records, complete: nextCursor === null, nextCursor, counts: { scope: "page", total: records.length, active: records.length, disabled: 0 } }));
  };
}
async function displayPage(owner = routineOwner()): Promise<RoutineDisplayPage> {
  const response = await handleDeskRoutineDisplay(get(), db, runtime, owner, () => saturday);
  expect(response.status).toBe(200);
  return RoutineDisplayPageSchema.parse(await response.json());
}
const browserDisplay = (owner = routineOwner()) => readDisplay(new AbortController().signal, async () => (await handleDeskRoutineDisplay(get(), db, runtime, owner, () => saturday)).json());
const byId = (page: RoutineDisplayPage) => new Map(page.routines.map((entry) => [entry.routineId, entry]));

describe("routine display preference API", () => {
  it("resolves frequent routines to Background automatically over a rolling 24 hours in the next 7 days", async () => {
    const page = await displayPage();
    expect(page.frequency).toEqual({ status: "known", start: "2026-11-07T00:00:00.000Z", end: "2026-11-14T00:00:00.000Z" });
    const routines = byId(page);
    expect([...routines].map(([id, entry]) => [id, entry.mode, entry.source, entry.maxDailyStarts])).toEqual([
      ["four-hourly", "scheduled", "frequency", 6],
      ["hourly-watch", "background", "frequency", 24],
      ["morning-briefing", "scheduled", "frequency", 1],
      ["shadow-watch", "background", "frequency", 7],
      ["studio-overseer", "background", "frequency", 96],
      ["weekday-watch", "background", "frequency", 14],
    ]);
    expect(displayEntry(page, "never-runs")).toMatchObject({ mode: "scheduled", source: "frequency", maxDailyStarts: 0 });
    expect(calls.filter((argv) => argv[2] === "occurrences").length).toBe(2);
    expect(calls.every((argv) => ["list", "occurrences"].includes(argv[2] ?? ""))).toBe(true);
  });
  it("lets a stored choice win in both directions, and Automatic removes it", async () => {
    for (const [routineId, mode] of [["hourly-watch", "scheduled"], ["morning-briefing", "background"]] as const) expect((await handleDeskRoutineDisplay(post({ ...scope, routineId, mode }), db, runtime, routineOwner())).status).toBe(200);
    let routines = byId(await displayPage());
    expect(routines.get("hourly-watch")).toMatchObject({ stored: "scheduled", automatic: "background", mode: "scheduled", source: "stored" });
    expect(routines.get("morning-briefing")).toMatchObject({ stored: "background", automatic: "scheduled", mode: "background", source: "stored" });
    const cleared = await handleDeskRoutineDisplay(post({ ...scope, routineId: "hourly-watch", mode: "automatic" }), db, runtime, routineOwner());
    expect(await cleared.json()).toEqual({ owner: "reflex", ...scope, routineId: "hourly-watch", mode: "automatic" });
    expect(readRoutineDisplay(db, scope).has("hourly-watch")).toBe(false);
    routines = byId(await displayPage());
    expect(routines.get("hourly-watch")).toMatchObject({ stored: null, mode: "background", source: "frequency" });
    expect(readRoutineDisplay(db, { ...scope, stack: "other" }).size).toBe(0);
  });
  it("keeps existing Background rows as explicit choices without rewriting them", async () => {
    db.query("INSERT INTO desk_routine_display (principal, stack, owner, routine_id, mode, updated_at) VALUES ('jc', 'default', 'reflex', 'studio-overseer', 'background', 1)").run();
    await displayPage();
    expect(db.query("SELECT routine_id, mode, updated_at FROM desk_routine_display").all()).toEqual([{ routine_id: "studio-overseer", mode: "background", updated_at: 1 }]);
    expect(byId(await displayPage()).get("studio-overseer")).toMatchObject({ source: "stored", mode: "background" });
  });
  it("never moves a routine without a stored choice when frequency is unknown", async () => {
    await handleDeskRoutineDisplay(post({ ...scope, routineId: "morning-briefing", mode: "background" }), db, runtime, routineOwner());
    for (const mode of ["occurrence-failure", "incomplete"] as const) {
      const page = await displayPage(routineOwner(mode));
      expect(page.frequency.status).toBe("unknown");
      expect(page.routines).toEqual([{ routineId: "morning-briefing", stored: "background", automatic: null, maxDailyStarts: null, mode: "background", source: "stored" }]);
      expect(displayEntry(page, "hourly-watch")).toMatchObject({ mode: "scheduled", source: "unknown" });
    }
  });
  it("refuses a foreign scope, an unknown routine, an owner failure and malformed input, keeping the prior display", async () => {
    await handleDeskRoutineDisplay(post({ ...scope, routineId: "studio-overseer", mode: "background" }), db, runtime, routineOwner());
    const foreign = await handleDeskRoutineDisplay(post({ ...scope, stack: "other", routineId: "studio-overseer", mode: "scheduled" }), db, runtime, routineOwner());
    expect(foreign.status).toBe(409);
    expect((await handleDeskRoutineDisplay(post({ ...scope, routineId: "gone", mode: "background" }), db, runtime, routineOwner())).status).toBe(404);
    expect((await handleDeskRoutineDisplay(post({ ...scope, routineId: "studio-overseer", mode: "automatic" }), db, runtime, routineOwner("inventory-failure"))).status).toBe(502);
    expect((await handleDeskRoutineDisplay(post({ ...scope, routineId: "studio-overseer", mode: "folded" }), db, runtime, routineOwner())).status).toBe(400);
    expect((await handleDeskRoutineDisplay(new Request("http://mc.local/api/desk/routine-display", { method: "DELETE" }), db, runtime, routineOwner())).status).toBe(405);
    expect([...readRoutineDisplay(db, scope)]).toEqual([["studio-overseer", "background"]]);
    expect((await handleDeskRoutineDisplay(get(), db, routineTestRuntime, routineOwner())).status).toBe(409);
  });
  it("counts starts in a half-open 24-hour window", () => {
    const at = (hour: number) => saturday + hour * 3600000;
    expect(maxStartsInWindow([0, 4, 8, 12, 16, 20, 24].map(at))).toBe(6);
    expect(maxStartsInWindow([0, 4, 8, 12, 16, 20, 23.99].map(at))).toBe(7);
    expect(maxStartsInWindow([])).toBe(0);
  });
});

describe("browser display preference handling", () => {
  it("rejects an answer for a different routine or scope and ignores late foreign results", async () => {
    expect(await rejection(saveDisplay(scope, "studio-overseer", "background", () => Promise.resolve({ owner: "reflex", ...scope, routineId: "morning-briefing", mode: "background" })))).toContain("different routine");
    expect(await rejection(saveDisplay(scope, "studio-overseer", "background", () => Promise.resolve({ owner: "reflex", ...scope, stack: "other", routineId: "studio-overseer", mode: "background" })))).toContain("different routine");
    const preferences = await browserDisplay();
    expect(withDisplay(preferences, { owner: "reflex", ...scope, stack: "other", routineId: "hourly-watch", mode: "scheduled" })).toBe(preferences);
    const kept = withDisplay(preferences, { owner: "reflex", ...scope, routineId: "hourly-watch", mode: "scheduled" });
    expect(kept.background.has("hourly-watch")).toBe(false);
    const restored = withDisplay(kept, { owner: "reflex", ...scope, routineId: "hourly-watch", mode: "automatic" });
    expect(restored.background.has("hourly-watch")).toBe(true);
    expect(restored.automatic.has("hourly-watch")).toBe(true);
  });
  it("partitions the calendar and explains Automatic from the same fixtures", async () => {
    await handleDeskRoutineDisplay(post({ ...scope, routineId: "hourly-watch", mode: "scheduled" }), db, runtime, routineOwner());
    const preferences = await browserDisplay();
    const lane = backgroundLane({ occurrences: planned, background: preferences.background, inventory: installed, showPaused: false, policy: "all" });
    expect(lane.map((row) => row.id).sort()).toEqual(["shadow-watch", "studio-overseer", "weekday-watch"]);
    const row = lane.find((entry) => entry.id === "shadow-watch");
    const html = row ? renderToStaticMarkup(<BackgroundRow routineId={row.id} name={row.name} schedule={row.schedule} timezone={row.timezone} entries={row.entries} complete period="in this view" displayTimezone="UTC" automatic={preferences.automatic.has(row.id)} onSelect={() => undefined} />) : "";
    expect(html).toContain("Here automatically: it starts more than 6 times a day.");
    const choice = (id: string) => renderToStaticMarkup(<RoutineDisplayChoice routineId={id} saved={storedChoice(displayEntry(preferences, id))} entry={displayEntry(preferences, id)} frequency={preferences.frequency} available pending={undefined} onChange={() => undefined} onDismiss={() => undefined} />);
    expect(choice("shadow-watch")).toMatch(/checked="" value="automatic"/);
    expect(choice("shadow-watch")).toContain("Automatic resolves to Background: the routine has 7 starts within 24 hours");
    expect(choice("four-hourly")).toContain("Automatic resolves to Scheduled starts: the routine has at most 6 starts");
    expect(choice("hourly-watch")).toMatch(/checked="" value="scheduled"/);
    expect(choice("hourly-watch")).toContain("Your stored choice of Scheduled starts applies instead.");
    const unknown = await browserDisplay(routineOwner("occurrence-failure"));
    expect(backgroundLane({ occurrences: planned, background: unknown.background, inventory: installed, showPaused: false, policy: "all" })).toEqual([]);
    expect(renderToStaticMarkup(<RoutineDisplayChoice routineId="shadow-watch" saved="automatic" entry={displayEntry(unknown, "shadow-watch")} frequency={unknown.frequency} available pending={undefined} onChange={() => undefined} onDismiss={() => undefined} />)).toContain("Automatic display is unknown. The routine owner could not list the planned starts for the next 7 days. Without a stored choice the routine stays in the calendar grid.");
  });
  it("shows the prior display and the unsaved proposed choice after a failed write", () => {
    const html = renderToStaticMarkup(<RoutineDisplayChoice routineId="studio-overseer" saved="scheduled" entry={null} frequency={null} available pending={{ mode: "background", busy: false, error: "The routine owner could not confirm this routine." }} onChange={() => undefined} onDismiss={() => undefined} />);
    expect(html).toContain("still uses Scheduled starts");
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
