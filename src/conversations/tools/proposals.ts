import { z } from "zod/v4";
import { ProposeSchema, ReviseSchema, type ConversationCreation, type ProposalView } from "../creation";
import { ConversationError } from "../errors";
import { proposalLinks } from "../links";
import type { ToolDefinition, ToolSession } from "./capabilities";

export type CreationOwner = Pick<ConversationCreation, "capabilities" | "propose" | "revise" | "check" | "list">;

const READ_PAGE_SIZE = 3;
const page = <T>(items: T[], offset: number, limit: number) => ({ items: items.slice(offset, offset + limit), next: offset + limit < items.length ? offset + limit : null });
const DiscoverInput = z.object({ type: z.string().max(64).optional(), offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(5).default(5) }).strict();
const ProposeInput = ProposeSchema.omit({ entryId: true });
const ReviseInput = ReviseSchema.extend({ proposalId: z.uuid() });
const ReadInput = z.object({ proposalId: z.uuid().optional(), offset: z.number().int().min(0).default(0) }).strict();
const actorOf = (session: ToolSession) => ({ principal: session.principal, transport: session.transport });
const resultOf = (view: ProposalView) => ({
  status: view.operation?.state ?? (view.feedback === "proposed" ? "pending" : view.feedback),
  links: proposalLinks(view), view,
});

async function ownerResult(run: () => Promise<object>): Promise<string> {
  try { return JSON.stringify(await run()); }
  catch (error) {
    if (!(error instanceof ConversationError)) throw error;
    return JSON.stringify({ status: error.status === 403 ? "refused" : error.status === 404 ? "unavailable" : "needs-review", message: error.message });
  }
}

export function proposalTools(owner: CreationOwner): ToolDefinition[] {
  return [
    {
      name: "creation_capabilities", operation: null, input: DiscoverInput,
      description: "Discover live creation types, owners, destinations, required fields, fixed restrictions and blocking reasons. Follow next for more types. Choose the type and destination with the principal; ask for missing required fields. Unsupported owners cannot be written here.",
      run: (raw) => {
        const input = raw as z.infer<typeof DiscoverInput>;
        const types = owner.capabilities().filter(type => input.type === undefined || type.type === input.type);
        const { items, next } = page(types, input.offset, input.limit);
        return Promise.resolve(JSON.stringify({ types: items, next, ...(input.type !== undefined && types.length === 0 ? { status: "unavailable", message: "This type is not in the creation catalog. Nothing was created." } : {}) }));
      },
    },
    {
      name: "creation_propose", operation: null, input: ProposeInput,
      description: "Prepare an editable owner proposal. Discover types first. Supply a stable proposalId UUID and reuse it with identical input after a timeout or restart; use creation_read_result to recover saved IDs. Omit type if unclear and ask which type and destination. Ask for every missing required field. The host binds the originating entry. This never confirms or grants permission; an existing scoped standing permission may create through the owner. Report only the returned state and links.",
      run: async (raw, { session, signal }) => ownerResult(async () => {
        signal.throwIfAborted();
        if (!session.entryId) throw new ConversationError(403, "The originating conversation entry is unavailable. Nothing was proposed.");
        const input = raw as z.infer<typeof ProposeInput>;
        const saved = (await owner.list(session.conversationId, actorOf(session))).proposals.find(view => view.proposal.proposalId === input.proposalId);
        signal.throwIfAborted();
        const made = await owner.propose(session.conversationId, { ...input, entryId: saved?.proposal.entryId ?? session.entryId }, actorOf(session));
        return { ...resultOf(made.view), duplicate: made.duplicate };
      }),
    },
    {
      name: "creation_revise", operation: null, input: ReviseInput,
      description: "Edit a saved proposal using its current revision. fields replaces the whole field map; preserve fields that still apply. This never confirms, grants permission or runs a writer. On a stale revision or retry, read the current result before editing again. An uncertain or accepted effect must be reconciled before revision.",
      run: async (raw, { session, signal }) => ownerResult(async () => {
        signal.throwIfAborted();
        const { proposalId, ...revision } = raw as z.infer<typeof ReviseInput>;
        return resultOf(await owner.revise(session.conversationId, proposalId, revision, actorOf(session)));
      }),
    },
    {
      name: "creation_read_result", operation: null, input: ReadInput,
      description: "Read saved proposals in this conversation, or reconcile one proposalId with owner readback. This never retries creation. Follow next for further proposals. Report pending, confirmed, running, created, unavailable and uncertain distinctly. Only created with an owner canonicalId proves creation. Cite the canonical object and originating entry links. Unknown remains unknown until the owner answers.",
      run: async (raw, { session, signal }) => ownerResult(async () => {
        signal.throwIfAborted();
        const input = raw as z.infer<typeof ReadInput>;
        if (input.proposalId) return resultOf(await owner.check(session.conversationId, input.proposalId, actorOf(session)));
        const { proposals } = await owner.list(session.conversationId, actorOf(session));
        const { items, next } = page(proposals, input.offset, READ_PAGE_SIZE);
        return { proposals: items.map(resultOf), next };
      }),
    },
  ];
}
