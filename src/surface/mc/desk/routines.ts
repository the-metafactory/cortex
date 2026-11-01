import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { validateSteps } from "pulse";
import { z } from "zod";
import type { DeskProposal } from "./ask";
import { spawnWithStdin } from "./create";
import { routineSchedule } from "./routine-schedule";
import { requireRoutineCapabilities, type RoutineCapabilities } from "./routine-providers";
import { routineStepLabels } from "./routine-steps";
import { PendingRoutineSchema, RoutineHistorySchema, RoutineSchema, RoutineRefusal, RoutineWriteFailure, reflexCommand, runRoutineCommand, type RoutineOptions, type RoutineRunner, type RoutineView } from "./routine-command";
import { checkRoutineOperation, claimRoutineOperation, finishRoutineOperation, pendingRoutineOperations, readRoutineOperation, readRoutineProposal, routineConfigHash, routineOperationBinding, saveRoutineProposal, type RoutineAction, type LegacyRoutineAction, type RoutineProposal, type RoutineResult } from "./routine-store";
import { actOnRoutineSchedule, reconcileSchedule } from "./routine-schedule-editor";

const ComposerReply = z.discriminatedUnion("status", [
  z.object({ status: z.literal("complete"), yaml: z.string().min(1).max(262144), summary: z.string().optional() }),
  z.object({ status: z.literal("no-match"), message: z.string() }),
  z.object({ status: z.literal("invalid"), findings: z.array(z.object({ message: z.string() })) }),
]);
const FlowDocument = z.object({ name: z.string().min(1), actions: z.array(z.unknown()).min(1), input: z.record(z.string(), z.unknown()).optional() });
const UNKNOWN = "Reflex has not confirmed the result. Refresh the Desk and retry this same action; it will not be sent twice.";
const failure = (error: unknown): string => error instanceof Error ? error.message : String(error);

export async function buildRoutineCard(db: Database, text: string, options: RoutineOptions | undefined, now: number, run: RoutineRunner = spawnWithStdin, capabilities?: RoutineCapabilities): Promise<DeskProposal> {
  const blocked = (problem: string): DeskProposal => ({ kind: "routine", label: "Routine", fields: { title: text }, problem, unwritable: true, via: "rules" });
  if (!options) return blocked("Routines are not set up on this stack.");
  const schedule = routineSchedule(text);
  if (typeof schedule === "string") return blocked(schedule);
  try {
    const result = await runRoutineCommand(run, [...options.composer, "--request", schedule.request, "--json"], options.timeoutSeconds * 1000);
    const reply = ComposerReply.parse(JSON.parse(result.stdout));
    if (reply.status === "no-match") return blocked(reply.message);
    if (reply.status === "invalid") return blocked(reply.findings.map((f) => f.message).join("; ") || "The composer could not produce a valid flow.");
    if (result.code !== 0) return blocked("The composer did not complete successfully.");
    const flow = FlowDocument.parse(parseYaml(reply.yaml));
    requireRoutineCapabilities(validateSteps(flow.actions), capabilities);
    const id = randomUUID();
    const proposal: RoutineProposal = {
      id, routineId: `desk-${id}`, title: schedule.request, request: schedule.request,
      schedule: schedule.expression, words: schedule.words, timezone: schedule.clock === "elapsed" ? "UTC" : options.timeZone,
      yaml: flow.input ? reply.yaml : `${reply.yaml}\n${stringifyYaml({ input: { request: schedule.request, scenario: schedule.request, text: schedule.request } })}`,
      steps: routineStepLabels(validateSteps(flow.actions)),
      configHash: routineConfigHash(options), createdAt: now,
    };
    saveRoutineProposal(db, proposal);
    return { kind: "routine", label: "Routine", fields: { proposalId: id, title: proposal.title, schedule: schedule.clock === "elapsed" ? proposal.words : `${proposal.words} (${proposal.timezone})`, steps: proposal.steps }, via: "rules" };
  } catch (error) {
    return blocked(`The routine could not be prepared: ${failure(error)}`);
  }
}

export async function readRoutines(db: Database, options: RoutineOptions, run: RoutineRunner = spawnWithStdin): Promise<RoutineView> {
  const reads = { ...options, timeoutSeconds: options.readTimeoutSeconds };
  try {
    const [installed, pending, history] = await Promise.all([
      reflexCommand(reads, ["routine", "list"], z.array(RoutineSchema), run),
      reflexCommand(reads, ["pending"], z.array(PendingRoutineSchema), run),
      reflexCommand(reads, ["history", "--limit", "200"], z.array(RoutineHistorySchema), run),
    ]);
    const selected = installed.filter((r) => r.target === options.target);
    const ids = new Set(selected.map((r) => r.id));
    for (const operation of pendingRoutineOperations(db, options)) {
      if (operation.action === "schedule") {
        const confirmed = await reconcileSchedule(options, operation, run);
        if (confirmed) finishRoutineOperation(db, operation.requestId, confirmed);
        continue;
      }
      const proposal = operation.action === "install" ? readRoutineProposal(db, operation.target) : null;
      const confirmed = reconcileState(options, operation, proposal, { installed, history });
      if (confirmed) finishRoutineOperation(db, operation.requestId, confirmed);
    }
    return {
      changes: pendingRoutineOperations(db, options),
      installed: selected.map((r) => {
        const proposal = readRoutineProposal(db, r.id, "routine_id");
        return { ...r, title: proposal?.title ?? r.id.replaceAll(/[-_]/g, " "), words: proposal?.words ?? `${r.schedule} (${r.timezone ?? "timezone not specified"})` };
      }),
      pending: pending.filter((p) => ids.has(p.blueprintId)),
      done: history.filter((h) => h.outcome === "fired" && h.resolutionOf === null && selected.some((r) => r.id === h.blueprintId && r.policy === "auto")).slice(0, 10).map((h) => ({ routineId: h.blueprintId, title: readRoutineProposal(db, h.blueprintId, "routine_id")?.title ?? h.blueprintId.replaceAll(/[-_]/g, " "), decisionId: h.decisionId, at: h.at })),
    };
  } catch (error) {
    return { installed: [], pending: [], done: [], changes: pendingRoutineOperations(db, options), error: `Routines could not be read: ${failure(error)}` };
  }
}

interface RoutineState { installed: z.infer<typeof RoutineSchema>[]; history: z.infer<typeof RoutineHistorySchema>[] }

function reconcileState(options: RoutineOptions, request: LegacyRoutineAction, proposal: RoutineProposal | null, state: RoutineState): RoutineResult | null {
  if (request.action === "approve" || request.action === "deny") {
    const resolution = state.history.find((h) => h.resolutionOf === request.target);
    if (!resolution) return null;
    if (request.action === "deny" && resolution.outcome === "denied") return { ok: true, message: "Routine fire denied." };
    if (request.action === "approve" && resolution.outcome === "fired") return { ok: true, message: "Routine fire approved and dispatched." };
    return { ok: false, error: `This fire ended as ${resolution.outcome}${resolution.reason ? `: ${resolution.reason}` : "."}` };
  }
  const routine = state.installed.find((r) => r.id === (proposal?.routineId ?? request.target));
  if (request.action === "remove") return routine ? null : { ok: true, message: "Routine removed." };
  if (routine?.target !== options.target) return null;
  if (request.action === "install") return routine.schedule === proposal?.schedule && routine.timezone === proposal.timezone && routine.policy === "approval"
    ? { ok: true, message: "Routine installed. Each fire will ask you first." } : null;
  if (routine.policy === (request.action === "auto" ? "auto" : "approval")) return { ok: true, message: request.action === "auto" ? "I will handle this routine myself." : "This routine will ask you before each run." };
  return null;
}

async function reconcile(options: RoutineOptions, request: LegacyRoutineAction, proposal: RoutineProposal | null, run: RoutineRunner): Promise<RoutineResult | null> {
  const reads = { ...options, timeoutSeconds: options.readTimeoutSeconds };
  const state = request.action === "approve" || request.action === "deny"
    ? { installed: [], history: await reflexCommand(reads, ["history", "--limit", "200"], z.array(RoutineHistorySchema), run) }
    : { installed: await reflexCommand(reads, ["routine", "list"], z.array(RoutineSchema), run), history: [] };
  return reconcileState(options, request, proposal, state);
}

class RoutinePreparationFailure extends Error {}

async function executeRoutineMutation(options: RoutineOptions, request: LegacyRoutineAction, proposal: RoutineProposal | null, run: RoutineRunner): Promise<void> {
  let temporary: string | undefined;
  let args: string[];
  try {
    if (proposal) {
      temporary = await mkdtemp(join(tmpdir(), "desk-routine-"));
      const flow = join(temporary, "flow.yaml");
      await writeFile(flow, proposal.yaml, { mode: 0o600, flag: "wx" });
      args = ["routine", "add", "--id", proposal.routineId, "--name", proposal.title.slice(0, 300), "--schedule", proposal.schedule, "--timezone", proposal.timezone, "--target", options.target, "--policy", "approve", "--payload", JSON.stringify({ input: { request: proposal.request, scenario: proposal.request, text: proposal.request } }), "--flow-file", flow];
    } else if (request.action === "approve" || request.action === "deny") args = [request.action, request.target];
    else if (request.action === "remove") args = ["routine", "remove", request.target];
    else args = ["routine", "set-policy", request.target, request.action === "auto" ? "auto" : "approve"];
  } catch (error) {
    let cleanup = "";
    if (temporary) {
      try { await rm(temporary, { recursive: true, force: true }); }
      catch (cleanupError) { cleanup = ` Temporary-file cleanup also failed: ${failure(cleanupError)}`; }
    }
    throw new RoutinePreparationFailure(`Reflex was not called because the flow input could not be prepared: ${failure(error)}${cleanup}`);
  }
  const outcome = await reflexCommand(options, args, z.unknown(), run).then(
    () => ({ kind: "confirmed" as const }),
    (error: unknown) => ({ kind: "failed" as const, error }),
  );
  if (temporary) {
    try { await rm(temporary, { recursive: true, force: true }); }
    catch (cleanupError) {
      if (outcome.kind === "failed") {
        process.stderr.write(`${JSON.stringify({ event: "desk.routine.temporary-cleanup-failed", reason: failure(cleanupError) })}\n`);
        throw outcome.error;
      }
      throw cleanupError;
    }
  }
  if (outcome.kind === "failed") throw outcome.error;
}

async function reconcileAndFinish(db: Database, options: RoutineOptions, request: LegacyRoutineAction, proposal: RoutineProposal | null, run: RoutineRunner): Promise<RoutineResult | null> {
  const confirmed = await reconcile(options, request, proposal, run);
  return confirmed ? finishRoutineOperation(db, request.requestId, confirmed) : null;
}

export async function actOnRoutine(db: Database, options: RoutineOptions, request: RoutineAction, now: number, run: RoutineRunner = spawnWithStdin, capabilities?: RoutineCapabilities): Promise<RoutineResult> {
  if (request.action === "schedule") return actOnRoutineSchedule(db, options, request, run);
  const proposal = request.action === "install" ? readRoutineProposal(db, request.target) : null;
  if (request.action === "install" && (proposal?.configHash !== routineConfigHash(options))) return { ok: false, error: "Prepare this routine again before confirming it." };
  const binding = routineOperationBinding(options, request);
  const prior = readRoutineOperation(db, request.requestId);
  if (prior) return checkRoutineOperation(db, request.requestId, binding, prior, () => reconcile(options, request, proposal, run), UNKNOWN);
  const execution = proposal ?? (request.action === "auto" ? readRoutineProposal(db, request.target, "routine_id") : null);
  if (request.action === "auto" && !execution) return { ok: false, error: "The Desk cannot verify the execution capabilities of a routine authored elsewhere. Stop and Remove remain available." };
  if (execution) {
    try { requireRoutineCapabilities(validateSteps(FlowDocument.parse(parseYaml(execution.yaml)).actions), capabilities); }
    catch (error) { return { ok: false, error: failure(error) }; }
  }
  if (proposal && now - proposal.createdAt > 86_400_000) return { ok: false, error: "This proposal has expired. Prepare the routine again." };
  const view = await readRoutines(db, options, run);
  if (view.error) return { ok: false, error: view.error };
  const resource = proposal?.routineId ?? view.pending.find((p) => p.decisionId === request.target)?.blueprintId ?? request.target;
  if (request.action !== "install") {
    const present = request.action === "approve" || request.action === "deny" ? view.pending.some((p) => p.decisionId === request.target) : view.installed.some((r) => r.id === request.target);
    if (!present) return { ok: false, error: "That routine or pending fire is no longer available. Refresh the Desk." };
  } else if (view.installed.some((r) => r.id === resource)) {
    return { ok: false, error: "This proposal is already installed." };
  }
  const claimed = claimRoutineOperation(db, request.requestId, binding, resource);
  if (!claimed) return { ok: false, error: "Another action for this routine is still awaiting confirmation. Retry that action first.", uncertain: true };
  try {
    await executeRoutineMutation(options, request, proposal, run);
    const confirmed = await reconcileAndFinish(db, options, request, proposal, run);
    if (confirmed) return confirmed;
    return { ok: false, error: UNKNOWN, uncertain: true };
  } catch (error) {
    if (error instanceof RoutinePreparationFailure) {
      db.query("DELETE FROM desk_routine_operations WHERE request_id = ? AND result IS NULL").run(request.requestId);
      return { ok: false, error: error.message };
    }
    if (error instanceof RoutineRefusal) {
      const confirmed = await reconcileAndFinish(db, { ...options, timeoutSeconds: options.readTimeoutSeconds }, request, proposal, run).catch(() => null);
      if (confirmed) return confirmed;
      db.query("DELETE FROM desk_routine_operations WHERE request_id = ? AND result IS NULL").run(request.requestId);
      return { ok: false, error: error.message };
    }
    try {
      const confirmed = await reconcileAndFinish(db, options, request, proposal, run);
      if (confirmed) return confirmed;
      if (error instanceof RoutineWriteFailure && request.action === "remove") {
        db.query("DELETE FROM desk_routine_operations WHERE request_id = ? AND result IS NULL").run(request.requestId);
        return { ok: false, error: `Reflex could not finish removing this routine. Retry Remove after repairing the cause: ${error.message}` };
      }
    } catch {
      return { ok: false, error: `${UNKNOWN} ${failure(error)}`, uncertain: true };
    }
    return { ok: false, error: `${UNKNOWN} ${failure(error)}`, uncertain: true };
  }
}
