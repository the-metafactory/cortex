import type { Database } from "bun:sqlite";
import type { CreateRequest, CreateResult, OwnerReadback, OwnerWriter, Policy, Suggestion } from "../../../conversations/types";
import type { DeskOptions } from "./compose";
import { studioRequestId } from "./conversation-ids";
import { readStudioMyDay } from "./studio-my-day";
import { planAct, StudioActSchema, type ActContext, type ActPlan, type ActRefusal, type StudioAct } from "./studio/acts";
import { askFiler, captureId, captureInInbox, captureInThread, captureModel, filerFor, recordCaptureDone, type CaptureModel } from "./studio/capture";
import { CONVERSATION_NOTE_KINDS, planConversationNote, type ConversationNoteKind } from "./studio/conversation-note";
import { REQUEST_TRAILER, spawnGit, type GitRunner } from "./studio/git";
import { oneLine } from "./studio/edit";
import { THREAD_OUTCOMES, type ThreadOutcome } from "./studio/format";
import { readStudioFiles } from "./studio/read";
import { buildStudioView } from "./studio/view";
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
  after?: (desk: DeskOptions, request: CreateRequest, commit: string, message: string) => Promise<void>;
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
    await spec.after?.(desk, request, result.commit, result.message);
    return { state: "created", canonicalId: result.commit };
  };
  return { create, readback: studioReadback(deps) };
}

const refreshMyDay = (deps: StudioWriterDeps) => async (desk: DeskOptions): Promise<void> => {
  await readStudioMyDay(deps.db, desk, (deps.now ?? Date.now)()).catch(() => undefined);
};

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
    after: refreshMyDay(deps),
  });
}

const THREAD_LABELS = { question: "The question", area: "The area", park: "The thread to park", link: "The conversation link" };

export function studioThreadWriter(deps: StudioWriterDeps): OwnerWriter {
  return studioConversationWriter(deps, {
    prepare: request => {
      const { question = "", area = "", park } = request.fields;
      const act = studioAct({ act: "open", from: "conversation", question, area, ...(park ? { park } : {}), link: request.provenance.link }, THREAD_LABELS);
      if (typeof act === "string") return act;
      return ctx => planAct(ctx, act);
    },
    after: refreshMyDay(deps),
  });
}

const isNoteKind = (kind: string): kind is ConversationNoteKind => (CONVERSATION_NOTE_KINDS as readonly string[]).includes(kind);

export function studioNoteWriter(deps: StudioWriterDeps): OwnerWriter {
  return studioConversationWriter(deps, {
    prepare: request => {
      const { thread = "", kind = "", text = "" } = request.fields;
      const chosen = kind.trim() || "note";
      if (!isNoteKind(chosen)) return `${chosen} is not a note kind; use note, idea or stand.`;
      if (!text.trim()) return "The text is empty.";
      return ctx => planConversationNote(ctx, { thread, kind: chosen, text, via: conversationVia(request) });
    },
    after: refreshMyDay(deps),
  });
}

const CLOSE_LABELS = { thread: "The thread", outcome: "The outcome", text: "The outcome text", expect: "What you expect to happen", reviewOn: "The review date" };
const isOutcome = (outcome: string): outcome is ThreadOutcome => (THREAD_OUTCOMES as readonly string[]).includes(outcome);

export function studioCloseWriter(deps: StudioWriterDeps): OwnerWriter {
  return studioConversationWriter(deps, {
    prepare: request => {
      const { thread = "", outcome = "", text = "", expect = "", reviewOn = "" } = request.fields;
      const chosen = outcome.trim();
      if (!isOutcome(chosen)) return `${chosen ? `${chosen} is not an outcome` : "The outcome is missing"}; use decided, shipped or dropped.`;
      const act = studioAct({ act: "close", thread, outcome: chosen, text, ...(expect.trim() ? { expect } : {}), ...(reviewOn.trim() ? { reviewOn: reviewOn.trim() } : {}) }, CLOSE_LABELS);
      if (typeof act === "string") return act;
      return ctx => planAct(ctx, act, conversationVia(request));
    },
    after: refreshMyDay(deps),
  });
}

const INBOX = "it goes to the Studio inbox.";
const toInbox = (reason: string): string => `${oneLine(reason).replace(/;? ?saved in the Studio inbox\.$/i, "").replace(/[.;\s]+$/, "")}; ${INBOX}`;

export interface CaptureWriterDeps extends StudioWriterDeps { model?: CaptureModel }

export function studioCaptureWriter(deps: CaptureWriterDeps): OwnerWriter {
  const clock = deps.now ?? Date.now;
  const writer = studioConversationWriter(deps, {
    prepare: request => {
      const text = (request.fields.text ?? "").trim();
      if (!text) return "The capture is empty.";
      const slug = (request.fields.thread ?? "").trim();
      const id = captureId(studioRequestId(request.operationId));
      return ctx => {
        if (!slug) return captureInInbox(ctx, id, text, { via: "conversation" }, "Saved in the Studio inbox.");
        const thread = ctx.view.active.find(t => t.slug === slug);
        if (!thread) return { status: 409, error: "That thread is no longer active. Nothing was created." };
        return captureInThread(ctx, thread, id, [oneLine(text)], `Filed capture ${id} ${conversationVia(request)}`, `Filed in “${oneLine(thread.question)}”.`);
      };
    },
    after: async (desk, request, _commit, message) => {
      recordCaptureDone(deps.db, captureId(studioRequestId(request.operationId)), (request.fields.text ?? "").trim(), message, clock());
      await refreshMyDay(deps)(desk);
    },
  });
  const suggest = async (fields: Record<string, string>, context: { policy: Policy }): Promise<Suggestion | null> => {
    const desk = deps.desk();
    const studio = desk?.enabled ? desk.studio : undefined;
    const text = fields.text?.trim();
    if (!desk || !studio || !text) return null;
    const { files, problems } = await readStudioFiles(studio.dir);
    const active = buildStudioView(files, studio, desk.areas, problems).active;
    const config = context.policy === "local" ? studio.filer?.local : filerFor(studio, active);
    if (!config) return null;
    if (active.length === 0) return { fields: {}, reason: `No thread is active; ${INBOX}` };
    const { answer, reason } = await askFiler(config, active, text, deps.model ?? captureModel);
    const match = answer?.match && answer.thread ? active.find(t => t.slug === answer.thread) : undefined;
    return match ? { fields: { thread: match.slug }, reason: oneLine(reason) } : { fields: {}, reason: toInbox(reason) };
  };
  return { ...writer, suggest };
}
