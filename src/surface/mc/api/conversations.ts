import { ConversationError, type HostStatus } from "../../../conversations/host";
import { AttachmentUploadSchema, CreateConversationSchema, InputRequestSchema } from "../../../conversations/types";
import { checkRebindGuard, enforceMutationAuth, type MutationGuardContext } from "./mutation-guard";
import { DEFAULT_LOCAL_PRINCIPAL } from "./networks-admission";

export type ConversationAccess = () => HostStatus | null;

const reply = (status: number, body: object): Response => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
const fail = (status: number, error: string): Response => reply(status, { ok: false, error });
const ITEM = /^\/api\/conversations\/([0-9a-f-]{36})(?:\/(inputs|entries|attachments)(?:\/([^/]+))?)?$/;

export function isStackPrincipal(principal: string, guard: MutationGuardContext): boolean {
  const who = principal.trim().toLowerCase();
  if (guard.principals.size > 0) return guard.principals.has(who);
  return who === (guard.localPrincipal ?? DEFAULT_LOCAL_PRINCIPAL).trim().toLowerCase();
}

async function body(req: Request): Promise<unknown> {
  return req.json().catch(() => null);
}

export async function handleConversations(req: Request, url: URL, guard: MutationGuardContext, access: ConversationAccess | undefined): Promise<Response> {
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
      if (req.method !== "POST") return new Response(null, { status: 405, headers: { Allow: "GET, POST" } });
      const parsed = CreateConversationSchema.safeParse(await body(req));
      if (!parsed.success) return fail(400, "The conversation request is not valid.");
      return reply(201, { ok: true, conversation: await host.create(parsed.data, auth.principal) });
    }
    const match = ITEM.exec(url.pathname);
    const id = match?.[1];
    if (!match || !id) return fail(404, "Unknown conversation route.");
    const [, , part, inputId] = match;
    if (!part) {
      if (req.method !== "GET") return new Response(null, { status: 405, headers: { Allow: "GET" } });
      return reply(200, { ok: true, conversation: await host.meta(id) });
    }
    if (part === "entries") {
      if (req.method !== "GET" || inputId) return new Response(null, { status: 405, headers: { Allow: "GET" } });
      const limit = Number(url.searchParams.get("limit") ?? "100");
      if (!Number.isInteger(limit) || limit < 1 || limit > 500) return fail(400, "The limit must be between 1 and 500.");
      return reply(200, { ok: true, ...(await host.entries(id, limit, url.searchParams.get("cursor") ?? undefined)) });
    }
    if (part === "attachments") {
      if (req.method !== "POST" || inputId) return new Response(null, { status: 405, headers: { Allow: "POST" } });
      const parsed = AttachmentUploadSchema.safeParse(await body(req));
      if (!parsed.success) return fail(400, "The attachment is not valid.");
      return reply(201, { ok: true, attachment: await host.storeAttachment(id, parsed.data) });
    }
    if (inputId) {
      if (req.method !== "GET") return new Response(null, { status: 405, headers: { Allow: "GET" } });
      return reply(200, { ok: true, submission: await host.input(id, decodeURIComponent(inputId)) });
    }
    if (req.method !== "POST") return new Response(null, { status: 405, headers: { Allow: "POST" } });
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
