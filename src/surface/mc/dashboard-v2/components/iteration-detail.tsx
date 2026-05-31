/**
 * F-15 — iteration detail surface (`/iterations/:id` semantically;
 * routed via `view === "kanban-detail"` in app.tsx — no router lib).
 *
 * Why FULL-PAGE rather than overlay (per spec "pick one and document
 * why"):
 *   - The detail surface is a planning artefact the principal wants to
 *     stay on while doing other work in another tab. Drill-down (F-7)
 *     is overlay-style because it's a transient attention surface — you
 *     come back to the focus row when done. Detail is the opposite:
 *     it's where you SIT to write the iteration plan.
 *   - The body editor is the primary affordance. A 200-line markdown
 *     textarea inside an overlay constrains the writing surface; full-
 *     page lets us give it the height it needs.
 *   - The kanban → detail → kanban round-trip is fast (no fetch on
 *     return — the kanban hook keeps its in-memory list).
 *
 * Composition:
 *   - Header: editable title, state pill, priority dropdown, source
 *     chip + open/closed badge, [Promote] / [Cancel iteration] / [Close]
 *     action buttons (gated via `iteration-actions.ts` matrix).
 *   - Body: markdown textarea with paste-trim + 50 KB cap, save-on-blur
 *     plus 1s debounced autosave. Inline error banner with status-coded
 *     copy on save failure (mirrors `drill-input.tsx`).
 *   - Tasks: list of attached tasks with per-row Detach button and a
 *     "+ Add task" affordance opening a popover with two tabs
 *     (attach existing inbox task / create new internal task).
 *
 * All state mutations go through the F-15 endpoints. WS-driven updates
 * arrive via `useIterationDetail` (id-narrowed iteration.detail_updated
 * / iteration.state_changed subscriptions — see the hook for the
 * broadcast-surface split per Echo grove-v2#42 Major 3); the local form
 * state for the body textarea is kept separately so an in-flight edit
 * isn't clobbered by an incoming WS frame (only updates from another
 * client's edit).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import "./iteration-detail.css";
import { ApiFailure, getJson, postJson } from "../lib/api";
import { safeSourceHref } from "../lib/safe-href";
import {
  iterationActionMatrix,
  disabledTooltip,
  labelForAction,
} from "../lib/iteration-actions";
import { useIterationDetail } from "../hooks/use-iteration-detail";
import type { WsClient } from "../hooks/use-websocket";
import type {
  IterationDetail,
  IterationState,
  InboxItem,
} from "../../db/iterations";

const PRIORITIES = [0, 1, 2, 3] as const;
/** UTF-8 byte cap on the body field. Mirrors server-side ITERATION_BODY_MAX_BYTES. */
const BODY_MAX_BYTES = 50 * 1024;
/** Debounce window for autosave on the body field (after the last keystroke). */
const BODY_AUTOSAVE_DEBOUNCE_MS = 1000;

export interface IterationDetailProps {
  iterationId: string;
  ws: WsClient;
  /** Called when the principal wants to return to the kanban (X button or post-action). */
  onClose: () => void;
}

interface SaveError {
  status: number;
  message: string;
}

export function IterationDetail({
  iterationId,
  ws,
  onClose,
}: IterationDetailProps) {
  const { iteration, loaded, error, refetch } = useIterationDetail(
    ws,
    iterationId
  );

  // Loading / error / not-found gates first — keep the happy path
  // unindented below.
  if (!loaded) {
    return (
      <section className="iteration-detail-section" aria-label="Iteration detail">
        <div className="iteration-detail-empty dim">Loading iteration…</div>
      </section>
    );
  }
  if (error) {
    return (
      <section className="iteration-detail-section" aria-label="Iteration detail">
        <div className="iteration-detail-error" role="alert">
          Failed to load iteration: {error}
        </div>
        <div>
          <button type="button" onClick={onClose}>
            Back to kanban
          </button>
        </div>
      </section>
    );
  }
  if (!iteration) {
    return (
      <section className="iteration-detail-section" aria-label="Iteration detail">
        <div className="iteration-detail-empty">Iteration not found.</div>
        <div>
          <button type="button" onClick={onClose}>
            Back to kanban
          </button>
        </div>
      </section>
    );
  }

  return (
    <IterationDetailLoaded
      iteration={iteration}
      onClose={onClose}
      onRefetch={refetch}
    />
  );
}

interface LoadedProps {
  iteration: IterationDetail;
  onClose: () => void;
  onRefetch: () => void;
}

function IterationDetailLoaded({ iteration, onClose, onRefetch }: LoadedProps) {
  const matrix = useMemo(
    () => iterationActionMatrix(iteration.state),
    [iteration.state]
  );

  // ---- Title editing (save on blur) ----
  const [titleDraft, setTitleDraft] = useState(iteration.title);
  const titleCommittedRef = useRef(iteration.title);
  // Keep the draft in sync with WS-driven updates from OTHER clients,
  // but only when our local draft equals the previously-committed value
  // (i.e. we're not in the middle of an edit).
  useEffect(() => {
    if (titleDraft === titleCommittedRef.current) {
      titleCommittedRef.current = iteration.title;
      setTitleDraft(iteration.title);
    } else {
      // Principal is editing locally — don't clobber. The committed-ref
      // still tracks what the server last told us so a subsequent blur
      // saves the principal's draft correctly.
      titleCommittedRef.current = iteration.title;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [iteration.title]);

  // ---- Body editing (save on blur + debounced autosave) ----
  const [bodyDraft, setBodyDraft] = useState(iteration.body ?? "");
  const bodyCommittedRef = useRef(iteration.body ?? "");
  const bodyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const incoming = iteration.body ?? "";
    if (bodyDraft === bodyCommittedRef.current) {
      bodyCommittedRef.current = incoming;
      setBodyDraft(incoming);
    } else {
      bodyCommittedRef.current = incoming;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [iteration.body]);

  // ---- Save error banners ----
  const [saveError, setSaveError] = useState<SaveError | null>(null);
  const [busy, setBusy] = useState(false);

  // Generic patch helper — single source of truth for the
  // PATCH /api/iterations/:id wire shape + error normalisation.
  const patch = useCallback(
    async (
      body: {
        title?: string;
        body?: string | null;
        priority?: number;
        state?: IterationState;
      }
    ): Promise<boolean> => {
      setBusy(true);
      try {
        await fetch(`/api/iterations/${encodeURIComponent(iteration.id)}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }).then(async (res) => {
          if (!res.ok) {
            let msg = `HTTP ${res.status}`;
            try {
              const j = (await res.json()) as { error?: string };
              if (j && typeof j.error === "string") msg = j.error;
            } catch {
              // body wasn't JSON; keep the HTTP fallback.
            }
            throw new ApiFailure({ status: res.status, message: msg });
          }
        });
        setSaveError(null);
        return true;
      } catch (e) {
        const status = e instanceof ApiFailure ? e.info.status : 0;
        const message =
          e instanceof ApiFailure
            ? e.info.message
            : e instanceof Error
              ? e.message
              : String(e);
        setSaveError({ status, message });
        return false;
      } finally {
        setBusy(false);
      }
    },
    [iteration.id]
  );

  // ---- Save callbacks ----
  const saveTitle = useCallback(async () => {
    const trimmed = titleDraft.trim();
    if (trimmed === titleCommittedRef.current) return;
    if (trimmed.length === 0) {
      // Reset the draft — empty title is rejected at the API anyway,
      // and silently restoring is friendlier than a flashed error.
      setTitleDraft(titleCommittedRef.current);
      return;
    }
    const ok = await patch({ title: trimmed });
    if (ok) titleCommittedRef.current = trimmed;
  }, [titleDraft, patch]);

  const saveBody = useCallback(async () => {
    if (bodyDraft === bodyCommittedRef.current) return;
    // 50 KB cap — mirrors the server-side bound; a paste larger than
    // that is trimmed (handled by the onChange handler), so reaching
    // this point with > BODY_MAX_BYTES means a manually-typed value at
    // the boundary. Server returns 413; surface the same.
    if (new TextEncoder().encode(bodyDraft).length > BODY_MAX_BYTES) {
      setSaveError({
        status: 413,
        message: "Body exceeds the 50 KB limit",
      });
      return;
    }
    const ok = await patch({ body: bodyDraft });
    if (ok) bodyCommittedRef.current = bodyDraft;
  }, [bodyDraft, patch]);

  // Debounced autosave on body — same pattern as the kanban refetch.
  useEffect(() => {
    if (bodyTimerRef.current !== null) clearTimeout(bodyTimerRef.current);
    if (bodyDraft === bodyCommittedRef.current) return;
    bodyTimerRef.current = setTimeout(() => {
      bodyTimerRef.current = null;
      void saveBody();
    }, BODY_AUTOSAVE_DEBOUNCE_MS);
    return () => {
      if (bodyTimerRef.current !== null) {
        clearTimeout(bodyTimerRef.current);
        bodyTimerRef.current = null;
      }
    };
  }, [bodyDraft, saveBody]);

  // ---- Priority change (immediate save) ----
  const onPriorityChange = useCallback(
    async (next: number) => {
      if (next === iteration.priority) return;
      await patch({ priority: next });
    },
    [iteration.priority, patch]
  );

  // ---- Promote (designing → queued) ----
  const onPromote = useCallback(async () => {
    if (!matrix.promote) return;
    if (
      !window.confirm(
        "Promote this iteration to queued? All attached tasks will be queued for dispatch."
      )
    ) {
      return;
    }
    const ok = await patch({ state: "queued" });
    if (ok) onClose();
  }, [matrix.promote, patch, onClose]);

  // ---- Cancel iteration ----
  const onCancelIteration = useCallback(async () => {
    if (!matrix.cancel) return;
    if (
      !window.confirm(
        "Cancel this iteration? This is reversible by API but the kanban will hide it."
      )
    ) {
      return;
    }
    const ok = await patch({ state: "cancelled" });
    if (ok) onClose();
  }, [matrix.cancel, patch, onClose]);

  // ---- Add / detach task helpers ----
  const [addOpen, setAddOpen] = useState(false);

  const onDetachTask = useCallback(
    async (taskId: string) => {
      if (!matrix.detachTask) return;
      if (!window.confirm("Detach this task from the iteration? The task itself is preserved.")) {
        return;
      }
      setBusy(true);
      try {
        const res = await fetch(
          `/api/iterations/${encodeURIComponent(iteration.id)}/tasks/${encodeURIComponent(taskId)}`,
          { method: "DELETE" }
        );
        if (!res.ok) {
          const j = (await res.json().catch(() => ({}))) as { error?: string };
          throw new ApiFailure({
            status: res.status,
            message: j.error ?? `HTTP ${res.status}`,
          });
        }
        setSaveError(null);
        onRefetch();
      } catch (e) {
        const status = e instanceof ApiFailure ? e.info.status : 0;
        const message =
          e instanceof ApiFailure ? e.info.message : (e as Error).message;
        setSaveError({ status, message });
      } finally {
        setBusy(false);
      }
    },
    [iteration.id, matrix.detachTask, onRefetch]
  );

  const safeUrl = safeSourceHref(iteration.source_url);
  // Per Echo grove-v2#42 (Nit 4) — memoize the byte-count so a 50 KB
  // body isn't re-encoded on every render for the counter banner. The
  // encoding only needs to re-run when `bodyDraft` actually changes.
  const bodySize = useMemo(
    () => new TextEncoder().encode(bodyDraft).length,
    [bodyDraft]
  );
  const counterCls =
    bodySize > BODY_MAX_BYTES
      ? "counter over"
      : bodySize > BODY_MAX_BYTES * 0.9
        ? "counter warn"
        : "counter";

  return (
    <section className="iteration-detail-section" aria-label="Iteration detail">
      {saveError && (
        <div className="iteration-detail-banner" role="alert">
          Save failed (HTTP {saveError.status}): {saveError.message}
        </div>
      )}

      {/* --- Header --- */}
      <div className="iteration-detail-header">
        <div className="titlebox">
          <input
            className="title-input"
            value={titleDraft}
            disabled={!matrix.edit}
            title={matrix.edit ? "" : disabledTooltip(iteration.state, "edit")}
            onChange={(e) => setTitleDraft(e.target.value)}
            onBlur={() => {
              void saveTitle();
            }}
            aria-label="Iteration title"
          />
          <div className="meta-row">
            <span className={`state-pill state-${iteration.state}`}>
              {iteration.state}
            </span>
            <select
              className="priority-select"
              value={String(iteration.priority)}
              disabled={!matrix.edit}
              onChange={(e) => void onPriorityChange(Number(e.target.value))}
              aria-label="Iteration priority"
            >
              {PRIORITIES.map((p) => (
                <option key={p} value={String(p)}>
                  P{p}
                </option>
              ))}
            </select>
            {iteration.source_system && (
              <span
                className="source-badge"
                title={`Imported from ${iteration.source_system}`}
              >
                {iteration.source_system}
              </span>
            )}
            {safeUrl && (
              <a
                className="source-link"
                href={safeUrl}
                target="_blank"
                rel="noopener noreferrer"
              >
                source ↗
              </a>
            )}
            <span className="dim">
              · {iteration.tasks.length} task
              {iteration.tasks.length === 1 ? "" : "s"}
            </span>
            {busy && <span className="dim">· saving…</span>}
          </div>
        </div>

        <div className="actions">
          {matrix.promote && (
            <button
              type="button"
              className="action-btn primary"
              onClick={() => void onPromote()}
              disabled={busy}
            >
              {labelForAction("promote")}
            </button>
          )}
          {matrix.cancel && (
            <button
              type="button"
              className="action-btn danger"
              onClick={() => void onCancelIteration()}
              disabled={busy}
              title={disabledTooltip(iteration.state, "cancel")}
            >
              {labelForAction("cancel")}
            </button>
          )}
          <button
            type="button"
            className="action-btn"
            onClick={onClose}
            aria-label="Close detail"
          >
            ✕ Close
          </button>
        </div>
      </div>

      {/* --- Body editor --- */}
      <div className="iteration-detail-body">
        <div className="label">Design notes (markdown)</div>
        <textarea
          rows={12}
          value={bodyDraft}
          disabled={!matrix.edit}
          placeholder={
            matrix.edit
              ? "Write the iteration design notes here. Saves on blur (or 1s after the last keystroke)."
              : disabledTooltip(iteration.state, "edit")
          }
          onChange={(e) => {
            const v = e.target.value;
            // Per Echo grove-v2#42 (Nit 4) — encode once, branch on
            // length, decode only if we have to trim. Previous version
            // ran `new TextEncoder().encode(v)` twice on the over-cap
            // branch (once to check, once to slice).
            const encoded = new TextEncoder().encode(v);
            if (encoded.length > BODY_MAX_BYTES) {
              // 50 KB hard cap — same pattern as drill-input. Trim
              // from the end if a paste pushes us over.
              const buf = encoded.slice(0, BODY_MAX_BYTES);
              try {
                setBodyDraft(new TextDecoder("utf-8", { fatal: false }).decode(buf));
              } catch (_err) {
                // Decode error on a multi-byte boundary — fall back to
                // the previous value rather than crashing the editor.
                setBodyDraft(bodyCommittedRef.current);
              }
            } else {
              setBodyDraft(v);
            }
          }}
          onBlur={() => {
            void saveBody();
          }}
          aria-label="Iteration design notes"
        />
        <div className="body-meta">
          <span className="dim">
            {bodyDraft === bodyCommittedRef.current ? "saved" : "unsaved changes"}
          </span>
          <span className={counterCls}>
            {bodySize.toLocaleString()} / {BODY_MAX_BYTES.toLocaleString()}
          </span>
        </div>
      </div>

      {/* --- Tasks --- */}
      <div className="iteration-detail-tasks">
        <div className="header-row">
          <h3>Tasks</h3>
          <button
            type="button"
            className="add-btn"
            disabled={!matrix.addTask || busy}
            title={
              matrix.addTask ? "" : disabledTooltip(iteration.state, "addTask")
            }
            onClick={() => setAddOpen((v) => !v)}
          >
            {addOpen ? "Cancel" : "+ Add task"}
          </button>
        </div>

        {addOpen && matrix.addTask && (
          <AddTaskPopover
            iterationId={iteration.id}
            onClose={() => setAddOpen(false)}
            onAdded={() => {
              setAddOpen(false);
              onRefetch();
            }}
            onError={(status, message) => setSaveError({ status, message })}
          />
        )}

        {iteration.tasks.length === 0 ? (
          <div className="iteration-detail-empty">
            No tasks attached yet. {matrix.addTask ? "Click + Add task to attach one." : ""}
          </div>
        ) : (
          iteration.tasks.map((t) => {
            const pCls =
              Number.isFinite(t.priority) && t.priority >= 0 && t.priority <= 3
                ? `p${t.priority}`
                : "pu";
            return (
              <div key={t.id} className="iteration-task-row">
                <span className="task-title" title={t.title}>
                  {t.title}
                </span>
                <span className={`task-priority ${pCls}`}>P{t.priority}</span>
                <span className="task-status">{t.status}</span>
                <button
                  type="button"
                  className="detach-btn"
                  disabled={!matrix.detachTask || busy}
                  title={
                    matrix.detachTask
                      ? "Detach this task (does not delete the task itself)"
                      : disabledTooltip(iteration.state, "detachTask")
                  }
                  onClick={() => void onDetachTask(t.id)}
                >
                  Detach
                </button>
              </div>
            );
          })
        )}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// AddTaskPopover — small inline affordance for attach-existing OR create+attach
// ---------------------------------------------------------------------------

interface AddTaskPopoverProps {
  iterationId: string;
  onClose: () => void;
  onAdded: () => void;
  onError: (status: number, message: string) => void;
}

interface InboxResponse {
  items: InboxItem[];
}

function AddTaskPopover({
  iterationId,
  onClose,
  onAdded,
  onError,
}: AddTaskPopoverProps) {
  const [tab, setTab] = useState<"existing" | "create">("existing");

  // -- attach-existing --
  const [inboxItems, setInboxItems] = useState<InboxItem[] | null>(null);
  const [selectedTaskId, setSelectedTaskId] = useState("");
  const [inboxLoading, setInboxLoading] = useState(false);

  useEffect(() => {
    if (tab !== "existing" || inboxItems !== null) return;
    let cancelled = false;
    setInboxLoading(true);
    getJson<InboxResponse>(
      "/api/inbox?source=github&limit=100"
    )
      .then((body) => {
        if (cancelled) return;
        setInboxItems(body.items ?? []);
      })
      .catch((e) => {
        if (cancelled) return;
        // Surface as the parent's banner — keep this popover focused.
        const status = e instanceof ApiFailure ? e.info.status : 0;
        const message =
          e instanceof ApiFailure ? e.info.message : (e as Error).message;
        onError(status, message);
        setInboxItems([]);
      })
      .finally(() => {
        if (!cancelled) setInboxLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [tab, inboxItems, onError]);

  // -- create-new --
  const [newTitle, setNewTitle] = useState("");
  const [newPriority, setNewPriority] = useState<number>(2);
  const [submitting, setSubmitting] = useState(false);

  const submit = useCallback(async () => {
    setSubmitting(true);
    try {
      const body =
        tab === "existing"
          ? { task_id: selectedTaskId }
          : { create: { title: newTitle.trim(), priority: newPriority } };
      await postJson<typeof body, unknown>(
        `/api/iterations/${encodeURIComponent(iterationId)}/tasks`,
        body
      );
      onAdded();
    } catch (e) {
      const status = e instanceof ApiFailure ? e.info.status : 0;
      const message =
        e instanceof ApiFailure ? e.info.message : (e as Error).message;
      onError(status, message);
    } finally {
      setSubmitting(false);
    }
  }, [tab, selectedTaskId, newTitle, newPriority, iterationId, onAdded, onError]);

  const canSubmit =
    tab === "existing"
      ? selectedTaskId.length > 0
      : newTitle.trim().length > 0;

  return (
    <div className="iteration-add-popover">
      <div className="tabs">
        <button
          type="button"
          className={tab === "existing" ? "active" : ""}
          onClick={() => setTab("existing")}
        >
          Attach inbox task
        </button>
        <button
          type="button"
          className={tab === "create" ? "active" : ""}
          onClick={() => setTab("create")}
        >
          Create new task
        </button>
      </div>

      {tab === "existing" ? (
        <div className="field-row">
          <label htmlFor="iteration-add-existing">
            Inbox task (top {INBOX_DROPDOWN_LIMIT} most-recent)
          </label>
          {inboxLoading ? (
            <span className="dim">Loading inbox…</span>
          ) : (
            <select
              id="iteration-add-existing"
              value={selectedTaskId}
              onChange={(e) => setSelectedTaskId(e.target.value)}
            >
              <option value="">— pick one —</option>
              {(inboxItems ?? []).slice(0, INBOX_DROPDOWN_LIMIT).map((it) => (
                <option key={it.id} value={it.id}>
                  {it.title}
                </option>
              ))}
            </select>
          )}
        </div>
      ) : (
        <>
          <div className="field-row">
            <label htmlFor="iteration-add-create-title">Title</label>
            <input
              id="iteration-add-create-title"
              type="text"
              value={newTitle}
              onChange={(e) => setNewTitle(e.target.value)}
              placeholder="A short, action-flavoured title"
              maxLength={500}
            />
          </div>
          <div className="field-row">
            <label htmlFor="iteration-add-create-priority">Priority</label>
            <select
              id="iteration-add-create-priority"
              value={String(newPriority)}
              onChange={(e) => setNewPriority(Number(e.target.value))}
            >
              {PRIORITIES.map((p) => (
                <option key={p} value={String(p)}>
                  P{p}
                </option>
              ))}
            </select>
          </div>
        </>
      )}

      <div className="button-row">
        <button type="button" onClick={onClose}>
          Cancel
        </button>
        <button
          type="button"
          className="primary"
          disabled={!canSubmit || submitting}
          onClick={() => void submit()}
        >
          {submitting ? "Saving…" : "Add task"}
        </button>
      </div>
    </div>
  );
}

/**
 * Cap on how many inbox items the dropdown shows at once. Principals
 * who have more than this many should be using the kanban's drag-drop
 * affordance, not this popover (which is a fallback for the rare case
 * where dragging across the screen isn't ergonomic).
 */
const INBOX_DROPDOWN_LIMIT = 50;
