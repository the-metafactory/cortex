import type { Database } from "bun:sqlite";
import { RoutineDisplayModeSchema, type RoutineDisplayChange, type RoutineDisplayMode, type RoutineDisplayResult } from "./routine-display-contract";
export * from "./routine-display-contract";

export const ROUTINE_DISPLAY_SQL = [
  `CREATE TABLE IF NOT EXISTS desk_routine_display (
    principal TEXT NOT NULL,
    stack TEXT NOT NULL,
    owner TEXT NOT NULL,
    routine_id TEXT NOT NULL,
    mode TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (principal, stack, owner, routine_id)
  )`,
];
interface Scope { principal: string; stack: string }
interface Row { routine_id: string; mode: string }

export function readRoutineDisplay(db: Database, scope: Scope): Map<string, RoutineDisplayMode> {
  const rows = db.query<Row, [string, string]>("SELECT routine_id, mode FROM desk_routine_display WHERE principal = ? AND stack = ? AND owner = 'reflex' ORDER BY routine_id LIMIT 1000").all(scope.principal, scope.stack);
  const stored = new Map<string, RoutineDisplayMode>();
  for (const row of rows) { const mode = RoutineDisplayModeSchema.safeParse(row.mode); if (mode.success) stored.set(row.routine_id, mode.data); }
  return stored;
}

export function writeRoutineDisplay(db: Database, change: RoutineDisplayChange, now = Date.now()): RoutineDisplayResult {
  if (change.mode === "automatic") {
    db.query("DELETE FROM desk_routine_display WHERE principal = ? AND stack = ? AND owner = 'reflex' AND routine_id = ?").run(change.principal, change.stack, change.routineId);
  } else {
    db.query("INSERT INTO desk_routine_display (principal, stack, owner, routine_id, mode, updated_at) VALUES (?, ?, 'reflex', ?, ?, ?) ON CONFLICT(principal, stack, owner, routine_id) DO UPDATE SET mode = excluded.mode, updated_at = excluded.updated_at").run(change.principal, change.stack, change.routineId, change.mode, now);
  }
  return { owner: "reflex", principal: change.principal, stack: change.stack, routineId: change.routineId, mode: change.mode };
}
