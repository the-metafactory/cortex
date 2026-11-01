import type { Database } from "bun:sqlite";
import type { RoutineDisplayChange, RoutineDisplayPage, RoutineDisplayResult } from "./routine-display-contract";
export * from "./routine-display-contract";

export const ROUTINE_DISPLAY_SQL = [
  `CREATE TABLE IF NOT EXISTS desk_routine_display (
    principal TEXT NOT NULL,
    stack TEXT NOT NULL,
    owner TEXT NOT NULL CHECK(owner = 'reflex'),
    routine_id TEXT NOT NULL,
    mode TEXT NOT NULL CHECK(mode = 'background'),
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (principal, stack, owner, routine_id)
  )`,
];
interface Scope { principal: string; stack: string }
interface Row { routine_id: string; updated_at: number }

export function readRoutineDisplay(db: Database, scope: Scope): RoutineDisplayPage {
  const rows = db.query<Row, [string, string]>("SELECT routine_id, updated_at FROM desk_routine_display WHERE principal = ? AND stack = ? AND owner = 'reflex' ORDER BY routine_id LIMIT 1000").all(scope.principal, scope.stack);
  return { owner: "reflex", principal: scope.principal, stack: scope.stack, preferences: rows.map((row) => ({ routineId: row.routine_id, mode: "background" as const, updatedAt: new Date(row.updated_at).toISOString() })) };
}

export function writeRoutineDisplay(db: Database, change: RoutineDisplayChange, now = Date.now()): RoutineDisplayResult {
  if (change.mode === "background") {
    db.query("INSERT INTO desk_routine_display (principal, stack, owner, routine_id, mode, updated_at) VALUES (?, ?, 'reflex', ?, 'background', ?) ON CONFLICT(principal, stack, owner, routine_id) DO UPDATE SET mode = excluded.mode, updated_at = excluded.updated_at").run(change.principal, change.stack, change.routineId, now);
  } else {
    db.query("DELETE FROM desk_routine_display WHERE principal = ? AND stack = ? AND owner = 'reflex' AND routine_id = ?").run(change.principal, change.stack, change.routineId);
  }
  return { owner: "reflex", principal: change.principal, stack: change.stack, routineId: change.routineId, mode: change.mode };
}
