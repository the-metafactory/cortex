/**
 * G-1115 — GET /api/governance (governance upgrade Stage 5).
 *
 * Read-only audit surface over `governance_verdicts`: the last-30-days verdict
 * list (capped), the window summary, and a deterministic alarm tier driven by
 * denials in the last 24h. No LLM judgment in an audit surface, and no fake
 * all-clear: the `alarm.note` always names the window measured, and the empty
 * state is the CONSUMER's to render honestly ("no governed pipelines have
 * run" ≠ "everything was allowed").
 */

import type { Database } from "bun:sqlite";

import {
  listRecentVerdicts,
  summarizeGovernance,
  type GovernanceSummary,
  type GovernanceVerdictRow,
} from "../db/governance";

export const GOVERNANCE_WINDOW_DAYS = 30;
export const GOVERNANCE_LIST_CAP = 200;

export type GovernanceAlarmTier = "none" | "elevated" | "high";

export interface GovernanceAlarm {
  tier: GovernanceAlarmTier;
  /** Denials observed in the last 24h — the tier's input, always disclosed. */
  denials24h: number;
  note: string;
}

export interface GovernanceResponse {
  verdicts: GovernanceVerdictRow[];
  summary: GovernanceSummary;
  alarm: GovernanceAlarm;
  windowDays: number;
  listCap: number;
}

/** Deterministic tiering: none (0 denials/24h), elevated (1-4), high (≥5). */
export function alarmFor(denials24h: number): GovernanceAlarm {
  const tier: GovernanceAlarmTier = denials24h === 0 ? "none" : denials24h < 5 ? "elevated" : "high";
  const note =
    tier === "none"
      ? "0 denials in the last 24h (window measured: 24h — absence of denials is not absence of risk)"
      : `${denials24h} denial${denials24h === 1 ? "" : "s"} in the last 24h`;
  return { tier, denials24h, note };
}

export function getGovernance(db: Database): GovernanceResponse {
  const summary = summarizeGovernance(db, GOVERNANCE_WINDOW_DAYS);
  return {
    verdicts: listRecentVerdicts(db, GOVERNANCE_WINDOW_DAYS, GOVERNANCE_LIST_CAP),
    summary,
    alarm: alarmFor(summary.denials24h),
    windowDays: GOVERNANCE_WINDOW_DAYS,
    listCap: GOVERNANCE_LIST_CAP,
  };
}

/** GET /api/governance — verdicts + summary + alarm tier. */
export function handleGetGovernance(db: Database): Response {
  return new Response(JSON.stringify(getGovernance(db)), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
