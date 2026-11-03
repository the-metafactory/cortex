export const GRAPH_REPOSITORIES_PATH = "/api/desk/graph-repositories";

export const GRAPH_REPOSITORY_SQL = [
  "CREATE TABLE IF NOT EXISTS desk_graph_repositories (ref TEXT PRIMARY KEY, enabled_at INTEGER NOT NULL)",
];
