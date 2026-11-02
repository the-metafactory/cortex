import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { z } from "zod";
import { ConversationError, DECISION_KIND, IMPORTED_TURN_KIND, type ConversationHost, type HostDetail, type OwnerScope, type Seed, type SeedEntry } from "../../../conversations/host";
import { ObjectRefSchema, type ConversationDetail, type ConversationMeta, type ObjectRef, type OperationRecord, type SourceView } from "../../../conversations/types";
import type { DeskOptions } from "../desk/compose";
import type { DeskRuntime } from "../desk/compose";
import { splitNoteId, studioNoteId, studioRequestId, studioThreadOf } from "../desk/conversation-sources";
import type { GitRunner } from "../desk/studio/git";
import { readStudioFiles } from "../desk/studio/read";
import { planExchangeEnd, sessionSubject } from "../desk/studio/session";
import { SessionEndSchema, StudioSessionSchema, type SessionEnd, type StudioSession } from "../desk/studio/session-schema";
import { buildStudioView } from "../desk/studio/view";
import { runStudioTransaction } from "../desk/studio/writer";

export interface StudioConversationDeps {
  db: Database;
  runtime: DeskRuntime | undefined;
  now?: () => Date;
  git?: GitRunner;
}

export const StartSchema = z.object({ startId: z.uuid(), source: ObjectRefSchema }).strict();
export const ImportSchema = z.object({ sessionId: z.uuid() }).strict();
export const OutcomeSchema = z.union([
  z.object({ proposalId: z.uuid(), outcome: SessionEndSchema }).strict(),
  z.object({ proposalId: z.uuid(), check: z.literal(true) }).strict(),
]);
const SOURCE_OWNERS = ["studio-thread", "studio-note", "balance-task", "balance-project"] as const;
export const SourceQuerySchema = z.object({ owner: z.enum(SOURCE_OWNERS), id: z.string().trim().min(1).max(512) });

export interface ImportableSession { id: string; subject: string; scope: "thread" | "note"; phase: "open" | "ending" | "ended"; turns: number }
export interface SourceConversations { source: SourceView; conversations: ConversationMeta[]; sessions: ImportableSession[] }

const SESSION_KEY = "studio-session:";
const clip = (text: string, max = 90): string => {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

function studioDesk(deps: StudioConversationDeps): DeskOptions & { studio: NonNullable<DeskOptions["studio"]> } {
  const desk = deps.runtime?.options;
  if (!desk?.enabled || !desk.studio) throw new ConversationError(409, "The Studio is not set up on this stack.");
  return { ...desk, studio: desk.studio };
}

const StudioScopeSchema = z.object({ thread: z.string(), note: z.string().optional(), original: z.string(), stand: z.string() });
type StudioScope = z.infer<typeof StudioScopeSchema>;
const studioTitle = (note: boolean, subject: string): string => `${note ? "Discuss" : "Talk it through"}: ${clip(subject)}`;
const ownerScope = (scope: StudioScope): OwnerScope => ({ owner: scope.note ? "studio-note" : "studio-thread", data: { thread: scope.thread, original: scope.original, stand: scope.stand, ...(scope.note ? { note: scope.note } : {}) } });
function studioScopeOf(scope: OwnerScope | null): StudioScope | null {
  if (scope?.owner !== "studio-note" && scope?.owner !== "studio-thread") return null;
  return StudioScopeSchema.safeParse(scope.data).data ?? null;
}

export async function withStudio(host: ConversationHost, id: string, detail: HostDetail): Promise<ConversationDetail> {
  const { scope, available, ...rest } = detail;
  const studio = available ? studioScopeOf(scope) : null;
  return { ...rest, studio: studio ? { scope: studio.note ? "note" : "thread", subject: studio.original, outcome: (await host.operations(id)).at(-1) ?? null } : null };
}

function sessionRows(deps: StudioConversationDeps, dir: string, thread: string): StudioSession[] {
  const rows = deps.db.query<{ data: string }, [string, string]>("SELECT data FROM desk_studio_sessions WHERE directory = ? AND json_extract(data, '$.thread') = ? ORDER BY rowid DESC LIMIT 200").all(dir, thread);
  return rows.flatMap(row => {
    const parsed = StudioSessionSchema.safeParse(JSON.parse(row.data));
    return parsed.success ? [parsed.data] : [];
  });
}

const sameThread = (slug: string) => (ref: ObjectRef): boolean => (ref.owner === "studio-thread" && ref.id === slug) || (ref.owner === "studio-note" && splitNoteId(ref.id)?.thread === slug);
const sameBalance = (id: string) => (ref: ObjectRef): boolean => (ref.owner === "balance-task" || ref.owner === "balance-project") && ref.id === id;

export async function sourceConversations(host: ConversationHost, deps: StudioConversationDeps, query: z.infer<typeof SourceQuerySchema>): Promise<SourceConversations> {
  const ref: ObjectRef = { owner: query.owner, id: query.id };
  const [source] = await host.sourcesOf([ref]);
  if (!source) throw new ConversationError(404, "That source was not found.");
  if (query.owner === "balance-task" || query.owner === "balance-project") return { source, conversations: await host.list(sameBalance(query.id)), sessions: [] };
  const slug = query.owner === "studio-note" ? splitNoteId(query.id)?.thread : query.id;
  if (!slug) throw new ConversationError(400, "The Studio note reference is not valid.");
  const conversations = await host.list(query.owner === "studio-note" ? (r: ObjectRef) => r.owner === "studio-note" && r.id === query.id : sameThread(slug));
  const dir = deps.runtime?.options?.studio?.dir;
  if (!dir || source.state === "unavailable") return { source, conversations, sessions: [] };
  const imported = await host.keyed(SESSION_KEY);
  const sessions = sessionRows(deps, dir, slug)
    .filter(s => !imported.has(s.id) && (query.owner === "studio-thread" || (s.scope.kind === "ghost" && studioNoteId(slug, s.scope.note) === query.id)))
    .map(s => ({ id: s.id, subject: s.original, scope: s.scope.kind === "ghost" ? "note" as const : "thread" as const, phase: s.phase.kind, turns: s.turns.length }));
  return { source, conversations, sessions };
}

export async function startFromSource(host: ConversationHost, deps: StudioConversationDeps, body: z.infer<typeof StartSchema>, principal: string): Promise<ConversationMeta> {
  const { source, startId } = body;
  const key = `start:${startId}`;
  const [resolved] = await host.sourcesOf([source]);
  if (resolved?.state !== "available") throw new ConversationError(403, "That source is unavailable, so no conversation was started.");
  if (source.owner === "balance-task" || source.owner === "balance-project") {
    return host.create({ title: clip(resolved.title), links: [source], origin: { kind: "balance", ref: source.id }, policy: resolved.policy }, principal, { key, titleFromSource: true });
  }
  if (source.owner !== "studio-thread" && source.owner !== "studio-note") throw new ConversationError(400, "Conversations start from a Studio thread, a Studio note or a Balance task.");
  const desk = studioDesk(deps);
  const note = source.owner === "studio-note" ? splitNoteId(source.id) : null;
  const slug = note?.thread ?? source.id;
  const { files, problems } = await readStudioFiles(desk.studio.dir);
  const thread = studioThreadOf(buildStudioView(files, desk.studio, desk.areas, problems), slug);
  const original = thread ? sessionSubject(thread, note ? { kind: "ghost", note: note.note } : { kind: "thread" }) : null;
  if (!thread || thread.state === "closed" || original === null) throw new ConversationError(409, "Choose an open idea, proposed stand or an active thread.");
  const scope = ownerScope({ thread: slug, ...(note ? { note: note.note } : {}), original, stand: thread.stand });
  return host.create({ title: studioTitle(Boolean(note), original), links: [source], origin: { kind: "studio", ref: slug }, policy: thread.policy }, principal, { key, scope, titleFromSource: true });
}

export async function importStudioSession(host: ConversationHost, deps: StudioConversationDeps, sessionId: string, principal: string): Promise<ConversationMeta> {
  const dir = studioDesk(deps).studio.dir;
  const row = deps.db.query<{ data: string }, [string, string]>("SELECT data FROM desk_studio_sessions WHERE id = ? AND directory = ?").get(sessionId, dir);
  if (!row) throw new ConversationError(404, "That Studio session was not found.");
  const session = StudioSessionSchema.parse(JSON.parse(row.data));
  if (session.phase.kind === "ending") throw new ConversationError(409, "The Studio is still saving this exchange. Finish it in the Studio first; it opens here afterwards.");
  const note = session.scope.kind === "ghost" ? session.scope.note : undefined;
  const link: ObjectRef = note ? { owner: "studio-note", id: studioNoteId(session.thread, note) } : { owner: "studio-thread", id: session.thread };
  const at = (deps.now?.() ?? new Date()).getTime();
  const entries: SeedEntry[] = session.turns.map(turn => ({
    kind: IMPORTED_TURN_KIND,
    data: { session: session.id, turn: turn.id, text: turn.text, reply: turn.answer?.reply ?? null, summary: turn.answer?.summary ?? null, proposal: turn.answer?.proposal ?? null, model: turn.model, policy: turn.policy },
    messages: [{ role: "user", text: turn.text, at }, ...(turn.answer ? [{ role: "assistant" as const, text: turn.answer.reply, model: turn.model, at }] : [])],
  }));
  const ended = session.phase.kind === "ended" ? session.phase : null;
  if (ended) entries.push({ kind: DECISION_KIND, data: { source: "imported-studio-session", session: session.id, outcome: ended.outcome, commit: ended.commit, readOnly: true } });
  const seed: Seed = {
    key: `${SESSION_KEY}${session.id}`, imported: true, titleFromSource: true, entries, draft: session.draft ?? "", state: ended ? "archived" : "current",
    ...(ended ? {} : { scope: ownerScope({ thread: session.thread, ...(note ? { note } : {}), original: session.original, stand: session.stand }) }),
  };
  return host.create({ title: studioTitle(Boolean(note), session.original), links: [link], origin: { kind: "imported-studio-session", ref: session.id }, policy: session.policy }, principal, seed);
}

export async function isImported(host: ConversationHost, sessionId: string): Promise<boolean> {
  return (await host.keyed(SESSION_KEY)).has(sessionId);
}

const digestOf = (outcome: SessionEnd): string => createHash("sha256").update(JSON.stringify(outcome)).digest("hex");

const outcomes = new Map<string, Promise<unknown>>();
export async function applyStudioOutcome(host: ConversationHost, deps: StudioConversationDeps, id: string, body: z.infer<typeof OutcomeSchema>): Promise<OperationRecord> {
  const previous = outcomes.get(id) ?? Promise.resolve();
  const run = previous.catch(() => undefined).then(() => outcomeOnce(host, deps, id, body));
  outcomes.set(id, run);
  try { return await run; }
  finally { if (outcomes.get(id) === run) outcomes.delete(id); }
}

async function outcomeOnce(host: ConversationHost, deps: StudioConversationDeps, id: string, body: z.infer<typeof OutcomeSchema>): Promise<OperationRecord> {
  const studio = studioScopeOf(await host.scopeOf(id));
  if (!studio) throw new ConversationError(409, "This conversation has no Studio idea or thread to save an outcome to.");
  const owner = studio.note ? "studio-note" : "studio-thread";
  if (!("outcome" in body)) {
    const known = (await host.operations(id)).find(op => op.proposalId === body.proposalId);
    if (!known) throw new ConversationError(404, "That outcome was not proposed in this conversation.");
    return known.state === "uncertain" || known.state === "running" ? check(host, known) : known;
  }
  const operation = await host.propose(id, body.proposalId, 1, owner, digestOf(body.outcome));
  if (operation.state === "created" || operation.state === "failed") return operation;
  if (operation.state === "uncertain" || operation.state === "running") return check(host, operation);
  const options = deps.runtime?.options;
  if (!options?.enabled || !options.studio) return host.transition(operation.operationId, "confirmed").then(() => host.transition(operation.operationId, "running")).then(() => host.transition(operation.operationId, "failed", { note: "The Studio is not set up on this stack. Nothing was written." }));
  await host.transition(operation.operationId, "confirmed");
  await host.transition(operation.operationId, "running");
  const exchange = { thread: studio.thread, scope: studio.note ? { kind: "ghost" as const, note: studio.note } : { kind: "thread" as const }, original: studio.original, stand: studio.stand };
  try {
    const turns = await host.exchange(id);
    const { policy } = await host.meta(id);
    const result = await runStudioTransaction({ options: options.studio, areas: options.areas, requestId: studioRequestId(operation.operationId), ...(deps.now ? { now: deps.now() } : {}), ...(deps.git ? { git: deps.git } : {}) },
      ctx => planExchangeEnd(ctx, { ...exchange, policy, turns }, body.outcome, `Record Ivy conversation ${id}`));
    if (!result.ok) {
      const to = result.status >= 500 ? "uncertain" : "failed";
      return await host.transition(operation.operationId, to, { note: result.error });
    }
    const created = await host.transition(operation.operationId, "created", { canonicalId: result.commit, note: result.message });
    await host.record(id, `decision:${operation.operationId}`, DECISION_KIND, { source: "studio-outcome", operationId: operation.operationId, outcome: body.outcome, commit: result.commit });
    return created;
  } catch (error) {
    return host.transition(operation.operationId, "uncertain", { note: error instanceof Error ? error.message : String(error) });
  }
}

async function check(host: ConversationHost, operation: OperationRecord): Promise<OperationRecord> {
  const found = await host.readback(operation);
  if (found?.found) {
    const created = await host.transition(operation.operationId, "created", { canonicalId: found.canonicalId, note: "Check found the saved note." });
    await host.record(operation.conversationId, `decision:${operation.operationId}`, DECISION_KIND, { source: "studio-outcome", operationId: operation.operationId, commit: found.canonicalId, checked: true });
    return created;
  }
  if (found && operation.state === "uncertain") return host.transition(operation.operationId, "failed", { note: "Check found no saved note. Nothing was written; choose again to retry." });
  if (found && operation.state === "running") return host.transition(operation.operationId, "uncertain", { note: "Check found no saved note yet." });
  return operation;
}
