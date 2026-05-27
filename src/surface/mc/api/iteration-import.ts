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
import { canonicalRef, type GitHubRef } from "./github-ref";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Default GitHub label that marks an issue as a Grove iteration parent.
 * Per Decision 10 Q6 ("explicit label `iteration` (or configurable
 * per-repo); avoids accidental promotion of unrelated parent issues").
 *
 * Operators override per-network via `iterationLabel` in the network
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

/**
 * Normalised parent-issue metadata. Both callers — webhook and
 * principal-driven path — collapse their respective raw inputs to this
 * shape before calling `importIterationFromMetadata`.
 *
 * Field meanings track the GitHub REST `/repos/:owner/:repo/issues/:n`
 * response (also matches the webhook payload's `issue` key) but with
 * the surface narrowed to what the iteration row needs.
 */
export interface ParentIssueMetadata {
  /** GitHub `owner/repo`. */
  owner: string;
  repo: string;
  /** Issue number (positive integer). */
  number: number;
  /** Issue title. */
  title: string;
  /** Issue body, raw markdown. May be null. */
  body: string | null;
  /** Canonical `html_url` from GitHub. */
  htmlUrl: string;
  /** Label names attached to the issue at the moment of import. */
  labels: string[];
}

/** Minimal sub-issue shape — enough to attach a child task. */
export interface SubIssueMetadata {
  owner: string;
  repo: string;
  number: number;
  title: string;
  /** GitHub `state` — "open" | "closed". */
  state: string;
  /** Canonical `html_url` from GitHub. */
  htmlUrl: string;
}

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

  // Fresh task row. Mirrors F-12b's INSERT shape (the schema's
  // `source_system` CHECK rejects anything other than 'github' /
  // 'internal', so we lean on the parent's source_system being
  // 'github' — sub-issues only flow through this path for GitHub
  // parents per Decision 7).
  const taskId = generateId();
  const status = child.state === "closed" ? "done" : "open";
  // Principal id mirrors F-12b's DEFAULT_OPERATOR_ID — the sub-issue
  // came in via webhook, no human acted; we attribute it to the
  // mission-control default principal the same way internal-task
  // creates do.
  const DEFAULT_OPERATOR_ID = "mc-default-operator";
  db.query(
    `INSERT INTO tasks
       (id, title, priority, principal_id,
        source_system, source_url, source_external_id,
        status, iteration_id)
     VALUES (?, ?, 2, ?, 'github', ?, ?, ?, ?)`
  ).run(
    taskId,
    child.title,
    DEFAULT_OPERATOR_ID,
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

// ---------------------------------------------------------------------------
// Webhook payload extractors
// ---------------------------------------------------------------------------

/**
 * Subset of the GitHub `issues` webhook payload we care about. The
 * full payload is huge; this is the minimum the import path reads.
 *
 * Marked `unknown`-typed at the boundary — the caller passes the
 * parsed JSON straight in and we narrow as we extract. Keeping the
 * surface this small means the test fixtures don't have to mock the
 * other 200+ fields GitHub sends.
 */
export interface IssuesWebhookEnvelope {
  action: string;
  issue: {
    number: number;
    title: string;
    body: string | null;
    html_url: string;
    state: string;
    labels?: ({ name?: string } | string)[] | null;
    /**
     * GitHub's sub-issue surface. When present, the issue is a child
     * of `parent`; the parent's owner/repo/number identifies the
     * Grove iteration to attach to.
     *
     * The shape here mirrors GitHub's own response (the parent issue
     * embedded inline). We tolerate either the full URL inline or the
     * minimal `repository.full_name` + `number` form — different
     * webhook deliveries include different subsets.
     */
    parent?: {
      number: number;
      html_url?: string;
      repository?: { full_name?: string };
    } | null;
  };
  repository: {
    full_name: string;
    name: string;
    owner: { login: string };
  };
  /**
   * Present on `issues.labeled` and `issues.unlabeled` — the label
   * that just changed. The handler keys on this for the "iteration
   * label was just added/removed" branches.
   */
  label?: { name?: string };
}

/**
 * Extract `ParentIssueMetadata` from the parsed webhook envelope. Pure;
 * no DB writes. Returns null when the payload is structurally wrong
 * (caller surfaces 400 / no-op).
 */
export function parentMetadataFromWebhook(
  envelope: unknown
): ParentIssueMetadata | null {
  if (typeof envelope !== "object" || envelope === null) return null;
  const env = envelope as Partial<IssuesWebhookEnvelope>;
  if (
    !env.issue ||
    typeof env.issue !== "object" ||
    !env.repository ||
    typeof env.repository !== "object"
  ) {
    return null;
  }
  const repo = env.repository as { full_name?: string; name?: string; owner?: { login?: string } };
  const issue = env.issue;
  const owner = repo.owner?.login;
  const name = repo.name;
  if (typeof owner !== "string" || typeof name !== "string") return null;
  if (typeof issue.number !== "number" || !Number.isInteger(issue.number)) {
    return null;
  }
  if (typeof issue.title !== "string" || typeof issue.html_url !== "string") {
    return null;
  }

  const labels: string[] = Array.isArray(issue.labels)
    ? (issue.labels as ({ name?: string } | string)[])
        .map((l) =>
          typeof l === "string"
            ? l
            : typeof l.name === "string"
              ? l.name
              : null
        )
        .filter((s): s is string => s !== null)
    : [];

  return {
    owner,
    repo: name,
    number: issue.number,
    title: issue.title,
    body: typeof issue.body === "string" ? issue.body : null,
    htmlUrl: issue.html_url,
    labels,
  };
}

/**
 * Extract sub-issue metadata + parent ref from the parsed webhook
 * envelope. Returns null when the payload doesn't carry a parent
 * (i.e., the issue isn't a sub-issue) or is structurally malformed.
 *
 * Per the design's note in F-17 acceptance criterion 1:
 *   "Sub-issue detection is via GitHub's `parent` field on the issue,
 *    OR the `iteration` label's parent-issue relationship — confirm
 *    which is in the existing `issues` table schema."
 *
 * We rely on the inline `issue.parent` field (the modern GitHub
 * sub-issue surface). Older checklist-style children — `- [ ]` lines
 * in the parent body — are explicitly out of scope for v1; the
 * design's "checklist sub-issues, normalized to issue refs" line in
 * Decision 2 names them as a future-friendly extension, not a v1
 * dependency.
 */
export function subIssueRefsFromWebhook(envelope: unknown): {
  parent: { owner: string; repo: string; number: number };
  child: SubIssueMetadata;
} | null {
  if (typeof envelope !== "object" || envelope === null) return null;
  const env = envelope as Partial<IssuesWebhookEnvelope>;
  if (
    !env.issue ||
    typeof env.issue !== "object" ||
    !env.repository ||
    typeof env.repository !== "object"
  ) {
    return null;
  }
  const issue = env.issue;
  const parent = issue.parent;
  if (!parent || typeof parent !== "object") return null;
  if (typeof parent.number !== "number" || !Number.isInteger(parent.number)) {
    return null;
  }

  // Resolve parent owner/repo. Prefer the embedded `repository.full_name`
  // over the `html_url` parse — full_name is structured and unambiguous;
  // the URL only kicks in when GitHub's payload omits the full_name (rare).
  let parentOwner: string | undefined;
  let parentName: string | undefined;
  if (parent.repository?.full_name && typeof parent.repository.full_name === "string") {
    const parts = parent.repository.full_name.split("/");
    if (parts.length === 2 && parts[0] && parts[1]) {
      parentOwner = parts[0];
      parentName = parts[1];
    }
  }
  if ((!parentOwner || !parentName) && typeof parent.html_url === "string") {
    // Format: https://github.com/<owner>/<repo>/issues/<number>
    try {
      const u = new URL(parent.html_url);
      const parts = u.pathname.split("/").filter(Boolean);
      // ['owner', 'repo', 'issues', 'N'] OR ['owner', 'repo', 'pull', 'N']
      if (parts.length >= 4 && parts[0] && parts[1]) {
        parentOwner = parts[0];
        parentName = parts[1];
      }
    } catch (_err) {
      // Malformed URL — fall through to the null-return below.
    }
  }
  if (!parentOwner || !parentName) {
    // GitHub didn't tell us the parent's repo. Sub-issues can live in
    // a different repo than their parent in principle (cross-repo
    // sub-issues are a recent GitHub feature) but for v1 we require
    // the payload to carry the parent repo explicitly so we don't
    // guess.
    return null;
  }

  const repo = env.repository as { name?: string; owner?: { login?: string } };
  const childOwner = repo.owner?.login;
  const childName = repo.name;
  if (typeof childOwner !== "string" || typeof childName !== "string") return null;
  if (typeof issue.number !== "number" || typeof issue.title !== "string") {
    return null;
  }
  if (typeof issue.html_url !== "string" || typeof issue.state !== "string") {
    return null;
  }

  return {
    parent: { owner: parentOwner, repo: parentName, number: parent.number },
    child: {
      owner: childOwner,
      repo: childName,
      number: issue.number,
      title: issue.title,
      state: issue.state,
      htmlUrl: issue.html_url,
    },
  };
}

/**
 * Build a `ParentIssueMetadata` from a `gh api` response shape (the
 * same structure `fetchIssueOrPr` produces, but with owner/repo/number
 * threaded through from the original parsed `GitHubRef` because the
 * `gh` response itself doesn't echo them in the convenient form).
 */
export function parentMetadataFromGhResponse(
  ref: GitHubRef,
  fetched: {
    title: string;
    body: string | null;
    labels: string[];
    html_url: string;
  }
): ParentIssueMetadata {
  return {
    owner: ref.owner,
    repo: ref.repo,
    number: ref.number,
    title: fetched.title,
    body: fetched.body,
    htmlUrl: fetched.html_url,
    labels: fetched.labels,
  };
}
