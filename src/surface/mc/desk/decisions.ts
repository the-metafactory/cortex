import { createHash } from "node:crypto";
import type { Database } from "bun:sqlite";
import { gitlabIssueRef } from "../adapters/gitlab/fetch";
import { DAY_MS, startOfDay } from "./time";

export const DECISION_RETENTION_MS = 90 * DAY_MS;
const MAX_DETAIL = 300;

export type DecisionAction = "ranger.rule" | "ranger.approve" | "ranger.retry" | "ranger.run-now";

type DecisionOutcomeState = "not-requested" | "pending" | "accepted" | "queued" | "failed";

export interface DecisionOutcome {
  state: DecisionOutcomeState;
  detail: string | null;
  at: number;
}

export interface DeskDecision {
  id: string;
  key: string;
  title: string;
  target: { repo: string; nodeId: string; link: string | null };
  action: DecisionAction;
  text: string | null;
  decidedAt: number;
  outcome: DecisionOutcome;
  withdrawable: false;
  supersededBy: { id: string; decidedAt: number } | null;
}

interface DecisionInput {
  operationKey: string;
  itemKey: string;
  action: DecisionAction;
  target: { repo: string; nodeId: string };
  title: string;
  text?: string;
  outcome: { state: DecisionOutcomeState; detail?: string | null };
}

interface Row {
  id: string;
  operation_key: string;
  item_key: string;
  action: DecisionAction;
  repo: string;
  node_id: string;
  title: string;
  text: string | null;
  decided_at: number;
  outcome: DecisionOutcomeState;
  outcome_detail: string | null;
  outcome_at: number;
}

const NODE_ID = /^[1-9]\d*$/;

function decisionLink(repo: string, nodeId: string): string | null {
  if (!NODE_ID.test(nodeId)) return null;
  const gitlab = gitlabIssueRef(repo, nodeId);
  if (gitlab) return `https://${gitlab.host}/${gitlab.path}/-/issues/${gitlab.number}`;
  return /^[\w.-]+\/[\w.-]+$/.test(repo) ? `https://github.com/${repo}/issues/${nodeId}` : null;
}

const decisionId = (operationKey: string): string => `dec-${createHash("sha256").update(operationKey).digest("hex").slice(0, 24)}`;

/** Start of the stack's calendar day and of the next one; the next start moves with a DST change. */
export function decisionDay(now: number): { start: number; end: number } {
  const start = startOfDay(now);
  const next = new Date(start);
  next.setDate(next.getDate() + 1);
  return { start, end: next.getTime() };
}

const oneLine = (text: string | null | undefined): string | null => {
  const line = (text ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_DETAIL);
  return line === "" ? null : line;
};

const project = (row: Row, supersededBy: DeskDecision["supersededBy"]): DeskDecision => ({
  id: row.id,
  key: row.item_key,
  title: row.title,
  target: { repo: row.repo, nodeId: row.node_id, link: decisionLink(row.repo, row.node_id) },
  action: row.action,
  text: row.text,
  decidedAt: row.decided_at,
  outcome: { state: row.outcome, detail: row.outcome_detail, at: row.outcome_at },
  withdrawable: false,
  supersededBy,
});

/**
 * Today's rulings and approvals, kept in the stack's Desk database for 90 days. A write failure is logged and never
 * undoes the graph or Ranger call that already happened.
 */
export class DecisionStore {
  constructor(private readonly db: Database, private readonly clock: () => number = Date.now) {}

  private guard<T>(what: string, fallback: T, operation: () => T): T {
    try {
      return operation();
    } catch (error) {
      console.error(`desk: decision history ${what} failed: ${error instanceof Error ? error.message : String(error)}`);
      return fallback;
    }
  }

  private prune(): void {
    this.db.run("DELETE FROM desk_decisions WHERE decided_at < ?", [this.clock() - DECISION_RETENTION_MS]);
  }

  has(operationKey: string, itemKey: string): boolean {
    return this.guard("lookup", false, () => this.db.query<{ n: number }, [string, string]>("SELECT 1 AS n FROM desk_decisions WHERE operation_key = ? AND item_key = ?").get(operationKey, itemKey) !== null);
  }

  record(input: DecisionInput): string {
    const id = decisionId(input.operationKey);
    const now = this.clock();
    this.guard("write", undefined, () => {
      this.prune();
      this.db.run(
        `INSERT INTO desk_decisions (id, operation_key, item_key, action, repo, node_id, title, text, decided_at, outcome, outcome_detail, outcome_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(operation_key) DO UPDATE SET outcome = excluded.outcome, outcome_detail = excluded.outcome_detail, outcome_at = excluded.outcome_at`,
        [id, input.operationKey, input.itemKey, input.action, input.target.repo, input.target.nodeId, input.title, input.text ?? null, now, input.outcome.state, oneLine(input.outcome.detail), now],
      );
    });
    return id;
  }

  settle(operationKey: string, outcome: DecisionInput["outcome"]): void {
    this.guard("outcome update", undefined, () => {
      this.db.run("UPDATE desk_decisions SET outcome = ?, outcome_detail = ?, outcome_at = ? WHERE operation_key = ? AND NOT (? = 'failed' AND outcome IN ('accepted', 'queued'))", [outcome.state, oneLine(outcome.detail), this.clock(), operationKey, outcome.state]);
    });
  }

  today(now: number = this.clock()): DeskDecision[] {
    this.guard("prune", undefined, () => { this.prune(); });
    return this.guard("read", [], () => readDecisions(this.db, now));
  }
}

/** Every retained decision from the current stack calendar day, newest first with the id as tie-break. */
export function readDecisions(db: Database, now: number): DeskDecision[] {
  const { start, end } = decisionDay(now);
  const rows = db.query<Row, [number, number]>("SELECT id, operation_key, item_key, action, repo, node_id, title, text, decided_at, outcome, outcome_detail, outcome_at FROM desk_decisions WHERE decided_at >= ? AND decided_at <= ?").all(now - DECISION_RETENTION_MS, now);
  const later = new Map<string, DeskDecision["supersededBy"]>();
  const rulings = rows.filter(row => row.action === "ranger.rule").sort((a, b) => a.decided_at - b.decided_at || a.id.localeCompare(b.id));
  const newestByTarget = new Map<string, DeskDecision["supersededBy"]>();
  for (const row of rulings.toReversed()) {
    const target = JSON.stringify([row.repo, row.node_id]);
    later.set(row.id, newestByTarget.get(target) ?? null);
    newestByTarget.set(target, { id: row.id, decidedAt: row.decided_at });
  }
  return rows
    .filter(row => row.decided_at >= start && row.decided_at < end)
    .sort((a, b) => b.decided_at - a.decided_at || a.id.localeCompare(b.id))
    .map(row => project(row, later.get(row.id) ?? null));
}
