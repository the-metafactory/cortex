export const MEETING_BRIEF_SQL = [
  `CREATE TABLE IF NOT EXISTS desk_meeting_briefs (
    event TEXT PRIMARY KEY,
    revision TEXT NOT NULL,
    prepared_at INTEGER NOT NULL,
    body TEXT NOT NULL CHECK (json_valid(body))
  )`,
];
