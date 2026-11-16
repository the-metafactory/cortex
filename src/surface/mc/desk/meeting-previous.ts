import type { Database } from "bun:sqlite";

interface PreviousRelation {
  event: string;
  eventConnection: string;
  previousEvent: string;
  previousConnection: string;
}

interface Raw {
  event: string;
  event_connection: string;
  previous_event: string;
  previous_connection: string;
}

export const readPreviousRelation = (db: Database, event: string): PreviousRelation | null => {
  const row = db.query<Raw, [string]>("SELECT event, event_connection, previous_event, previous_connection FROM desk_meeting_previous WHERE event = ?").get(event);
  return row ? { event: row.event, eventConnection: row.event_connection, previousEvent: row.previous_event, previousConnection: row.previous_connection } : null;
};

export const setPreviousRelation = (db: Database, relation: PreviousRelation, now: number): void => {
  db.query(
    `INSERT INTO desk_meeting_previous (event, event_connection, previous_event, previous_connection, updated_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(event) DO UPDATE SET event_connection = excluded.event_connection, previous_event = excluded.previous_event, previous_connection = excluded.previous_connection, updated_at = excluded.updated_at`,
  ).run(relation.event, relation.eventConnection, relation.previousEvent, relation.previousConnection, now);
};

export const clearPreviousRelation = (db: Database, event: string): void => {
  db.query("DELETE FROM desk_meeting_previous WHERE event = ?").run(event);
};
