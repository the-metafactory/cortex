export const GRAPH_WRITER_SQL = [
  "CREATE TABLE IF NOT EXISTS desk_graph_operations (operation_id TEXT PRIMARY KEY, repository TEXT NOT NULL, parent TEXT, args TEXT NOT NULL, at INTEGER NOT NULL)",
];
