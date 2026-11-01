import { describe, expect, it } from "bun:test";
import { initDatabase } from "../db/init";
import { actOnRoutine } from "../desk/routines";
import { pendingRoutineOperations } from "../desk/routine-store";
import { actOnRoutineRemoval } from "../desk/routine-removal";
import type { RemovalAction, RemovalDetail } from "../desk/routine-removal-contract";
import type { RoutineRunner } from "../desk/routine-command";
import { routineTestOptions as options, routineAnswer as answer } from "./routine-owner-fixture";
const request: RemovalAction = { action: "delete", target: "sample", revision: "a".repeat(64), requestId: "delete-request" };
function owner() {
  let detail: RemovalDetail = { id: "sample", revision: request.revision, name: "Sample", target: options.target, schedule: "0 8 * * *", timezone: "UTC", paused: false, writable: true, reason: "" };
  let status: "unknown" | "pending" | "removed" = "unknown"; let mode: "ok" | "lost" | "partial" | "refuse" = "ok";
  const writes: string[] = [];
  const run: RoutineRunner = async (argv) => {
    if (argv[2] === "removal" && argv[3] === "inspect") return answer(detail);
    const operation = argv[2] === "remove" ? "remove" : argv[3];
    if (operation === "remove") {
      writes.push("remove");
      if (mode === "lost") throw new Error("transport lost before acceptance");
      if (mode === "refuse") return answer({ error: { code: "invalid-input", message: "Foreign-owned definition" } }, 1);
      status = mode === "partial" ? "pending" : "removed";
      if (mode === "partial") throw new Error("cleanup uncertain");
    } else if (operation === "reconcile") { writes.push("reconcile"); if (mode !== "partial") status = "removed"; }
    else if (operation !== "status") throw new Error("Unexpected owner command");
    return answer({ id: "sample", revision: request.revision, requestId: request.requestId, status });
  };
  return { run, writes, detail: (change: Partial<RemovalDetail>) => { detail = { ...detail, ...change }; }, mode: (value: typeof mode) => { mode = value; } };
}
describe("revision-bound routine deletion", () => {
  it("confirms exact owner absence once, binds retries, and refuses the legacy confirmation bypass", async () => {
    const db = initDatabase(":memory:"); const s = owner();
    try {
      expect(await actOnRoutine(db, options, { action: "remove", target: "sample", requestId: "legacy-request" }, Date.now(), s.run)).toMatchObject({ ok: false, error: expect.stringContaining("confirm Delete") });
      expect(s.writes).toEqual([]);
      expect(await actOnRoutineRemoval(db, options, request, s.run)).toMatchObject({ ok: true });
      expect(await actOnRoutineRemoval(db, options, request, s.run)).toMatchObject({ ok: true });
      expect(s.writes).toEqual(["remove"]);
      expect(await actOnRoutineRemoval(db, options, { ...request, target: "another" }, s.run)).toMatchObject({ ok: false, error: expect.stringContaining("different routine action") });
    } finally { db.close(); }
  });
  it("keeps unknown delivery pending without resending a delete and reconciles partial cleanup by exact intent", async () => {
    const db = initDatabase(":memory:"); const s = owner();
    try {
      s.mode("lost");
      expect(await actOnRoutineRemoval(db, options, request, s.run)).toMatchObject({ ok: false, uncertain: true });
      expect(await actOnRoutineRemoval(db, options, request, s.run)).toMatchObject({ ok: false, uncertain: true });
      expect(s.writes).toEqual(["remove"]); expect(pendingRoutineOperations(db, options)).toEqual([request]);
    } finally { db.close(); }
    const next = initDatabase(":memory:"); const partial = owner();
    try {
      partial.mode("partial"); expect(await actOnRoutineRemoval(next, options, request, partial.run)).toMatchObject({ ok: false, uncertain: true });
      partial.mode("ok"); expect(await actOnRoutineRemoval(next, options, request, partial.run)).toMatchObject({ ok: true });
      expect(partial.writes).toEqual(["remove", "reconcile", "reconcile"]);
      expect(pendingRoutineOperations(next, options)).toEqual([]);
    } finally { next.close(); }
  });
  it("refuses changed revisions and foreign targets before writes and releases definite refusals", async () => {
    const db = initDatabase(":memory:"); const s = owner();
    try {
      s.detail({ revision: "b".repeat(64) }); expect(await actOnRoutineRemoval(db, options, request, s.run)).toMatchObject({ ok: false });
      s.detail({ revision: request.revision, target: "@foreign/owner" }); expect(await actOnRoutineRemoval(db, options, request, s.run)).toMatchObject({ ok: false });
      expect(s.writes).toEqual([]);
      s.detail({ target: options.target }); s.mode("refuse"); expect(await actOnRoutineRemoval(db, options, request, s.run)).toMatchObject({ ok: false, error: "Foreign-owned definition" });
      expect(pendingRoutineOperations(db, options)).toEqual([]);
    } finally { db.close(); }
  });
});
