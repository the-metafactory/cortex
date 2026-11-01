import { describe, expect, it } from "bun:test";
import { initDatabase } from "../db/init";
import { actOnRoutineLifecycle, inspectRoutineLifecycle, previewRoutineLifecycle } from "../desk/routine-lifecycle";
import type { LifecycleAction, LifecycleDetail } from "../desk/routine-lifecycle-contract";
import type { RoutineRunner } from "../desk/routine-command";
import { claimRoutineOperation, pendingRoutineOperations, routineOperationBinding } from "../desk/routine-store";
import { handleDeskRoutineLifecycle } from "../api/desk-routine-lifecycle";
import { readRoutines } from "../desk/routines";

import { routineTestOptions as options, routineTestRuntime as runtime, routineAnswer as answer } from "./routine-owner-fixture";
function owner() {
  let current: LifecycleDetail = { id: "sample", revision: "a".repeat(64), writable: true, reason: "", runtimeConfirmed: true, current: { paused: false, policy: "approval", schedule: "0 8 * * *", timezone: "Europe/Zurich" } };
  let fail: "none" | "before" | "runtime" | "refuse" = "none"; let writes = 0;
  const run: RoutineRunner = async (argv) => {
    const args = argv.slice(1); const flag = (name: string) => args[args.indexOf(name) + 1] ?? "";
    if (args[0] !== "routine" || args[1] !== "lifecycle") throw new Error("Unexpected command");
    if (args[2] === "inspect") return answer(current);
    const paused = flag("--paused") === "true"; const proposedRevision = (paused ? "b" : "c").repeat(64);
    if (args[2] === "preview") return answer({ ...current, proposedRevision, paused });
    if (args[2] !== "update") throw new Error("Unexpected lifecycle command");
    writes++;
    if (fail === "before") throw new Error("transport lost before write");
    if (fail === "refuse") return answer({ error: { code: "invalid-input", message: "Revision changed" } }, 1);
    current = { ...current, revision: proposedRevision, current: { ...current.current, paused }, runtimeConfirmed: fail !== "runtime" };
    if (fail === "runtime") throw new Error("Runtime synchronization failed after rename");
    return answer(current);
  };
  return { run, get: () => current, set: (value: LifecycleDetail) => { current = value; }, fail: (value: typeof fail) => { fail = value; }, writes: () => writes };
}
async function intent(s: ReturnType<typeof owner>, action: "pause" | "resume" = "pause", requestId = "lifecycle-request"): Promise<LifecycleAction> {
  const current = await inspectRoutineLifecycle(options, "sample", s.run);
  const preview = await previewRoutineLifecycle(options, { id: current.id, revision: current.revision, paused: action === "pause" }, s.run);
  return { requestId, action, target: current.id, revision: current.revision, proposedRevision: preview.proposedRevision };
}
describe("owner-confirmed lifecycle ledger", () => {
  it("previews without a write then pauses/resumes with immutable bindings and one write per intent", async () => {
    const s = owner(); const db = initDatabase(":memory:");
    try {
      const request = await intent(s); expect(s.writes()).toBe(0);
      expect(await actOnRoutineLifecycle(db, options, request, s.run)).toMatchObject({ ok: true });
      expect(s.get().current).toEqual({ paused: true, policy: "approval", schedule: "0 8 * * *", timezone: "Europe/Zurich" });
      expect(await actOnRoutineLifecycle(db, options, request, s.run)).toMatchObject({ ok: true }); expect(s.writes()).toBe(1);
      expect(await actOnRoutineLifecycle(db, options, { ...request, action: "resume" }, s.run)).toMatchObject({ ok: false, error: expect.stringContaining("different routine action") });
      expect(await actOnRoutineLifecycle(db, options, await intent(s, "resume", "resume-request"), s.run)).toMatchObject({ ok: true }); expect(s.writes()).toBe(2);
    } finally { db.close(); }
  });
  it("does not mistake a committed file revision for a confirmed runtime and converges without resending", async () => {
    const s = owner(); const db = initDatabase(":memory:");
    try {
      const request = await intent(s); s.fail("runtime");
      expect(await actOnRoutineLifecycle(db, options, request, s.run)).toMatchObject({ ok: false, uncertain: true });
      expect(s.get().revision).toBe(request.proposedRevision); expect(s.get().current.paused).toBe(true);
      expect(await actOnRoutineLifecycle(db, options, request, s.run)).toMatchObject({ ok: false, uncertain: true }); expect(pendingRoutineOperations(db, options)).toEqual([request]);
      s.set({ ...s.get(), runtimeConfirmed: true });
      expect(await actOnRoutineLifecycle(db, options, request, s.run)).toMatchObject({ ok: true }); expect(s.writes()).toBe(1);
    } finally { db.close(); }
  });
  it("keeps precommit and unrelated-revision results unresolved and never resends", async () => {
    const s = owner(); const db = initDatabase(":memory:");
    try {
      const request = await intent(s); s.fail("before");
      expect(await actOnRoutineLifecycle(db, options, request, s.run)).toMatchObject({ ok: false, uncertain: true });
      s.set({ ...s.get(), revision: "d".repeat(64), current: { ...s.get().current, paused: true } });
      expect(await actOnRoutineLifecycle(db, options, request, s.run)).toMatchObject({ ok: false, uncertain: true }); expect(s.writes()).toBe(1);
    } finally { db.close(); }
  });
  it("refuses busy resources definitely before sending and releases definite owner refusal", async () => {
    const s = owner(); const db = initDatabase(":memory:");
    try {
      const request = await intent(s); claimRoutineOperation(db, "schedule-request", routineOperationBinding(options, { requestId: "schedule-request", action: "stop", target: "sample" }), "sample");
      const busy = await actOnRoutineLifecycle(db, options, request, s.run); expect(busy).toMatchObject({ ok: false, error: expect.stringContaining("not sent") }); expect("uncertain" in busy).toBe(false); expect(s.writes()).toBe(0);
      db.query("DELETE FROM desk_routine_operations").run(); s.fail("refuse");
      expect(await actOnRoutineLifecycle(db, options, request, s.run)).toMatchObject({ ok: false }); expect(pendingRoutineOperations(db, options)).toEqual([]);
    } finally { db.close(); }
  });
  it("retains inventory and pending approvals when lifecycle reconciliation is unavailable", async () => {
    const s = owner(); const db = initDatabase(":memory:");
    try {
      const request = await intent(s); claimRoutineOperation(db, request.requestId, routineOperationBinding(options, request), request.target);
      const run: RoutineRunner = async (argv) => {
        if (argv[2] === "list") return answer([{ id: "sample", schedule: "0 8 * * *", timezone: "UTC", policy: "approval", paused: true, target: options.target, file: "/sample.yaml", lastDecision: null }]);
        if (argv[1] === "history") return answer([]);
        if (argv[1] === "pending") return answer([{ decisionId: "waiting", blueprintId: "sample", matchedAt: "2026-01-01T00:00:00Z", expiresAt: "2030-01-01T00:00:00Z", impulseSummary: "Existing request" }]);
        throw new Error("Lifecycle owner unavailable");
      };
      const result = await readRoutines(db, options, run); expect(result.error).toBeUndefined(); expect(result.installed[0]?.paused).toBe(true); expect(result.pending).toHaveLength(1); expect(result.changes).toEqual([request]);
    } finally { db.close(); }
  });
  it("rejects stale, read-only and unconfirmed preflight and validates exact API input without writes", async () => {
    const s = owner(); const db = initDatabase(":memory:");
    try {
      const request = await intent(s);
      for (const change of [{ writable: false, reason: "Externally owned" }, { runtimeConfirmed: false }, { revision: "d".repeat(64) }]) {
        const original = s.get(); s.set({ ...original, ...change }); expect(await actOnRoutineLifecycle(db, options, request, s.run)).toMatchObject({ ok: false }); s.set(original);
      }
      expect((await handleDeskRoutineLifecycle(new Request("http://localhost/api/desk/routine-lifecycle?id=sample"), runtime, s.run)).status).toBe(200);
      expect((await handleDeskRoutineLifecycle(new Request("http://localhost/api/desk/routine-lifecycle?id=sample&path=other"), runtime, s.run)).status).toBe(400);
      for (const body of [{ id: "sample", revision: request.revision, paused: true }, { id: "sample", revision: request.revision, paused: "true" }]) {
        expect((await handleDeskRoutineLifecycle(new Request("http://localhost/api/desk/routine-lifecycle", { method: "POST", body: JSON.stringify(body) }), runtime, s.run)).status).toBe(typeof body.paused === "boolean" ? 200 : 400);
      }
      expect(s.writes()).toBe(0);
    } finally { db.close(); }
  });
});
