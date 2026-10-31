import type { Database } from "bun:sqlite";

export interface DeskNote {
  id: number;
  kind: "reminder" | "note";
  text: string;
  dueAt: number | null;
  createdAt: number;
}

interface Row {
  id: number;
  kind: "reminder" | "note";
  text: string;
  due_at: number | null;
  created_at: number;
}

const fromRow = (r: Row): DeskNote => ({ id: r.id, kind: r.kind, text: r.text, dueAt: r.due_at, createdAt: r.created_at });

export function addNote(db: Database, kind: DeskNote["kind"], text: string, dueAt: number | null, now: number): DeskNote {
  const row = db
    .query<Row, [string, string, number | null, number]>("INSERT INTO desk_notes (kind, text, due_at, created_at) VALUES (?, ?, ?, ?) RETURNING id, kind, text, due_at, created_at")
    .get(kind, text, dueAt, now);
  if (!row) throw new Error("the note was not stored");
  return fromRow(row);
}

export function listOpenNotes(db: Database): DeskNote[] {
  return db
    .query<Row, []>("SELECT id, kind, text, due_at, created_at FROM desk_notes WHERE done_at IS NULL ORDER BY kind DESC, due_at ASC, created_at DESC")
    .all()
    .map(fromRow);
}

export function closeNote(db: Database, id: number, now: number): boolean {
  return db.query("UPDATE desk_notes SET done_at = ? WHERE id = ? AND done_at IS NULL").run(now, id).changes > 0;
}
