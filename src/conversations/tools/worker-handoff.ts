import { z } from "zod/v4";
import { WORKER_NODE_REF, WORKER_REPOSITORY_REF } from "../../common/types/desk-workers";
import type { Policy } from "../types";
import type { ToolDefinition, ToolSession } from "./capabilities";
import { redactToolText } from "./output";
import { mayRelease, STALE_AFTER_MS } from "./work-context";
import type { CreationOwner } from "./proposals";
import { proposalResult } from "./proposals";

export const WORKER_STATES = ["prepared", "queued", "running", "stopping", "waiting", "review", "merged", "failed", "cancelled"] as const;
export type WorkerState = (typeof WORKER_STATES)[number];
export const WORKER_ACTIVE: ReadonlySet<WorkerState> = new Set(["queued", "running", "stopping", "waiting", "review"]);

const BUDGET_TOKEN_MAX = 10_000_000;
const BUDGET_MINUTE_MAX = 1_440;

export const repositoryOf = (ref: string): string => ref.slice(0, ref.lastIndexOf("#"));

export const BudgetSchema = z.object({
  tokens: z.number().int().min(1).max(BUDGET_TOKEN_MAX),
  minutes: z.number().int().min(1).max(BUDGET_MINUTE_MAX),
  invocations: z.number().int().min(1).max(100_000).optional(),
}).strict();

const BriefInputSchema = z.object({
  proposalId: z.uuid(),
  repository: z.string().trim().max(300).regex(WORKER_REPOSITORY_REF),
  map: z.string().trim().max(320).regex(WORKER_NODE_REF),
  parent: z.string().trim().max(320).regex(WORKER_NODE_REF),
  title: z.string().trim().min(1).max(200),
  scope: z.string().trim().min(1).max(4_000),
  acceptanceChecks: z.array(z.string().trim().min(1).max(600)).min(1).max(12),
  checkpoint: z.string().trim().min(1).max(120).regex(/^[a-z0-9][a-z0-9-]*$/),
  budget: BudgetSchema,
  probes: z.array(z.string().trim().min(2).max(600)).max(8).optional(),
  blockedBy: z.array(z.string().trim().min(3).max(320)).max(16).optional(),
}).strict();
type BriefInput = z.infer<typeof BriefInputSchema>;
const NodeInputSchema = z.object({ proposalId: z.uuid(), node: z.string().trim().max(320).regex(WORKER_NODE_REF) }).strict();
type NodeInput = z.infer<typeof NodeInputSchema>;
const StatusInputSchema = z.object({ node: z.string().trim().max(320).regex(WORKER_NODE_REF) }).strict();
type StatusInput = z.infer<typeof StatusInputSchema>;

export interface WorkerHandoff {
  node: string;
  map: string;
  policy: Policy;
  state: WorkerState;
  reason: string | null;
  generation: number | null;
  pr: string | null;
  result: string | null;
  url?: string;
  prUrl?: string;
  observedAt: number;
}
export type WorkerRead = { state: "available"; handoff: WorkerHandoff } | { state: "unknown"; reason: string } | { state: "unauthorized" } | { state: "unavailable"; reason: string };
export interface WorkerOwner {
  maps: (session: ToolSession) => readonly string[];
  read: (session: ToolSession, node: string) => Promise<WorkerRead>;
  recorded: (session: ToolSession, node: string) => Policy | null;
  remember: (session: ToolSession, handoff: WorkerHandoff, signal: AbortSignal) => Promise<boolean>;
  now: () => number;
}

const NOTHING = "Nothing was started.";
const NOTHING_CANCELLED = "Nothing was cancelled.";
const UNAVAILABLE = "The owning system could not answer for this node. This is not a confirmed absence.";
const UNKNOWN = "This node is not a recorded implementation handoff from this principal's conversation. Prepare a brief first; nothing was started.";

export type Guard = { handoff: WorkerHandoff } | { refusal: { status: string; message: string } };

async function guard(owner: WorkerOwner, session: ToolSession, node: string, verb: "started" | "cancelled", signal: AbortSignal): Promise<Guard> {
  const read = await owner.read(session, node);
  signal.throwIfAborted();
  if (read.state === "unauthorized") return { refusal: { status: "refused", message: `This conversation may not read that node, so it cannot be ${verb === "started" ? "started" : "cancelled"}. Nothing was ${verb}.` } };
  if (read.state === "unavailable") return { refusal: { status: "unavailable", message: `${UNAVAILABLE} Nothing was ${verb}.` } };
  if (read.state === "unknown") return { refusal: { status: "refused", message: UNKNOWN.replace("started", verb) } };
  if (!mayRelease(session, read.handoff.policy)) return { refusal: { status: "refused", message: `This node is outside what this conversation may release. Nothing was ${verb}.` } };
  return { handoff: read.handoff };
}

const briefBody = (brief: BriefInput): string => [
  `Repository: ${brief.repository}`,
  `Map: ${brief.map}`,
  "",
  "## Deliverable",
  brief.scope,
  "",
  "## Acceptance criteria",
  ...brief.acceptanceChecks.map(check => `- ${check}`),
  "",
  "## Budget",
  `- ${brief.budget.tokens} tokens`,
  ...(brief.budget.invocations === undefined ? [] : [`- ${brief.budget.invocations} agent invocations`]),
  `- ${brief.budget.minutes} minutes`,
].join("\n");

const briefFields = (brief: BriefInput): Record<string, string> => ({
  repository: brief.repository,
  map: brief.map,
  parent: brief.parent,
  title: brief.title,
  checkpoint: brief.checkpoint,
  body: briefBody(brief),
  budgetTokens: String(brief.budget.tokens),
  budgetMinutes: String(brief.budget.minutes),
  ...(brief.budget.invocations === undefined ? {} : { budgetInvocations: String(brief.budget.invocations) }),
  ...(brief.probes?.length ? { probes: brief.probes.join("\n") } : {}),
  ...(brief.blockedBy?.length ? { dependencies: brief.blockedBy.join("\n") } : {}),
});

export function briefRefusal(brief: BriefInput, maps: readonly string[]): string | null {
  if (repositoryOf(brief.map) !== brief.repository) return "The configured map belongs to another repository than the one named. Nothing was filed.";
  if (!maps.includes(brief.map)) return `${brief.map} is not a configured registered map for implementation work. Nothing was filed.`;
  if (repositoryOf(brief.parent) !== brief.repository) return "The parent node belongs to another repository than the one named. Nothing was filed.";
  for (const probe of brief.probes ?? []) {
    try { JSON.parse(probe); }
    catch { return "A probe must be one JSON object. Nothing was filed."; }
  }
  return null;
}

const NOT_ELIGIBLE = ["routes escalate-hitl", "routes provisioning", "routes brief-not-ready", "is proposed", "was refused", "not walkable", "waits for the principal"];
export const awaitingApproval = (reason: string): boolean => NOT_ELIGIBLE.some(marker => reason.toLowerCase().includes(marker));

const view = (made: { view: Parameters<typeof proposalResult>[0]; duplicate: boolean }) => ({ ...proposalResult(made.view), duplicate: made.duplicate });
const failed = (status: number, text: string): string => JSON.stringify({ status: status === 403 ? "refused" : status === 404 ? "unavailable" : "needs-review", message: text });
const ownerFailure = (error: unknown): string => JSON.stringify({ status: "needs-review", message: redactToolText(error instanceof Error ? error.message : String(error)) });
const actor = (session: ToolSession) => ({ principal: session.principal, transport: session.transport });

async function propose(owner: CreationOwner, session: ToolSession, body: { proposalId: string; type: string; fields: Record<string, string> }, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted();
  if (!session.entryId) return failed(403, "The originating conversation entry is unavailable. Nothing was filed.");
  const made = await owner.propose(session.conversationId, { ...body, entryId: session.entryId }, actor(session));
  return JSON.stringify(view(made));
}

export function workerTools(owner: WorkerOwner, creation: CreationOwner): ToolDefinition[] {
  const brief: ToolDefinition = {
    name: "worker_brief", operation: null, input: BriefInputSchema,
    description: "Prepare a concrete implementation brief and file it as a work-graph node through the owner proposal path: repository, registered map, parent node, scope, acceptance checks, checkpoint, probes and budget. Reuse the proposalId with identical input after a timeout or restart. This never starts work and never changes a node's autonomy; the node is filed as one that needs approval. A scoped standing permission may file it without asking.",
    run: async (raw, { session, signal }) => {
      try {
        signal.throwIfAborted();
        const input = raw as BriefInput;
        const refusal = briefRefusal(input, owner.maps(session));
        if (refusal) return JSON.stringify({ status: "refused", message: refusal });
        return await propose(creation, session, { proposalId: input.proposalId, type: "work-brief", fields: briefFields(input) }, signal);
      } catch (error) { return ownerFailure(error); }
    },
  };
  const start: ToolDefinition = {
    name: "worker_start", operation: null, input: NodeInputSchema,
    description: "Ask to start one exact recorded implementation node that this conversation prepared, on its configured registered map, through Ranger's supported start verb. Starting is its own authority: without a scoped standing permission the principal confirms it, and the answer says awaiting-confirmation. Ranger's own gates decide: dependencies, ownership, pause, lane, provisioning, budget and approvals all apply, and a node it will not run automatically is reported as awaiting approval rather than rewritten. Retries reconcile the recorded handoff instead of starting another worker. Nothing is merged, deployed or sent.",
    run: async (raw, { session, signal }) => {
      try {
        signal.throwIfAborted();
        const input = raw as NodeInput;
        const checked = await guard(owner, session, input.node, "started", signal);
        if ("refusal" in checked) return JSON.stringify(checked.refusal);
        const { handoff } = checked;
        if (!owner.maps(session).includes(handoff.map)) return JSON.stringify({ status: "refused", message: `The recorded map is not configured for implementation work on this stack. ${NOTHING}` });
        if (WORKER_ACTIVE.has(handoff.state)) return JSON.stringify({ status: "already-started", state: handoff.state, generation: handoff.generation, node: handoff.node, map: handoff.map, message: "This node already has a recorded worker; nothing new was started." });
        const answer = await propose(creation, session, { proposalId: input.proposalId, type: "work-start", fields: { node: handoff.node } }, signal);
        const parsed = JSON.parse(answer) as { status?: string; view?: { operation?: { state?: string; history?: { detail?: string }[] } | null; refusal?: string | null } };
        const reason = parsed.view?.operation?.history?.at(-1)?.detail ?? parsed.view?.refusal ?? "";
        return JSON.stringify({ ...parsed, ...(awaitingApproval(reason) ? { status: "awaiting-approval", message: `${reason} ${NOTHING} The node's autonomy is unchanged.` } : {}) });
      } catch (error) { return ownerFailure(error); }
    },
  };
  const status: ToolDefinition = {
    name: "worker_status", operation: null, input: StatusInputSchema,
    description: "Read one recorded implementation handoff through the owning system: queued, running, stopping, waiting, review, merged, failed or cancelled, the worker generation, the node link, the pull request and the last result. merged means the pull request merged; it never means deployed or live. unknown is not an absence and unavailable is not a failure. This reads only and starts nothing.",
    run: async (raw, { session, signal }) => {
      try {
        const input = raw as StatusInput;
        const read = await owner.read(session, input.node);
        signal.throwIfAborted();
        if (read.state === "unauthorized") return JSON.stringify({ status: "unauthorized", message: "This conversation may not read that node." });
        if (read.state === "unavailable") return JSON.stringify({ status: "unavailable", node: input.node, message: UNAVAILABLE });
        if (read.state === "unknown") return JSON.stringify({ status: "unknown", node: input.node, message: "No worker is recorded for this node in this principal's conversations." });
        if (!mayRelease(session, read.handoff.policy)) return JSON.stringify({ status: "unauthorized", node: input.node, message: "This node is outside what this conversation may release." });
        if (!await owner.remember(session, read.handoff, signal)) return JSON.stringify({ status: "unknown", node: input.node, message: "The result changed before release and was withheld. Read it again." });
        const handoff = read.handoff;
        return JSON.stringify({
          status: "ok", node: handoff.node, map: handoff.map, state: handoff.state, active: WORKER_ACTIVE.has(handoff.state),
          generation: handoff.generation, pr: handoff.pr, result: handoff.result === null ? null : redactToolText(handoff.result),
          ...(handoff.url ? { url: handoff.url } : {}), ...(handoff.prUrl ? { prUrl: handoff.prUrl } : {}),
          ...(handoff.reason ? { reason: redactToolText(handoff.reason) } : {}),
          observedAt: new Date(handoff.observedAt).toISOString(), freshness: owner.now() - handoff.observedAt > STALE_AFTER_MS ? "stale" : "fresh",
          merged: handoff.state === "merged", deployed: false,
        });
      } catch (error) { return ownerFailure(error); }
    },
  };
  const cancel: ToolDefinition = {
    name: "worker_cancel", operation: null, input: NodeInputSchema,
    description: "Ask to cancel the exact recorded worker generation of one implementation node through the supported stop verb. Cancellation is its own confirmed request: without a scoped standing permission the principal confirms it. It refuses an unknown node, a generation the owning system no longer records, and a worker that already stopped. The answer says acknowledged when the owner accepted the request and confirmed-stopped only when the owner reports the worker stopped. It never edits a journal, kills a process or undoes edits a worker already accepted.",
    run: async (raw, { session, signal }) => {
      try {
        signal.throwIfAborted();
        const input = raw as NodeInput;
        const checked = await guard(owner, session, input.node, "cancelled", signal);
        if ("refusal" in checked) return JSON.stringify(checked.refusal);
        const { handoff } = checked;
        if (handoff.generation === null) return JSON.stringify({ status: "refused", message: `No worker generation is recorded for this node yet, so there is nothing exact to stop. ${NOTHING_CANCELLED}` });
        if (!WORKER_ACTIVE.has(handoff.state)) return JSON.stringify({ status: "not-active", state: handoff.state, generation: handoff.generation, message: `The recorded worker is no longer active. ${NOTHING_CANCELLED}` });
        return await propose(creation, session, { proposalId: input.proposalId, type: "work-cancel", fields: { node: handoff.node, generation: String(handoff.generation) } }, signal);
      } catch (error) { return ownerFailure(error); }
    },
  };
  return [brief, start, status, cancel];
}
