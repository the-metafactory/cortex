import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { RoutineEvidencePageSchema, RoutineLogPageSchema, type RoutineEvidenceRecord } from "../desk/routine-evidence-contract";
import { appendEvidence, downloadLog, evidenceLabel, evidenceOrigin, failedExecution, logQuery, readEvidence, validateLogPage } from "../dashboard-v2/lib/routine-evidence";
import { RoutineEvidenceList } from "../dashboard-v2/components/desk-routine-evidence";
import { readRoutinesLocation, routinesSearch } from "../dashboard-v2/hooks/use-routines-location";
const record: RoutineEvidenceRecord = { routineId: "removed", routineName: "Historical name <script>", nameSource: "recorded", definitionPresent: false, target: null, decisionId: "11111111-1111-4111-8111-111111111111", decision: "fired", at: "2026-11-01T12:00:00Z", impulseKind: "schedule", correlationId: "22222222-2222-4222-8222-222222222222", resolutionOf: null, approval: null, execution: { kind: "unavailable", reason: "Missing or delayed", evidence: "missing-or-delayed" } };
const file = { ref: "process-audit", filename: "process-audit.jsonl", type: "application/x-ndjson", availability: "available", reason: null } satisfies Parameters<typeof logQuery>[1];
const observed: RoutineEvidenceRecord = { ...record, execution: { kind: "observed", owner: "cortex-process", executionId: "a".repeat(64), state: "succeeded", freshness: "recorded", startedAt: record.at, endedAt: null, durationMs: null, files: [file] } };
describe("routine evidence browser contract", () => {
  it("never turns dispatch, denial, stale observations or delayed evidence into success", () => {
    expect(evidenceLabel(record)).toBe("Dispatched · completion unconfirmed");
    expect(evidenceLabel({ ...record, decision: "denied", correlationId: null })).toBe("Denied · no execution");
    expect(failedExecution({ ...record, decision: "denied" })).toBe(false);
    expect(evidenceLabel(observed)).toBe("Succeeded");
    expect(failedExecution({ ...observed, execution: { ...observed.execution, kind: "observed", owner: "cortex-process", executionId: "a".repeat(64), state: "failed", freshness: "recorded", startedAt: record.at, endedAt: null, durationMs: null, files: [file] } })).toBe(true);
    expect(evidenceOrigin({ ...record, resolutionOf: "33333333-3333-4333-8333-333333333333" })).toContain("unconfirmed");
    expect(evidenceOrigin(record)).toBe("Automatic");
    const parent = { ...record, decisionId: "33333333-3333-4333-8333-333333333333", decision: "matched", approval: { state: "approved", decidedAt: record.at, expiresAt: record.at } } satisfies RoutineEvidenceRecord;
    expect(evidenceOrigin({ ...record, resolutionOf: parent.decisionId }, [parent])).toBe("Explicitly approved");
    expect(evidenceOrigin({ ...record, resolutionOf: parent.decisionId }, [{ ...parent, decision: "blocked", approval: null }])).toBe("Automatic");
  });
  it("preserves deleted identity and rejects repeated or out-of-order history", () => {
    expect(appendEvidence([], [record])[0]).toMatchObject({ definitionPresent: false, routineName: "Historical name <script>", target: null });
    expect(() => appendEvidence([record], [record])).toThrow("repeated");
    expect(() => appendEvidence([record], [{ ...record, decisionId: "33333333-3333-4333-8333-333333333333", at: "2026-11-02T12:00:00Z" }])).toThrow("changed");
    expect(() => RoutineEvidencePageSchema.parse({ records: [] })).toThrow();
    const page = { owner: "reflex", principal: "p", stack: "s", routineId: "removed", records: [observed], executionOwner: "cortex-process", complete: true, nextCursor: null };
    expect(RoutineEvidencePageSchema.parse(page).records[0]).toEqual(observed);
    expect(() => RoutineEvidencePageSchema.parse({ ...page, records: [{ ...observed, nameSource: "identifier", routineName: "wrong" }] })).toThrow();
  });
  it("requires exact authorized references, matching file and advancing revision-bound pages", () => {
    expect(() => logQuery(record, file)).toThrow("No authorized");
    expect(() => logQuery(observed, { ...file, availability: "unavailable", reason: "Expired" })).toThrow("Expired");
    expect(logQuery(observed, file, 10, "b".repeat(64)).get("revision")).toBe("b".repeat(64));
    const page = RoutineLogPageSchema.parse({ file, revision: "b".repeat(64), offset: 10, nextOffset: 20, totalBytes: 30, complete: false, content: "0123456789" });
    expect(() => { validateLogPage(page, file, 10, "b".repeat(64)); }).not.toThrow();
    expect(() => { validateLogPage({ ...page, nextOffset: 10 }, file, 10); }).toThrow("repeated");
    expect(() => { validateLogPage(page, file, 10, "c".repeat(64)); }).toThrow("changed");
    expect(() => { validateLogPage({ ...page, content: "abcdef", offset: 0, nextOffset: 4, totalBytes: 8 }, file, 0); }).toThrow("skipped bytes");
    expect(() => { validateLogPage({ ...page, totalBytes: 4_000_001 }, file, 10); }).toThrow("limits");
    expect(() => { validateLogPage(page, file, 10, page.revision, 31); }).toThrow("changed");
    expect(() => { validateLogPage({ ...page, content: "é", offset: 0, nextOffset: 2, totalBytes: 3 }, file, 0); }).not.toThrow();
    expect(() => { validateLogPage({ ...page, content: "é", offset: 0, nextOffset: 1, totalBytes: 3 }, file, 0); }).toThrow("skipped bytes");
    expect(() => { validateLogPage({ ...page, file: { ...file, ref: "stdout" } }, file, 10); }).toThrow();
  });
  it("validates scoped history replies and keeps owner errors distinct from empty", async () => {
    const signal = new AbortController().signal;
    const read = () => Promise.resolve({ owner: "reflex", principal: "p", stack: "s", routineId: "other", executionOwner: "cortex-process", records: [], complete: true, nextCursor: null });
    const failure = await readEvidence("removed", null, signal, read).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(String(failure)).toContain("inconsistent");
    const unavailable = await readEvidence(null, null, signal, () => Promise.reject(new Error("Owner unavailable"))).catch((error: unknown) => error);
    expect(String(unavailable)).toContain("Owner unavailable");
  });
  it("assembles only complete bounded attachment pages and refuses changed/repeated/oversized downloads", async () => {
    const calls: string[] = []; const signal = new AbortController().signal;
    const response = (body: string, next: string, revision = "b".repeat(64), total = 6) => new Response(body, { status: next ? 206 : 200, headers: { "X-Audit-Revision": revision, "X-Next-Offset": next, "X-Total-Bytes": String(total) } });
    const read = (url: string) => { calls.push(url); return Promise.resolve(url.includes("offset=3") ? response("def", "") : response("abc", "3")); };
    expect(await (await downloadLog(observed, file, signal, read)).text()).toBe("abcdef");
    expect(calls[1]).toContain("revision="); expect(calls.every((url) => url.includes("download=1"))).toBe(true);
    const cases: { read: (url: string) => Promise<Response>; message: string }[] = [
      { read: (url) => Promise.resolve(url.includes("offset=3") ? response("def", "", "c".repeat(64)) : response("abc", "3")), message: "changed" },
      { read: () => Promise.resolve(response("abc", "0")), message: "repeated" },
      { read: () => Promise.resolve(response("abc", "3", "b".repeat(64), 4_000_001)), message: "too large" },
      { read: () => Promise.resolve(new Response("Unavailable", { status: 409 })), message: "Restart" },
    ];
    for (const scenario of cases) {
      const failure = await downloadLog(observed, file, signal, scenario.read).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(Error); expect(String(failure)).toContain(scenario.message);
    }
  });
  it("restores internal workspace navigation without replacing the two page tabs", () => {
    const route = readRoutinesLocation("?routines=workspace&routine=removed&routine-workspace=executions");
    expect(route?.workspace).toBe("executions");
    expect(routinesSearch("?unrelated=1", route)).toContain("routine-workspace=executions");
    expect(renderToStaticMarkup(<RoutineEvidenceList routineId={null} active={false} />)).toContain("Failed executions only");
  });
});
