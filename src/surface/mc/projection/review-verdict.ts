/**
 * MC-I1.S6 (#848, ADR-0005 §4) — project `review.verdict.*` envelopes into MC.
 *
 * A verdict is the reviewing agent's decision on a PR. The review pipeline
 * correlates a verdict to its request via `correlation_id` = the request
 * envelope's `id` (see `bus/review-events.ts` §5.1). The dispatch-lifecycle
 * projection (S4) keys its MC anchor on that SAME `correlation_id` (the review
 * consumer emits `dispatch.task.*` lifecycle envelopes carrying the request id
 * as their correlation_id). So a verdict whose `correlation_id` matches a
 * projected dispatch anchor JOINS onto that session — the working grid shows
 * "Echo reviewed PR #861: changes-requested" against the right tile.
 *
 * **Join strategy (stated in the PR).** Verdicts carry `repo` + `pr` in the
 * payload, NOT an MC task id. Two join paths, in priority order:
 *   1. `correlation_id` → the dispatch anchor's session (the strong join — the
 *      review consumer's lifecycle envelopes share the verdict's correlation_id).
 *   2. No matching anchor → store as an UNATTACHED MC event on the orphan
 *      catch-all session for the verdict (a per-verdict observed anchor), so the
 *      verdict is never silently dropped. (repo+pr alone don't reliably resolve
 *      to a local session — MC tasks carry GitHub SourceRefs but a verdict for a
 *      peer's PR has no local task; the correlation_id join is the only sound
 *      one, so the fallback is "keep it, unattached" rather than a fuzzy match.)
 *
 * The verdict lands as an `events` row (type `review.verdict`) on the joined
 * session — surfaces render it from the session's recent-events feed, the same
 * channel hook events use. Idempotent on `(session, envelope.id)`: a redelivered
 * verdict with the same envelope id is not double-inserted.
 *
 * Non-throwing: malformed payloads return null (no-op); the renderer's catch is
 * the outer belt.
 */

import type { Database } from "bun:sqlite";

import { insertEvent } from "../db/events";
import { ensureAgentRow } from "../db/agents";
import { registerOrphanSession } from "../db/sessions";
import { findAnchorSession } from "./anchor";

/** The three verdict kinds (mirror `bus/review-events.ts:ReviewVerdictKind`). */
const VERDICT_KINDS = new Set(["approved", "changes-requested", "commented"]);

/** Minimal projectable shape — the renderer hands any validated envelope here. */
export interface ProjectableVerdictEnvelope {
  id?: string;
  type: string;
  correlation_id?: string;
  payload: Record<string, unknown>;
}

export interface VerdictProjectionResult {
  /** Whether the verdict joined a dispatch anchor (true) or landed unattached (false). */
  attached: boolean;
  /** MC session the verdict event landed on. */
  sessionId: string;
  /** The verdict kind projected. */
  verdict: string;
  /** The MC event id created. */
  eventId: string;
}

const VERDICT_EVENT_TYPE = "review.verdict";

/**
 * Project one `review.verdict.*` envelope into MC. Returns null for any
 * non-verdict type (the authoritative filter — the renderer subscribes broadly)
 * or a malformed payload.
 */
export function projectReviewVerdict(
  db: Database,
  envelope: ProjectableVerdictEnvelope,
): VerdictProjectionResult | null {
  const kind = verdictKind(envelope.type);
  if (kind === null) return null;

  const rawPayload: unknown = envelope.payload;
  const payload =
    typeof rawPayload === "object" && rawPayload !== null
      ? (rawPayload as Record<string, unknown>)
      : {};

  const verdict = asString(payload.verdict) ?? kind;
  const repo = asString(payload.repo);
  const pr = asNumber(payload.pr);
  const reviewer = asString(payload.reviewer) ?? "reviewer";
  if (repo === null || pr === null) {
    process.stderr.write(
      `[mission-control] verdict-projection: ignoring ${envelope.type} — missing repo/pr\n`,
    );
    return null;
  }

  const correlationId = asString(envelope.correlation_id);
  const envelopeId = asString(envelope.id);

  const eventPayload: Record<string, unknown> = {
    verdict,
    repo,
    pr,
    reviewer,
    ...(asString(payload.summary) !== null && { summary: payload.summary }),
    ...(asString(payload.github_review_url) !== null && {
      github_review_url: payload.github_review_url,
    }),
    ...(payload.findings !== undefined && { findings: payload.findings }),
    ...(asString(payload.presentation) !== null && {
      presentation: payload.presentation,
    }),
    ...(envelopeId !== null && { envelope_id: envelopeId }),
  };

  const txn = db.transaction((): VerdictProjectionResult => {
    // 1. Strong join: a dispatch anchor for this correlation_id.
    const joined =
      correlationId !== null
        ? findAnchorSession(db, correlationId)
        : null;

    if (joined !== null) {
      // Idempotency: skip if this exact verdict envelope already landed on
      // the session (redelivery).
      if (envelopeId !== null && verdictEventExists(db, joined, envelopeId)) {
        return existingResult(db, joined, verdict, envelopeId, true);
      }
      const ev = insertEvent(db, {
        sessionId: joined,
        type: VERDICT_EVENT_TYPE,
        payload: eventPayload,
      });
      return { attached: true, sessionId: joined, verdict, eventId: ev.id };
    }

    // 2. Fallback: unattached. Anchor a per-verdict observed session keyed on a
    //    synthetic cc id (repo#pr + envelope id) so redelivery dedupes, then
    //    store the verdict event on it. Never silently drop the verdict.
    const syntheticCc = `verdict:${repo}#${pr}:${envelopeId ?? correlationId ?? "anon"}`;
    const existingSession = findSessionByCcId(db, syntheticCc);
    const sessionId = existingSession ?? anchorUnattachedVerdict(db, syntheticCc, reviewer);

    if (
      existingSession !== null &&
      envelopeId !== null &&
      verdictEventExists(db, sessionId, envelopeId)
    ) {
      return existingResult(db, sessionId, verdict, envelopeId, false);
    }

    const ev = insertEvent(db, {
      sessionId,
      type: VERDICT_EVENT_TYPE,
      payload: eventPayload,
    });
    return { attached: false, sessionId, verdict, eventId: ev.id };
  });

  return txn();
}

// ---------------------------------------------------------------------------
// Joins
// ---------------------------------------------------------------------------

function findSessionByCcId(db: Database, ccSessionId: string): string | null {
  const row = db
    .query(`SELECT id FROM sessions WHERE cc_session_id = ? LIMIT 1`)
    .get(ccSessionId) as { id: string } | null;
  return row ? row.id : null;
}

/**
 * Anchor an unattached verdict on a per-verdict observed session. Reuses the S5
 * orphan pattern (synthetic task + per-anchor agent + assignment + session) so
 * the verdict is reachable through the same assignment-anchored joins the
 * working grid uses. The agent is a `head`/non-persistent reviewer tile.
 */
function anchorUnattachedVerdict(
  db: Database,
  syntheticCc: string,
  reviewer: string,
): string {
  // ST-P2: registerOrphanSession now resolves the OWNING agent from the
  // identity we pass (here: the reviewer label as displayName) rather than
  // minting a per-session agent. Distinct reviewers fold to one agent each.
  const orphan = registerOrphanSession(db, syntheticCc, {
    displayName: `${reviewer} (verdict)`,
  });
  if (orphan !== null) {
    // The reviewer label rides as the display name on both the resolved owning
    // agent (insert-only) and the session's agent_name column. Nothing else.
    return orphan.sessionId;
  }
  // Race: another writer created it between our miss + the insert. Re-find.
  const found = findSessionByCcId(db, syntheticCc);
  if (found !== null) return found;
  // Should not happen (registerOrphanSession only returns null when a session
  // already exists for the cc id), but keep the helper total: stamp the agent
  // and surface the error rather than throwing out of render().
  ensureAgentRow(db, {
    id: `verdict-${syntheticCc}`,
    name: `${reviewer} (verdict)`,
    type: "head",
    persistent: false,
  });
  throw new Error(
    `verdict-projection: could not anchor unattached verdict for ${syntheticCc}`,
  );
}

function verdictEventExists(
  db: Database,
  sessionId: string,
  envelopeId: string,
): boolean {
  const row = db
    .query(
      `SELECT 1 FROM events
       WHERE session_id = ? AND type = ? AND json_extract(payload, '$.envelope_id') = ?
       LIMIT 1`,
    )
    .get(sessionId, VERDICT_EVENT_TYPE, envelopeId);
  return row !== null;
}

function existingResult(
  db: Database,
  sessionId: string,
  verdict: string,
  envelopeId: string,
  attached: boolean,
): VerdictProjectionResult {
  const row = db
    .query(
      `SELECT id FROM events
       WHERE session_id = ? AND type = ? AND json_extract(payload, '$.envelope_id') = ?
       LIMIT 1`,
    )
    .get(sessionId, VERDICT_EVENT_TYPE, envelopeId) as { id: string } | null;
  return {
    attached,
    sessionId,
    verdict,
    eventId: row?.id ?? "",
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function verdictKind(type: string): string | null {
  const prefix = "review.verdict.";
  if (!type.startsWith(prefix)) return null;
  const kind = type.slice(prefix.length);
  return VERDICT_KINDS.has(kind) ? kind : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
