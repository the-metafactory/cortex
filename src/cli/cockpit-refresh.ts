/**
 * ML.2 — runnable cockpit-refresh trigger.
 *
 * The runtime entry point that makes the cockpit live: opens the Mission
 * Control DB and runs one `refreshCockpit` pass (plan-doc ingestion →
 * provider-dispatched work-item ingestion → attention reconcile). Invoked by
 * the principal on demand, or on a schedule (launchd/cron):
 *
 *   bun src/cli/cockpit-refresh.ts --docs ./docs --repo the-metafactory/cortex --stack laptop [--db <path>]
 *
 * The arg parser + run logic are exported (deps injected) so the wiring is
 * unit-testable without touching the real FS / DB; `import.meta.main` runs it
 * with the production deps.
 */
import type { Database } from "bun:sqlite";
import { initDatabase } from "../surface/mc/db/init";
import { DEFAULT_CONFIG } from "../surface/mc/config";
import { refreshCockpit, defaultWorkItemSourceFor, type RefreshResult } from "../surface/mc/refresh";

export interface CockpitRefreshArgs {
  docsDir: string;
  /** Default repo for qualifying short umbrella refs + building doc URLs. */
  repo?: { owner: string; repo: string };
  stackId: string;
  /** Override the MC DB path (defaults to the configured location). */
  dbPath?: string;
}

/** Read `--flag value` from argv. */
function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
}

/** Parse CLI args. Returns `{ error }` on a usage problem (exit code 2). */
export function parseCockpitRefreshArgs(argv: string[]): CockpitRefreshArgs | { error: string } {
  const docsDir = flag(argv, "docs");
  if (!docsDir) return { error: "--docs <dir> is required" };
  const stackId = flag(argv, "stack");
  if (!stackId) return { error: "--stack <id> is required" };

  let repo: { owner: string; repo: string } | undefined;
  const repoArg = flag(argv, "repo");
  if (repoArg !== undefined) {
    const parts = repoArg.split("/");
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
      return { error: `--repo must be owner/name (got "${repoArg}")` };
    }
    repo = { owner: parts[0], repo: parts[1] };
  }

  return { docsDir, stackId, repo, dbPath: flag(argv, "db") };
}

export interface CockpitRefreshDeps {
  openDb: (path: string) => Database;
  refresh: typeof refreshCockpit;
}

export interface CockpitRefreshOutcome {
  code: number;
  result?: RefreshResult;
  error?: string;
}

/** Parse args, open the DB, run one refresh. Deps injected for testability. */
export async function runCockpitRefresh(argv: string[], deps: CockpitRefreshDeps): Promise<CockpitRefreshOutcome> {
  const parsed = parseCockpitRefreshArgs(argv);
  if ("error" in parsed) return { code: 2, error: parsed.error };

  const db = deps.openDb(parsed.dbPath ?? DEFAULT_CONFIG.db.path);
  const result = await deps.refresh(db, {
    docsDir: parsed.docsDir,
    stackId: parsed.stackId,
    defaultRepo: parsed.repo,
    urlForPath: parsed.repo
      ? (rel) => `https://github.com/${parsed.repo?.owner}/${parsed.repo?.repo}/blob/main/${rel}`
      : undefined,
    workItemSourceFor: defaultWorkItemSourceFor,
  });
  return { code: 0, result };
}

if (import.meta.main) {
  void runCockpitRefresh(process.argv.slice(2), { openDb: initDatabase, refresh: refreshCockpit }).then(
    ({ code, result, error }) => {
      if (error !== undefined) {
        process.stderr.write(`cockpit-refresh: ${error}\n`);
      } else {
        process.stdout.write(`cockpit-refresh: ${JSON.stringify(result)}\n`);
      }
      process.exit(code);
    }
  );
}
