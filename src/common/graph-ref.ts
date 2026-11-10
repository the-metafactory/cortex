export const GRAPH_FORGES = ["github", "gitlab"] as const;
export type GraphForge = (typeof GRAPH_FORGES)[number];

export interface GraphRepoRef {
  forge: GraphForge;
  host: string;
  path: string;
}

export interface GraphNodeRef {
  repo: GraphRepoRef;
  sigil: "#" | "&";
  iid: number;
}

export interface GraphReadScope {
  repositories: readonly GraphRepoRef[];
  namespaces?: readonly GraphRepoRef[];
}

const FORGE = /^(github|gitlab):/;
const HOST = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(?::[1-9]\d{0,4})?$/;
const PART = /^[A-Za-z0-9_.-]+$/;
const NODE = /^(.+)([#&])([1-9]\d*)$/;

const parsePath = (text: string): string | null => {
  const parts = text.split("/");
  return parts.length > 0 && parts.every(part => PART.test(part) && part !== "." && part !== "..") ? parts.join("/") : null;
};

export function parseGraphRepoRef(text: string): GraphRepoRef | null {
  const trimmed = text.trim();
  const forge = FORGE.exec(trimmed)?.[1] as GraphForge | undefined;
  if (!forge) return null;
  const rest = trimmed.slice(forge.length + 1);
  const slash = rest.indexOf("/");
  if (slash <= 0 || slash === rest.length - 1) return null;
  const host = rest.slice(0, slash).toLowerCase();
  const path = parsePath(rest.slice(slash + 1));
  if (!HOST.test(host) || !path) return null;
  if (forge === "github" && path.split("/").length !== 2) return null;
  return { forge, host, path };
}

export function parseGraphNodeRef(text: string): GraphNodeRef | null {
  const match = NODE.exec(text.trim());
  if (!match) return null;
  const repo = parseGraphRepoRef(match[1] ?? "");
  if (!repo) return null;
  const sigil = match[2] as "#" | "&";
  if (sigil === "&" && repo.forge !== "gitlab") return null;
  return { repo, sigil, iid: Number(match[3]) };
}

export function graphReadScope(read: { repos: readonly string[]; namespaces?: readonly string[] }): GraphReadScope {
  return {
    repositories: read.repos.flatMap(text => parseGraphRepoRef(text) ?? []),
    namespaces: (read.namespaces ?? []).flatMap(text => parseGraphRepoRef(text) ?? []),
  };
}

export const formatGraphRepoRef = (repo: GraphRepoRef): string => `${repo.forge}:${repo.host}/${repo.path}`;

export const formatGraphNodeRef = (ref: GraphNodeRef): string => `${formatGraphRepoRef(ref.repo)}${ref.sigil}${ref.iid}`;

export function permitsGraphRead(scope: GraphReadScope, repo: GraphRepoRef): boolean {
  const path = repo.path.toLowerCase();
  const sameAuthority = (entry: GraphRepoRef): boolean => entry.forge === repo.forge && entry.host === repo.host;
  return scope.repositories.some(entry => sameAuthority(entry) && entry.path.toLowerCase() === path)
    || (scope.namespaces ?? []).some(entry => sameAuthority(entry) && (path === entry.path.toLowerCase() || path.startsWith(`${entry.path.toLowerCase()}/`)));
}

export function qualifiedNodeId(repoText: string, id: string): string {
  const direct = parseGraphNodeRef(id);
  if (direct) return formatGraphNodeRef(direct);
  const repo = parseGraphRepoRef(repoText);
  if (!repo) return id;
  if (/^[1-9]\d*$/.test(id)) return `${formatGraphRepoRef(repo)}#${id}`;
  const located = NODE.exec(id);
  if (located) return `${repo.forge}:${repo.host}/${located[1]}${located[2]}${located[3]}`;
  return id;
}

export function canonicalNodeId(ref: GraphNodeRef): string {
  return ref.repo.forge === "github" ? String(ref.iid) : `${ref.repo.path}${ref.sigil}${ref.iid}`;
}

const BARE_NODE = /^#?([1-9]\d*)$/;

export const isBareGraphNode = (value: string): boolean => BARE_NODE.test(value);

/**
 * The equality form of a stored graph id: only one `github:github.com/` prefix is removed, as `canonicalTaskRef` does,
 * and a bare number is joined to the repository it was asked with. Nothing else is normalised, so GitLab refs stay as written.
 */
export function canonicalGraphRef(value: string, repository?: string): string {
  const text = value.trim();
  const bare = BARE_NODE.exec(text);
  const combined = bare && repository !== undefined ? `${repository}#${bare[1]}` : text;
  return combined.replace(/^github:github\.com\//, "");
}
