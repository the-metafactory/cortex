/**
 * F-12b — "Add task from GitHub" modal.
 *
 * Three states (Decision 2): input → preview → submitting; conflict
 * overlays input when the dedup query at preview-time hits.
 *
 * Server endpoints (verified against `src/mission-control/server.ts`):
 *  - POST /api/tasks/preview  → 200 PreviewResponse | 409 ConflictResponse
 *  - POST /api/tasks          → 201 CreateTaskResponse | 409 conflict
 *
 * No new dependencies — fetch + JSON only. The GitHub CLI lives
 * server-side; F-12b reuses Grove's existing `gh` shape (Decision 3).
 *
 * Keyboard parity with the legacy modal:
 *  - Enter advances input → preview → submit
 *  - Esc closes
 *  - Click on the dim backdrop closes (but not click on the modal body)
 */

import { useCallback, useEffect, useRef, useState } from "react";
import "./add-task-modal.css";
import { parseGitHubRef } from "../lib/github-issue-ref";
import type { TaskListItem } from "../../db/tasks";

type ModalState = "input" | "preview" | "conflict";

interface PreviewBody {
  kind: "preview";
  ref: string;
  url: string;
  type: "issue" | "pr";
  state: string;
  title: string;
  labels?: string[];
  body_excerpt?: string;
  fetched_at: string;
}

interface ConflictBody {
  kind: "conflict";
  existingTaskId: string;
  existingTitle: string;
  existingStatus: string;
  message: string;
}

interface CreateBody {
  taskId: string;
  shadowAssignmentId: string;
  shadowSessionId: string;
  title: string;
  source_url: string;
  source_external_id: string;
  priority: number;
}

export interface AddTaskModalProps {
  open: boolean;
  /**
   * Current `all` task list — used to deeplink "Open existing task" on
   * conflict without re-fetching.
   */
  all: readonly TaskListItem[];
  onClose: () => void;
  /** Fired after a successful create — the parent triggers a refetch. */
  onCreated: () => void;
  /** Fired when "Open existing task →" is clicked on the conflict state. */
  onOpenExisting: (task: TaskListItem) => void;
}

const PRIORITIES = [0, 1, 2, 3] as const;

export function AddTaskModal({
  open, all, onClose, onCreated, onOpenExisting,
}: AddTaskModalProps) {
  const [stateName, setStateName] = useState<ModalState>("input");
  const [refInput, setRefInput] = useState("");
  const [titleOverride, setTitleOverride] = useState("");
  const [priority, setPriority] = useState<number>(2); // F-12b D2 default
  const [errMsg, setErrMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState<"preview" | "submit" | null>(null);
  const [preview, setPreview] = useState<PreviewBody | null>(null);
  const [conflict, setConflict] = useState<ConflictBody | null>(null);

  const refInputEl = useRef<HTMLInputElement | null>(null);

  // Reset modal state every time it opens.
  useEffect(() => {
    if (!open) return;
    setStateName("input");
    setRefInput("");
    setTitleOverride("");
    setPriority(2);
    setErrMsg(null);
    setBusy(null);
    setPreview(null);
    setConflict(null);
    // Defer focus so the input element exists.
    const t = setTimeout(() => refInputEl.current?.focus(), 0);
    return () => clearTimeout(t);
  }, [open]);

  const firePreview = useCallback(async () => {
    setErrMsg(null);
    const ref = refInput.trim();
    if (ref.length === 0) {
      setErrMsg("Paste a GitHub URL or owner/repo#N.");
      return;
    }
    // Pre-flight client validation per F-12b Decision 4. Defaults are
    // not configured client-side (would need the bot.yaml roundtrip), so
    // `#N` shorthand falls through to the server which handles it.
    const parsed = parseGitHubRef(ref);
    if (!parsed.ok && parsed.error !== "needs-default-repo") {
      setErrMsg(parsed.message);
      return;
    }
    setBusy("preview");
    try {
      const res = await fetch("/api/tasks/preview", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ref }),
      });
      const body = await res.json().catch(() => ({} as Record<string, unknown>));
      if (res.status === 409 && (body as ConflictBody).kind === "conflict") {
        setConflict(body as ConflictBody);
        setStateName("conflict");
        return;
      }
      if (!res.ok) {
        const errBody = body as { error?: string };
        setErrMsg(errBody.error || `Preview failed (HTTP ${res.status}).`);
        return;
      }
      setPreview(body as PreviewBody);
      setStateName("preview");
    } catch (err) {
      setErrMsg(`Network error: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(null);
    }
  }, [refInput]);

  const fireSubmit = useCallback(async () => {
    setErrMsg(null);
    const ref = refInput.trim();
    setBusy("submit");
    try {
      const payload: { ref: string; priority: number; titleOverride?: string } =
        { ref, priority };
      if (titleOverride.trim().length > 0) payload.titleOverride = titleOverride.trim();
      const res = await fetch("/api/tasks", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = await res.json().catch(() => ({} as Record<string, unknown>));
      if (res.status === 409 && (body as ConflictBody).kind === "conflict") {
        setConflict(body as ConflictBody);
        setStateName("conflict");
        return;
      }
      if (!res.ok) {
        const errBody = body as { error?: string };
        setErrMsg(errBody.error || `Create failed (HTTP ${res.status}).`);
        return;
      }
      // Success — parent triggers refetch which will reveal the new row.
      const _created = body as CreateBody;
      void _created; // kept for future logging
      onCreated();
      onClose();
    } catch (err) {
      setErrMsg(`Network error: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(null);
    }
  }, [refInput, priority, titleOverride, onCreated, onClose]);

  // Esc/Enter handler scoped to the modal subtree (the legacy approach;
  // keeps us out of conflict with the task-table's `/`+`f` bindings).
  const onKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      if (stateName === "input") void firePreview();
      else if (stateName === "preview") void fireSubmit();
    }
  }, [stateName, firePreview, fireSubmit, onClose]);

  if (!open) return null;

  return (
    <div
      className="add-task-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label="Add task from GitHub"
      onClick={(e) => {
        // Click on the backdrop (not the modal body) closes.
        if (e.target === e.currentTarget) onClose();
      }}
      onKeyDown={onKeyDown}
    >
      <div className="add-task-modal">
        <h3>Add task from GitHub</h3>
        {errMsg && <div className="err-banner">{errMsg}</div>}

        {stateName === "input" && (
          <>
            <label className="field" htmlFor="add-task-ref">
              GitHub URL or shorthand
              <input
                ref={refInputEl}
                id="add-task-ref"
                type="text"
                placeholder="https://github.com/owner/repo/issues/42"
                autoComplete="off"
                value={refInput}
                onChange={(e) => setRefInput(e.target.value)}
                disabled={busy !== null}
              />
              <div className="hint">
                Accepts the full URL, <code>owner/repo#N</code>, or
                {" "}<code>#N</code> if a default repo is configured.
              </div>
            </label>
            <label className="field" htmlFor="add-task-title">
              Title override (optional)
              <input
                id="add-task-title"
                type="text"
                placeholder="Leave empty to use the GitHub title"
                autoComplete="off"
                value={titleOverride}
                onChange={(e) => setTitleOverride(e.target.value)}
                disabled={busy !== null}
              />
            </label>
            <div className="priority-row">
              <span>Priority</span>
              {PRIORITIES.map((p) => (
                <label key={p}>
                  <input
                    type="radio"
                    name="add-task-priority"
                    value={String(p)}
                    checked={priority === p}
                    onChange={() => setPriority(p)}
                    disabled={busy !== null}
                  />
                  {" "}P{p}
                </label>
              ))}
            </div>
            <div className="actions-row">
              <button type="button" onClick={onClose}>Cancel</button>
              <button
                type="button"
                className="primary"
                disabled={busy !== null}
                onClick={() => void firePreview()}
              >
                {busy === "preview"
                  ? <><span className="spinner" />Loading…</>
                  : "Preview"}
              </button>
            </div>
          </>
        )}

        {stateName === "preview" && preview && (
          <>
            <PreviewBox preview={preview} />
            <div className="actions-row">
              <button
                type="button"
                onClick={() => { setErrMsg(null); setStateName("input"); }}
                disabled={busy !== null}
              >
                ← Back
              </button>
              <button
                type="button"
                className="primary"
                disabled={busy !== null}
                onClick={() => void fireSubmit()}
              >
                {busy === "submit"
                  ? <><span className="spinner" />Adding…</>
                  : "Add to queue"}
              </button>
            </div>
          </>
        )}

        {stateName === "conflict" && conflict && (
          <>
            <ConflictBox c={conflict} />
            <div className="actions-row">
              <button type="button" onClick={onClose}>Cancel</button>
              <button
                type="button"
                className="primary"
                onClick={() => {
                  const existing = all.find((t) => t.id === conflict.existingTaskId);
                  if (existing) onOpenExisting(existing);
                  else onClose();
                }}
              >
                Open existing task →
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function PreviewBox({ preview }: { preview: PreviewBody }) {
  const stateSuffix = preview.type === "pr" ? "pull request" : "issue";
  const labels = preview.labels && preview.labels.length > 0
    ? preview.labels.join(", ")
    : "—";
  const body = preview.body_excerpt && preview.body_excerpt.length > 0
    ? preview.body_excerpt
    : "—";
  // React's escaping is the XSS guarantee — never `dangerouslySetInnerHTML`.
  return (
    <div className="preview-box">
      <div className="pb-row pb-title">✓ {preview.ref}</div>
      <div className="pb-row"><span className="pb-label">Title:</span> {preview.title}</div>
      <div className="pb-row"><span className="pb-label">State:</span> {preview.state} ({stateSuffix})</div>
      <div className="pb-row"><span className="pb-label">Labels:</span> {labels}</div>
      <div className="pb-row pb-body">{body}</div>
    </div>
  );
}

function ConflictBox({ c }: { c: ConflictBody }) {
  return (
    <div className="conflict-box">
      <div>⚠ Already tracked</div>
      <div style={{ marginTop: 6 }}>Task {c.existingTaskId} already tracks this issue.</div>
      <div><span style={{ opacity: 0.6 }}>Title:</span> {c.existingTitle}</div>
      <div><span style={{ opacity: 0.6 }}>Status:</span> {c.existingStatus}</div>
    </div>
  );
}
