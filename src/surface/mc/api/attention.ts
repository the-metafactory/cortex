import type { Database } from "bun:sqlite";
import { fileProposal, type ProposalFilingOptions } from "../../../vigil/file-proposal";
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
  error?: string;
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
  return listOpenAttention(db).map((item) => {
    const error = item.kind === "proposal" ? db.query<{ filing_error: string | null }, [string]>(
      "SELECT filing_error FROM vigil_proposals WHERE attention_id = ?",
    ).get(item.id)?.filing_error : null;
    return { item, link: resolveLink(db, item), ...(error ? { error } : {}) };
  });
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

const filings = new WeakMap<Database, Set<string>>();

export async function handleAttentionLifecycle(
  db: Database,
  id: string,
  action: "resolve" | "dismiss",
  options: ProposalFilingOptions = {},
): Promise<Response> {
  const item = getAttentionItem(db, id);
  if (filings.get(db)?.has(id)) return json({ error: "proposal filing already in progress" }, 409);
  if (item?.kind === "proposal" && item.status === "open" && action === "resolve") {
    const pending = filings.get(db) ?? new Set<string>();
    filings.set(db, pending);
    pending.add(id);
    try {
      const row = db.query<{ proposal_ref: string }, [string]>(
        "SELECT proposal_ref FROM vigil_proposals WHERE attention_id = ?",
      ).get(id);
      const result = row ? await fileProposal(row.proposal_ref, options)
        : { error: "proposal_ref missing", status: 400 };
      let error: string;
      let status: number;
      if ("filed" in result) {
        try {
          const resolved = db.transaction(() => {
            const changed = resolveVigilAttention(db, id, "approved", { filed: result.filed });
            if (changed) db.query("UPDATE vigil_proposals SET filing_error = NULL WHERE attention_id = ?").run(id);
            return changed;
          })();
          if (!resolved) {
            return json({ error: "proposal is no longer open" }, 409);
          }
          return json({ status: "resolved", id, filed: result.filed }, 200);
        } catch {
          error = "proposal filing returned invalid node or resolution could not be recorded";
          status = 502;
        }
      } else {
        ({ error, status } = result);
      }
      db.query("UPDATE vigil_proposals SET filing_error = ? WHERE attention_id = ?").run(error, id);
      return json({ error }, status);
    } finally {
      pending.delete(id);
    }
  }
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
