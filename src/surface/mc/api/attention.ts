/**
 * G-1113.E.3 — attention queue projection + endpoint (design §7.4).
 *
 * Lists the open attention items (severity-ordered by db/attention) and
 * resolves each one's deep-link target so the UI can route to it:
 *   - workItemId → the work item (title) → the work-item-detail surface (D.5).
 *   - sessionId  → its assignment id (sessions.assignment_id) → the drill-down.
 * §7.4 requires every item to deep-link; E.2 already guarantees an open item
 * carries at least one of these targets, so `link.kind` is never "none" for a
 * reconciled item. `work_item_id`/`session_id` are FK columns with ON DELETE
 * SET NULL, so each is either a live row or NULL — never a dangling ref — which
 * is why the label / assignmentId fallbacks below are defensively unreachable.
 */
import type { Database } from "bun:sqlite";
import { resultPresentation, type ResultRenderOptions } from "../../../vigil/result-render";
import { isVigilAttention, resolveVigilAttention } from "../../../vigil/resolution";
import type { VigilResultRow } from "../../../vigil/results";
import type { AttentionItem } from "../types";
import {
  listOpenAttention,
  resolveAttentionItem,
  dismissAttentionItem,
  getAttentionItem,
} from "../db/attention";
import { getWorkItem } from "../db/work-items";

export type AttentionLink =
  | { kind: "work-item"; workItemId: string; label: string }
  | { kind: "session"; sessionId: string; assignmentId: string | null }
  | { kind: "result"; label: string; url: string }
  | { kind: "none" };

export interface AttentionEntry {
  item: AttentionItem;
  /** Resolved deep-link target the UI routes on. */
  link: AttentionLink;
}

function resolveLink(db: Database, item: AttentionItem): AttentionLink {
  if (item.workItemId !== null) {
    const wi = getWorkItem(db, item.workItemId);
    return { kind: "work-item", workItemId: item.workItemId, label: wi?.title ?? item.workItemId };
  }
  if (item.sessionId !== null) {
    const row = db
      .query(`SELECT assignment_id FROM sessions WHERE id = ?`)
      .get(item.sessionId) as { assignment_id: string } | null;
    return { kind: "session", sessionId: item.sessionId, assignmentId: row?.assignment_id ?? null };
  }
  return { kind: "none" };
}

/** The open attention queue, each item with its resolved deep-link target. */
export function getAttentionQueue(db: Database): AttentionEntry[] {
  return listOpenAttention(db).map((item) => ({ item, link: resolveLink(db, item) }));
}

/** GET /api/attention — open attention items with resolved deep-links. */
export async function handleListAttention(db: Database, options: ResultRenderOptions = {}): Promise<Response> {
  const attention = await Promise.all(getAttentionQueue(db).map(async (entry): Promise<AttentionEntry> => {
    if (entry.item.kind !== "result") return entry;
    const result = db.query<VigilResultRow, [string]>("SELECT * FROM vigil_results WHERE attention_id = ?").get(entry.item.id);
    return result ? { ...entry, link: { kind: "result", ...await resultPresentation(result, options) } } : entry;
  }));
  return new Response(JSON.stringify({ attention }), {
    status: 200,
    headers: { "content-type": "application/json", "Cache-Control": "no-store" },
  });
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * CK-6a — the attention lifecycle data route (POST resolve/dismiss over
 * `db/attention setStatus`). A REAL db state op, distinct from Approve/Deny
 * (which stays theater until SPX-8). Registered under the FND-6 identity gate
 * in `server.ts`: no unauthenticated mutation joins the surface.
 *
 * @param action `"resolve"` (condition cleared) or `"dismiss"` (principal
 *               cleared it without action). 404 when no open row changed.
 */
export function handleAttentionLifecycle(
  db: Database,
  id: string,
  action: "resolve" | "dismiss",
): Response {
  const item = getAttentionItem(db, id);
  const changed =
    isVigilAttention(item)
      ? resolveVigilAttention(db, id, action === "dismiss" ? "dismissed" : item.kind === "result" ? "read" : "approved")
      : action === "resolve"
      ? resolveAttentionItem(db, id)
      : dismissAttentionItem(db, id);
  if (!changed) {
    return json(
      { error: "not_found", detail: `no open attention item with id '${id}'` },
      404,
    );
  }
  return json({ status: action === "resolve" ? "resolved" : "dismissed", id }, 200);
}
