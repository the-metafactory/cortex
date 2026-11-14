import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { DeskRuntime } from "../desk/compose";
import { MAX_INSTRUCTION } from "../desk/handoff";
import { acceptTask, discardTask, handTask, NOT_SET_UP, previewHandoff, retryTask, type HandoffDeps, type TaskHandoffResult } from "../desk/task-handoff";
import { expireTaskHandoffs } from "../desk/task-handoff-store";
import { fail, noStore } from "./desk-mail";

const taskId = z.string().min(1).max(300);
const agent = z.string().regex(/^[a-z][a-z0-9-]*$/).max(64);
const instruction = z.string().max(MAX_INSTRUCTION);

const TaskHandoffRequestSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("preview"), taskId, agent: agent.optional(), instruction: instruction.optional() }).strict(),
  z.object({ action: z.literal("hand"), requestId: z.uuid(), taskId, agent, instruction: instruction.optional(), briefHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
  z.object({ action: z.literal("retry"), requestId: z.uuid(), id: z.uuid() }).strict(),
  z.object({ action: z.literal("discard"), id: z.uuid() }).strict(),
  z.object({ action: z.literal("accept"), id: z.uuid(), done: z.boolean(), requestId: z.uuid() }).strict(),
]);

export interface DeskTaskHandoffDeps {
  now?: () => number;
  newId?: () => string;
}

/**
 * POST {action: "preview", taskId, agent?, instruction?} returns the exact brief, its hash and what leaves the Desk;
 * {action: "hand", requestId, taskId, agent, instruction?, briefHash} publishes it to the agent over the local bus;
 * {action: "retry", requestId, id}, {action: "discard", id} and {action: "accept", id, done, requestId} act on one
 * hand-off. The rebind and identity gates in handleApi run before this handler. Task fields come from the Balance
 * store, never from the page.
 */
export async function handleDeskTaskHandoff(req: Request, db: Database, runtime: DeskRuntime | undefined, deps: DeskTaskHandoffDeps = {}): Promise<Response> {
  if (req.method !== "POST") return new Response(null, { status: 405, headers: { Allow: "POST" } });
  const desk = runtime?.options;
  if (!desk?.enabled) return fail(409, "The Desk is turned off on this stack.");
  const parsed = TaskHandoffRequestSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return fail(400, "An action and its fields are required: a task id to preview or hand, or a hand-off id to act on.");
  const dispatch = desk.dispatch;
  const bus = runtime?.dispatch;
  if (!dispatch || !bus) return fail(409, NOT_SET_UP);
  const now = (deps.now ?? Date.now)();
  expireTaskHandoffs(db, dispatch, now);
  const handoff: HandoffDeps = { db, desk: { ...desk, dispatch }, bus, now, newId: deps.newId ?? randomUUID };
  const body = parsed.data;
  switch (body.action) {
    case "preview": {
      const previewed = previewHandoff(db, handoff.desk, body);
      return previewed.ok ? Response.json(previewed, { headers: noStore }) : fail(previewed.status, previewed.error);
    }
    case "hand":
      return answer(await handTask(body, handoff));
    case "retry":
      return answer(await retryTask(body, handoff));
    case "discard":
      return answer(discardTask(db, dispatch, body.id, now));
    case "accept":
      return answer(await acceptTask(body, handoff));
  }
}

function answer(result: TaskHandoffResult): Response {
  return result.ok ? Response.json(result, { headers: noStore }) : fail(result.status, result.error);
}
