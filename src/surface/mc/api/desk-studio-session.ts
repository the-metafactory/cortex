import { readStudioMyDay } from "../desk/studio-my-day";
import { SessionAnswerSchema, SessionRequestSchema, StudioSessionSchema, type StudioSession } from "../desk/studio/session-schema";
import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import type { DeskRuntime } from "../desk/compose";
import { readStudioFiles } from "../desk/studio/read";
import { buildStudioView } from "../desk/studio/view";
import { runStudioAct, runStudioTransaction } from "../desk/studio/writer";
import { composerDraft, planSessionEnd, sessionEndpoint, sessionModel, sessionPrompt, sessionSubject, sessionThread, type SessionModel } from "../desk/studio/session";

const queues = new WeakMap<Database, Map<string, Promise<void>>>();
const answer = (status: number, body: object): Response => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
const fail = (status: number, error: string, session?: StudioSession): Response => answer(status, { ok: false, error, ...(session ? { session } : {}) });
export function readStudioSession(db: Database, dir: string, id: string): StudioSession | null {
  const row = db.query<{ data: string }, [string, string]>("SELECT data FROM desk_studio_sessions WHERE id = ? AND directory = ?").get(id, dir);
  return row ? StudioSessionSchema.parse(JSON.parse(row.data)) : null;
}
function save(db: Database, dir: string, session: StudioSession): void {
  db.query("INSERT INTO desk_studio_sessions (id, directory, data) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data WHERE directory = excluded.directory").run(session.id, dir, JSON.stringify(session));
}
export interface SessionDeps {
  model?: SessionModel;
  now?: () => Date;
  imported?: (sessionId: string) => Promise<boolean>;
}
export async function handleDeskStudioSession(req: Request, db: Database, runtime: DeskRuntime | undefined, deps: SessionDeps = {}): Promise<Response> {
  if (req.method !== "POST") return new Response(null, { status: 405, headers: { Allow: "POST" } });
  const desk = runtime?.options;
  if (!desk?.enabled || !desk.studio) return fail(409, "The Studio is not set up on this stack.");
  const options = desk.studio;
  const parsed = SessionRequestSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return fail(400, "The session request is not valid.");
  const request = parsed.data;
  let queue = queues.get(db);
  if (!queue) { queue = new Map(); queues.set(db, queue); }
  const previous = queue.get(request.id) ?? Promise.resolve();
  const { promise: current, resolve: release } = Promise.withResolvers<undefined>();
  queue.set(request.id, current);
  await previous;
  try {
    const { dir } = options;
    if (request.action === "recover") {
      const rows = db.query<{ data: string }, [string]>("SELECT data FROM desk_studio_sessions WHERE directory = ? AND json_extract(data, '$.phase.kind') != 'ended' ORDER BY rowid DESC LIMIT 50").all(dir);
      const sessions = rows.map(row => StudioSessionSchema.parse(JSON.parse(row.data))).filter(s => s.phase.kind !== "ended");
      const kept = [];
      for (const s of sessions) if (s.phase.kind === "ending" || !(await deps.imported?.(s.id))) kept.push(s);
      return answer(200, { ok: true, sessions: kept });
    }
    let session = readStudioSession(db, dir, request.id);
    const context = async () => {
      const { files, problems } = await readStudioFiles(dir);
      return { files, view: buildStudioView(files, options, desk.areas, problems), now: deps.now?.() ?? new Date() };
    };
    if (request.action === "start") {
      if (session) {
        if (session.thread !== request.thread || JSON.stringify(session.scope) !== JSON.stringify(request.scope)) return fail(409, "That session id already names another discussion.");
      } else {
        const thread = sessionThread(await context(), request.thread);
        const original = thread ? sessionSubject(thread, request.scope) : null;
        if (!thread || thread.state === "closed" || original === null) return fail(409, "Choose an open idea, proposed stand or an active thread.");
        session = { id: request.id, thread: request.thread, scope: request.scope, original, stand: thread.stand, policy: thread.policy, turns: [], phase: { kind: "open" } };
        save(db, dir, session);
      }
    }
    if (!session) return fail(404, "That session was not found in this Studio.");
    if (request.action === "start" || request.action === "read") return answer(200, { ok: true, session });
    if (session.phase.kind === "open" && await deps.imported?.(session.id)) return fail(409, "This exchange continues as an Ivy conversation. Open it from its Studio thread.", session);
    if (request.action === "save-message") {
      if (session.phase.kind !== "ended") return fail(409, "Save the exchange before adding a remaining message.", session);
      const hash = createHash("sha256").update(JSON.stringify([session.id, session.thread, request.text])).digest("hex").slice(0, 56);
      try { await readStudioMyDay(db, desk, deps.now?.().getTime() ?? Date.now(), true); }
      catch { return fail(409, "Studio is busy or unreadable. Nothing was written; retry when its files are ready.", session); }
      const result = await runStudioAct({ options, areas: desk.areas, requestId: `late-${hash}`, act: { act: "respond", thread: session.thread, text: request.text }, ...(deps.now ? { now: deps.now() } : {}) });
      if (!result.ok) return fail(result.status, result.error, session);
      try { await readStudioMyDay(db, desk, deps.now?.().getTime() ?? Date.now()); }
      catch { return answer(200, { ok: true, session, commit: result.commit, message: result.message, projection: "pending" }); }
      return answer(200, { ok: true, session, commit: result.commit, message: result.message });
    }
    if (request.action === "end") {
      if (session.phase.kind !== "open" && JSON.stringify(session.phase.outcome) !== JSON.stringify(request.outcome)) return fail(409, "This session already has a different ending. Reload its saved outcome.", session);
      if (session.phase.kind === "ended") return answer(200, { ok: true, session });
      if (session.phase.kind === "open") session.draft = composerDraft(session.draft, request.draft, session.turns.at(-1)?.text);
      session.phase = { kind: "ending", outcome: request.outcome };
      save(db, dir, session);
      const ending = session;
      const result = await runStudioTransaction({ options, areas: desk.areas, requestId: `session-${session.id}`, ...(deps.now ? { now: deps.now() } : {}) }, ctx => planSessionEnd(ctx, ending, request.outcome));
      if (!result.ok) {
        session.phase = { kind: "open" }; save(db, dir, session);
        return fail(result.status, result.error, session);
      }
      session.phase = { kind: "ended", outcome: request.outcome, commit: result.commit };
      save(db, dir, session);
      return answer(200, { ok: true, session, message: result.message });
    }
    if (session.phase.kind !== "open") return fail(409, "This session has ended. Its exchange is retained.", session);
    const prior = session.turns.find(t => t.id === request.turn);
    if (prior && prior.text !== request.text) return fail(409, "That turn id already has different text.", session);
    if (prior?.answer) { session.draft = composerDraft(session.draft, request.draft, request.text); save(db, dir, session); return answer(200, { ok: true, session }); }
    if (session.turns.some(t => !t.answer && t.id !== request.turn)) return fail(409, "Retry the unanswered turn or close and save the exchange first.", session);
    if (!prior && session.turns.length >= 30) return fail(409, "This short session is full. Save its note before starting another.", session);
    session.draft = composerDraft(session.draft, request.draft, request.text);
    const thread = sessionThread(await context(), session.thread);
    if (!thread || thread.state === "closed") return fail(409, "The thread is unavailable. Your exchange is retained.", session);
    if (thread.policy === "local") session.policy = "local";
    const endpoint = sessionEndpoint(options, { ...thread, policy: session.policy });
    const turn = prior ?? { id: request.turn, text: request.text, answer: null, model: endpoint?.model ?? "unavailable", policy: session.policy };
    if (!prior) session.turns.push(turn);
    turn.policy = session.policy; turn.model = endpoint?.model ?? "unavailable";
    save(db, dir, session);
    if (!endpoint) return fail(503, session.policy === "local" ? "The local model is not configured. Your text is saved; no cloud fallback was used." : "A Studio model is not configured. Your text is saved.", session);
    try {
      turn.answer = SessionAnswerSchema.parse(await (deps.model ?? sessionModel)(endpoint, sessionPrompt(session, thread)));
      save(db, dir, session);
      return answer(200, { ok: true, session });
    } catch {
      return fail(502, "Ivy could not answer. Your text is saved. Retry the same turn, or close and save the exchange.", session);
    }
  } finally {
    release(undefined);
    if (queue.get(request.id) === current) queue.delete(request.id);
  }
}
