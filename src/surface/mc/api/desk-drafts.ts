import { z } from "zod";
import { DraftConflict, type DraftView, type Lane } from "../../../conversations/domain-adapters/drafting";
import { ConversationError } from "../../../conversations/host";
import type { DeskDraftAccess, DeskDraftEditor } from "../desk/draft-editor";
import { DESK_DRAFTS_PATH } from "../desk/draft-editor-contract";
import { fail, notAllowed, reply } from "./conversations";
import { stackPrincipalOf } from "./desk-connections";
import type { MutationGuardContext } from "./mutation-guard";

const id = z.string().min(1).max(512);
const revision = z.number().int().positive();
const Make = z.object({ conversationId: id, entryId: id, capabilityId: id, connectionId: id, newDraft: z.boolean().optional(), selectDraftId: id.optional() }).strict();
const Edit = z.object({ revision, pointer: id, change: z.discriminatedUnion("kind", [z.object({ kind: z.literal("set"), value: z.json() }).strict(), z.object({ kind: z.literal("omit") }).strict(), z.object({ kind: z.literal("null") }).strict()]) }).strict();
const Revision = z.object({ revision }).strict();
const Destination = z.object({ revision, connectionId: id, capabilityId: id }).strict();
const readBody = (req: Request): Promise<unknown> => req.json().catch(() => null);
const hasTarget = (editor: DeskDraftEditor, capabilityId: string, connectionId: string): boolean => editor.targets().some(target => target.capabilityId === capabilityId && target.connectionId === connectionId);

interface DraftContext { req: Request; url: URL; editor: DeskDraftEditor; audience: Lane; principal: string; draftId: string; before: DraftView }

async function readAvailable(editor: DeskDraftEditor, draftId: string, audience: Lane): Promise<DraftView | null> {
  const view = await editor.service.read(draftId, audience);
  if (view && !hasTarget(editor, view.draft.capabilityId, view.draft.connectionId)) throw new DraftConflict("This drafting destination is unavailable; the saved draft is retained.");
  return view;
}

async function present({ editor, draftId, audience, before }: DraftContext): Promise<Response> {
  const view = await readAvailable(editor, draftId, audience);
  if (!view) throw new DraftConflict("Draft does not exist.");
  return reply(200, editor.present(view, before));
}

async function collection(req: Request, editor: DeskDraftEditor, audience: Lane): Promise<Response> {
  if (req.method === "GET") return reply(200, { targets: editor.targets() });
  if (req.method !== "POST") return notAllowed("GET, POST");
  const parsed = Make.safeParse(await readBody(req));
  if (!parsed.success) return fail(400, "The Make request is not valid.");
  if (!hasTarget(editor, parsed.data.capabilityId, parsed.data.connectionId)) return fail(403, "This drafting destination is unavailable.");
  await editor.host.detail(parsed.data.conversationId);
  const made = await editor.service.make(parsed.data);
  if (made.kind === "select") return reply(200, made);
  const view = await readAvailable(editor, made.view.draft.draftId, audience);
  if (!view) throw new DraftConflict("Draft does not exist.");
  return reply(200, { kind: "draft", reopened: made.reopened, ...editor.present(view) });
}

async function draft(context: DraftContext): Promise<Response> {
  const { req, editor, draftId, before } = context;
  if (req.method === "GET") return reply(200, editor.present(before));
  if (req.method !== "PATCH") return notAllowed("GET, PATCH");
  const parsed = Edit.safeParse(await readBody(req));
  if (!parsed.success) return fail(400, "The field edit is not valid.");
  await editor.service.edit(draftId, parsed.data.revision, parsed.data.pointer, parsed.data.change);
  return present(context);
}

async function details({ req, url, editor, draftId, audience }: DraftContext): Promise<Response> {
  if (req.method !== "GET") return notAllowed("GET");
  const field = await editor.service.details(draftId, url.searchParams.get("pointer") ?? "", audience);
  return field ? reply(200, { details: field }) : fail(404, "No source details for this field.");
}

async function destination(context: DraftContext): Promise<Response> {
  const { req, editor, draftId } = context;
  if (req.method !== "POST") return notAllowed("POST");
  const parsed = Destination.safeParse(await readBody(req));
  if (!parsed.success) return fail(400, "The destination request is not valid.");
  if (!hasTarget(editor, parsed.data.capabilityId, parsed.data.connectionId)) return fail(403, "This drafting destination is unavailable.");
  await editor.service.changeDestination(draftId, parsed.data.revision, parsed.data);
  return present(context);
}

async function refresh(context: DraftContext): Promise<Response> {
  const { req, editor, draftId } = context;
  if (req.method !== "POST") return notAllowed("POST");
  const parsed = Revision.safeParse(await readBody(req));
  if (!parsed.success) return fail(400, "A draft revision is required.");
  const refreshed = await editor.service.refresh(draftId, parsed.data.revision);
  return refreshed.kind === "stale" ? fail(409, "The draft changed. Reopen it before refreshing.") : present(context);
}

async function confirm({ req, editor, draftId, before, principal, audience }: DraftContext): Promise<Response> {
  if (req.method !== "POST") return notAllowed("POST");
  const parsed = Revision.safeParse(await readBody(req));
  if (!parsed.success) return fail(400, "A draft revision is required.");
  if (before.withheld.length > 0) return reply(200, { confirmation: { kind: "blocked", reason: "Policy withholds draft fields in this context. Open the draft in a permitted context before confirming." } });
  const handoff = await editor.service.handoff(draftId, parsed.data.revision);
  if (!handoff.ok) return reply(200, { confirmation: { kind: "blocked", reason: `Confirmation needs review: ${[...handoff.blocking.map(item => `${item.pointer} ${item.code}`), ...handoff.outdated].join(", ")}.` } });
  const confirmation = editor.confirm ? await editor.confirm({ handoff: handoff.handoff, principal, transport: "web", audience }) : { kind: "blocked", reason: "Creation is not enabled for this drafting destination. The draft is saved; nothing was created." };
  return reply(200, { confirmation });
}

const ACTIONS: ReadonlyMap<string, (context: DraftContext) => Promise<Response>> = new Map([["", draft], ["details", details], ["destination", destination], ["refresh", refresh], ["confirm", confirm]]);

export async function handleDeskDrafts(req: Request, url: URL, guard: MutationGuardContext, access: DeskDraftAccess | undefined): Promise<Response> {
  const principal = await stackPrincipalOf(req, guard, "Only this stack's principal can review drafts.");
  if (principal instanceof Response) return principal;
  const editor = access?.();
  if (!editor) return req.method === "GET" && url.pathname === DESK_DRAFTS_PATH ? reply(200, { targets: [] }) : fail(503, "Drafting is not configured on this stack.");
  const audience = guard.isLoopback ? editor.audience : "cloud";
  try {
    if (url.pathname === DESK_DRAFTS_PATH) return await collection(req, editor, audience);
    const segments = url.pathname.slice(DESK_DRAFTS_PATH.length + 1).split("/");
    const draftId = segments[0] ? decodeURIComponent(segments[0]) : undefined;
    if (!draftId || segments.length > 2) return fail(404, "Unknown draft route.");
    const before = await editor.service.read(draftId, audience);
    if (!before) return fail(404, "Draft does not exist.");
    await editor.host.detail(before.draft.conversationId);
    if (!hasTarget(editor, before.draft.capabilityId, before.draft.connectionId)) return fail(403, "This drafting destination is unavailable; the saved draft is retained.");
    const action = ACTIONS.get(segments[1] ?? "");
    return action ? await action({ req, url, editor, audience, principal, draftId, before }) : fail(404, "Unknown draft action.");
  } catch (error) {
    if (error instanceof URIError) return fail(400, "The draft ID is not valid URI encoding.");
    if (error instanceof DraftConflict) return fail(409, error.message);
    if (error instanceof ConversationError) return fail(error.status, error.message);
    process.stderr.write(`desk drafts: ${error instanceof Error ? error.message : String(error)}\n`);
    return fail(500, "The draft could not be processed. Reopen it before retrying.");
  }
}
