export const MEETING_BRIEF_SQL = [
  `CREATE TABLE IF NOT EXISTS desk_meeting_briefs (
    event TEXT PRIMARY KEY,
    revision TEXT NOT NULL,
    prepared_at INTEGER NOT NULL,
    body TEXT NOT NULL CHECK (json_valid(body))
  )`,
  `CREATE TABLE IF NOT EXISTS desk_meeting_previous (
    event TEXT PRIMARY KEY,
    event_connection TEXT NOT NULL,
    previous_event TEXT NOT NULL,
    previous_connection TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
];
