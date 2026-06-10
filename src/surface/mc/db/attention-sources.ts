/**
 * G-1113.E.2 — attention producers (design §5.5 / §7.4).
 *
 * `reconcileAttention` derives the open attention set from current DB state and
 * upserts it, then auto-resolves any previously-open item whose condition has
 * cleared (acceptance criterion: "items resolve when their condition clears" +
 * the E.1 orphaned-link follow-up). A derive+diff reconciler — rather than
 * hooking every runner/bus emit point — keeps producers idempotent (stable ids)
 * and the whole thing pure + testable. A periodic/event trigger that CALLS it
 * is the integration step (kept minimal, like the D.2/D.5b ingestion split).
 *
 * Sources wired here (the DB-derivable kinds with a clean deep-link):
 *   - blocked assignments → kind from block_reason (permission / review /
 *     blocked), deep-linked via the assignment's session.
 *   - stale work items → kind "stale", deep-linked via the work item
 *     (`att:stale:{wiId}`).
 *   - stale ASSIGNMENTS (MC-I1.S7) → kind "stale", deep-linked via the
 *     assignment's session (`att:stale:asg:{asgId}`). An assignment stuck
 *     non-terminal (queued / dispatched / running) with no recent activity —
 *     "Which sessions are running, stale, or waiting for input?" (design §8).
 *     Last-activity is the assignment's latest `system.agent.heartbeat` event
 *     timestamp (the S6 liveness row), falling back to the assignment's
 *     `updated_at` when no heartbeat has landed.
 *
 * Deferred (documented, NOT silently dropped):
 *   - "failed_dispatch": completed in MC-I1.S7 as an EVENT-DRIVEN producer
 *     (projection/failed-dispatch.ts) — the failure detail (error_summary + the
 *     cortex#249 nak reason) rides the terminal envelope and is not queryable DB
 *     state, so it can't be re-derived here. Its `att:faildis:` namespace is
 *     disjoint from these prefixes; the resolve sweeps below never touch it.
 *   - failing checks: a Check links by commit SHA, with no direct work-item /
 *     session deep-link target (§7.4 requires one) until the check→PR→workItem
 *     chain exists; revisit with that linkage.
 *   - "input_needed": no current block_reason maps to it; a future producer.
 */
import type { Database } from "bun:sqlite";
import type { AttentionItem, AttentionKind, AttentionSeverity, BlockReason } from "../types";
import { listFocusArea } from "./assignments";
import { upsertAttentionItem, listOpenAttention, resolveAttentionItem } from "./attention";
import type { AttentionDelta } from "../attention-notify";

/** Deterministic id prefixes — let re-runs upsert in place + diff for resolution. */
const BLOCK_PREFIX = "att:block:";
const STALE_PREFIX = "att:stale:";
/** Sub-namespace of STALE_PREFIX for stuck ASSIGNMENTS (work items keep the bare prefix). */
const STALE_ASSIGNMENT_PREFIX = "att:stale:asg:";

/** Work-item statuses treated as terminal (never "stale"). GitHub ingest writes open/closed. */
const TERMINAL_WORK_ITEM_STATUSES = new Set(["done", "closed", "cancelled", "completed"]);

/**
 * Assignment states that are NON-terminal AND not already an attention source
 * via the block producer (which owns `blocked`). An assignment in one of these
 * with no recent activity is "stale" — work the principal dispatched that has
 * gone quiet without finishing.
 */
const STALE_ASSIGNMENT_STATES = new Set(["queued", "dispatched", "running"]);

const HEARTBEAT_EVENT_TYPE = "system.agent.heartbeat";

const DEFAULT_STALE_AFTER_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/**
 * A dispatched session goes "stale" far sooner than a planning-board work item:
 * a running CC session that hasn't ticked a heartbeat in an hour is stuck (the
 * runner heartbeats every ~30 s — cortex#361). The work-item threshold (days)
 * tracks a different cadence (a GitHub issue untouched for a week). Both are
 * module constants, not config schema, per the slice's minimal-scope rule — no
 * cockpit knob clearly belongs to either yet; revisit if a stack needs to tune.
 */
const DEFAULT_STALE_ASSIGNMENT_AFTER_MS = 60 * 60 * 1000; // 1 hour

export interface ReconcileAttentionOptions {
  /** Stack/deployment id stamped on produced items. */
  stackId: string;
  /** An open work item untouched longer than this is "stale". Default 7 days. */
  staleAfterMs?: number;
  /**
   * A non-terminal assignment whose most-recent HEARTBEATING session has not
   * ticked a heartbeat within this window is "stale". Default 1 hour — a
   * dispatched CC session heartbeats every ~30 s, so an hour of silence means
   * it's stuck. Only sessions that emit heartbeats are judged (see the stale-asg
   * query) — observed/orphan sessions that never tick are out of scope.
   */
  staleAssignmentAfterMs?: number;
  /** Current time in epoch SECONDS (injectable for deterministic tests). */
  nowEpochSec?: number;
}

export interface ReconcileResult extends AttentionDelta {
  /** The full set of items currently open after this reconcile. */
  open: AttentionItem[];
  // `opened` / `resolved` come from AttentionDelta (the shared notify shape) —
  // ReconcileResult is that delta plus the full `open` snapshot.
}

/** Map a block reason to its attention kind + severity. Exhaustive over BlockReason. */
function blockReasonToAttention(reason: BlockReason): { kind: AttentionKind; severity: AttentionSeverity } {
  switch (reason.kind) {
    case "permission.request":
      return { kind: "permission", severity: "high" };
    case "review.checkpoint":
      return { kind: "review", severity: "normal" };
    case "tool.error":
      return { kind: "blocked", severity: "high" };
  }
}

/**
 * Derive the current open-attention set from DB state, upsert it, and resolve
 * any previously-open reconciled item whose condition has cleared. Idempotent.
 * Returns the items currently derived as open.
 */
export function reconcileAttention(db: Database, opts: ReconcileAttentionOptions): ReconcileResult {
  const nowSec = opts.nowEpochSec ?? Math.floor(Date.now() / 1000);
  const staleBeforeSec = nowSec - Math.floor((opts.staleAfterMs ?? DEFAULT_STALE_AFTER_MS) / 1000);
  const staleAssignmentBeforeSec =
    nowSec - Math.floor((opts.staleAssignmentAfterMs ?? DEFAULT_STALE_ASSIGNMENT_AFTER_MS) / 1000);

  // Snapshot the prior NON-resolved set (open + dismissed) BEFORE mutating, to
  // compute the open/resolve delta (ML.3 — what to notify on) and to respect
  // dismiss. A dismissed item is "seen" — re-deriving it must NOT reopen it or
  // re-notify (the principal said "stop showing me this"). Only an item absent
  // from BOTH open and dismissed (i.e. genuinely new, or previously *resolved*
  // and now recurring) counts as newly opened.
  //
  // NB (PR #873 review nit 1): a RESOLVED item that re-derives DOES re-notify by
  // design — a blocker that cleared and genuinely recurred is exactly what the
  // principal wants surfaced again (the established ML.3 contract, pinned by the
  // "re-notifies after RESOLVE (not dismiss)" test). The nit's flap concern is
  // handled at the producer instead: review major 2 scopes stale-assignment to
  // heartbeating sessions, removing the false-positive flap that motivated it.
  const priorRows = db
    .query(`SELECT id, status FROM attention_items WHERE status IN ('open', 'dismissed')`)
    .all() as { id: string; status: string }[];
  const dismissedIds = new Set(priorRows.filter((r) => r.status === "dismissed").map((r) => r.id));
  const seenBefore = new Set(priorRows.map((r) => r.id)); // open ∪ dismissed

  const derived = new Map<string, AttentionItem>();

  // 1. Blocked assignments (listFocusArea is the state='blocked' projection).
  for (const a of listFocusArea(db)) {
    if (!a.block_reason) continue; // schema guarantees non-null when blocked, but be defensive
    const sessionId = a.session?.id ?? null;
    // §7.4 requires every attention item to deep-link; the session is the only
    // link target for a block-source item (no work-item linkage from an
    // assignment). A blocked assignment with no session therefore has no
    // deep-link target — skip rather than surface an un-actionable item. This
    // honours the invariant the E.1 schema note delegates to the producer.
    // (In practice the three block reasons all originate from a running CC
    // session, so this is an edge; revisit if a session-less block proves real.)
    if (!sessionId) continue;
    const { kind, severity } = blockReasonToAttention(a.block_reason);
    const id = `${BLOCK_PREFIX}${a.id}`;
    derived.set(id, {
      id,
      stackId: opts.stackId,
      workItemId: null,
      sessionId,
      kind,
      severity,
      status: "open",
    });
  }

  // 2. Stale work items (open + untouched past the threshold).
  const staleRows = db
    .query(`SELECT id, status FROM work_items WHERE updated_at < ?`)
    .all(staleBeforeSec) as { id: string; status: string }[];
  for (const w of staleRows) {
    if (TERMINAL_WORK_ITEM_STATUSES.has(w.status.toLowerCase())) continue;
    const id = `${STALE_PREFIX}${w.id}`;
    derived.set(id, {
      id,
      stackId: opts.stackId,
      workItemId: w.id,
      sessionId: null,
      kind: "stale",
      severity: "low",
      status: "open",
    });
  }

  // 3. Stale ASSIGNMENTS (MC-I1.S7) — a non-terminal, non-blocked assignment
  //    whose most-recent session HAS heartbeated and has now gone silent past
  //    the threshold.
  //
  //    SCOPING (PR #873 review major 2): only sessions that emit heartbeats can
  //    be judged stale by a heartbeat-cadence threshold. `attachHeartbeatToCC-
  //    Session` is wired ONLY for controlled CC sessions (dispatch-handler +
  //    review-consumer); `local.observed` + auto-registered orphan sessions
  //    reach `running` via the ingestor but NEVER tick. Their last-activity
  //    would fall back to `updated_at`, which the ingestor bumps on every event
  //    — so a legitimately-quiet observed session (stalled hook stream) crosses
  //    the 1h heartbeat-tuned threshold with no churn and FLAPS an `opened`
  //    notification every cycle.
  //
  //    We therefore require the most-recent session to carry at least one
  //    heartbeat liveness row (INNER-join the latest heartbeat per session).
  //    This is preferred over a hardcoded `endpoint_kind = local.process.con-
  //    trolled` filter because it self-scopes: it tracks the ACTUAL liveness
  //    signal, so if a future endpoint_kind starts heartbeating it's covered
  //    automatically, and a controlled session that somehow never heartbeats
  //    (spawn raced the attach) is correctly excluded rather than false-flagged.
  //
  //    Staleness is then the latest heartbeat's age (NOT MAX'd with `updated_at`
  //    — for a heartbeating session the heartbeat IS the authoritative liveness
  //    signal; `updated_at` churn from unrelated ingest would mask a stuck CC).
  //    The deep-link target (§7.4) is that session.
  const staleStatePlaceholders = [...STALE_ASSIGNMENT_STATES].map(() => "?").join(", ");
  const staleAssignmentRows = db
    .query(
      `SELECT a.id AS assignment_id, s.session_id AS session_id
       FROM agent_task_assignment a
       JOIN (
         SELECT se.assignment_id,
                se.id AS session_id,
                MAX(unixepoch(ev.timestamp)) AS last_heartbeat_sec,
                ROW_NUMBER() OVER (
                  PARTITION BY se.assignment_id ORDER BY se.started_at DESC, se.id DESC
                ) AS rn
         FROM sessions se
         JOIN events ev ON ev.session_id = se.id AND ev.type = ?
         GROUP BY se.id
       ) s ON s.assignment_id = a.id AND s.rn = 1
       WHERE a.state IN (${staleStatePlaceholders})
         AND s.last_heartbeat_sec < ?`,
    )
    .all(HEARTBEAT_EVENT_TYPE, ...STALE_ASSIGNMENT_STATES, staleAssignmentBeforeSec) as {
    assignment_id: string;
    session_id: string;
  }[];
  for (const a of staleAssignmentRows) {
    const id = `${STALE_ASSIGNMENT_PREFIX}${a.assignment_id}`;
    derived.set(id, {
      id,
      stackId: opts.stackId,
      workItemId: null,
      sessionId: a.session_id,
      kind: "stale",
      severity: "normal",
      status: "open",
    });
  }

  // Upsert derived items as open — but NEVER resurrect a dismissed one (skip it,
  // leaving its 'dismissed' status intact so it neither reopens nor re-notifies).
  for (const item of derived.values()) {
    if (dismissedIds.has(item.id)) continue;
    upsertAttentionItem(db, item);
  }

  // newly-opened = derived now but not seen before (not open, not dismissed).
  const opened = [...derived.values()].filter((i) => !seenBefore.has(i.id));

  // Resolve previously-open RECONCILED items whose condition no longer holds
  // (assignment unblocked / work item touched or terminal). Only our own
  // prefixes — never touch items produced by other sources.
  const resolved: AttentionItem[] = [];
  for (const open of listOpenAttention(db)) {
    const reconciled = open.id.startsWith(BLOCK_PREFIX) || open.id.startsWith(STALE_PREFIX);
    if (reconciled && !derived.has(open.id)) {
      resolveAttentionItem(db, open.id);
      resolved.push(open);
    }
  }

  // `open` reflects what's actually open: derived minus the dismissed (skipped) ones.
  const open = [...derived.values()].filter((i) => !dismissedIds.has(i.id));
  return { open, opened, resolved };
}
