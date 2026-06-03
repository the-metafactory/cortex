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
 *   - stale work items → kind "stale", deep-linked via the work item.
 *
 * Deferred (documented, NOT silently dropped):
 *   - "failed_dispatch": a Myelin envelope nak — bus-level, not in the MC DB;
 *     wired when the dispatch-failure event lands a DB record.
 *   - failing checks: a Check links by commit SHA, with no direct work-item /
 *     session deep-link target (§7.4 requires one) until the check→PR→workItem
 *     chain exists; revisit with that linkage.
 *   - "input_needed": no current block_reason maps to it; a future producer.
 */
import type { Database } from "bun:sqlite";
import type { AttentionItem, AttentionKind, AttentionSeverity, BlockReason } from "../types";
import { listFocusArea } from "./assignments";
import { upsertAttentionItem, listOpenAttention, resolveAttentionItem } from "./attention";

/** Deterministic id prefixes — let re-runs upsert in place + diff for resolution. */
const BLOCK_PREFIX = "att:block:";
const STALE_PREFIX = "att:stale:";

/** Work-item statuses treated as terminal (never "stale"). GitHub ingest writes open/closed. */
const TERMINAL_WORK_ITEM_STATUSES = new Set(["done", "closed", "cancelled", "completed"]);

const DEFAULT_STALE_AFTER_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export interface ReconcileAttentionOptions {
  /** Stack/deployment id stamped on produced items. */
  stackId: string;
  /** An open work item untouched longer than this is "stale". Default 7 days. */
  staleAfterMs?: number;
  /** Current time in epoch SECONDS (injectable for deterministic tests). */
  nowEpochSec?: number;
}

export interface ReconcileResult {
  /** The full set of items currently open after this reconcile. */
  open: AttentionItem[];
  /** Items that transitioned absent → open this run (notify "opened"). */
  opened: AttentionItem[];
  /** Items that transitioned open → resolved this run (notify "resolved"). */
  resolved: AttentionItem[];
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

  // Snapshot the prior NON-resolved set (open + dismissed) BEFORE mutating, to
  // compute the open/resolve delta (ML.3 — what to notify on) AND to respect
  // dismiss. A dismissed item is "seen" — re-deriving it must NOT reopen it or
  // re-notify (the principal said "stop showing me this"). Only an item absent
  // from BOTH open and dismissed (i.e. genuinely new, or previously *resolved*
  // and now recurring) counts as newly opened.
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
