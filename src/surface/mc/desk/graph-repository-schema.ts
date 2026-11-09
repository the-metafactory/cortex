// glossary-ignore: host
export const GRAPH_REPOSITORIES_PATH = "/api/desk/graph-repositories";
export const GRAPH_TICKED_PARAM = "ticked";
export const GRAPH_NODES_SUFFIX = "/nodes";
export const graphNodesPath = (ref: string): string => `${GRAPH_REPOSITORIES_PATH}/${encodeURIComponent(ref)}${GRAPH_NODES_SUFFIX}`;

export const GRAPH_REPOSITORY_SQL = [
  "CREATE TABLE IF NOT EXISTS desk_graph_repositories (ref TEXT PRIMARY KEY, enabled_at INTEGER NOT NULL)",
];

export const GITLAB_REF_PREFIX = "gitlab:";
export const GITLAB_HOST = /^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?(?::\d{1,5})?$/;
export const GITLAB_PATH = /^[^/\s]+(?:\/[^/\s]+)+$/;

export function parseGitlabRef(ref: string): { host: string; path: string } | null {
  if (!ref.startsWith(GITLAB_REF_PREFIX)) return null;
  const rest = ref.slice(GITLAB_REF_PREFIX.length);
  const slash = rest.indexOf("/");
  const host = rest.slice(0, slash);
  const path = rest.slice(slash + 1);
  return slash > 0 && GITLAB_HOST.test(host) && GITLAB_PATH.test(path) ? { host, path } : null;
}
