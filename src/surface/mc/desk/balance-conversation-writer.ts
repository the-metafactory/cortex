import type { Database } from "bun:sqlite";
import { findNode, type AppState, type OutlineNode } from "../../../balance";
import type { CreateRequest, CreateResult, OperationRecord, OwnerWriter, ReadbackResult } from "../../../conversations/types";
import { BalanceCommandSchema, type BalanceCommand } from "./balance-command";
import { STALE_OUTLINE } from "./balance-outline";
import { loadBalanceState } from "./balance-store";
import type { DeskOptions } from "./compose";
import { operationUuid } from "./conversation-ids";
import { changeMyDay, loadMeta, localDay, readMyDay } from "./my-day";
import { withStudioProjection } from "./studio-my-day";
import type { StudioProjection } from "./studio-outline";

export interface BalanceWriterDeps {
  db: Database;
  desk: () => DeskOptions | undefined;
  now?: () => number;
}

const NOTHING = "Nothing was created.";
const failed = (sentence: string): CreateResult => ({ state: "failed", error: `${sentence} ${NOTHING}` });
const ownerRefusal = (error: unknown): error is Error => error instanceof Error && error.constructor === Error;

export function hasBalanceState(db: Database): boolean {
  return db.query<{ id: number }, []>("SELECT id FROM desk_balance WHERE id = 1").get() !== null;
}

const isTask = (node: OutlineNode): boolean => node.children.length === 0 && node.effort !== undefined;
const isOpenProject = (node: OutlineNode): boolean =>
  !node.id.startsWith("studio-response:") && !isTask(node) && !(node.done && node.children.length > 0);

function projectsIn(area: OutlineNode): OutlineNode[] {
  const found: OutlineNode[] = [];
  const visit = (node: OutlineNode): void => {
    for (const child of node.children) {
      if (child.done && child.children.length > 0) continue;
      if (isOpenProject(child)) found.push(child);
      visit(child);
    }
  };
  visit(area);
  return found;
}

export function balanceDestination(state: AppState, desk: DeskOptions, fields: Record<string, string>): { parent: string } | { refused: string } {
  const areaId = fields.area ?? "";
  const area = desk.areas.find(a => a.id === areaId);
  if (!area) return { refused: `${areaId} is not a configured area.` };
  const parent = `area:${area.id}`;
  const project = fields.project;
  if (!project) return { parent };
  const node = state.outline.children.find(n => n.id === parent);
  const open = node ? projectsIn(node) : [];
  const byId = open.find(p => p.id === project);
  const byTitle = open.filter(p => p.title.trim().toLowerCase() === project.toLowerCase());
  const chosen = byId ?? (byTitle.length === 1 ? byTitle[0] : undefined);
  return chosen ? { parent: chosen.id } : { refused: `That project is not open in ${area.label}.` };
}

function taskCommand(fields: Record<string, string>, parent: string, revision: number): BalanceCommand | { refused: string } {
  const due = fields.due;
  if (due && !/^\d{4}-\d{2}-\d{2}$/.test(due)) return { refused: `${due} is not a due date in the form YYYY-MM-DD.` };
  const parsed = BalanceCommandSchema.safeParse({ op: "outline-add", revision, parent, title: fields.title ?? "", kind: "task", ...(fields.note ? { note: fields.note } : {}), ...(due ? { dueDate: due } : {}) });
  if (!parsed.success) return { refused: parsed.error.issues.some(i => i.path[0] === "dueDate") ? `${due ?? ""} is not a valid due date.` : "Balance takes a title of up to 300 characters and a note of up to 10,000." };
  return parsed.data;
}

export function balanceTaskWriter(deps: BalanceWriterDeps): OwnerWriter {
  const clock = deps.now ?? Date.now;
  const add = (desk: DeskOptions, request: CreateRequest, studio: StudioProjection | undefined): CreateResult => {
    if (request.signal.aborted) throw new Error("The conversation stopped waiting before Balance was called.");
    const state = loadBalanceState(deps.db);
    if (!state) return failed("Balance has no saved outline on this stack yet.");
    const where = balanceDestination(state, desk, request.fields);
    if ("refused" in where) return failed(where.refused);
    const requestId = operationUuid(request.operationId);
    const attempt = (revision: number): string | undefined => {
      const command = taskCommand(request.fields, where.parent, revision);
      if ("refused" in command) throw new Error(command.refused);
      const now = clock();
      return changeMyDay({ db: deps.db, desk, now, date: localDay(now), requestId, command, studio }).outlineId;
    };
    let outlineId: string | undefined;
    try {
      try { outlineId = attempt(loadMeta(deps.db).revision); }
      catch (error) {
        if (!(ownerRefusal(error) && error.message === STALE_OUTLINE)) throw error;
        outlineId = attempt(readMyDay(deps.db, desk, clock(), studio).revision);
      }
    } catch (error) {
      if (!ownerRefusal(error)) throw error;
      return failed(error.message === STALE_OUTLINE ? "Balance kept changing while the task was being added." : error.message);
    }
    if (!outlineId) throw new Error("Balance answered without the new task's outline id.");
    return { state: "created", canonicalId: outlineId };
  };
  return {
    create: async request => {
      const desk = deps.desk();
      if (!desk?.enabled) return failed("The Desk is turned off on this stack.");
      return withStudioProjection(desk, studio => add(desk, request, studio));
    },
    readback: (operation: OperationRecord): Promise<ReadbackResult> => {
      try {
        const state = loadBalanceState(deps.db);
        if (!state) return Promise.resolve(null);
        const receipt = loadMeta(deps.db).receipts.find(r => r.id === operationUuid(operation.operationId));
        const outlineId = receipt?.outlineId;
        if (!outlineId || !findNode(state.outline, outlineId)) return Promise.resolve({ found: false });
        return Promise.resolve({ found: true, canonicalId: outlineId });
      } catch {
        return Promise.resolve(null);
      }
    },
  };
}
