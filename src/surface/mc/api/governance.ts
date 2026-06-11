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
  listRecentDenials,
  summarizeDenials,
  type GovernanceSummary,
  type GovernanceVerdictRow,
  type GovernanceDenialRow,
  type GovernanceDenialSummary,
} from "../db/governance";

export const GOVERNANCE_WINDOW_DAYS = 30;
export const GOVERNANCE_LIST_CAP = 200;

export type GovernanceAlarmTier = "none" | "elevated" | "high";

export interface GovernanceAlarm {
  tier: GovernanceAlarmTier;
  /**
   * The tier's input: verdict denials + access denials/refusals observed in the
   * last 24h, combined. Always disclosed (no opaque tiering).
   */
  denials24h: number;
  note: string;
}

export interface GovernanceResponse {
  /** Governed-action verdict rows (governance.verdict.*). */
  verdicts: GovernanceVerdictRow[];
  summary: GovernanceSummary;
  /**
   * P-14 U3.1 (#936) — access-gate denial rows (U0.2's system.access.*), newest
   * first. Refusals (sovereignty subset) carry `isRefusal: true`.
   */
  denials: GovernanceDenialRow[];
  denialSummary: GovernanceDenialSummary;
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
      : `${denials24h} denial${denials24h === 1 ? "" : "s"} in the last 24h (verdict denials + access denials/refusals)`;
  return { tier, denials24h, note };
}

export function getGovernance(db: Database): GovernanceResponse {
  const summary = summarizeGovernance(db, GOVERNANCE_WINDOW_DAYS);
  const denialSummary = summarizeDenials(db, GOVERNANCE_WINDOW_DAYS);
  // The alarm tier combines the governed-action verdict denials with the
  // access-gate denials/refusals over the SAME 24h window — both are governance
  // "no" signals, so a spike in either should raise the banner.
  const combined24h = summary.denials24h + denialSummary.denials24h;
  return {
    verdicts: listRecentVerdicts(db, GOVERNANCE_WINDOW_DAYS, GOVERNANCE_LIST_CAP),
    summary,
    denials: listRecentDenials(db, GOVERNANCE_WINDOW_DAYS, GOVERNANCE_LIST_CAP),
    denialSummary,
    alarm: alarmFor(combined24h),
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
