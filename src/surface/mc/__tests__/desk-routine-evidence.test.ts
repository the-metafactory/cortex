import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { z } from "zod";
import type { Database } from "bun:sqlite";
import { initDatabase } from "../db/init";
import { projectObservability } from "../projection/observability-renderer";
import { handleDeskRoutineEvidence } from "../api/desk-routine-evidence";
import { HandledLedger } from "../desk/actions";
import type { DeskRuntime } from "../desk/compose";
import type { RoutineRunner } from "../desk/routine-command";
import { readRoutineEvidence } from "../desk/routine-evidence";
import { insertObservabilityEvent } from "../db/observability";

const scope = { principal: "test", stack: "default" };
const options = { reflex: ["configured-owner"], composer: ["compose"], target: "@test/pulse-flow", timeZone: "UTC", timeoutSeconds: 120, readTimeoutSeconds: 1 };
const runtime: DeskRuntime = { ledger: new HandledLedger(), options: { routineScope: scope, enabled: true, displayName: "Test", topN: 5, rangerUrl: "", areas: [], sources: [], routines: options } };
const id = crypto.randomUUID();
const correlation = crypto.randomUUID();
const started = "2026-11-01T09:00:00.000Z";
const ended = "2026-11-01T09:00:03.000Z";
const subject = "local.test.default.system.bus.process";
const record = { decisionId: id, routineId: "fixture", routineName: "Historical routine", nameSource: "recorded", target: "@test/pulse-flow", definitionPresent: false, decision: "fired", at: started, trigger: "schedule", correlationId: correlation, resolutionOf: null, approval: null };
const page = { owner: "reflex", ...scope, routineId: null, records: [record], complete: true, nextCursor: null };
const response = (data: unknown) => Promise.resolve({ stdout: JSON.stringify(data), stderr: "", code: 0 });
const run: RoutineRunner = async (argv, input, timeout) => {
  expect(argv.slice(0, 3)).toEqual(["configured-owner", "routine", "history"]);
  expect(argv).toContain("--principal"); expect(argv).toContain("--stack"); expect(input).toBe(""); expect(timeout).toBe(1000);
  const routineIndex = argv.indexOf("--routine-id");
  return response({ ...page, routineId: routineIndex >= 0 ? argv[routineIndex + 1] : null });
};
let db: Database;
function event(outcome: "started" | "completed" | "failed", extra: Record<string, unknown> = {}, eventSubject = subject, foreign = false) {
  projectObservability(db, { id: crypto.randomUUID(), type: "system.bus.process", timestamp: outcome === "started" ? started : ended, payload: {
    outcome, process: "pulse-flow", decision_id: id, correlation_id: correlation, started_at: started,
    reason: "private-fixture-value", argv: ["private-fixture-value"], env: { PRIVATE_VALUE: "private-fixture-value" }, __cortexProcessSubject: subject, ...extra,
  } }, undefined, foreign ? { kind: "foreign", peer: "other/default" } : "local", eventSubject);
}
const logReply = z.object({ content: z.string(), complete: z.boolean(), nextOffset: z.number().nullable(), totalBytes: z.number(), revision: z.string() });
const historyUrl = "http://localhost/api/desk/routine-history";
function logUrl(executionId: string, extra: Record<string, string> = {}) {
  return "http://localhost/api/desk/routine-log?" + new URLSearchParams({ routineId: "fixture", decisionId: id, executionId, file: "process-audit", ...extra }).toString();
}

beforeEach(() => { db = initDatabase(":memory:"); });
afterEach(() => { db.close(); });
describe("routine execution evidence", () => {
  it("correlates owner audit IDs and exposes a bounded redacted audit file after definition deletion", async () => {
    event("completed"); event("started");
    const history = await readRoutineEvidence(db, options, { limit: 25 }, scope, run);
    const execution = history.records[0]?.execution;
    expect(execution).toMatchObject({ kind: "observed", state: "succeeded", startedAt: started, endedAt: ended, durationMs: 3000 });
    if (execution?.kind !== "observed") throw new Error("Expected execution");
    expect(execution.files.find((f) => f.ref === "stdout")).toMatchObject({ availability: "unavailable" });
    const firstResponse = await handleDeskRoutineEvidence(new Request(logUrl(execution.executionId, { limit: "90" })), db, runtime, true, run);
    const first = logReply.parse(await firstResponse.json());
    expect(firstResponse.status).toBe(200); expect(first.complete).toBe(false); expect(first.content.length).toBe(90);
    const restResponse = await handleDeskRoutineEvidence(new Request(logUrl(execution.executionId, { offset: String(first.nextOffset), revision: first.revision })), db, runtime, true, run);
    const rest = logReply.parse(await restResponse.json());
    expect(rest.complete).toBe(true);
    const content = first.content + rest.content;
    expect(content).not.toContain("private-fixture-value"); expect(content).not.toContain("argv"); expect(content).not.toContain("PRIVATE_VALUE");
    expect(content.trim().split("\n").map((line: string) => JSON.parse(line).outcome)).toEqual(["started", "completed"]);
    const download = await handleDeskRoutineEvidence(new Request(logUrl(execution.executionId, { download: "1" })), db, runtime, true, run);
    expect(download.headers.get("content-disposition")).toContain("process-audit.jsonl"); expect(download.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await download.text()).toBe(content);
  });

  it("keeps denied, waiting, dispatched, failed, running and stale evidence distinct", async () => {
    for (const decision of ["denied", "matched", "blocked", "expired"]) {
      const result = await readRoutineEvidence(db, options, { limit: 25 }, scope, () => response({ ...page, records: [{ ...record, decision, correlationId: null }] }));
      expect(result.records[0]?.execution.kind).toBe("not-started");
    }
    expect((await readRoutineEvidence(db, options, { limit: 25 }, scope, run)).records[0]?.execution).toMatchObject({ kind: "unavailable", evidence: "missing-or-delayed" });
    event("started");
    expect((await readRoutineEvidence(db, options, { limit: 25 }, scope, run, Date.parse(started) + 30 * 60000)).records[0]?.execution).toMatchObject({ kind: "observed", state: "running", freshness: "stale", durationMs: null });
    event("failed");
    expect((await readRoutineEvidence(db, options, { limit: 25 }, scope, run)).records[0]?.execution).toMatchObject({ kind: "observed", state: "failed", durationMs: 3000 });
    event("completed");
    expect((await readRoutineEvidence(db, options, { limit: 25 }, scope, run)).records[0]?.execution).toMatchObject({ kind: "unavailable", evidence: "conflicting" });
  });

  it("rejects foreign scope, guessed correlations, forged files and inconsistent owner reads", async () => {
    event("completed", {}, "local.other.default.system.bus.process");
    event("completed", {}, subject, true);
    event("completed", { correlation_id: crypto.randomUUID() });
    expect((await readRoutineEvidence(db, options, { limit: 25 }, scope, run)).records[0]?.execution.kind).toBe("unavailable");
    for (const invalid of [{ ...page, principal: "other" }, { ...page, stack: "other" }, { ...page, records: [record, record] }, { ...page, complete: false, nextCursor: null }]) {
      expect((await handleDeskRoutineEvidence(new Request(historyUrl), db, runtime, false, () => response(invalid))).status).toBe(502);
    }
    event("completed");
    const execution = (await readRoutineEvidence(db, options, { limit: 25 }, scope, run)).records[0]?.execution;
    if (execution?.kind !== "observed") throw new Error("Expected execution");
    const invalidQueries: Record<string, string>[] = [{ file: "../../etc/passwd" }, { principal: "other" }, { limit: "65537" }, { routineId: "../fixture" }];
    for (const extra of invalidQueries) expect((await handleDeskRoutineEvidence(new Request(logUrl(execution.executionId, extra)), db, runtime, true, run)).status).toBe(400);
    const refusedQueries: Record<string, string>[] = [{ file: "stdout" }, { executionId: "a".repeat(64) }, { revision: "b".repeat(64) }];
    for (const extra of refusedQueries) expect((await handleDeskRoutineEvidence(new Request(logUrl(execution.executionId, extra)), db, runtime, true, run)).status).toBe(409);
    expect((await handleDeskRoutineEvidence(new Request(logUrl(execution.executionId, { offset: "3999999" })), db, runtime, true, run)).status).toBe(400);
    expect((await handleDeskRoutineEvidence(new Request(historyUrl, { method: "POST" }), db, runtime, false, run)).status).toBe(405);
  });

  it("refuses oversized, malformed, truncated and contradictory audit evidence", async () => {
    event("completed", { started_at: "2026-11-02T00:00:00Z" });
    expect((await readRoutineEvidence(db, options, { limit: 25 }, scope, run)).records[0]?.execution).toMatchObject({ kind: "unavailable", evidence: "conflicting" });
    db.run("DELETE FROM observability_events");
    event("completed", { reason: "x".repeat(70000) });
    expect((await readRoutineEvidence(db, options, { limit: 25 }, scope, run)).records[0]?.execution).toMatchObject({ kind: "unavailable", evidence: "incomplete" });
    db.run("DELETE FROM observability_events");
    event("completed", { started_at: "not-an-instant" });
    expect((await readRoutineEvidence(db, options, { limit: 25 }, scope, run)).records[0]?.execution).toMatchObject({ kind: "unavailable", evidence: "incomplete" });
    db.run("DELETE FROM observability_events");
    db.transaction(() => { for (let i = 0; i < 2001; i++) event("started"); })();
    expect((await readRoutineEvidence(db, options, { limit: 25 }, scope, run)).records[0]?.execution).toMatchObject({ kind: "unavailable", evidence: "incomplete" });
  });

  it("keeps duplicate deliveries idempotent and refuses a continuation after late owner events", async () => {
    const eventId = crypto.randomUUID();
    const payload = { outcome: "started", process: "pulse-flow", decision_id: id, correlation_id: correlation, started_at: started, __cortexProcessSubject: subject };
    for (let i = 0; i < 2; i++) insertObservabilityEvent(db, { envelopeId: eventId, type: "system.bus.process", family: "dispatch", payload, timestamp: started });
    const execution = (await readRoutineEvidence(db, options, { limit: 25 }, scope, run)).records[0]?.execution;
    if (execution?.kind !== "observed") throw new Error("Expected execution");
    const initial = logReply.parse(await (await handleDeskRoutineEvidence(new Request(logUrl(execution.executionId, { limit: "30" })), db, runtime, true, run)).json());
    expect(initial.totalBytes).toBeGreaterThan(30);
    event("completed");
    expect((await handleDeskRoutineEvidence(new Request(logUrl(execution.executionId, { offset: String(initial.nextOffset), revision: initial.revision })), db, runtime, true, run)).status).toBe(409);
    const current = logReply.parse(await (await handleDeskRoutineEvidence(new Request(logUrl(execution.executionId)), db, runtime, true, run)).json());
    expect(current.content.trim().split("\n")).toHaveLength(2);
    const beyond = await handleDeskRoutineEvidence(new Request(logUrl(execution.executionId, { offset: String(current.totalBytes + 1), revision: current.revision })), db, runtime, true, run);
    expect(beyond.status).toBe(409);
  });
});
