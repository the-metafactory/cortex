import type { ConversationDetail, ConversationEntry, ConversationMeta, LinkedView, ObjectRef, OperationRecord, Organize, OverviewPage, OverviewRow, SubmissionView } from "../../../../conversations/types";
import type { ImportableSession, SourceConversations } from "../../api/conversation-studio";
import type { SessionEnd } from "../../desk/studio/session-schema";
import { CONTINUATION_KIND, CREATION_KIND, DECISION_KIND, GRANT_KIND, IMPORTED_TURN_KIND, PROPOSAL_KIND } from "../../../../conversations/types";
import { ApiFailure, getJson, postJson } from "./api";

export const failureText = (error: unknown, fallback: string): string => (error instanceof ApiFailure ? error.info.message : fallback);

export type { ConversationDetail, ConversationEntry, ConversationMeta, ImportableSession, LinkedView, ObjectRef, OperationRecord, OverviewPage, OverviewRow, SourceConversations, SubmissionView };

const BASE = "/api/conversations";
const PAGE = 200;
const MAX_PAGES = 25;

export const readConversation = (id: string, signal?: AbortSignal): Promise<ConversationDetail> =>
  getJson<ConversationDetail>(`${BASE}/${id}`, signal ? { signal } : {});

export async function readEntries(id: string, signal?: AbortSignal): Promise<ConversationEntry[]> {
  const all: ConversationEntry[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const query = new URLSearchParams({ limit: String(PAGE), ...(cursor ? { cursor } : {}) });
    const reply = await getJson<{ entries: ConversationEntry[]; next?: string }>(`${BASE}/${id}/entries?${query.toString()}`, signal ? { signal } : {});
    all.push(...reply.entries);
    cursor = reply.next;
    if (!cursor) break;
  }
  return all;
}

export const OVERVIEW_PAGE = 25;

export const readOverview = (query: { state: "current" | "archived"; q: string; cursor?: string }, signal?: AbortSignal): Promise<OverviewPage> =>
  getJson<OverviewPage>(`${BASE}/overview?${new URLSearchParams({ state: query.state, limit: String(OVERVIEW_PAGE), ...(query.q ? { q: query.q } : {}), ...(query.cursor ? { cursor: query.cursor } : {}) }).toString()}`, signal ? { signal } : {});

export const organize = (id: string, change: Organize): Promise<{ conversation: ConversationMeta }> =>
  getJson(`${BASE}/${id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(change) });

export const readSource = (source: ObjectRef, signal?: AbortSignal): Promise<SourceConversations> =>
  getJson<SourceConversations>(`${BASE}/source?${new URLSearchParams({ owner: source.owner, id: source.id }).toString()}`, signal ? { signal } : {});

export const startConversation = (source: ObjectRef, startId: string): Promise<{ conversation: ConversationMeta }> =>
  postJson(`${BASE}/starts`, { startId, source });

export const importSession = (sessionId: string): Promise<{ conversation: ConversationMeta }> =>
  postJson(`${BASE}/imports`, { sessionId });

export const sendInput = (id: string, input: { inputId: string; text: string; mode: "queue" | "steer" }): Promise<{ duplicate: boolean; submission: SubmissionView }> =>
  postJson(`${BASE}/${id}/inputs`, { ...input, transport: "web" });

export async function saveDraft(id: string, text: string, keepalive = false): Promise<void> {
  const res = await fetch(`${BASE}/${id}/draft`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ text }), keepalive });
  if (!res.ok) throw new Error(`The draft was not saved (HTTP ${res.status}).`);
}

export async function chooseOutcome(id: string, proposalId: string, outcome: SessionEnd | "check"): Promise<{ operation: OperationRecord | null; error: string | null }> {
  const res = await fetch(`${BASE}/${id}/outcome`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(outcome === "check" ? { proposalId, check: true } : { proposalId, outcome }) });
  const body = await res.json().catch(() => null) as { operation?: OperationRecord; error?: string } | null;
  return { operation: body?.operation ?? null, error: body?.error ?? (res.ok || res.status === 202 ? null : `HTTP ${res.status}`) };
}

export type EntryView =
  | { kind: "message"; who: "you" | "ivy"; text: string; note?: string }
  | { kind: "activity"; text: string };

const record = (value: unknown): Record<string, unknown> => (value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {});
const text = (value: unknown): string => (typeof value === "string" ? value : "");

export function entryViews(entry: ConversationEntry): EntryView[] {
  const data = record(entry.data);
  if (entry.kind === IMPORTED_TURN_KIND) {
    const reply = text(data.reply);
    const from = `From the earlier Studio session · ${text(data.model)}, ${text(data.policy)}`;
    return [
      { kind: "message", who: "you", text: text(data.text), note: from },
      reply ? { kind: "message", who: "ivy", text: reply, note: from } : { kind: "activity", text: "No answer was received for this earlier turn." },
    ];
  }
  if (entry.kind === DECISION_KIND) {
    const outcome = record(data.outcome);
    const commit = text(data.commit).slice(0, 7);
    if (data.readOnly === true) return [{ kind: "activity", text: `Earlier Studio outcome (${text(outcome.kind) || "saved"}), commit ${commit}. Read-only; continuing never re-applies it.` }];
    return [{ kind: "activity", text: `Saved to the Studio${text(outcome.kind) ? ` (${text(outcome.kind)})` : ""}, commit ${commit}.` }];
  }
  if (entry.kind === PROPOSAL_KIND) {
    const revision = typeof data.revision === "number" ? data.revision : 1;
    return [{ kind: "activity", text: revision > 1 ? `Proposal edited (revision ${revision}). Nothing is created until it is confirmed.` : `Proposed ${text(data.type) || "a creation; type and destination still to choose"}. Nothing is created until it is confirmed.` }];
  }
  if (entry.kind === CREATION_KIND) {
    const authority = record(data.authority);
    const how = authority.kind === "grant" ? `under standing ${text(authority.scope)} permission` : "after your confirmation";
    return [{ kind: "activity", text: `Created ${text(data.type)} ${text(data.canonicalId)} ${how}.${text(data.url) ? ` ${text(data.url)}` : ""}` }];
  }
  if (entry.kind === GRANT_KIND) {
    return [{ kind: "activity", text: data.action === "revoked" ? `Standing ${text(data.type)} permission (${text(data.scope)}) revoked. Objects created earlier stay.` : `Standing ${text(data.type)} permission granted for ${data.scope === "global" ? "all your conversations" : "this conversation"}. Creation only.` }];
  }
  if (entry.kind === CONTINUATION_KIND) {
    return [{ kind: "activity", text: data.mode === "native-resume" ? "Resumed the same engine after a restart." : `Continued with reconstructed context on the ${text(data.to)} model.` }];
  }
  if (entry.role === "user" && entry.text) return [{ kind: "message", who: "you", text: entry.text }];
  if (entry.role === "assistant" && entry.text) return [{ kind: "message", who: "ivy", text: entry.text }];
  return [];
}

export function pendingLabel(submission: SubmissionView): string {
  if (submission.status === "queued") return "Queued · waits for Ivy's current turn";
  if (submission.status === "placed") return "Ivy is working on this";
  return submission.status === "done" ? "Answered" : `Not answered: ${submission.reason ?? "unknown reason"}`;
}

export function sourceLabel(source: Pick<ObjectRef, "owner">): string {
  if (source.owner === "studio-thread") return "Studio thread";
  if (source.owner === "studio-note") return "Studio idea";
  if (source.owner === "balance-task") return "Balance task";
  if (source.owner === "balance-project") return "Balance project";
  return source.owner;
}

export function statusLabel(status: ConversationMeta["activity"]["status"]): string {
  if (status === "working") return "Ivy is working";
  return status === "waiting" ? "Waiting for you" : "Ready to continue";
}
