import { z } from "zod";
import { DraftConflict } from "../../../conversations/domain-adapters/drafting";
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

export async function handleDeskDrafts(req: Request, url: URL, guard: MutationGuardContext, access: DeskDraftAccess | undefined): Promise<Response> {
  const principal = await stackPrincipalOf(req, guard, "Only this stack's principal can review drafts.");
  if (principal instanceof Response) return principal;
  const editor = access?.();
  if (!editor) return req.method === "GET" && url.pathname === DESK_DRAFTS_PATH ? reply(200, { targets: [] }) : fail(503, "Drafting is not configured on this stack.");
  const { service } = editor;
  const audience = guard.isLoopback ? editor.audience : "cloud";
  const present = async (draftId: string, before?: Awaited<ReturnType<typeof service.read>>) => {
    const view = await service.read(draftId, audience);
    if (!view) throw new DraftConflict("Draft does not exist.");
    if (!hasTarget(editor, view.draft.capabilityId, view.draft.connectionId)) throw new DraftConflict("This drafting destination is unavailable; the saved draft is retained.");
    return editor.present(view, before ?? undefined);
  };
  try {
    if (url.pathname === DESK_DRAFTS_PATH) {
      if (req.method === "GET") return reply(200, { targets: editor.targets() });
      if (req.method !== "POST") return notAllowed("GET, POST");
      const parsed = Make.safeParse(await readBody(req));
      if (!parsed.success) return fail(400, "The Make request is not valid.");
      if (!hasTarget(editor, parsed.data.capabilityId, parsed.data.connectionId)) return fail(403, "This drafting destination is unavailable.");
      await editor.host.detail(parsed.data.conversationId);
      const made = await service.make(parsed.data);
      return made.kind === "select" ? reply(200, made) : reply(200, { kind: "draft", reopened: made.reopened, ...await present(made.view.draft.draftId) });
    }
    const segments = url.pathname.slice(DESK_DRAFTS_PATH.length + 1).split("/");
    const draftId = segments[0];
    const action = segments[1];
    if (!draftId || segments.length > 2) return fail(404, "Unknown draft route.");
    const before = await service.read(draftId, audience);
    if (!before) return fail(404, "Draft does not exist.");
    await editor.host.detail(before.draft.conversationId);
    if (!hasTarget(editor, before.draft.capabilityId, before.draft.connectionId)) return fail(403, "This drafting destination is unavailable; the saved draft is retained.");
    if (!action && req.method === "GET") return reply(200, await present(draftId));
    if (action === "details") {
      if (req.method !== "GET") return notAllowed("GET");
      const pointer = url.searchParams.get("pointer") ?? "";
      const details = await service.details(draftId, pointer, audience);
      return details ? reply(200, { details }) : fail(404, "No source details for this field.");
    }
    if (!action) {
      if (req.method !== "PATCH") return notAllowed("GET, PATCH");
      const parsed = Edit.safeParse(await readBody(req));
      if (!parsed.success) return fail(400, "The field edit is not valid.");
      await service.edit(draftId, parsed.data.revision, parsed.data.pointer, parsed.data.change);
      return reply(200, await present(draftId, before));
    }
    if (!["refresh", "destination", "confirm"].includes(action)) return fail(404, "Unknown draft action.");
    if (req.method !== "POST") return notAllowed("POST");
    const raw = await readBody(req);
    if (action === "destination") {
      const parsed = Destination.safeParse(raw);
      if (!parsed.success) return fail(400, "The destination request is not valid.");
      if (!hasTarget(editor, parsed.data.capabilityId, parsed.data.connectionId)) return fail(403, "This drafting destination is unavailable.");
      await service.changeDestination(draftId, parsed.data.revision, parsed.data);
      return reply(200, await present(draftId, before));
    }
    const parsed = Revision.safeParse(raw);
    if (!parsed.success) return fail(400, "A draft revision is required.");
    if (action === "refresh") {
      const refreshed = await service.refresh(draftId, parsed.data.revision);
      return refreshed.kind === "stale" ? fail(409, "The draft changed. Reopen it before refreshing.") : reply(200, await present(draftId, before));
    }
    if (before.withheld.length > 0) return reply(200, { confirmation: { kind: "blocked", reason: "Policy withholds draft fields in this context. Open the draft in a permitted context before confirming." } });
    const handoff = await service.handoff(draftId, parsed.data.revision);
    if (!handoff.ok) return reply(200, { confirmation: { kind: "blocked", reason: `Confirmation needs review: ${[...handoff.blocking.map(item => `${item.pointer} ${item.code}`), ...handoff.outdated].join(", ")}.` } });
    const confirmation = editor.confirm ? await editor.confirm({ handoff: handoff.handoff, principal, transport: "web", audience }) : { kind: "blocked", reason: "Creation is not enabled for this drafting destination. The draft is saved; nothing was created." };
    return reply(200, { confirmation });
  } catch (error) {
    if (error instanceof DraftConflict) return fail(409, error.message);
    if (error instanceof ConversationError) return fail(error.status, error.message);
    process.stderr.write(`desk drafts: ${error instanceof Error ? error.message : String(error)}\n`);
    return fail(500, "The draft could not be processed. Reopen it before retrying.");
  }
}
