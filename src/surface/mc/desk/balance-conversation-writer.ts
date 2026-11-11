import type { Database } from "bun:sqlite";
import { findNode, type AppState } from "../../../balance";
import type { CreateRequest, CreateResult, OperationRecord, OwnerWriter, ReadbackResult } from "../../../conversations/types";
import { BalanceCommandSchema, type BalanceCommand } from "./balance-command";
import { areaProjects, balanceDestinations, resolveBalanceProject } from "./balance-destinations";
import { STALE_OUTLINE } from "./balance-outline";
import { loadBalanceState } from "./balance-store";
import type { DeskOptions } from "./compose";
import { operationUuid } from "../../../conversations/conversation-ids";
import type { ListedMail } from "./mail-actions";
import { logMailTodo } from "./mail-log";
import { syncBalance } from "./balance-sync";
import { changeMyDay, loadMeta, localDay, sourceIdentity } from "./my-day";
import { withStudioProjection } from "./studio-my-day";
import type { StudioProjection } from "./studio-outline";
import type { DeskItem } from "./types";

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

export function balanceDestination(state: AppState, desk: DeskOptions, fields: Record<string, string>): { parent: string } | { refused: string } {
  const areaId = fields.area ?? "";
  const area = desk.areas.find(a => a.id === areaId);
  if (!area) return { refused: `${areaId} is not a configured area.` };
  const parent = `area:${area.id}`;
  const project = fields.project?.trim();
  if (!project) return { parent };
  const open = areaProjects(balanceDestinations(state.outline, desk.areas), area.id);
  const chosen = resolveBalanceProject(open, project);
  return chosen ? { parent: chosen.id } : { refused: `That project is not open in ${area.label}.` };
}

export type BalanceKind = "task" | "project";

function addCommand(kind: BalanceKind, fields: Record<string, string>, parent: string, revision: number): BalanceCommand | { refused: string } {
  const due = kind === "task" ? fields.due : undefined;
  if (due && !/^\d{4}-\d{2}-\d{2}$/.test(due)) return { refused: `${due} is not a due date in the form YYYY-MM-DD.` };
  const parsed = BalanceCommandSchema.safeParse({ op: "outline-add", revision, parent, title: fields.title ?? "", kind, ...(fields.note ? { note: fields.note } : {}), ...(due ? { dueDate: due } : {}) });
  if (!parsed.success) return { refused: parsed.error.issues.some(i => i.path[0] === "dueDate") ? `${due ?? ""} is not a valid due date.` : "Balance takes a title of up to 300 characters and a note of up to 10,000." };
  return parsed.data;
}

function readReceipt(db: Database, operationId: string): ReadbackResult {
  try {
    const state = loadBalanceState(db);
    if (!state) return null;
    const id = operationUuid(operationId);
    const meta = loadMeta(db);
    const outlineId = meta.receipts.find(r => r.id === id)?.outlineId;
    const held = outlineId !== undefined && (findNode(state.outline, outlineId) !== null || meta.inbox.some(node => node.id === outlineId));
    return outlineId && held ? { found: true, canonicalId: outlineId } : { found: false };
  } catch {
    return null;
  }
}

const DESK_OFF = "The Desk is turned off on this stack.";
const receiptReadback = (db: Database) => (operation: OperationRecord): Promise<ReadbackResult> => Promise.resolve(readReceipt(db, operation.operationId));

export function balanceWriter(kind: BalanceKind, deps: BalanceWriterDeps): OwnerWriter {
  const clock = deps.now ?? Date.now;
  const add = (desk: DeskOptions, request: CreateRequest, studio: StudioProjection | undefined): CreateResult => {
    if (request.signal.aborted) throw new Error("The conversation stopped waiting before Balance was called.");
    const state = loadBalanceState(deps.db);
    if (!state) return failed("Balance has no saved outline on this stack yet.");
    const where = balanceDestination(state, desk, request.fields);
    if ("refused" in where) return failed(where.refused);
    syncBalance(deps.db, desk, clock(), studio);
    const requestId = operationUuid(request.operationId);
    const attempt = (revision: number): string | undefined => {
      const command = addCommand(kind, request.fields, where.parent, revision);
      if ("refused" in command) throw new Error(command.refused);
      const now = clock();
      return changeMyDay({ db: deps.db, desk, now, date: localDay(now), requestId, command, studio }).outlineId;
    };
    const stale = (error: unknown): boolean => ownerRefusal(error) && error.message === STALE_OUTLINE;
    const attemptWithStaleRetry = (): string | undefined => {
      try { return attempt(loadMeta(deps.db).revision); }
      catch (error) {
        if (!stale(error)) throw error;
        syncBalance(deps.db, desk, clock(), studio);
        return attempt(loadMeta(deps.db).revision);
      }
    };
    let outlineId: string | undefined;
    try { outlineId = attemptWithStaleRetry(); }
    catch (error) {
      if (!ownerRefusal(error)) throw error;
      return failed(stale(error) ? `Balance kept changing while the ${kind} was being added.` : error.message);
    }
    if (!outlineId) throw new Error(`Balance answered without the new ${kind}'s outline id.`);
    return { state: "created", canonicalId: outlineId };
  };
  return {
    create: async request => {
      const desk = deps.desk();
      if (!desk?.enabled) return failed(DESK_OFF);
      return withStudioProjection(desk, studio => add(desk, request, studio));
    },
    readback: receiptReadback(deps.db),
  };
}

export interface InboxWriterDeps extends BalanceWriterDeps {
  deskItems: () => Promise<DeskItem[]>;
  listedMail?: (key: string) => ListedMail | null;
}

export function balanceInboxWriter(deps: InboxWriterDeps): OwnerWriter {
  const clock = deps.now ?? Date.now;
  const move = (desk: DeskOptions, request: CreateRequest, item: DeskItem, studio: StudioProjection | undefined): CreateResult => {
    const now = clock();
    syncBalance(deps.db, desk, now, studio);
    let outlineId: string | undefined;
    try {
      outlineId = changeMyDay({ db: deps.db, desk, now, date: localDay(now), requestId: operationUuid(request.operationId), command: { op: "todo", key: item.key, fingerprint: sourceIdentity(item) }, source: item, studio }).outlineId;
    } catch (error) {
      if (!ownerRefusal(error)) throw error;
      return failed(error.message);
    }
    if (!outlineId) throw new Error("Balance answered without the Inbox task's id.");
    const mail = item.kind === "mail" ? deps.listedMail?.(item.key) : null;
    if (mail) logMailTodo(deps.db, mail, "conversation", now);
    return { state: "created", canonicalId: outlineId };
  };
  return {
    create: async request => {
      const desk = deps.desk();
      if (!desk?.enabled) return failed(DESK_OFF);
      const earlier = readReceipt(deps.db, request.operationId);
      if (earlier?.found) return { state: "created", canonicalId: earlier.canonicalId };
      const item = (await deps.deskItems()).find(i => i.key === request.fields.item);
      if (request.signal.aborted) throw new Error("The conversation stopped waiting before Balance was called.");
      if (!item) return failed("That Day item is no longer on the Desk.");
      if (item.title.trim() !== request.fields.title) return failed("The Day item changed since it was proposed, or its title was edited; the Inbox task takes the item's own title.");
      return withStudioProjection(desk, studio => move(desk, request, item, studio));
    },
    readback: receiptReadback(deps.db),
  };
}
