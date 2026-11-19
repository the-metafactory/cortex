import type { Database } from "bun:sqlite";
import type { DeskOptions } from "../compose";

export const STUDIO_LOOK_SQL = [
  `CREATE TABLE IF NOT EXISTS desk_studio_look (
    principal TEXT NOT NULL,
    stack TEXT NOT NULL,
    last_look INTEGER NOT NULL,
    PRIMARY KEY (principal, stack)
  )`,
];

type Scope = NonNullable<DeskOptions["routineScope"]>;

export function readStudioLook(db: Database, scope: Scope): number | null {
  return db.query<{ last_look: number }, [string, string]>("SELECT last_look FROM desk_studio_look WHERE principal = ? AND stack = ?").get(scope.principal, scope.stack)?.last_look ?? null;
}

export function writeStudioLook(db: Database, scope: Scope, at: number): void {
  db.query("INSERT INTO desk_studio_look (principal, stack, last_look) VALUES (?, ?, ?) ON CONFLICT(principal, stack) DO UPDATE SET last_look = excluded.last_look").run(scope.principal, scope.stack, at);
}
