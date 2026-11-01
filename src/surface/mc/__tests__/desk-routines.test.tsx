import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { z } from "zod";
import type { Database } from "bun:sqlite";
import { readFile, mkdtemp, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { initDatabase } from "../db/init";
import { buildRoutineCard, actOnRoutine, readRoutines } from "../desk/routines";
import { readRoutineProposal } from "../desk/routine-store";
import type { InstalledRoutine, PendingRoutine, RoutineOptions, RoutineRunner } from "../desk/routine-command";
import { routineRequest, routineSchedule } from "../desk/routine-schedule";
import { handleDeskAsk, handleDeskCreate } from "../api/desk-ask";
import { HandledLedger } from "../desk/actions";
import type { DeskRuntime } from "../desk/compose";
import { ProposalCard } from "../dashboard-v2/components/desk-proposal";
import { RoutinesSection, RoutineDone } from "../dashboard-v2/components/desk-routines";
import { RoutineReadLoop } from "../desk/routine-read";
import { startServer } from "../server";
import { DEFAULT_CONFIG } from "../config";
import { requireRoutineCapabilities, localRoutineCapabilities } from "../desk/routine-providers";
import { validateSteps } from "pulse";
import type { AgentPresenceSnapshotRecord } from "../api/agents";
import { routineStepLabels } from "../desk/routine-steps";

const OPTIONS: RoutineOptions = { composer: ["composer"], reflex: ["reflex"], target: "@example/pulse-flow", timeZone: "Europe/Zurich", timeoutSeconds: 10, readTimeoutSeconds: 1 };
const YAML = "name: F_READ\nactions:\n  - A_EXTRACT_URLS # sovereignty: D, residency: CH\n";
const NOW = Date.parse("2026-10-31T12:00:00Z");
const answer = (value: unknown, code = 0) => ({ code, stdout: JSON.stringify(value), stderr: "" });
const post = (body: unknown): Request => new Request("http://localhost/api/desk", { method: "POST", body: JSON.stringify(body) });

function seam() {
  const routines: InstalledRoutine[] = [];
  const pending: PendingRoutine[] = [];
  const history: { decisionId: string; blueprintId: string; outcome: string; reason: string | null; resolutionOf: string | null; at: string }[] = [];
  const mutations: string[][] = [];
  const reads: string[][] = [];
  let supplied = "";
  let refusal = false;
  let lostReply = false;
  let unavailable = false;
  let writeUncertain = false;
  let stallReads = false;
  let stallAfterWrite = false;
  const readTimeouts: number[] = [];
  let composer: unknown = { status: "complete", yaml: YAML };
  const run: RoutineRunner = async (argv, _stdin, timeoutMs) => {
    if (argv[0] === "composer") return answer(composer);
    if (unavailable) throw new Error("transport unavailable");
    const args = argv.slice(1);
    const [kind, verb] = args;
    if ((kind === "routine" && verb === "list") || kind === "pending" || kind === "history") reads.push(args);
    if (stallReads && ((kind === "routine" && verb === "list") || kind === "history")) { readTimeouts.push(timeoutMs); return new Promise<never>(() => undefined); }
    if (kind === "routine" && verb === "list") return answer(routines);
    if (kind === "pending") return answer(pending);
    if (kind === "history") return answer(history);
    mutations.push(args);
    if (writeUncertain) return answer({ error: { code: "write-uncertain", message: "Filesystem operation interrupted." } }, 1);
    if (refusal) return answer({ error: { code: "invalid-input", message: "Target discovery is unavailable." } }, 1);
    const flag = (name: string): string => args[args.indexOf(name) + 1] ?? "";
    if (kind === "routine" && verb === "add") {
      supplied = await readFile(flag("--flow-file"), "utf8");
      routines.push({ id: flag("--id"), schedule: flag("--schedule"), timezone: flag("--timezone"), policy: "approval", target: flag("--target"), file: "/owned/routine.yaml", lastDecision: null });
    } else if (kind === "routine" && verb === "set-policy") {
      const row = routines.find((r) => r.id === args[2]);
      if (row) row.policy = args[3] === "auto" ? "auto" : "approval";
    } else if (kind === "routine" && verb === "remove") routines.splice(0);
    else if (kind === "approve" || kind === "deny") {
      const fire = pending.find((p) => p.decisionId === verb);
      if (fire) {
        history.unshift({ decisionId: "resolution", blueprintId: fire.blueprintId, resolutionOf: fire.decisionId, outcome: kind === "approve" ? "fired" : "denied", at: new Date(NOW).toISOString(), reason: null });
        pending.splice(pending.indexOf(fire), 1);
      }
    }
    if (lostReply) { unavailable = true; throw new Error("reply lost after daemon applied mutation"); }
    if (stallAfterWrite) stallReads = true;
    return answer({ id: "receipt" });
  };
  return { run, routines, pending, history, mutations, reads, readTimeouts, supplied: () => supplied, stallAfterWrite: () => { stallAfterWrite = true; }, refuse: (v: boolean) => { refusal = v; }, uncertain: () => { writeUncertain = true; }, lose: () => { lostReply = true; }, recover: () => { unavailable = false; lostReply = false; writeUncertain = false; stallReads = false; stallAfterWrite = false; }, compose: (value: unknown) => { composer = value; } };
}

describe("Desk routines", () => {
  let db: Database;
  beforeEach(() => { db = initDatabase(":memory:"); });
  afterEach(() => { db.close(); });

  it("reads recurring schedules in words and refuses ambiguous or invalid times", () => {
    expect(routineSchedule("every Friday at 17:00, extract URLs")).toEqual({ clock: "wall", expression: "0 17 * * 5", words: "Every Friday at 17:00", request: "extract URLs" });
    expect(routineSchedule("every 2 minutes, extract URLs")).toMatchObject({ expression: "*/2 * * * *" });
    expect(routineSchedule("every weekday at 9am, extract URLs")).toMatchObject({ expression: "0 9 * * 1-5" });
    expect(routineRequest("every 2 minutes, extract URLs")).toBe(true);
    expect(typeof routineSchedule("every day, extract URLs")).toBe("string");
    expect(typeof routineSchedule("every Friday at 25:00, extract URLs")).toBe("string");
    expect(typeof routineSchedule("every 59 minutes, read")).toBe("string");
    expect(typeof routineSchedule("every 23 hours, read")).toBe("string");
    expect(routineSchedule("every 30 minutes, read")).toMatchObject({ expression: "*/30 * * * *" });
    expect(routineSchedule("every 12 hours, read")).toMatchObject({ expression: "0 */12 * * *" });
  });

  it("stores a real composer preview and preserves annotations through Reflex transient input", async () => {
    const s = seam();
    const card = await buildRoutineCard(db, "every Friday at 17:00, extract URLs from https://example.com", OPTIONS, NOW, s.run);
    expect(card).toMatchObject({ kind: "routine", fields: { schedule: "Every Friday at 17:00 (Europe/Zurich)", steps: ["extract urls"] } });
    const id = String(card.fields.proposalId);
    const result = await actOnRoutine(db, OPTIONS, { action: "install", requestId: "install-1", target: id }, NOW, s.run);
    expect(result.ok).toBe(true);
    expect(s.supplied().startsWith(YAML)).toBe(true);
    expect(s.supplied()).toContain("input:");
    expect(s.mutations[0]).toContain("approve");
    expect(s.mutations[0]?.join(" ")).not.toContain("bash");
    expect(await actOnRoutine(db, OPTIONS, { action: "install", requestId: "install-1", target: id }, NOW, s.run)).toEqual(result);
    expect(s.mutations).toHaveLength(1);
  });

  it("binds elapsed schedules to UTC and named clock times to the configured local timezone", async () => {
    const s = seam();
    const elapsed = await buildRoutineCard(db, "every 12 hours, read", OPTIONS, NOW, s.run);
    expect(elapsed.fields.schedule).toBe("Every 12 hours");
    expect(readRoutineProposal(db, String(elapsed.fields.proposalId))?.timezone).toBe("UTC");
    const clock = await buildRoutineCard(db, "every day at 17:00, read", OPTIONS, NOW, s.run);
    expect(clock.fields.schedule).toBe("Every day at 17:00 (Europe/Zurich)");
    expect(readRoutineProposal(db, String(clock.fields.proposalId))?.timezone).toBe("Europe/Zurich");
  });

  it("shows missing-capability refusal with no Confirm and never saves a runnable proposal", async () => {
    const s = seam();
    s.compose({ status: "no-match", message: "The gap is a missing calendar capability." });
    const card = await buildRoutineCard(db, "every minute, create a calendar", OPTIONS, NOW, s.run);
    expect(card.unwritable).toBe(true);
    const html = renderToStaticMarkup(<ProposalCard proposal={card} said="request" maps={[]} now={NOW} busy={false} onConfirm={() => undefined} onCancel={() => undefined} onGoto={() => undefined} onFieldsChange={() => undefined} />);
    expect(html).toContain("missing calendar capability");
    expect(html).not.toContain(">Confirm<");
    expect(db.query("SELECT * FROM desk_routine_proposals").all()).toHaveLength(0);
    expect(s.mutations).toHaveLength(0);
  });

  it("rejects malformed composer output unknown steps and configuration changes", async () => {
    const s = seam();
    s.compose({ status: "complete", yaml: "name: F_BAD\nactions: [{invented: 1}]" });
    expect((await buildRoutineCard(db, "every minute, read", OPTIONS, NOW, s.run)).unwritable).toBe(true);
    s.compose({ status: "complete", yaml: YAML });
    const card = await buildRoutineCard(db, "every minute, read", OPTIONS, NOW, s.run);
    expect((await actOnRoutine(db, { ...OPTIONS, target: "@other/pulse-flow" }, { action: "install", target: String(card.fields.proposalId), requestId: "changed-config" }, NOW, s.run)).ok).toBe(false);
    expect(s.mutations).toHaveLength(0);
  });

  it("binds Confirm to the saved proposal rather than forged browser fields", async () => {
    const s = seam();
    const runtime: DeskRuntime = { options: { enabled: true, displayName: "", topN: 5, rangerUrl: "", areas: [], sources: [], routines: OPTIONS }, ledger: new HandledLedger() };
    const response = await handleDeskAsk(post({ text: "every minute, extract URLs" }), runtime, { now: () => NOW, runRoutine: s.run }, db);
    const { proposal } = z.object({ proposal: z.object({ fields: z.object({ proposalId: z.uuid() }) }) }).parse(await response.json());
    const create = await handleDeskCreate(post({ kind: "routine", requestId: "forged-fields", fields: { ...proposal.fields, yaml: "forged", schedule: "* * * * *", target: "@other/process" } }), db, runtime, { now: () => NOW, runRoutine: s.run });
    expect(create.status).toBe(200);
    expect(s.supplied()).not.toContain("forged");
    const forged = await handleDeskCreate(post({ kind: "routine", requestId: "forged-preview", fields: { proposalId: crypto.randomUUID() } }), db, runtime, { runRoutine: s.run });
    expect(forged.status).toBe(409);
    expect(s.mutations).toHaveLength(1);
  });

  it("recovers from definite discovery refusal and still permits Stop and Remove", async () => {
    const s = seam();
    const card = await buildRoutineCard(db, "every minute, read", OPTIONS, NOW, s.run);
    const id = String(card.fields.proposalId);
    const install = { action: "install", target: id, requestId: "install-recovery" } as const;
    s.refuse(true);
    expect(await actOnRoutine(db, OPTIONS, install, NOW, s.run)).toEqual({ ok: false, error: "Target discovery is unavailable." });
    s.refuse(false);
    expect((await actOnRoutine(db, OPTIONS, install, NOW, s.run)).ok).toBe(true);
    const routine = readRoutineProposal(db, id)?.routineId ?? "";
    s.refuse(true);
    const promote = { action: "auto", target: routine, requestId: "promote-recovery" } as const;
    expect((await actOnRoutine(db, OPTIONS, promote, NOW, s.run)).ok).toBe(false);
    s.refuse(false);
    expect((await actOnRoutine(db, OPTIONS, promote, NOW, s.run)).ok).toBe(true);
    expect((await actOnRoutine(db, OPTIONS, { action: "stop", target: routine, requestId: "stop-recovery" }, NOW, s.run)).ok).toBe(true);
    expect((await actOnRoutine(db, OPTIONS, { action: "remove", target: routine, requestId: "remove-recovery" }, NOW, s.run)).ok).toBe(true);
    expect(s.routines).toHaveLength(0);
  });

  it("durably reconciles a lost install reply without issuing another add", async () => {
    const s = seam();
    const card = await buildRoutineCard(db, "every minute, read", OPTIONS, NOW, s.run);
    const request = { action: "install", target: String(card.fields.proposalId), requestId: "uncertain-install" } as const;
    s.lose();
    expect(await actOnRoutine(db, OPTIONS, request, NOW, s.run)).toMatchObject({ ok: false, uncertain: true });
    s.recover();
    const readsBefore = s.reads.length;
    const view = await readRoutines(db, OPTIONS, s.run);
    expect(s.reads.length - readsBefore).toBe(3);
    expect(view.changes).toHaveLength(0);
    expect((await actOnRoutine(db, OPTIONS, request, NOW, s.run)).ok).toBe(true);
    expect(s.mutations).toHaveLength(1);
    expect((await actOnRoutine(db, OPTIONS, { ...request, action: "remove" }, NOW, s.run)).ok).toBe(false);
  });

  it("does not treat a known partial write as a validation refusal or retry its install", async () => {
    const s = seam();
    const card = await buildRoutineCard(db, "every minute, read", OPTIONS, NOW, s.run);
    const request = { action: "install", target: String(card.fields.proposalId), requestId: "partial-install" } as const;
    s.uncertain();
    expect(await actOnRoutine(db, OPTIONS, request, NOW, s.run)).toMatchObject({ ok: false, uncertain: true });
    s.recover();
    expect(await actOnRoutine(db, OPTIONS, request, NOW, s.run)).toMatchObject({ ok: false, uncertain: true });
    expect((await readRoutines(db, OPTIONS, s.run)).changes).toHaveLength(1);
    expect(s.mutations).toHaveLength(1);
  });

  it("releases a pre-command claim after a real temporary-directory failure and recovers on retry", async () => {
    const s = seam();
    const card = await buildRoutineCard(db, "every minute, read", OPTIONS, NOW, s.run);
    const request = { action: "install", target: String(card.fields.proposalId), requestId: "temporary-failure" } as const;
    const directory = await mkdtemp(join(tmpdir(), "routine-readonly-"));
    const previous = process.env.TMPDIR;
    try {
      await chmod(directory, 0o500);
      process.env.TMPDIR = directory;
      const failed = await actOnRoutine(db, OPTIONS, request, NOW, s.run);
      expect(failed.ok).toBe(false);
      if (!failed.ok) expect(failed.uncertain).toBeUndefined();
      expect(s.mutations).toHaveLength(0);
      expect(db.query("SELECT * FROM desk_routine_operations WHERE result IS NULL").all()).toHaveLength(0);
      await chmod(directory, 0o700);
      if (previous === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = previous;
      expect((await actOnRoutine(db, OPTIONS, request, NOW, s.run)).ok).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = previous;
      await chmod(directory, 0o700);
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("uses short read deadlines after a successful mutation whose reconciliation stalls", async () => {
    const s = seam();
    const options = { ...OPTIONS, timeoutSeconds: 1, readTimeoutSeconds: 0.01 };
    const card = await buildRoutineCard(db, "every minute, read", options, NOW, s.run);
    const request = { action: "install", target: String(card.fields.proposalId), requestId: "stalled-reconcile" } as const;
    s.stallAfterWrite();
    expect(await actOnRoutine(db, options, request, NOW, s.run)).toMatchObject({ ok: false, uncertain: true });
    expect(s.readTimeouts).toEqual([10, 10]);
    s.recover();
    expect((await actOnRoutine(db, options, request, NOW, s.run)).ok).toBe(true);
    expect(s.mutations).toHaveLength(1);
  });

  it("permits safe removal recovery after an explicit partial-write reply while retaining the activation", async () => {
    const s = seam();
    const card = await buildRoutineCard(db, "every minute, read", OPTIONS, NOW, s.run);
    await actOnRoutine(db, OPTIONS, { action: "install", target: String(card.fields.proposalId), requestId: "install-removal" }, NOW, s.run);
    const request = { action: "remove", target: s.routines[0]?.id ?? "", requestId: "partial-remove" } as const;
    s.uncertain();
    const result = await actOnRoutine(db, OPTIONS, request, NOW, s.run);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("Retry Remove");
    s.recover();
    expect((await actOnRoutine(db, OPTIONS, request, NOW, s.run)).ok).toBe(true);
    expect(s.routines).toHaveLength(0);
  });

  it("approves and denies only the configured target's pending fires and reports automatic dispatch separately", async () => {
    const s = seam();
    const card = await buildRoutineCard(db, "every minute, read", OPTIONS, NOW, s.run);
    await actOnRoutine(db, OPTIONS, { action: "install", target: String(card.fields.proposalId), requestId: "install-pending" }, NOW, s.run);
    const id = s.routines[0]?.id ?? "";
    const fire = (decisionId: string): PendingRoutine => ({ decisionId, blueprintId: id, matchedAt: new Date(NOW).toISOString(), expiresAt: new Date(NOW + 60000).toISOString(), impulseSummary: "schedule" });
    s.pending.push(fire("fire-approve"), fire("fire-deny"));
    expect((await actOnRoutine(db, OPTIONS, { action: "approve", target: "fire-approve", requestId: "approve-pending" }, NOW, s.run)).ok).toBe(true);
    expect((await actOnRoutine(db, OPTIONS, { action: "deny", target: "fire-deny", requestId: "deny-pending" }, NOW, s.run)).ok).toBe(true);
    await actOnRoutine(db, OPTIONS, { action: "auto", target: id, requestId: "auto-pending" }, NOW, s.run);
    expect((await readRoutines(db, OPTIONS, s.run)).done).toHaveLength(0);
    s.history.unshift({ decisionId: "automatic", blueprintId: id, outcome: "fired", reason: null, resolutionOf: null, at: new Date(NOW).toISOString() });
    const view = await readRoutines(db, OPTIONS, s.run);
    expect(view.done).toHaveLength(1);
    const html = renderToStaticMarkup(<RoutineDone view={view} onChanged={() => undefined} />);
    expect(html).toContain("Automatically dispatched");
    expect(html).not.toContain("completed");
    expect(renderToStaticMarkup(<RoutinesSection view={view} onChanged={() => undefined} />)).toContain("Remove");
  });

  it("bounds stalled reads separately from authoring and keeps cached Desk reads immediate", async () => {
    const options = { ...OPTIONS, timeoutSeconds: 120, readTimeoutSeconds: 0.01 };
    const never: RoutineRunner = () => new Promise(() => undefined);
    const view = await readRoutines(db, options, never);
    expect(view.error).toContain("timed out");
    const loop = new RoutineReadLoop();
    await loop.refresh(db, options, NOW, never);
    expect(loop.read(db, options, NOW).error).toContain("timed out");
    expect(loop.read(db, options, NOW).installed).toHaveLength(0);
  });

  it("guards create and every routine write through Host Origin and principal identity without step-up", async () => {
    const ctx = startServer({ ...DEFAULT_CONFIG, port: 0, governance: { principals: ["principal@example.com"] } }, db, {
      desk: { enabled: true, displayName: "", topN: 5, rangerUrl: "", areas: [], sources: [], routines: OPTIONS },
    });
    const base = `http://localhost:${ctx.server.port}`;
    const send = (path: string, email: string, origin = base): Promise<Response> => fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json", origin, "Cf-Access-Authenticated-User-Email": email }, body: "{}" });
    try {
      for (const path of ["/api/desk/create", "/api/desk/routines", "/api/desk/routine-editor"]) {
        expect((await send(path, "unlisted@example.com")).status).toBe(403);
        expect((await send(path, "principal@example.com", "https://evil.example")).status).toBe(403);
        expect((await send(path, "principal@example.com")).status).toBe(400);
      }
    } finally {
      ctx.stop(true);
    }
  });

  it("refuses a composed agent capability with no fresh local worker and checks again at Confirm", async () => {
    const s = seam();
    const yaml = "name: F_AGENT\nactions:\n  - agent: # sovereignty: A, residency: CH\n      name: derive\n      capability: compose.judgment\n      prompt: '{text}'\n      collect: result\n";
    s.compose({ status: "complete", yaml });
    const refused = await buildRoutineCard(db, "every minute, derive a result", OPTIONS, NOW, s.run);
    expect(refused.problem).toContain("No fresh online local agent provides compose.judgment");
    expect(refused.unwritable).toBe(true);
    const card = await buildRoutineCard(db, "every minute, derive a result", OPTIONS, NOW, s.run, () => new Set(["compose.judgment"]));
    expect(card.problem).toBeUndefined();
    expect(card.fields.steps).toEqual(["Ask an agent to derive"]);
    const html = renderToStaticMarkup(<ProposalCard proposal={card} said="request" maps={[]} now={NOW} busy={false} onConfirm={() => undefined} onCancel={() => undefined} onGoto={() => undefined} onFieldsChange={() => undefined} />);
    expect(html).toContain("Ask an agent to derive");
    expect(html).not.toContain("sovereignty");
    expect(html).not.toContain("compose.judgment");
    const request = { action: "install", target: String(card.fields.proposalId), requestId: "worker-disappeared" } as const;
    const result = await actOnRoutine(db, OPTIONS, request, NOW, s.run);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("compose.judgment");
    expect(s.mutations).toHaveLength(0);
  });

  it("recurses into composed flows and accepts only fresh online stack-local capability declarations", () => {
    const base: AgentPresenceSnapshotRecord = { key: "test", origin: "local", agentId: "test", nkeyPublicKey: "public", assistantName: "Test", principal: "example", stack: "default", capabilities: ["compose.judgment"], state: "online", lastSeenAt: NOW };
    expect([...localRoutineCapabilities({ getAgents: () => [base] }, NOW)]).toEqual(["compose.judgment"]);
    for (const change of [{ state: "offline" }, { lastSeenAt: NOW - 90_001 }, { origin: { kind: "foreign", principal: "other", stack: "default" } }] satisfies Partial<AgentPresenceSnapshotRecord>[]) {
      expect(localRoutineCapabilities({ getAgents: () => [{ ...base, ...change }] }, NOW).size).toBe(0);
    }
    const nested = validateSteps([{ retry: { attempts: 1, actions: [{ agent: { name: "derive", capability: "compose.judgment", prompt: "read" } }] } }]);
    expect(() => requireRoutineCapabilities(nested)).toThrow("compose.judgment");
    expect(requireRoutineCapabilities(nested, () => new Set(["compose.judgment"]))).toEqual(["compose.judgment"]);
    expect(routineStepLabels(nested)).toEqual(["Try up to 1 times: Ask an agent to derive"]);
  });
});
