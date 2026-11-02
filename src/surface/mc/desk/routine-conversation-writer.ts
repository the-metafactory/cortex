import { createHash } from "node:crypto";
import { z } from "zod";
import type { CreateRequest, CreateResult, OperationRecord, OwnerWriter, ReadbackResult } from "../../../conversations/types";
import { spawnWithStdin } from "./create";
import { reflexCommand, RoutineRefusal, RoutineSchema, type InstalledRoutine, type RoutineOptions, type RoutineRunner } from "./routine-command";

export interface RoutineWriterDeps {
  routines: () => RoutineOptions | undefined;
  run?: RoutineRunner;
}

const NOTHING = "Nothing was created.";
const SLUG_MAX = 80;
const sentence = (text: string): string => `${text.trim().replace(/[.\s]+$/, "")}.`;
const failed = (text: string): CreateResult => ({ state: "failed", error: `${sentence(text)} ${NOTHING}` });
const AddReply = z.object({ id: z.string() });
const RoutineList = z.array(RoutineSchema);

function routineSlug(name: string): string {
  const slug = name.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  if (slug.length <= SLUG_MAX) return slug;
  const cut = slug.slice(0, SLUG_MAX);
  const dash = cut.lastIndexOf("-");
  return dash > 0 ? cut.slice(0, dash) : cut;
}

const operationSuffix = (operationId: string): string => createHash("sha256").update(operationId).digest("hex").slice(0, 12);

export function conversationRoutineId(name: string, operationId: string): string {
  return [routineSlug(name), operationSuffix(operationId)].filter(Boolean).join("-");
}

const madeFor = (id: string, suffix: string): boolean => id === suffix || id.endsWith(`-${suffix}`);

export function routineAddArgs(id: string, fields: Record<string, string>): string[] {
  return ["routine", "add", "--id", id, "--name", fields.name ?? "", "--schedule", fields.schedule ?? "", "--timezone", fields.timezone ?? "", "--target", fields.target ?? "", "--payload", "{}", "--paused"];
}

const sameRoutine = (routine: InstalledRoutine, fields: Record<string, string>): boolean =>
  routine.target === fields.target && routine.schedule === fields.schedule && routine.timezone === fields.timezone && routine.paused;

export function routineWriter(deps: RoutineWriterDeps): OwnerWriter {
  const run = deps.run ?? spawnWithStdin;
  const list = (options: RoutineOptions): Promise<InstalledRoutine[]> => reflexCommand({ ...options, timeoutSeconds: options.readTimeoutSeconds }, ["routine", "list"], RoutineList, run);
  const create = async (request: CreateRequest): Promise<CreateResult> => {
    const options = deps.routines();
    if (!options) return failed("Routines are not set up on this stack");
    const { fields } = request;
    if (fields.target !== options.target) return failed(`This stack creates routines only for ${options.target}`);
    const id = conversationRoutineId(fields.name ?? "", request.operationId);
    if (request.signal.aborted) throw new Error("The conversation stopped waiting before Reflex was called.");
    try {
      const reply = await reflexCommand(options, routineAddArgs(id, fields), AddReply, run);
      if (reply.id !== id) throw new Error(`Reflex answered for routine ${reply.id} instead of ${id}.`);
      return { state: "created", canonicalId: id };
    } catch (error) {
      if (!(error instanceof RoutineRefusal)) throw error;
      const existing = (await list(options)).find(r => r.id === id);
      return existing && sameRoutine(existing, fields) ? { state: "created", canonicalId: id } : failed(error.message);
    }
  };
  const readback = async (operation: OperationRecord): Promise<ReadbackResult> => {
    const options = deps.routines();
    if (!options) return null;
    try {
      const suffix = operationSuffix(operation.operationId);
      const found = (await list(options)).find(r => madeFor(r.id, suffix));
      return found ? { found: true, canonicalId: found.id } : { found: false };
    } catch {
      return null;
    }
  };
  return { create, readback };
}
