import type { Database } from "bun:sqlite";
import { CommandTimeout, runCommand, type CommandResult } from "./spawn";

export const GITHUB_REF_PREFIX = "github:github.com/";

const GITHUB_REF = /^github:github\.com\/[^/\s]+\/[^/\s]+$/;
const GH_TIMEOUT_MS = 30_000;
const GH_LIST_ARGV = ["gh", "api", "--paginate", "user/repos?affiliation=owner,organization_member", "--jq", ".[].full_name"];

export interface GraphRepository {
  ref: string;
  label: string;
  forge: string;
  enabled: boolean;
  listed?: false;
}

export type GraphRepositoryListing = { ok: true } | { ok: false; reason: string };

export interface GraphRepositoryView {
  repositories: GraphRepository[];
  listing: GraphRepositoryListing;
}

export type GraphRepositoryRunner = (argv: string[], timeoutMs: number) => Promise<CommandResult>;

export const githubRef = (fullName: string): string => `${GITHUB_REF_PREFIX}${fullName}`;

export const isGithubRef = (ref: string): boolean => GITHUB_REF.test(ref);

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
  return { forge, label: ref.startsWith(GITHUB_REF_PREFIX) ? ref.slice(GITHUB_REF_PREFIX.length) : ref };
}

const failureReason = (err: unknown): string => (err instanceof CommandTimeout ? `gh ${err.message}` : err instanceof Error ? err.message : String(err));

async function listGithubFullNames(run: GraphRepositoryRunner): Promise<{ ok: true; names: string[] } | { ok: false; reason: string }> {
  let result: CommandResult;
  try {
    result = await run(GH_LIST_ARGV, GH_TIMEOUT_MS);
  } catch (err) {
    return { ok: false, reason: failureReason(err) };
  }
  const firstStderrLine = result.stderr.trim().split("\n")[0] ?? "";
  if (result.code !== 0) return { ok: false, reason: firstStderrLine === "" ? `gh exited with code ${result.code}` : firstStderrLine };
  const names = result.stdout.split("\n").map((line) => line.trim()).filter((line) => /^[^/\s]+\/[^/\s]+$/.test(line));
  return { ok: true, names };
}

/**
 * Every GitHub repository the signed-in `gh` can see (own account and organisations), merged with the stored ticks.
 * A ticked repository the listing does not return stays in the result with `listed: false`; when the listing fails,
 * only the ticked repositories are returned, so they can still be unticked.
 */
export async function listGraphRepositories(db: Database, run: GraphRepositoryRunner = runCommand): Promise<GraphRepositoryView> {
  const enabled = new Set(storedRefs(db));
  const listed = await listGithubFullNames(run);
  const rows = new Map<string, GraphRepository>();
  if (listed.ok) {
    for (const name of listed.names) {
      const ref = githubRef(name);
      rows.set(ref, { ref, label: name, forge: "github", enabled: enabled.has(ref) });
    }
  }
  for (const ref of enabled) {
    if (!rows.has(ref)) rows.set(ref, { ref, ...describeRef(ref), enabled: true, ...(listed.ok ? { listed: false as const } : {}) });
  }
  const repositories = [...rows.values()].sort((a, b) => a.label.localeCompare(b.label) || a.ref.localeCompare(b.ref));
  return { repositories, listing: listed.ok ? { ok: true } : { ok: false, reason: listed.reason } };
}
