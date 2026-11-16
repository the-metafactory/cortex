import type { Database } from "bun:sqlite";
import { findNode, type RecurrenceOutcome } from "../../../balance";
import { loadBalanceState } from "../desk/balance-store";
import type { DeskRuntime } from "../desk/compose";

export const DESK_OUTLINE_HISTORY_PATH = "/api/desk/outline/history";
const OUTLINE_HISTORY_DEFAULT_LIMIT = 20;
export const OUTLINE_HISTORY_MAX_LIMIT = 100;

const noStore = { "Cache-Control": "no-store" };
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const CURSOR_VERSION = 1;

export interface OutlineHistoryEntry {
  planned: string;
  outcome: "completed" | "skipped" | "missed";
  actionDate: string | null;
  recordedOn: string;
}

export interface OutlineHistoryPage {
  task: string;
  outcomes: OutlineHistoryEntry[];
  nextCursor: string | null;
}

interface Position {
  planned: string;
  recordedOn: string;
  ordinal: number;
}

interface Ranked {
  position: Position;
  entry: OutlineHistoryEntry;
}

function refuse(status: number, code: string, error: string): Response {
  return Response.json({ ok: false, code, error }, { status, headers: noStore });
}

function actionDateOf(outcome: RecurrenceOutcome): string | null {
  if (outcome.status === "completed") return outcome.completedOn ?? null;
  if (outcome.status === "skipped") return outcome.skippedOn ?? null;
  return null;
}

function comesAfter(a: Position, b: Position): boolean {
  if (a.planned !== b.planned) return a.planned < b.planned;
  if (a.recordedOn !== b.recordedOn) return a.recordedOn < b.recordedOn;
  return a.ordinal < b.ordinal;
}

function encodeCursor(task: string, position: Position): string {
  return Buffer.from(JSON.stringify({ v: CURSOR_VERSION, t: task, p: position.planned, r: position.recordedOn, o: position.ordinal })).toString("base64url");
}

type CursorRead = { kind: "ok"; task: string; position: Position } | { kind: "malformed" };

function decodeCursor(raw: string): CursorRead {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    if (typeof parsed !== "object" || parsed === null) return { kind: "malformed" };
    const { v, t, p, r, o } = parsed as Record<string, unknown>;
    if (v !== CURSOR_VERSION || typeof t !== "string" || typeof p !== "string" || typeof r !== "string") return { kind: "malformed" };
    if (!ISO_DATE.test(p) || !ISO_DATE.test(r) || typeof o !== "number" || !Number.isInteger(o) || o < 0) return { kind: "malformed" };
    return { kind: "ok", task: t, position: { planned: p, recordedOn: r, ordinal: o } };
  } catch (_err) {
    return { kind: "malformed" };
  }
}

function rank(outcomes: readonly RecurrenceOutcome[], task: string): Ranked[] {
  const ranked: Ranked[] = [];
  outcomes.forEach((outcome, ordinal) => {
    if (outcome.taskId !== task) return;
    ranked.push({
      position: { planned: outcome.planned, recordedOn: outcome.recordedOn, ordinal },
      entry: { planned: outcome.planned, outcome: outcome.status, actionDate: actionDateOf(outcome), recordedOn: outcome.recordedOn },
    });
  });
  return ranked.sort((a, b) => (comesAfter(a.position, b.position) ? 1 : -1));
}

function limitOf(raw: string | null): number | null {
  if (raw === null) return OUTLINE_HISTORY_DEFAULT_LIMIT;
  if (!/^\d+$/.test(raw)) return null;
  const limit = Number(raw);
  return limit >= 1 && limit <= OUTLINE_HISTORY_MAX_LIMIT ? limit : null;
}

export function handleDeskOutlineHistory(req: Request, db: Database, runtime: DeskRuntime | undefined): Response {
  if (req.method !== "GET") return new Response(null, { status: 405, headers: { Allow: "GET" } });
  const desk = runtime?.options;
  if (!desk?.enabled) return refuse(409, "desk_off", "The Desk is turned off.");
  const params = new URL(req.url).searchParams;
  const task = params.get("task") ?? "";
  if (!task) return refuse(400, "task_required", "Name the outline task to read the history of.");
  const limit = limitOf(params.get("limit"));
  if (limit === null) return refuse(400, "invalid_limit", `The limit is a whole number from 1 to ${OUTLINE_HISTORY_MAX_LIMIT}.`);
  const rawCursor = params.get("cursor");
  const cursor = rawCursor === null ? null : decodeCursor(rawCursor);
  if (cursor?.kind === "malformed") return refuse(400, "invalid_cursor", "The cursor is not valid. Start again without one.");
  const state = loadBalanceState(db);
  const configured = state?.outline.children.filter(area => desk.areas.some(a => area.id === `area:${a.id}`)) ?? [];
  const found = configured.some(area => area.id !== task && findNode(area, task) !== null);
  if (!state || !found) return refuse(404, "task_not_found", "That outline task is unavailable or its area is no longer configured.");
  if (cursor && cursor.task !== task) return refuse(400, "cursor_other_task", "This cursor belongs to a different task. Start again without one.");
  const after = cursor?.position;
  const remaining = rank(state.outcomes ?? [], task).filter(item => !after || comesAfter(item.position, after));
  const page = remaining.slice(0, limit);
  const last = page.at(-1);
  const body: OutlineHistoryPage = {
    task,
    outcomes: page.map(item => item.entry),
    nextCursor: last && remaining.length > page.length ? encodeCursor(task, last.position) : null,
  };
  return Response.json(body, { headers: noStore });
}
