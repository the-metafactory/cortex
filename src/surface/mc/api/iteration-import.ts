/**
 * Grove Mission Control v3 — F-17 GitHub iteration auto-import.
 *
 * Pure import functions that turn a normalised GitHub issue payload
 * (parent issue with the principal-configured `iteration` label, or a
 * sub-issue of a tracked parent) into Grove iteration / task rows.
 *
 * Two callers:
 *   1. The webhook receiver in `api/handlers.ts` (POST /api/github/webhook)
 *      — wired to the existing `webhook-proxy` fan-out so issues +
 *      sub-issues stream in without a new GitHub subscription.
 *   2. The principal-driven path `POST /api/iterations/from-github` —
 *      lets the principal import an existing labelled issue without
 *      waiting for the next webhook event (and to backfill labelled
 *      issues that pre-date the webhook subscription).
 *
 * Design references (`docs/design-mc-iteration-planning.md`):
 *   - Decision 1 — Grove owns the lifecycle. Source is import-only.
 *   - Decision 2 — GitHub parent-issue + sub-issues IS the iteration.
 *   - Decision 7 — GitHub-only in v1 (other adapters are Phase G).
 *   - Decision 9 — Source is upstream-only. No write-back, ever.
 *
 * Keep this module pure relative to:
 *   - HTTP framing — handlers wrap the result in Response objects.
 *   - WebSocket broadcast — handlers fire `broadcastIterationCreated`
 *     after the import succeeds; this file never touches `WsClientRegistry`.
 *   - GitHub I/O — the principal-driven path fetches via `gh` CLI in the
 *     handler and passes the parsed metadata to `importIterationFromMetadata`.
 *     The webhook path receives the metadata extracted from the payload.
 *
 * The split keeps the import logic unit-testable without a live HTTP
 * server, a real `gh` CLI, or a WebSocket fan-out. Mirrors the
 * `iteration-status.ts` / `iteration-transitions.ts` discipline.
 */

import type { Database } from "bun:sqlite";
import {
  createIteration,
  findIterationBySourceParentRef,
  updateIterationImportedBody,
  type IterationRow,
} from "../db/iterations";
import { generateId } from "../db/events";
import {
  canonicalRef,
  // D.7b — the GitHub payload parsers + their neutral output shapes now live
  // behind the adapter boundary; iteration-import consumes the neutral types.
  type ParentIssueMetadata,
  type SubIssueMetadata,
} from "../adapters/github";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Default GitHub label that marks an issue as a Grove iteration parent.
 * Per Decision 10 Q6 ("explicit label `iteration` (or configurable
 * per-repo); avoids accidental promotion of unrelated parent issues").
 *
 * Principals override per-network via `iterationLabel` in the network
 * yaml; the absence of an override falls through to this default. The
 * label match is case-sensitive — GitHub itself preserves label case
 * exactly and treats `Iteration` as a different label from `iteration`,
 * so we follow suit rather than smuggling in a normaliser the principal
 * wouldn't predict from looking at GitHub directly.
 */
export const DEFAULT_ITERATION_LABEL = "iteration";

/**
 * Soft cap on imported body bytes. Mirrors `ITERATION_BODY_MAX_BYTES`
 * in `api/handlers.ts` (50 KB) — the dashboard's iteration body editor
 * caps writes at 50 KB and the schema accepts arbitrarily long values
 * but the import path defends the principal from a malicious 5 MB
 * GitHub issue body landing in the kanban as an outlier row.
 *
 * Truncation is at the byte boundary (not the character boundary): we
 * slice the string conservatively and let the DB store fewer bytes
 * than the cap rather than risk emitting a malformed UTF-8 sequence.
 * The original body is in GitHub anyway — truncation is loss-less for
 * the principal who clicks through to the source URL.
 */
export const IMPORTED_BODY_MAX_BYTES = 50 * 1024;

// ---------------------------------------------------------------------------
// Input shapes
// ---------------------------------------------------------------------------

// D.7b — `ParentIssueMetadata` / `SubIssueMetadata` (the neutral shapes the
// import functions below consume) are defined in `adapters/github/iteration-webhook`
// alongside the GitHub parsers that produce them, and imported above. They're
// re-exported here so existing `from "./iteration-import"` consumers stay green.
export type { ParentIssueMetadata, SubIssueMetadata } from "../adapters/github";

/**
 * Per-network options. Both fields default sensibly so callers can
 * pass `{}` when the network's settings are at their defaults.
 */
export interface ImportOptions {
  /**
   * Override the iteration label. Falls through to
   * `DEFAULT_ITERATION_LABEL` ("iteration") when unset.
   */
  iterationLabel?: string;
}

// ---------------------------------------------------------------------------
// Result shapes (discriminated unions — caller maps to HTTP status)
// ---------------------------------------------------------------------------

/**
 * Parent-issue import outcome. Discriminated union so the caller can
 * tell idempotent re-import (200) from fresh import (201) from
 * non-iteration-labelled (409 — principal-driven path) from
 * upstream-changed-body (200 with a refresh tag).
 */
export type ImportIterationResult =
  | { kind: "created"; iteration: IterationRow }
  | { kind: "exists"; iteration: IterationRow; bodyRefreshed: boolean }
  | { kind: "not_iteration_labelled"; canonical: string }
  | { kind: "invalid_metadata"; reason: string };

/**
 * Sub-issue import outcome. Discriminated union mirrors the parent
 * shape — fresh attach (201), idempotent re-attach (200), parent-
 * not-tracked (no-op — the webhook fires for sub-issue events on
 * issues whose parent isn't (yet) labelled `iteration`; we don't want
 * to surface every such event as an error).
 */
export type ImportSubIssueResult =
  | { kind: "attached"; taskId: string; iterationId: string }
  | { kind: "exists"; taskId: string; iterationId: string }
  | { kind: "parent_not_tracked"; parentRef: string }
  | { kind: "invalid_metadata"; reason: string };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * True iff the given label set marks the issue as a Grove iteration
 * parent. Case-sensitive comparison per the rationale on
 * `DEFAULT_ITERATION_LABEL` above.
 */
export function hasIterationLabel(
  labels: readonly string[],
  iterationLabel: string = DEFAULT_ITERATION_LABEL
): boolean {
  return labels.includes(iterationLabel);
}

/**
 * Canonical `owner/repo#N` string for an issue. Mirrors F-12b's
 * `canonicalRef` (and is used as the dedup key in
 * `iterations.source_parent_ref`).
 */
export function parentRef(meta: {
  owner: string;
  repo: string;
  number: number;
}): string {
  return canonicalRef({
    owner: meta.owner,
    repo: meta.repo,
    number: meta.number,
  });
}

/**
 * Truncate a string to at most `maxBytes` UTF-8 bytes. Used to clamp
 * `imported_body` so a pathological GitHub issue body doesn't bloat
 * the iteration row.
 *
 * The truncation walks back from the byte boundary until it lands on
 * a UTF-8 codepoint boundary so we don't emit a malformed surrogate.
 * Returns the original string when it's already short enough.
 */
export function truncateToBytes(input: string, maxBytes: number): string {
  if (Buffer.byteLength(input, "utf8") <= maxBytes) return input;
  // Conservative slice + back off from any half-codepoint at the tail.
  // Slicing by `slice(0, maxBytes)` works on character indices, not
  // bytes, so we encode to bytes, truncate, then decode back; the
  // decoder fatal=false path replaces a partial trailing sequence
  // with U+FFFD which we then strip.
  const enc = new TextEncoder();
  const dec = new TextDecoder("utf-8", { fatal: false });
  const bytes = enc.encode(input).slice(0, maxBytes);
  let out = dec.decode(bytes);
  // Strip a single trailing replacement char if the slice landed
  // mid-codepoint. (Multiple trailing replacement chars are real
  // U+FFFD in the input and we leave them.)
  if (out.endsWith("�") && !input.endsWith("�")) {
    out = out.slice(0, -1);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Parent-issue import (the iteration row)
// ---------------------------------------------------------------------------

/**
 * Import (or refresh) a Grove iteration row from a normalised
 * GitHub parent-issue metadata.
 *
 * Behaviour:
 *   - If `meta` doesn't carry the configured iteration label, returns
 *     `{ kind: "not_iteration_labelled" }` and writes nothing. The
 *     webhook caller treats this as a no-op; the principal-driven
 *     `POST /api/iterations/from-github` caller surfaces it as 400.
 *   - If a Grove iteration with this `source_parent_ref` already
 *     exists, the principal-editable `body` / `title` / `priority` /
 *     `state` are LEFT UNCHANGED (Decision 9 — no write-back / no
 *     upstream-clobber). Only the audit-only `imported_body` snapshot
 *     is refreshed when the upstream body actually changed; otherwise
 *     the call is a true no-op (no write, no `updated_at` bump).
 *   - On fresh import the row lands with `state = 'inbox'`,
 *     `priority = 2`, `body` initialised from the (truncated) upstream
 *     body, and `imported_body` snapshotted equal to the upstream body.
 *     The principal then drags it from inbox → designing in the kanban
 *     (Decision 5 — explicit principal action, no auto-promote).
 *
 * Idempotent: calling repeatedly with the same upstream body is a
 * no-op after the first call.
 */
export function importIterationFromMetadata(
  db: Database,
  meta: ParentIssueMetadata,
  opts: ImportOptions = {}
): ImportIterationResult {
  // Defensive validation — the principal-driven path passes parsed
  // metadata that we mostly trust, but the webhook path is fed
  // attacker-controlled JSON. Keep the rejection path local so the
  // caller doesn't have to re-validate.
  if (
    typeof meta.owner !== "string" ||
    typeof meta.repo !== "string" ||
    typeof meta.title !== "string"
  ) {
    return { kind: "invalid_metadata", reason: "owner/repo/title must be strings" };
  }
  if (!Number.isFinite(meta.number) || !Number.isInteger(meta.number) || meta.number <= 0) {
    return { kind: "invalid_metadata", reason: "number must be a positive integer" };
  }
  if (typeof meta.htmlUrl !== "string" || meta.htmlUrl.length === 0) {
    return { kind: "invalid_metadata", reason: "htmlUrl must be a non-empty string" };
  }
  if (!Array.isArray(meta.labels)) {
    return { kind: "invalid_metadata", reason: "labels must be an array" };
  }

  const iterationLabel = opts.iterationLabel ?? DEFAULT_ITERATION_LABEL;

  if (!hasIterationLabel(meta.labels, iterationLabel)) {
    return {
      kind: "not_iteration_labelled",
      canonical: parentRef(meta),
    };
  }

  const canonical = parentRef(meta);
  const importedBody =
    typeof meta.body === "string" && meta.body.length > 0
      ? truncateToBytes(meta.body, IMPORTED_BODY_MAX_BYTES)
      : null;

  // Idempotency check — already imported.
  const existing = findIterationBySourceParentRef(db, "github", canonical);
  if (existing) {
    // Refresh the audit snapshot when the upstream body changed;
    // never touch the principal-editable `body` / `title` / `priority`
    // / `state` (Decision 9 — no upstream-clobber).
    if (existing.imported_body !== importedBody) {
      updateIterationImportedBody(db, existing.id, importedBody);
      // Re-read so the caller observes the freshened `imported_body`
      // + bumped `updated_at` consistently.
      const refreshed = findIterationBySourceParentRef(db, "github", canonical);
      // Defensive — re-read should never miss; if it does, fall back
      // to the pre-refresh row (so callers don't see a phantom null).
      return {
        kind: "exists",
        iteration: refreshed ?? existing,
        bodyRefreshed: true,
      };
    }
    return { kind: "exists", iteration: existing, bodyRefreshed: false };
  }

  // Fresh import. The new row lands in `inbox` (Decision 5 — principal
  // promotes to `designing` explicitly). `body` is seeded from the
  // upstream body so the kanban card has something readable on day
  // one; `imported_body` keeps the same value as the audit snapshot
  // (the two diverge as soon as the principal edits the live body).
  const id = generateId();
  const row = createIteration(db, {
    id,
    title: meta.title,
    body: importedBody,
    imported_body: importedBody,
    priority: 2,
    state: "inbox",
    source_system: "github",
    source_url: meta.htmlUrl,
    source_parent_ref: canonical,
    imported_at: Math.floor(Date.now() / 1000),
  });
  return { kind: "created", iteration: row };
}

// ---------------------------------------------------------------------------
// Sub-issue import (a child task on the iteration)
// ---------------------------------------------------------------------------

/**
 * Import (or refresh) a Grove task row for a GitHub sub-issue of a
 * tracked parent.
 *
 * The "tracked parent" gate is:
 *   - There is a Grove `iterations` row whose `source_parent_ref`
 *     matches the sub-issue's parent canonical ref.
 * Otherwise the sub-issue event is a no-op (the parent isn't an
 * iteration as far as Grove is concerned).
 *
 * Idempotent on `tasks.source_external_id` — repeated imports of the
 * same sub-issue update the task title and status if they changed,
 * but never duplicate the row.
 *
 * Does NOT broadcast — the caller fires `broadcastTaskUpdated` /
 * `broadcastIterationDetailUpdated` after the write commits.
 */
export function importSubIssueFromMetadata(
  db: Database,
  parent: { owner: string; repo: string; number: number },
  child: SubIssueMetadata,
  _opts: ImportOptions = {}
): ImportSubIssueResult {
  if (
    typeof child.owner !== "string" ||
    typeof child.repo !== "string" ||
    typeof child.title !== "string"
  ) {
    return { kind: "invalid_metadata", reason: "owner/repo/title must be strings" };
  }
  if (!Number.isFinite(child.number) || !Number.isInteger(child.number) || child.number <= 0) {
    return { kind: "invalid_metadata", reason: "number must be a positive integer" };
  }
  if (typeof child.htmlUrl !== "string" || child.htmlUrl.length === 0) {
    return { kind: "invalid_metadata", reason: "htmlUrl must be a non-empty string" };
  }

  const parentCanonical = parentRef(parent);
  const childCanonical = parentRef(child);

  // Parent-tracked gate. The lookup is one indexed query (composite
  // on `source_system` + `source_parent_ref`); cheap enough to do on
  // every sub-issue event without caching.
  const parentIteration = findIterationBySourceParentRef(
    db,
    "github",
    parentCanonical
  );
  if (!parentIteration) {
    return { kind: "parent_not_tracked", parentRef: parentCanonical };
  }

  // Idempotency — task already exists for this sub-issue.
  const existing = db
    .query(
      `SELECT id, iteration_id, title, status
       FROM tasks
       WHERE source_system = 'github' AND source_external_id = ?`
    )
    .get(childCanonical) as
    | { id: string; iteration_id: string | null; title: string; status: string }
    | null;

  if (existing) {
    // Refresh title and status if they drifted upstream. Patch the
    // `iteration_id` if it's null or pointing at a different parent
    // (rare — happens when the parent label was added late, after
    // the child task was first imported as a stand-alone task).
    const desiredStatus = child.state === "closed" ? "done" : "open";
    const sets: string[] = [];
    const params: unknown[] = [];
    if (existing.title !== child.title) {
      sets.push("title = ?");
      params.push(child.title);
    }
    if (existing.status !== desiredStatus) {
      sets.push("status = ?");
      params.push(desiredStatus);
    }
    if (existing.iteration_id !== parentIteration.id) {
      sets.push("iteration_id = ?");
      params.push(parentIteration.id);
    }
    if (sets.length > 0) {
      sets.push("updated_at = unixepoch()");
      params.push(existing.id);
      db.query(`UPDATE tasks SET ${sets.join(", ")} WHERE id = ?`).run(
        ...(params as never[])
      );
    }
    return {
      kind: "exists",
      taskId: existing.id,
      iterationId: parentIteration.id,
    };
  }

  // Fresh task row. Mirrors F-12b's INSERT shape. Sub-issues only flow
  // through this path for GitHub parents (Decision 7), so source_system is
  // hardcoded 'github' below. (The DB's source_system CHECK was dropped in
  // G-1113.D.7c — the column is now provider-neutral — but this path remains
  // GitHub-specific by design until other providers grow an import path.)
  const taskId = generateId();
  const status = child.state === "closed" ? "done" : "open";
  // Principal id mirrors F-12b's DEFAULT_PRINCIPAL_ID — the sub-issue
  // came in via webhook, no human acted; we attribute it to the
  // mission-control default principal the same way internal-task
  // creates do.
  const DEFAULT_PRINCIPAL_ID = "mc-default-principal";
  db.query(
    `INSERT INTO tasks
       (id, title, priority, principal_id,
        source_system, source_url, source_external_id,
        status, iteration_id)
     VALUES (?, ?, 2, ?, 'github', ?, ?, ?, ?)`
  ).run(
    taskId,
    child.title,
    DEFAULT_PRINCIPAL_ID,
    child.htmlUrl,
    childCanonical,
    status,
    parentIteration.id
  );
  return {
    kind: "attached",
    taskId,
    iterationId: parentIteration.id,
  };
}

