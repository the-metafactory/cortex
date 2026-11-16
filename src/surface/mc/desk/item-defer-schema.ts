export const ITEM_DEFER_SQL = [
  `CREATE TABLE IF NOT EXISTS desk_item_defers (
    item_key TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    title TEXT NOT NULL,
    wait TEXT NOT NULL,
    until_at INTEGER,
    event_key TEXT,
    event_title TEXT,
    event_start INTEGER,
    label TEXT NOT NULL,
    state TEXT NOT NULL,
    back_at INTEGER,
    reason TEXT,
    created_at INTEGER NOT NULL,
    urgent_at_defer INTEGER NOT NULL DEFAULT 0
  )`,
  "CREATE INDEX IF NOT EXISTS desk_item_defers_state ON desk_item_defers (state, created_at)",
];
