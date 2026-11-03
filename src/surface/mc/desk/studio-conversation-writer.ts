import type { Database } from "bun:sqlite";
import type { CreateRequest, CreateResult, OwnerReadback, OwnerWriter } from "../../../conversations/types";
import type { DeskOptions } from "./compose";
import { studioRequestId } from "./conversation-ids";
import { readStudioMyDay } from "./studio-my-day";
import { planAct, StudioActSchema, type ActContext, type ActPlan, type ActRefusal, type StudioAct } from "./studio/acts";
import { REQUEST_TRAILER, spawnGit, type GitRunner } from "./studio/git";
import { runStudioTransaction } from "./studio/writer";

export interface StudioWriterDeps {
  db: Database;
  desk: () => DeskOptions | undefined;
  git?: GitRunner;
  now?: () => number;
}

export type StudioPlanner = (ctx: ActContext) => ActPlan | ActRefusal | Promise<ActPlan | ActRefusal>;

export interface StudioWriterSpec {
  prepare: (request: CreateRequest, desk: DeskOptions) => StudioPlanner | string | Promise<StudioPlanner | string>;
  after?: (desk: DeskOptions, request: CreateRequest, commit: string) => Promise<void>;
}

const NOTHING = "Nothing was created.";
const SAYS_NOTHING = /nothing was (?:written|created|committed)/i;

export function studioFailed(sentence: string): CreateResult {
  const text = sentence.trim();
  return { state: "failed", error: SAYS_NOTHING.test(text) ? text : `${text.replace(/[.\s]+$/, "")}. ${NOTHING}` };
}

export const conversationVia = (request: CreateRequest): string => `from Ivy conversation ${request.provenance.link}`;

export function studioAct(input: Record<string, unknown>, labels: Record<string, string>): StudioAct | string {
  const parsed = StudioActSchema.safeParse(input);
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  const field = String(issue?.path[0] ?? "");
  return `${labels[field] ?? "The request"} ${issue?.message ?? "is not a Studio change"}`;
}

export function studioReadback(deps: Pick<StudioWriterDeps, "desk" | "git">): OwnerReadback {
  return async operation => {
    const dir = deps.desk()?.studio?.dir;
    if (!dir) return null;
    const r = await (deps.git ?? spawnGit)(["log", "-n", "1", `--grep=^${REQUEST_TRAILER}: ${studioRequestId(operation.operationId)}$`, "--format=%H"], dir);
    if (r.code !== 0) return null;
    const sha = r.stdout.trim();
    return sha ? { found: true, canonicalId: sha } : { found: false };
  };
}

export function studioConversationWriter(deps: StudioWriterDeps, spec: StudioWriterSpec): OwnerWriter {
  const clock = deps.now ?? Date.now;
  const create = async (request: CreateRequest): Promise<CreateResult> => {
    const desk = deps.desk();
    const studio = desk?.enabled ? desk.studio : undefined;
    if (!desk || !studio) return studioFailed("The Studio is not set up on this stack.");
    const planner = await spec.prepare(request, desk);
    if (typeof planner === "string") return studioFailed(planner);
    if (request.signal.aborted) throw new Error("The conversation stopped waiting before the Studio was called.");
    const result = await runStudioTransaction({ options: studio, areas: desk.areas, requestId: studioRequestId(request.operationId), now: new Date(clock()), ...(deps.git ? { git: deps.git } : {}) }, planner);
    if (!result.ok) {
      if (result.status >= 500) throw new Error(result.error);
      return studioFailed(result.error);
    }
    await spec.after?.(desk, request, result.commit);
    return { state: "created", canonicalId: result.commit };
  };
  return { create, readback: studioReadback(deps) };
}

const RESPONSE_LABELS = { thread: "The thread", text: "The response" };
const STUDIO_BUSY = "Studio is busy or unreadable. Nothing was written; retry when its files are ready.";

export function studioResponseWriter(deps: StudioWriterDeps): OwnerWriter {
  const clock = deps.now ?? Date.now;
  return studioConversationWriter(deps, {
    prepare: async (request, desk) => {
      const act = studioAct({ act: "respond", thread: request.fields.thread ?? "", text: request.fields.text ?? "" }, RESPONSE_LABELS);
      if (typeof act === "string") return act;
      try { await readStudioMyDay(deps.db, desk, clock(), true); }
      catch { return STUDIO_BUSY; }
      return ctx => planAct(ctx, act, conversationVia(request));
    },
    after: async desk => { await readStudioMyDay(deps.db, desk, clock()).catch(() => undefined); },
  });
}

const THREAD_LABELS = { question: "The question", area: "The area", park: "The thread to park", link: "The conversation link" };

export function studioThreadWriter(deps: StudioWriterDeps): OwnerWriter {
  const clock = deps.now ?? Date.now;
  return studioConversationWriter(deps, {
    prepare: request => {
      const { question = "", area = "", park } = request.fields;
      const act = studioAct({ act: "open", from: "conversation", question, area, ...(park ? { park } : {}), link: request.provenance.link }, THREAD_LABELS);
      if (typeof act === "string") return act;
      return ctx => planAct(ctx, act);
    },
    after: async desk => { await readStudioMyDay(deps.db, desk, clock()).catch(() => undefined); },
  });
}
