import { ConversationError, type HostStatus } from "../../../conversations/host";
import { AttachmentUploadSchema, CreateConversationSchema, DraftSchema, InputRequestSchema } from "../../../conversations/types";
import { applyStudioOutcome, ImportSchema, isImported, importStudioSession, OutcomeSchema, sourceConversations, SourceQuerySchema, StartSchema, startFromSource, type StudioConversationDeps } from "./conversation-studio";
import { checkRebindGuard, enforceMutationAuth, type MutationGuardContext } from "./mutation-guard";
import { DEFAULT_LOCAL_PRINCIPAL } from "./networks-admission";

export type ConversationAccess = () => HostStatus | null;

const reply = (status: number, body: object): Response => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
const fail = (status: number, error: string): Response => reply(status, { ok: false, error });
const notAllowed = (allow: string): Response => new Response(null, { status: 405, headers: { Allow: allow } });
function decoded(value: string): string | null {
  try { return decodeURIComponent(value); }
  catch { return null; }
}
const ITEM = /^\/api\/conversations\/([0-9a-f-]{36})(?:\/(inputs|entries|attachments|draft|outcome)(?:\/([^/]+))?)?$/;

export function importedSessions(access: ConversationAccess | undefined): (sessionId: string) => Promise<boolean> {
  return async sessionId => {
    const status = access?.();
    return status?.state === "ready" ? isImported(status.host, sessionId) : false;
  };
}

export function isStackPrincipal(principal: string, guard: MutationGuardContext): boolean {
  const who = principal.trim().toLowerCase();
  if (guard.principals.size > 0) return guard.principals.has(who);
  return who === (guard.localPrincipal ?? DEFAULT_LOCAL_PRINCIPAL).trim().toLowerCase();
}

async function body(req: Request): Promise<unknown> {
  return req.json().catch(() => null);
}

export async function handleConversations(req: Request, url: URL, guard: MutationGuardContext, access: ConversationAccess | undefined, studio?: StudioConversationDeps): Promise<Response> {
  const rebind = checkRebindGuard(req, guard);
  if (rebind) return rebind;
  const auth = await enforceMutationAuth(req, guard);
  if (auth instanceof Response) return auth;
  if (!isStackPrincipal(auth.principal, guard)) return fail(403, "Only this stack's principal can read or write its conversations.");
  const status = access?.() ?? null;
  if (!status) return fail(503, "Conversations are not set up on this stack.");
  if (status.state === "unavailable") return fail(503, status.reason);
  const { host } = status;
  try {
    if (url.pathname === "/api/conversations") {
      if (req.method === "GET") return reply(200, { ok: true, conversations: await host.list() });
      if (req.method !== "POST") return notAllowed("GET, POST");
      const parsed = CreateConversationSchema.safeParse(await body(req));
      if (!parsed.success) return fail(400, "The conversation request is not valid.");
      return reply(201, { ok: true, conversation: await host.create(parsed.data, auth.principal) });
    }
    if (url.pathname === "/api/conversations/source") {
      if (req.method !== "GET") return notAllowed("GET");
      const query = SourceQuerySchema.safeParse({ owner: url.searchParams.get("owner"), id: url.searchParams.get("id") });
      if (!query.success) return fail(400, "The source reference is not valid.");
      if (!studio) return fail(503, "Conversation sources are not set up on this stack.");
      return reply(200, { ok: true, ...(await sourceConversations(host, studio, query.data)) });
    }
    if (url.pathname === "/api/conversations/starts" || url.pathname === "/api/conversations/imports") {
      if (req.method !== "POST") return notAllowed("POST");
      if (!studio) return fail(503, "Conversation sources are not set up on this stack.");
      const raw = await body(req);
      if (url.pathname === "/api/conversations/starts") {
        const parsed = StartSchema.safeParse(raw);
        if (!parsed.success) return fail(400, "The start request is not valid.");
        return reply(201, { ok: true, conversation: await startFromSource(host, studio, parsed.data, auth.principal) });
      }
      const parsed = ImportSchema.safeParse(raw);
      if (!parsed.success) return fail(400, "The import request is not valid.");
      return reply(200, { ok: true, conversation: await importStudioSession(host, studio, parsed.data.sessionId, auth.principal) });
    }
    const match = ITEM.exec(url.pathname);
    const id = match?.[1];
    if (!match || !id) return fail(404, "Unknown conversation route.");
    const [, , part, inputId] = match;
    if (!part) {
      if (req.method !== "GET") return notAllowed("GET");
      return reply(200, { ok: true, ...(await host.detail(id)) });
    }
    if (part === "draft") {
      if (req.method !== "PUT" || inputId) return notAllowed("PUT");
      const parsed = DraftSchema.safeParse(await body(req));
      if (!parsed.success) return fail(400, "The draft is not valid.");
      await host.saveDraft(id, parsed.data.text);
      return reply(200, { ok: true });
    }
    if (part === "outcome") {
      if (req.method !== "POST" || inputId) return notAllowed("POST");
      if (!studio) return fail(503, "Conversation sources are not set up on this stack.");
      const parsed = OutcomeSchema.safeParse(await body(req));
      if (!parsed.success) return fail(400, "The outcome is not valid.");
      const operation = await applyStudioOutcome(host, studio, id, parsed.data);
      return reply(operation.state === "created" ? 200 : operation.state === "failed" ? 409 : 202, { ok: operation.state === "created", operation, ...(operation.state === "failed" ? { error: operation.history.at(-1)?.detail ?? "The outcome was not saved." } : {}) });
    }
    if (part === "entries") {
      if (req.method !== "GET" || inputId) return notAllowed("GET");
      const limit = Number(url.searchParams.get("limit") ?? "100");
      if (!Number.isInteger(limit) || limit < 1 || limit > 500) return fail(400, "The limit must be between 1 and 500.");
      return reply(200, { ok: true, ...(await host.entries(id, limit, url.searchParams.get("cursor") ?? undefined)) });
    }
    if (part === "attachments") {
      if (req.method !== "POST" || inputId) return notAllowed("POST");
      const parsed = AttachmentUploadSchema.safeParse(await body(req));
      if (!parsed.success) return fail(400, "The attachment is not valid.");
      return reply(201, { ok: true, attachment: await host.storeAttachment(id, parsed.data) });
    }
    if (inputId) {
      if (req.method !== "GET") return notAllowed("GET");
      const key = decoded(inputId);
      if (key === null) return fail(400, "The input id is not valid.");
      return reply(200, { ok: true, submission: await host.input(id, key) });
    }
    if (req.method !== "POST") return notAllowed("POST");
    const parsed = InputRequestSchema.safeParse(await body(req));
    if (!parsed.success) return fail(400, "The input request is not valid.");
    if (parsed.data.transport !== "web") return fail(400, "This route carries web input only.");
    const result = await host.submit(id, parsed.data);
    return reply(result.duplicate ? 200 : 202, { ok: true, ...result });
  } catch (error) {
    if (error instanceof ConversationError) return fail(error.status, error.message);
    console.error(`conversations: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
    return fail(500, "The conversation store failed this request. Nothing further was changed.");
  }
}
