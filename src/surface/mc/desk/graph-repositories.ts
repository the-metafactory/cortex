// glossary-ignore: run, host
import type { Database } from "bun:sqlite";
import { CommandTimeout, runCommand, type CommandResult } from "./spawn";
import { GITLAB_HOST, GITLAB_PATH, GITLAB_REF_PREFIX, parseGitlabRef } from "./graph-repository-schema";

export { GITLAB_REF_PREFIX } from "./graph-repository-schema";
export const GITHUB_REF_PREFIX = "github:github.com/";

const FULL_NAME = /^[^/\s]+\/[^/\s]+$/;
const LOGGED_IN = /✓\s+Logged in to (\S+) as /;
const FORGE_TIMEOUT_MS = 30_000;
const GH_LIST_ARGV = ["gh", "api", "--paginate", "user/repos?affiliation=owner,organization_member", "--jq", ".[].full_name"];
const GLAB_STATUS_ARGV = ["glab", "auth", "status"];
const glabListArgv = (host: string): string[] => ["glab", "api", "--hostname", host, "--paginate", "projects?membership=true&simple=true"];

export interface GraphRepository {
  ref: string;
  label: string;
  forge: string;
  enabled: boolean;
  listed?: false;
}

export type GraphRepositoryListing = { ok: true } | { ok: false; reason: string };

// glossary-ignore: host
/** One logged-in GitLab host and whether its projects could be listed. */
export type GitlabHostListing = { host: string; ok: true } | { host: string; ok: false; reason: string };

/** Fails as a whole only when glab cannot say which hosts it is logged in to; otherwise reports each logged-in host. */
export type GitlabListing = { ok: true; hosts: GitlabHostListing[] } | { ok: false; reason: string };

export interface GraphRepositoryView {
  repositories: GraphRepository[];
  listing: GraphRepositoryListing;
  gitlab: GitlabListing;
}

export type GraphRepositoryRunner = (argv: string[], timeoutMs: number) => Promise<CommandResult>;

export const githubRef = (fullName: string): string => `${GITHUB_REF_PREFIX}${fullName}`;

export const gitlabRef = (host: string, path: string): string => `${GITLAB_REF_PREFIX}${host}/${path}`;

export const isGithubRef = (ref: string): boolean => ref.startsWith(GITHUB_REF_PREFIX) && FULL_NAME.test(ref.slice(GITHUB_REF_PREFIX.length));

export const isGitlabRef = (ref: string): boolean => parseGitlabRef(ref) !== null;

/** True only for a ref that matches a stored row exactly: a string comparison, no normalisation. An empty table allows nothing. */
export function isGraphRepositoryAllowed(db: Database, ref: string): boolean {
  return db.query("SELECT 1 FROM desk_graph_repositories WHERE ref = ?").get(ref) !== null;
}

export function setGraphRepositoryEnabled(db: Database, ref: string, enabled: boolean, now: number): void {
  if (enabled) db.query("INSERT OR IGNORE INTO desk_graph_repositories (ref, enabled_at) VALUES (?, ?)").run(ref, now);
  else db.query("DELETE FROM desk_graph_repositories WHERE ref = ?").run(ref);
}

const storedRefs = (db: Database): string[] => db.query<{ ref: string }, []>("SELECT ref FROM desk_graph_repositories").all().map((r) => r.ref);

function describeRef(ref: string): Pick<GraphRepository, "label" | "forge"> {
  const colon = ref.indexOf(":");
  const forge = colon > 0 ? ref.slice(0, colon) : "unknown";
  if (ref.startsWith(GITHUB_REF_PREFIX)) return { forge, label: ref.slice(GITHUB_REF_PREFIX.length) };
  return { forge, label: parseGitlabRef(ref)?.path ?? ref };
}

const failureReason = (tool: string, err: unknown): string => (err instanceof CommandTimeout ? `${tool} ${err.message}` : err instanceof Error ? err.message : String(err));

const firstLine = (text: string): string => text.trim().split("\n")[0] ?? "";

async function attempt(run: GraphRepositoryRunner, tool: string, argv: string[]): Promise<{ ok: true; result: CommandResult } | { ok: false; reason: string }> {
  try {
    return { ok: true, result: await run(argv, FORGE_TIMEOUT_MS) };
  } catch (err) {
    return { ok: false, reason: failureReason(tool, err) };
  }
}

async function listGithubFullNames(run: GraphRepositoryRunner): Promise<{ ok: true; names: string[] } | { ok: false; reason: string }> {
  const ran = await attempt(run, "gh", GH_LIST_ARGV);
  if (!ran.ok) return ran;
  const { result } = ran;
  if (result.code !== 0) return { ok: false, reason: firstLine(result.stderr) || `gh exited with code ${result.code}` };
  const names = result.stdout.split("\n").map((line) => line.trim()).filter((line) => FULL_NAME.test(line));
  return { ok: true, names };
}

async function loggedInGitlabHostsIgnoringExitCode(run: GraphRepositoryRunner): Promise<{ ok: true; hosts: string[] } | { ok: false; reason: string }> {
  const ran = await attempt(run, "glab", GLAB_STATUS_ARGV);
  if (!ran.ok) return ran;
  const hosts = new Set<string>();
  for (const line of `${ran.result.stdout}\n${ran.result.stderr}`.split("\n")) {
    const host = LOGGED_IN.exec(line)?.[1];
    if (host !== undefined && GITLAB_HOST.test(host)) hosts.add(host);
  }
  return { ok: true, hosts: [...hosts].sort() };
}

function splitTopLevelJson(text: string): string[] | null {
  const slices: string[] = [];
  let depth = 0;
  let inString = false;
  let escaped = false;
  let start = -1;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === "\"") inString = false;
      continue;
    }
    if (c === "\"") inString = true;
    else if (c === "[" || c === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (c === "]" || c === "}") {
      depth--;
      if (depth < 0) return null;
      if (depth === 0) slices.push(text.slice(start, i + 1));
    } else if (depth === 0 && !/\s/.test(c ?? "")) return null;
  }
  return depth === 0 && !inString ? slices : null;
}

function parseProjectPages(stdout: string): unknown[] | null {
  const slices = splitTopLevelJson(stdout);
  if (slices === null || slices.length === 0) return null;
  try {
    const pages = slices.map((slice): unknown => JSON.parse(slice));
    return pages.every((page): page is unknown[] => Array.isArray(page)) ? pages.flat() : null;
  } catch (_err) {
    return null;
  }
}

async function listHostProjects(run: GraphRepositoryRunner, host: string): Promise<{ ok: true; paths: string[] } | { ok: false; reason: string }> {
  const ran = await attempt(run, "glab", glabListArgv(host));
  if (!ran.ok) return ran;
  if (ran.result.code !== 0) return { ok: false, reason: firstLine(ran.result.stderr) || `glab exited with code ${ran.result.code}` };
  const projects = parseProjectPages(ran.result.stdout);
  if (projects === null) return { ok: false, reason: "glab did not return a project list" };
  const paths = projects
    .map((p: unknown) => (typeof p === "object" && p !== null ? (p as Record<string, unknown>).path_with_namespace : undefined))
    .filter((p): p is string => typeof p === "string" && GITLAB_PATH.test(p));
  return { ok: true, paths };
}

async function listGitlabProjects(run: GraphRepositoryRunner): Promise<{ listing: GitlabListing; refs: { ref: string; path: string }[] }> {
  const status = await loggedInGitlabHostsIgnoringExitCode(run);
  if (!status.ok) return { listing: { ok: false, reason: status.reason }, refs: [] };
  if (status.hosts.length === 0) return { listing: { ok: false, reason: "glab is not logged in to any GitLab host" }, refs: [] };
  const listings = await Promise.all(status.hosts.map(async (host) => ({ host, listed: await listHostProjects(run, host) })));
  const hosts: GitlabHostListing[] = [];
  const refs: { ref: string; path: string }[] = [];
  for (const { host, listed } of listings) {
    if (!listed.ok) {
      hosts.push({ host, ok: false, reason: listed.reason });
      continue;
    }
    hosts.push({ host, ok: true });
    for (const path of listed.paths) refs.push({ ref: gitlabRef(host, path), path });
  }
  return { listing: { ok: true, hosts }, refs };
}

// glossary-ignore: host
function listingAnswered(ref: string, github: { ok: boolean }, gitlab: GitlabListing): boolean {
  if (!ref.startsWith(GITLAB_REF_PREFIX)) return github.ok;
  if (!gitlab.ok) return false;
  const host = parseGitlabRef(ref)?.host;
  return gitlab.hosts.find((h) => h.host === host)?.ok ?? true;
}

/**
 * Every GitHub repository the signed-in `gh` can see (own account and organisations) and every GitLab project `glab`
 * can see on each host it is logged in to, merged with the stored ticks. A ticked repository its listing does not
 * return stays in the result with `listed: false`; when a forge's or a host's listing fails, its ticked repositories
 * are still returned, so they can be unticked.
 */
export async function listGraphRepositories(db: Database, run: GraphRepositoryRunner = runCommand): Promise<GraphRepositoryView> {
  const enabled = new Set(storedRefs(db));
  const [github, gitlab] = await Promise.all([listGithubFullNames(run), listGitlabProjects(run)]);
  const rows = new Map<string, GraphRepository>();
  if (github.ok) {
    for (const name of github.names) {
      const ref = githubRef(name);
      rows.set(ref, { ref, label: name, forge: "github", enabled: enabled.has(ref) });
    }
  }
  for (const { ref, path } of gitlab.refs) rows.set(ref, { ref, label: path, forge: "gitlab", enabled: enabled.has(ref) });
  for (const ref of enabled) {
    if (rows.has(ref)) continue;
    const described = describeRef(ref);
    rows.set(ref, { ref, ...described, enabled: true, ...(listingAnswered(ref, github, gitlab.listing) ? { listed: false as const } : {}) });
  }
  const repositories = [...rows.values()].sort((a, b) => a.label.localeCompare(b.label) || a.ref.localeCompare(b.ref));
  return { repositories, listing: github.ok ? { ok: true } : { ok: false, reason: github.reason }, gitlab: gitlab.listing };
}
