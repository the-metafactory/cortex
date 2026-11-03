import type { ConversationDetail, ConversationEntry, ConversationMeta, LinkedView, ObjectRef, OperationRecord, Organize, OverviewPage, OverviewRow, SubmissionView } from "../../../../conversations/types";
import type { ImportableSession, SourceConversations } from "../../api/conversation-studio";
import type { SessionEnd } from "../../desk/studio/session-schema";
import type { AskFields } from "../../desk/ask";
import { CONTINUATION_KIND, CREATION_KIND, DECISION_KIND, GRANT_KIND, IMPORTED_TURN_KIND, laneName, PROPOSAL_KIND, routeLabel, TOOL_ACTIVITY_KIND } from "../../../../conversations/types";
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

export function modelLine(models: ConversationDetail["models"]): { choose: boolean; text: string; missing: string | null } {
  const lane = models.cloud.find(candidate => candidate.id === models.using);
  const missing = models.chosen !== null && !models.cloud.some(candidate => candidate.id === models.chosen) ? models.chosen : null;
  return { choose: models.cloud.length > 1 || missing !== null, text: lane ? laneName(lane) : "", missing };
}

export const continueInDiscord = (id: string, retry = false): Promise<{ conversation: ConversationMeta }> =>
  postJson(`${BASE}/${id}/discord`, retry ? { retry } : {});

export const readSource = (source: ObjectRef, signal?: AbortSignal): Promise<SourceConversations> =>
  getJson<SourceConversations>(`${BASE}/source?${new URLSearchParams({ owner: source.owner, id: source.id }).toString()}`, signal ? { signal } : {});

export const startConversation = (source: ObjectRef, startId: string): Promise<{ conversation: ConversationMeta }> =>
  postJson(`${BASE}/starts`, { startId, source });

export const startFromAsk = (startId: string, fields: AskFields["conversation"]): Promise<{ conversation: ConversationMeta }> =>
  postJson(`${BASE}/asks`, { startId, ...fields });

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
  | { kind: "activity"; text: string }
  | { kind: "failure"; text: string };

const record = (value: unknown): Record<string, unknown> => (value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {});
const text = (value: unknown): string => (typeof value === "string" ? value : "");
const TOOL_DETAIL = ["action", "query", "skill", "path", "pattern"] as const;
const short = (value: string, max = 80): string => (value.length > max ? `${value.slice(0, max - 1)}…` : value);

function toolLine(data: Record<string, unknown>): string {
  const tool = text(data.tool) || "a tool";
  const args = record(data.args);
  const detail = TOOL_DETAIL.flatMap(key => (text(args[key]) ? [short(text(args[key]))] : [])).join(" · ");
  const named = detail ? `${tool} (${detail})` : tool;
  if (data.outcome === "refused") return `Refused ${named}: it is not on the read-only tool allowlist, so nothing ran.`;
  if (data.outcome === "stopped") return `${named} is not on the read-only tool allowlist and may have run; the turn was stopped.`;
  if (data.outcome === "error") return `Read with ${named} failed: ${short(text(data.result).split("\n")[0] ?? "", 160)}`;
  return `Read with ${named}.`;
}

function continuationLine(data: Record<string, unknown>): string {
  if (data.mode === "native-resume") return "Resumed the same engine after a restart.";
  if (data.reason === "engine-changed") return "Ivy's working context was rebuilt from this conversation's record, because earlier turns came from another engine.";
  if (data.reason === "session-missing") return "Ivy's earlier pi session was not found, so the working context was rebuilt from this conversation's record.";
  return `Continued with reconstructed context on the ${routeLabel(text(data.to))} model.`;
}

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
  if (entry.kind === CONTINUATION_KIND) return [{ kind: "activity", text: continuationLine(data) }];
  if (entry.kind === TOOL_ACTIVITY_KIND) return [{ kind: "activity", text: toolLine(data) }];
  if (entry.role === "assistant" && entry.error) return [{ kind: "failure", text: `Ivy could not answer${entry.model ? ` on ${entry.model}` : ""}: ${entry.error}` }];
  if (entry.role === "user" && entry.text) return [{ kind: "message", who: "you", text: entry.text }];
  if (entry.role === "assistant" && entry.text) return [{ kind: "message", who: "ivy", text: entry.text, ...(entry.model ? { note: entry.model } : {}) }];
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
