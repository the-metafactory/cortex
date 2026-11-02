import { ConfirmSchema, creationFor, ProposeSchema, ReviseSchema, type Actor } from "../../../conversations/creation";
import { ConversationError, type ConversationHost, type HostStatus } from "../../../conversations/host";
import { AttachmentUploadSchema, CreateConversationSchema, DraftSchema, InputRequestSchema, OrganizeSchema, OverviewQuerySchema } from "../../../conversations/types";
import { applyStudioOutcome, ImportSchema, isImported, withStudio, importStudioSession, OutcomeSchema, sourceConversations, SourceQuerySchema, StartSchema, startFromSource, type StudioConversationDeps } from "./conversation-studio";
import { checkRebindGuard, enforceMutationAuth, type MutationGuardContext } from "./mutation-guard";
import { DEFAULT_LOCAL_PRINCIPAL } from "./networks-admission";

export type ConversationAccess = () => HostStatus | null;

const reply = (status: number, body: object): Response => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
const fail = (status: number, error: string): Response => reply(status, { ok: false, error });
const NO_SOURCES = (): Response => fail(503, "Conversation sources are not set up on this stack.");
const notAllowed = (allow: string): Response => new Response(null, { status: 405, headers: { Allow: allow } });
function decoded(value: string): string | null {
  try { return decodeURIComponent(value); }
  catch { return null; }
}
const PROPOSALS = /^\/api\/conversations\/([0-9a-f-]{36})\/proposals(?:\/([0-9a-f-]{36})(?:\/(confirm|check))?)?$/;
const GRANT = /^\/api\/conversations\/grants\/(grant-[0-9a-f]{32})$/;
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
    if (url.pathname === "/api/conversations/overview") {
      if (req.method !== "GET") return notAllowed("GET");
      const query = OverviewQuerySchema.safeParse(Object.fromEntries(url.searchParams));
      if (!query.success) return fail(400, "The overview query is not valid.");
      return reply(200, { ok: true, ...(await host.overview(query.data)) });
    }
    if (url.pathname === "/api/conversations/source") {
      if (req.method !== "GET") return notAllowed("GET");
      const query = SourceQuerySchema.safeParse({ owner: url.searchParams.get("owner"), id: url.searchParams.get("id") });
      if (!query.success) return fail(400, "The source reference is not valid.");
      if (!studio) return NO_SOURCES();
      return reply(200, { ok: true, ...(await sourceConversations(host, studio, query.data)) });
    }
    if (url.pathname === "/api/conversations/starts" || url.pathname === "/api/conversations/imports") {
      if (req.method !== "POST") return notAllowed("POST");
      if (!studio) return NO_SOURCES();
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
    const actor: Actor = { principal: auth.principal, transport: "web" };
    const creation = await handleCreation(req, url, host, actor);
    if (creation) return creation;
    const match = ITEM.exec(url.pathname);
    const id = match?.[1];
    if (!match || !id) return fail(404, "Unknown conversation route.");
    const [, , part, inputId] = match;
    if (!part) {
      if (req.method === "PATCH") {
        const parsed = OrganizeSchema.safeParse(await body(req));
        if (!parsed.success) return fail(400, "Send pinned and/or state (current or archived).");
        return reply(200, { ok: true, conversation: await host.organize(id, parsed.data) });
      }
      if (req.method !== "GET") return notAllowed("GET, PATCH");
      return reply(200, { ok: true, ...(await withStudio(host, id, await host.detail(id))) });
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
      if (!studio) return NO_SOURCES();
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

async function handleCreation(req: Request, url: URL, host: ConversationHost, actor: Actor): Promise<Response | null> {
  const creation = creationFor(host);
  if (url.pathname === "/api/conversations/capabilities") {
    if (req.method !== "GET") return notAllowed("GET");
    return reply(200, { ok: true, types: creation.capabilities() });
  }
  if (url.pathname === "/api/conversations/grants") {
    if (req.method !== "GET") return notAllowed("GET");
    return reply(200, { ok: true, grants: await creation.grants(actor.principal) });
  }
  const grant = GRANT.exec(url.pathname);
  if (grant?.[1]) {
    if (req.method !== "DELETE") return notAllowed("DELETE");
    return reply(200, { ok: true, grant: await creation.revoke(grant[1], actor) });
  }
  const match = PROPOSALS.exec(url.pathname);
  const id = match?.[1];
  if (!match || !id) return null;
  const [, , proposalId, action] = match;
  if (!proposalId) {
    if (req.method === "GET") return reply(200, { ok: true, ...(await creation.list(id, actor)) });
    if (req.method !== "POST") return notAllowed("GET, POST");
    const parsed = ProposeSchema.safeParse(await body(req));
    if (!parsed.success) return fail(400, "The proposal is not valid.");
    const made = await creation.propose(id, parsed.data, actor);
    return reply(made.duplicate ? 200 : 201, { ok: true, proposal: made.view });
  }
  if (!action) {
    if (req.method !== "PATCH") return notAllowed("PATCH");
    const parsed = ReviseSchema.safeParse(await body(req));
    if (!parsed.success) return fail(400, "The proposal change is not valid.");
    return reply(200, { ok: true, proposal: await creation.revise(id, proposalId, parsed.data, actor) });
  }
  if (req.method !== "POST") return notAllowed("POST");
  if (action === "check") return reply(200, { ok: true, proposal: await creation.check(id, proposalId, actor) });
  const parsed = ConfirmSchema.safeParse(await body(req));
  if (!parsed.success) return fail(400, "The confirmation is not valid.");
  const view = await creation.confirm(id, proposalId, parsed.data, actor);
  const status = view.feedback === "created" ? 200 : view.feedback === "failed" ? 409 : 202;
  return reply(status, { ok: view.feedback === "created", proposal: view, ...(view.feedback === "failed" ? { error: view.operation?.history.at(-1)?.detail ?? "The owner refused it." } : {}) });
}
