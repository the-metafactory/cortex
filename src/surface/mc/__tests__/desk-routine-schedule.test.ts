import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { initDatabase } from "../db/init";
import type { RoutineOptions, RoutineRunner } from "../desk/routine-command";
import { actOnRoutineSchedule, inspectRoutineSchedule, previewRoutineSchedule } from "../desk/routine-schedule-editor";
import { ScheduleActionSchema, ScheduleDetailSchema, SchedulePreviewSchema, type ScheduleAction, type ScheduleValue } from "../desk/routine-schedule-contract";
import { claimRoutineOperation, pendingRoutineOperations, readRoutineOperation, routineOperationBinding } from "../desk/routine-store";
import { handleDeskRoutineEditor } from "../api/desk-routine-editor";
import { handleDeskRoutineSchedule } from "../api/desk-routine-schedule";
import { HandledLedger } from "../desk/actions";
import type { DeskRuntime } from "../desk/compose";
import { commonSchedule } from "../dashboard-v2/components/desk-routine-schedule";
import { readRoutines } from "../desk/routines";

const options: RoutineOptions = { composer: ["compose"], reflex: ["reflex"], target: "@test/pulse-flow", timeZone: "UTC", timeoutSeconds: 2, readTimeoutSeconds: 1 };
const runtime: DeskRuntime = { ledger: new HandledLedger(), options: { enabled: true, displayName: "Test", topN: 5, rangerUrl: "", areas: [], sources: [], routines: options } };
const at = "2026-01-01T00:00:00.000Z";
const dates = ["2030-01-01T08:00:00.000Z", "2030-01-02T08:00:00.000Z", "2030-01-03T08:00:00.000Z"];
const projection = (value: ScheduleValue) => ({ schedule: value.schedule, timezone: value.timezone, effectiveTimezone: value.timezone ?? "UTC", occurrences: dates });
const answer = (value: unknown, code = 0) => ({ code, stdout: JSON.stringify(value), stderr: "" });

function owner() {
  let current = { id: "sample", revision: "a".repeat(64), at, writable: true, reason: "", current: projection({ schedule: "0 8 * * *", timezone: "UTC" }) };
  let failure: "none" | "refuse" | "before" | "after" = "none"; let down = false; const writes: string[][] = [];
  let duringUpdate: (() => Promise<void>) | undefined;
  const run: RoutineRunner = async (argv) => {
    const args = argv.slice(1); const flag = (name: string) => args[args.indexOf(name) + 1] ?? "";
    if (down) throw new Error("owner unavailable");
    if (args[0] !== "routine" || args[1] !== "schedule") throw new Error("Unexpected owner command");
    if (args[2] === "inspect") return answer(current);
    const value = { schedule: flag("--schedule"), timezone: args.includes("--owner-timezone") ? null : flag("--timezone") };
    const proposedRevision = value.schedule === current.current.schedule && value.timezone === current.current.timezone ? current.revision : createHash("sha256").update(JSON.stringify([flag("--revision"), value])).digest("hex");
    if (args[2] === "preview") return answer({ id: current.id, revision: current.revision, proposedRevision, at, current: current.current, proposed: projection(value) });
    if (args[2] !== "update") throw new Error("Unexpected schedule command");
    writes.push(args);
    await duringUpdate?.();
    if (failure === "refuse") return answer({ error: { code: "invalid-input", message: "Routine changed before update" } }, 1);
    if (failure === "before") throw new Error("transport lost before acknowledgement");
    current = { ...current, revision: proposedRevision, current: projection(value) };
    if (failure === "after") { down = true; throw new Error("reply lost after commit"); }
    return answer(current);
  };
  return { run, writes, get: () => current, set: (value: typeof current) => { current = value; }, fail: (kind: typeof failure) => { failure = kind; }, recover: () => { down = false; failure = "none"; }, hold: (callback: () => Promise<void>) => { duringUpdate = callback; } };
}

async function intent(s: ReturnType<typeof owner>, requestId = "request-first", schedule = "*/7 * * * * *"): Promise<ScheduleAction> {
  const current = await inspectRoutineSchedule(options, "sample", s.run);
  const value = { id: current.id, revision: current.revision, schedule, timezone: null };
  const result = await previewRoutineSchedule(options, value, s.run);
  return ScheduleActionSchema.parse({ requestId, action: "schedule", target: current.id, revision: current.revision, proposedRevision: result.proposedRevision, schedule: value.schedule, timezone: value.timezone });
}

describe("Desk schedule edit contract and ledger", () => {
  it("preserves successful routine reads when a pending schedule owner inspection fails", async () => {
    const db = initDatabase(":memory:"); const s = owner();
    try {
      const request = await intent(s); claimRoutineOperation(db, request.requestId, routineOperationBinding(options, request), request.target);
      const run: RoutineRunner = async (argv) => {
        if (argv[1] === "routine" && argv[2] === "list") return answer([{ id: "surviving", schedule: "0 8 * * *", timezone: "UTC", policy: "approval", target: options.target, file: "/owned/surviving.yaml", lastDecision: null }]);
        if (argv[1] === "pending") return answer([{ decisionId: "pending-survivor", blueprintId: "surviving", matchedAt: at, expiresAt: dates[0], impulseSummary: "Scheduled fixture" }]);
        if (argv[1] === "history") return answer([]);
        throw new Error("Pending routine was removed from the owner");
      };
      const view = await readRoutines(db, options, run);
      expect(view.error).toBeUndefined(); expect(view.installed.map((entry) => entry.id)).toEqual(["surviving"]); expect(view.pending).toHaveLength(1); expect(view.changes).toEqual([request]);
    } finally { db.close(); }
  });

  it("bounds pending schedule reconciliation concurrency while retaining failed intents", async () => {
    const db = initDatabase(":memory:"); const s = owner();
    let active = 0; let maximum = 0; let inspected = 0;
    let release = (): void => {};
    const firstBatch = new Promise<void>((resolve) => { release = resolve; });
    try {
      const request = await intent(s);
      for (let index = 0; index < 9; index++) {
        const next = { ...request, requestId: `pending-${index}`, target: `routine-${index}` };
        claimRoutineOperation(db, next.requestId, routineOperationBinding(options, next), next.target);
      }
      const run: RoutineRunner = async (argv) => {
        if (argv[1] === "history" || argv[1] === "pending" || argv[2] === "list") return answer([]);
        active++; inspected++; maximum = Math.max(maximum, active);
        if (active === 4) release();
        await firstBatch;
        active--;
        throw new Error("Owner unavailable");
      };
      const view = await readRoutines(db, options, run);
      expect(view.error).toBeUndefined(); expect(inspected).toBe(9); expect(maximum).toBe(4); expect(view.changes).toHaveLength(9);
    } finally { db.close(); }
  });

  it("detects only the exact common clock subset and leaves one-off interval ranges and unknown forms custom", () => {
    expect(commonSchedule("0 8 * * 1-5")).toEqual({ days: [1, 2, 3, 4, 5], time: "08:00" });
    expect(commonSchedule("30 23 * * *")?.time).toBe("23:30");
    for (const value of ["*/7 * * * * *", "2030-01-01T08:00:00", "0 8 1 * *", "0 8 * * 0-6", "0 8 * * 1,1", "60 8 * * *", "0 24 * * *", " 0 8 * * *"]) expect(commonSchedule(value)).toBeNull();
  });

  it("previews without mutation, saves through the existing ledger and uses distinct acknowledged intents", async () => {
    const db = initDatabase(":memory:"); const s = owner();
    try {
      const request = await intent(s); expect(s.writes).toHaveLength(0);
      expect(await actOnRoutineSchedule(db, options, request, s.run)).toEqual({ ok: true, message: "Schedule saved and verified." });
      expect(s.writes).toHaveLength(1); expect(s.writes[0]).toContain("--owner-timezone"); expect(s.get().current.timezone).toBeNull();
      expect(await actOnRoutineSchedule(db, options, request, s.run)).toMatchObject({ ok: true }); expect(s.writes).toHaveLength(1);
      expect(await actOnRoutineSchedule(db, options, { ...request, schedule: "0 10 * * *" }, s.run)).toMatchObject({ ok: false, error: expect.stringContaining("different routine action") });
      expect(readRoutineOperation(db, request.requestId)?.result).not.toBeNull(); expect(pendingRoutineOperations(db, options)).toEqual([]);
      const unchanged = await intent(s, "request-nochange"); expect(await actOnRoutineSchedule(db, options, unchanged, s.run)).toMatchObject({ ok: false, error: expect.stringContaining("unchanged") });
      const next = await intent(s, "request-second", "0 10 * * *"); expect(next.requestId).not.toBe(request.requestId);
      expect(await actOnRoutineSchedule(db, options, next, s.run)).toMatchObject({ ok: true }); expect(s.writes).toHaveLength(2);
    } finally { db.close(); }
  });

  it("reconciles a lost committed reply by exact revision without resending", async () => {
    const db = initDatabase(":memory:"); const s = owner();
    try {
      const request = await intent(s); s.fail("after");
      expect(await actOnRoutineSchedule(db, options, request, s.run)).toMatchObject({ ok: false, uncertain: true });
      expect(pendingRoutineOperations(db, options)).toEqual([request]); s.recover();
      expect(await actOnRoutineSchedule(db, options, request, s.run)).toMatchObject({ ok: true }); expect(s.writes).toHaveLength(1);
    } finally { db.close(); }
  });

  it("keeps precommit and unrelated-revision uncertainty unresolved even when schedule values match", async () => {
    const db = initDatabase(":memory:"); const s = owner();
    try {
      const request = await intent(s); s.fail("before");
      expect(await actOnRoutineSchedule(db, options, request, s.run)).toMatchObject({ ok: false, uncertain: true }); s.recover();
      expect(await actOnRoutineSchedule(db, options, request, s.run)).toMatchObject({ ok: false, uncertain: true });
      s.set({ ...s.get(), revision: "c".repeat(64), current: projection(request) });
      expect(await actOnRoutineSchedule(db, options, request, s.run)).toMatchObject({ ok: false, uncertain: true });
      expect(s.writes).toHaveLength(1); expect(readRoutineOperation(db, request.requestId)?.result).toBeNull();
    } finally { db.close(); }
  });

  it("shares resource exclusion with policy and parameter writes and releases a definitive prewrite refusal", async () => {
    const db = initDatabase(":memory:"); const s = owner();
    try {
      const request = await intent(s);
      expect(claimRoutineOperation(db, "policy-request", routineOperationBinding(options, { requestId: "policy-request", action: "stop", target: "sample" }), "sample")).toBe(true);
      const busy = await actOnRoutineSchedule(db, options, request, s.run);
      expect(busy).toMatchObject({ ok: false, error: expect.stringContaining("was not sent") }); expect("uncertain" in busy).toBe(false); expect(s.writes).toHaveLength(0);
      const response = await handleDeskRoutineEditor(new Request("http://localhost/api/desk/routine-editor", { method: "POST", body: JSON.stringify({ action: "update", id: "sample", revision: request.revision, patches: [{ path: ["actions", 0, "retry", "attempts"], value: 3 }] }) }), runtime, s.run, db);
      expect(response.status).toBe(409); expect(await response.text()).toContain("awaiting confirmation");
      db.query("DELETE FROM desk_routine_operations").run(); s.fail("refuse");
      expect(await actOnRoutineSchedule(db, options, request, s.run)).toMatchObject({ ok: false }); expect(readRoutineOperation(db, request.requestId)).toBeNull();
    } finally { db.close(); }
  });

  it("reconciles a same-request claim race without sending a duplicate owner update", async () => {
    const db = initDatabase(":memory:"); const s = owner(); let release = () => {}; let entered = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; }); const ready = new Promise<void>((resolve) => { entered = resolve; });
    let pending: Promise<unknown> | undefined;
    try {
      const request = await intent(s); s.hold(async () => { entered(); await gate; });
      const raceRun: RoutineRunner = async (argv, stdin, timeout) => {
        if (argv.includes("preview")) {
          const response = await s.run(argv, stdin, timeout);
          const claim = claimRoutineOperation(db, request.requestId, routineOperationBinding(options, request), request.target);
          if (claim) pending = s.run(["reflex", "routine", "schedule", "update", request.target, "--revision", request.revision, "--schedule", request.schedule, "--owner-timezone", "--proposed-revision", request.proposedRevision], "", 1000);
          return response;
        }
        return s.run(argv, stdin, timeout);
      };
      const raced = actOnRoutineSchedule(db, options, request, raceRun); await ready;
      expect(await raced).toMatchObject({ ok: false, uncertain: true }); expect(s.writes).toHaveLength(1);
      release(); await pending;
      expect(await actOnRoutineSchedule(db, options, request, s.run)).toMatchObject({ ok: true }); expect(s.writes).toHaveLength(1);
    } finally { release(); await pending; db.close(); }
  });

  it("rejects malformed owner timezones identity and nonfuture/nonincreasing occurrence projections", async () => {
    const s = owner(); const original = s.get();
    for (const current of [
      { ...original.current, effectiveTimezone: "Invalid/Zone" },
      { ...original.current, effectiveTimezone: "Europe/Zurich" },
      { ...original.current, occurrences: [dates[1] ?? "", dates[0] ?? ""] },
      { ...original.current, occurrences: [at] },
    ]) {
      s.set({ ...original, current }); await expect(inspectRoutineSchedule(options, "sample", s.run)).rejects.toThrow();
    }
    s.set({ ...original, id: "foreign" }); await expect(inspectRoutineSchedule(options, "sample", s.run)).rejects.toThrow("different schedule");
    s.set(original); expect(ScheduleDetailSchema.safeParse(original).success).toBe(true);
    expect(SchedulePreviewSchema.safeParse({ id: "sample", revision: original.revision, proposedRevision: "b".repeat(64), at, current: original.current, proposed: { ...original.current, occurrences: ["2025-01-01T00:00:00Z"] } }).success).toBe(false);
  });

  it("exposes bounded exact schedule inspection/preview and refuses malformed API input without writes", async () => {
    const s = owner();
    const read = await handleDeskRoutineSchedule(new Request("http://localhost/api/desk/routine-schedule?id=sample"), runtime, s.run); expect(read.status).toBe(200);
    expect((await handleDeskRoutineSchedule(new Request("http://localhost/api/desk/routine-schedule?id=sample&path=anything"), runtime, s.run)).status).toBe(400);
    const current = s.get(); const input = { id: current.id, revision: current.revision, schedule: "0 9 * * *", timezone: "UTC" };
    expect((await handleDeskRoutineSchedule(new Request("http://localhost/api/desk/routine-schedule", { method: "POST", body: JSON.stringify(input) }), runtime, s.run)).status).toBe(200);
    expect((await handleDeskRoutineSchedule(new Request("http://localhost/api/desk/routine-schedule", { method: "POST", body: "{}" }), runtime, s.run)).status).toBe(400);
    expect((await handleDeskRoutineSchedule(new Request("http://localhost/api/desk/routine-schedule", { method: "DELETE" }), runtime, s.run)).status).toBe(405); expect(s.writes).toHaveLength(0);
  });
});
