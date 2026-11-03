// glossary-ignore: run, host
import type { Database } from "bun:sqlite";
import { CommandTimeout, runCommand, type CommandResult } from "./spawn";

export const GITHUB_REF_PREFIX = "github:github.com/";
export const GITLAB_REF_PREFIX = "gitlab:";

const FULL_NAME = /^[^/\s]+\/[^/\s]+$/;
const GITLAB_HOST = /^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?(?::\d{1,5})?$/;
const GITLAB_PATH = /^[^/\s]+(?:\/[^/\s]+)+$/;
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

export type GitlabListing = { ok: true; host: string } | { ok: false; kind: "unavailable" | "several-hosts"; reason: string };

export interface GraphRepositoryView {
  repositories: GraphRepository[];
  listing: GraphRepositoryListing;
  gitlab: GitlabListing;
}

export type GraphRepositoryRunner = (argv: string[], timeoutMs: number) => Promise<CommandResult>;

export const githubRef = (fullName: string): string => `${GITHUB_REF_PREFIX}${fullName}`;

export const gitlabRef = (host: string, path: string): string => `${GITLAB_REF_PREFIX}${host}/${path}`;

export const isGithubRef = (ref: string): boolean => ref.startsWith(GITHUB_REF_PREFIX) && FULL_NAME.test(ref.slice(GITHUB_REF_PREFIX.length));

function parseGitlabRef(ref: string): { host: string; path: string } | null {
  if (!ref.startsWith(GITLAB_REF_PREFIX)) return null;
  const rest = ref.slice(GITLAB_REF_PREFIX.length);
  const slash = rest.indexOf("/");
  const host = rest.slice(0, slash);
  const path = rest.slice(slash + 1);
  return slash > 0 && GITLAB_HOST.test(host) && GITLAB_PATH.test(path) ? { host, path } : null;
}

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

async function listGitlabProjects(run: GraphRepositoryRunner): Promise<{ listing: GitlabListing; paths: string[] }> {
  const unavailable = (reason: string) => ({ listing: { ok: false as const, kind: "unavailable" as const, reason }, paths: [] });
  const status = await loggedInGitlabHostsIgnoringExitCode(run);
  if (!status.ok) return unavailable(status.reason);
  const [host, ...others] = status.hosts;
  if (host === undefined) return unavailable("glab is not logged in to any GitLab host");
  if (others.length > 0) return { listing: { ok: false, kind: "several-hosts", reason: `glab is logged in to ${status.hosts.join(", ")}` }, paths: [] };
  const ran = await attempt(run, "glab", glabListArgv(host));
  if (!ran.ok) return unavailable(ran.reason);
  if (ran.result.code !== 0) return unavailable(firstLine(ran.result.stderr) || `glab exited with code ${ran.result.code}`);
  let projects: unknown;
  try {
    projects = JSON.parse(ran.result.stdout);
  } catch (_err) {
    return unavailable("glab did not return a project list");
  }
  if (!Array.isArray(projects)) return unavailable("glab did not return a project list");
  const paths = projects
    .map((p: unknown) => (typeof p === "object" && p !== null ? (p as Record<string, unknown>).path_with_namespace : undefined))
    .filter((p): p is string => typeof p === "string" && GITLAB_PATH.test(p));
  return { listing: { ok: true, host }, paths };
}

/**
 * Every GitHub repository the signed-in `gh` can see (own account and organisations) and every GitLab project of the
 * one GitLab instance `glab` is logged in to, merged with the stored ticks. A ticked repository its forge's listing does not
 * return stays in the result with `listed: false`; when a forge's listing fails, its ticked repositories are still
 * returned, so they can be unticked. Several logged-in GitLab instances list no GitLab project (fail closed).
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
  if (gitlab.listing.ok) {
    for (const path of gitlab.paths) {
      const ref = gitlabRef(gitlab.listing.host, path);
      rows.set(ref, { ref, label: path, forge: "gitlab", enabled: enabled.has(ref) });
    }
  }
  for (const ref of enabled) {
    if (rows.has(ref)) continue;
    const described = describeRef(ref);
    const listingOk = described.forge === "gitlab" ? gitlab.listing.ok : github.ok;
    rows.set(ref, { ref, ...described, enabled: true, ...(listingOk ? { listed: false as const } : {}) });
  }
  const repositories = [...rows.values()].sort((a, b) => a.label.localeCompare(b.label) || a.ref.localeCompare(b.ref));
  return { repositories, listing: github.ok ? { ok: true } : { ok: false, reason: github.reason }, gitlab: gitlab.listing };
}
