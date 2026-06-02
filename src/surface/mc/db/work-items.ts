/**
 * G-1113.D.4 — WorkItem storage (design §6). Idempotent upsert by id, get, and
 * list (by phase / by plan); snake_case rows → camelCase domain types. Mirrors
 * the plans / git-objects pattern: provider narrowed via isProvider at the read
 * boundary; `status`/`priority` are open strings (no CHECK), passed through
 * verbatim. Ingestion that fills these (from the umbrella's sub-issues) is a
 * follow-up; D.4 lands the model + storage + phase-detail projection.
 */
import type { Database } from "bun:sqlite";
import type { WorkItem } from "../types";
import { isProvider } from "../types";

interface WorkItemRow {
  id: string;
  plan_id: string | null;
  phase_id: string | null;
  parent_id: string | null;
  title: string;
  description: string | null;
  status: string;
  priority: string;
  provider: string;
  external_id: string | null;
  url: string | null;
}

function rowToWorkItem(r: WorkItemRow): WorkItem {
  return {
    id: r.id,
    planId: r.plan_id,
    phaseId: r.phase_id,
    parentId: r.parent_id,
    title: r.title,
    description: r.description,
    status: r.status,
    priority: r.priority,
    provider: isProvider(r.provider) ? r.provider : "custom",
    externalId: r.external_id,
    url: r.url,
  };
}

/** Insert or update a work item by id (idempotent re-ingestion). */
export function upsertWorkItem(db: Database, wi: WorkItem): void {
  db.query(
    `INSERT INTO work_items
       (id, plan_id, phase_id, parent_id, title, description, status, priority,
        provider, external_id, url)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       plan_id = excluded.plan_id,
       phase_id = excluded.phase_id,
       parent_id = excluded.parent_id,
       title = excluded.title,
       description = excluded.description,
       status = excluded.status,
       priority = excluded.priority,
       provider = excluded.provider,
       external_id = excluded.external_id,
       url = excluded.url,
       updated_at = unixepoch()`
  ).run(
    wi.id,
    wi.planId,
    wi.phaseId,
    wi.parentId,
    wi.title,
    wi.description,
    wi.status,
    wi.priority,
    wi.provider,
    wi.externalId,
    wi.url
  );
}

export function getWorkItem(db: Database, id: string): WorkItem | null {
  const row = db.query(`SELECT * FROM work_items WHERE id = ?`).get(id) as WorkItemRow | null;
  return row ? rowToWorkItem(row) : null;
}

/**
 * Work items filed under a phase, ordered by priority then title (stable on id).
 * NOTE: `priority` is an open string (§6), so this ORDER BY is lexicographic —
 * `'10'` sorts before `'2'`. Faithful to the spec today; when ingestion (#587)
 * lands and a provider emits numeric priorities, revisit whether a numeric-aware
 * sort key is wanted. The behaviour is locked by a test.
 */
export function listWorkItemsForPhase(db: Database, phaseId: string): WorkItem[] {
  const rows = db
    .query(`SELECT * FROM work_items WHERE phase_id = ? ORDER BY priority, title, id`)
    .all(phaseId) as WorkItemRow[];
  return rows.map(rowToWorkItem);
}

/** Work items belonging to a plan (any phase, including unphased). */
export function listWorkItemsForPlan(db: Database, planId: string): WorkItem[] {
  const rows = db
    .query(`SELECT * FROM work_items WHERE plan_id = ? ORDER BY priority, title, id`)
    .all(planId) as WorkItemRow[];
  return rows.map(rowToWorkItem);
}
