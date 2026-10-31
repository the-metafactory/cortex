import type { Database } from "bun:sqlite";
import { oneLine, planRangerAction, retryable, retryKey, spawnRanger, type HandledLedger, type RangerCli, type RangerRunner } from "./actions";
import { rangerItemKey, readRangerState, type RangerFetch, type RangerNeedsYou, type RangerState } from "./sources/ranger";
import { DAY_MS } from "./time";

export const PROMOTABLE = ["ranger.retry", "studio.capture"] as const;
export type PromotableAction = (typeof PROMOTABLE)[number];

export const isPromotable = (id: unknown): id is PromotableAction => PROMOTABLE.includes(id as PromotableAction);

export const PROMOTABLE_LABELS: Record<PromotableAction, { label: string; note: string }> = {
  "studio.capture": { label: "File thoughts in the Studio", note: "Each capture shows its reason and can be undone." },
  "ranger.retry": {
    label: "Retry agent tasks that failed",
    note: "Each task is retried once a day at most. A retry cannot be taken back.",
  },
};

const KEEP_MS = 7 * DAY_MS;

export function listGrants(db: Database): Set<PromotableAction> {
  const rows = db.query<{ action: string }, []>("SELECT action FROM desk_grants").all();
  return new Set(rows.map((r) => r.action).filter(isPromotable));
}

export function setGrant(db: Database, action: PromotableAction, on: boolean, now: number): void {
  if (on) db.query("INSERT INTO desk_grants (action, granted_at) VALUES (?, ?) ON CONFLICT(action) DO NOTHING").run(action, now);
  else db.query("DELETE FROM desk_grants WHERE action = ?").run(action);
}

export interface DoneEntry {
  attemptKey: string;
  action: string;
  itemKey: string;
  title: string;
  status: "running" | "done" | "failed";
  message: string | null;
  createdAt: number;
}

interface DoneRow {
  attempt_key: string;
  action: string;
  item_key: string;
  title: string;
  status: DoneEntry["status"];
  message: string | null;
  created_at: number;
}

export function readDone(db: Database, now: number): DoneEntry[] {
  const rows = db
    .query<DoneRow, [number]>("SELECT attempt_key, action, item_key, title, status, message, created_at FROM desk_done WHERE created_at >= ? ORDER BY created_at DESC")
    .all(now - KEEP_MS);
  return rows.map((r) => ({ attemptKey: r.attempt_key, action: r.action, itemKey: r.item_key, title: r.title, status: r.status, message: r.message, createdAt: r.created_at }));
}

const failedNode = (n: RangerNeedsYou): boolean => n.status === "failed" && n.reason?.class !== "blocked" && retryable(n);

const triedToday = (done: DoneEntry[], itemKey: string, now: number): boolean => done.some((d) => d.itemKey === itemKey && now - d.createdAt < DAY_MS);

export interface AutonomyDeps {
  db: Database;
  rangerUrl: string;
  cli: RangerCli;
  ledger: HandledLedger;
  run?: RangerRunner;
  fetchImpl?: RangerFetch;
  now?: () => number;
}

/**
 * Performs the promoted action types without asking. Today that is Ranger retry: each failed node is retried
 * once a day at most, through the same plan, claim and ledger as the Desk's own button. Every attempt is
 * written to the "Done for you" log before Ranger is called, so a restart cannot send it twice.
 */
export async function runAutonomy(deps: AutonomyDeps): Promise<DoneEntry[]> {
  const { db, ledger, cli } = deps;
  const now = (deps.now ?? Date.now)();
  db.query("DELETE FROM desk_done WHERE created_at < ?").run(now - KEEP_MS);
  if (!listGrants(db).has("ranger.retry") || !cli.bin) return [];
  const state: RangerState | null = await readRangerState(deps.rangerUrl, deps.fetchImpl).catch(() => null);
  if (!state) return [];
  const done = readDone(db, now);
  const results: DoneEntry[] = [];
  for (const n of state.needsYou.filter(failedNode)) {
    const attemptKey = retryKey(n);
    const itemKey = rangerItemKey(`${n.repo}#${n.nodeId}`);
    if (attemptKey === null || ledger.has(attemptKey) || triedToday(done, itemKey, now)) continue;
    if (!listGrants(db).has("ranger.retry")) break;
    const plan = planRangerAction(state, "ranger.retry", itemKey, cli);
    if (typeof plan === "string" || !ledger.claim(plan.claimKey)) continue;
    try {
      const claimed = db
        .query("INSERT INTO desk_done (attempt_key, action, item_key, title, status, created_at, updated_at) VALUES (?, 'ranger.retry', ?, ?, 'running', ?, ?) ON CONFLICT(attempt_key) DO NOTHING")
        .run(attemptKey, itemKey, n.title, now, now).changes > 0;
      if (!claimed) continue;
      const entry = await attempt(deps, plan.argv, plan.done);
      db.query("UPDATE desk_done SET status = ?, message = ?, updated_at = ? WHERE attempt_key = ?").run(entry.status, entry.message, (deps.now ?? Date.now)(), attemptKey);
      if (entry.status === "done") ledger.add(attemptKey, now);
      results.push({ attemptKey, action: "ranger.retry", itemKey, title: n.title, createdAt: now, ...entry });
    } finally {
      ledger.release(plan.claimKey);
    }
  }
  return results;
}

async function attempt(deps: AutonomyDeps, argv: string[], doneText: string): Promise<{ status: "done" | "failed"; message: string }> {
  try {
    const result = await (deps.run ?? spawnRanger)(argv);
    if (result.code === 0) return { status: "done", message: doneText };
    return { status: "failed", message: `Ranger refused: ${oneLine(result.stderr || result.stdout, `exit code ${result.code}`)}` };
  } catch (err) {
    return { status: "failed", message: `Could not run Ranger: ${err instanceof Error ? err.message : String(err)}` };
  }
}
