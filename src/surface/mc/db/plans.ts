/**
 * G-1113.D.1 — Plan + PlanPhase storage (design §6). Idempotent upsert by id,
 * get, and list; snake_case rows → camelCase domain types. Mirrors the Phase-C
 * git-objects pattern: provider narrowed via isProvider at the read boundary;
 * CHECK-backed enums cast. Ingestion that fills these from plan docs is D.2.
 */
import type { Database } from "bun:sqlite";
import type { Plan, PlanKind, PlanStatus, PlanPhase, PlanPhaseStatus } from "../types";
import { isProvider } from "../types";

interface PlanRow {
  id: string;
  title: string;
  kind: string;
  source_document_url: string | null;
  provider: string;
  external_id: string | null;
  umbrella_work_item_id: string | null;
  status: string;
}

function rowToPlan(r: PlanRow): Plan {
  return {
    id: r.id,
    title: r.title,
    kind: r.kind as PlanKind, // CHECK-constrained
    sourceDocumentUrl: r.source_document_url,
    provider: isProvider(r.provider) ? r.provider : "custom",
    externalId: r.external_id,
    umbrellaWorkItemId: r.umbrella_work_item_id,
    status: r.status as PlanStatus, // CHECK-constrained
  };
}

/** Insert or update a plan by id (idempotent re-ingestion). */
export function upsertPlan(db: Database, plan: Plan): void {
  db.query(
    `INSERT INTO plans
       (id, title, kind, source_document_url, provider, external_id,
        umbrella_work_item_id, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       title = excluded.title,
       kind = excluded.kind,
       source_document_url = excluded.source_document_url,
       provider = excluded.provider,
       external_id = excluded.external_id,
       umbrella_work_item_id = excluded.umbrella_work_item_id,
       status = excluded.status,
       updated_at = unixepoch()`
  ).run(
    plan.id,
    plan.title,
    plan.kind,
    plan.sourceDocumentUrl,
    plan.provider,
    plan.externalId,
    plan.umbrellaWorkItemId,
    plan.status
  );
}

export function getPlan(db: Database, id: string): Plan | null {
  const row = db.query(`SELECT * FROM plans WHERE id = ?`).get(id) as PlanRow | null;
  return row ? rowToPlan(row) : null;
}

export function listPlans(db: Database): Plan[] {
  const rows = db.query(`SELECT * FROM plans ORDER BY title`).all() as PlanRow[];
  return rows.map(rowToPlan);
}

interface PlanPhaseRow {
  id: string;
  plan_id: string;
  title: string;
  phase_order: number;
  status: string;
}

function rowToPlanPhase(r: PlanPhaseRow): PlanPhase {
  return {
    id: r.id,
    planId: r.plan_id,
    title: r.title,
    order: r.phase_order,
    status: r.status as PlanPhaseStatus, // CHECK-constrained
  };
}

/** Insert or update a plan phase by id (idempotent re-ingestion). */
export function upsertPlanPhase(db: Database, phase: PlanPhase): void {
  db.query(
    `INSERT INTO plan_phases (id, plan_id, title, phase_order, status)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       plan_id = excluded.plan_id,
       title = excluded.title,
       phase_order = excluded.phase_order,
       status = excluded.status,
       updated_at = unixepoch()`
  ).run(phase.id, phase.planId, phase.title, phase.order, phase.status);
}

export function getPlanPhase(db: Database, id: string): PlanPhase | null {
  const row = db.query(`SELECT * FROM plan_phases WHERE id = ?`).get(id) as PlanPhaseRow | null;
  return row ? rowToPlanPhase(row) : null;
}

export function listPhasesForPlan(db: Database, planId: string): PlanPhase[] {
  const rows = db
    .query(`SELECT * FROM plan_phases WHERE plan_id = ? ORDER BY phase_order, id`)
    .all(planId) as PlanPhaseRow[];
  return rows.map(rowToPlanPhase);
}
