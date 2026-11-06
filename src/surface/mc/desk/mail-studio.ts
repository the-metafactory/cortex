import type { Database } from "bun:sqlite";
import { stringify } from "yaml";
import { readClassifications } from "./classify";
import type { ListedMail } from "./mail-actions";
import { logMailDecision, mailFeatures } from "./mail-log";
import type { SourceReading } from "./sources/command";
import { askFiler, captureId, captureInThread, captureModel, filerFor, type CaptureModel } from "./studio/capture";
import { localTime, oneLine, safeBody } from "./studio/edit";
import { readStudioFiles } from "./studio/read";
import { buildStudioView, effectivePolicy, type StudioArea } from "./studio/view";
import { runStudioTransaction, type ActResult } from "./studio/writer";
import type { ActContext, ActPlan, ActRefusal } from "./studio/acts";
import type { StudioOptions } from "./types";

export const MAX_MAIL_REASON = 200;

export interface MailStudioThread {
  slug: string;
  question: string;
}

export interface MailStudioProposal {
  thread: string | null;
  reason: string;
  threads: MailStudioThread[];
  canIncludeText: boolean;
}

export interface MailForStudio {
  mail: ListedMail;
  area: string | null;
  summary: string | null;
}

export interface MailStudioDeps {
  options: StudioOptions;
  areas: readonly StudioArea[];
  db: Database;
  now?: Date;
  model?: CaptureModel;
}

export interface AddMailInput {
  requestId: string;
  thread: string | null;
  reason?: string;
  includeText: boolean;
}

export function mailForStudio(db: Database, readings: readonly SourceReading[], mail: ListedMail): MailForStudio {
  const area = readings.find((r) => r.id === mail.sourceId)?.area ?? null;
  const summary = readClassifications(db, [mail.id]).get(mail.id)?.summary?.trim() ?? null;
  return { mail, area, summary: summary === "" ? null : summary };
}

const sender = (item: MailForStudio): string => {
  const { name, address } = item.mail.from;
  return name ? `${oneLine(name)} <${oneLine(address)}>` : oneLine(address);
};

const day = (iso: string): string => {
  const at = new Date(iso);
  return Number.isFinite(at.getTime()) ? localTime(at).slice(0, 16).replace("T", " ") : oneLine(iso);
};

const linkTarget = (url: string): string => url.replace(/[\s<>]/g, (c) => encodeURIComponent(c));

const gist = (item: MailForStudio): string => oneLine(item.summary ?? item.mail.firstParagraph ?? "");

export function mailLine(item: MailForStudio): string {
  const summary = gist(item);
  const link = item.mail.url ? ` Open in Mail: <${linkTarget(item.mail.url)}>` : "";
  return `Mail from ${sender(item)}, received ${day(item.mail.receivedAt)}: “${oneLine(item.mail.subject)}”.${summary ? ` ${summary}` : ""}${link}`;
}

const quoted = (text: string): string[] => safeBody(text).map((l) => (l.trim() ? `  > ${l}` : "  >"));

const bodyText = (item: MailForStudio, includeText: boolean): string | null => {
  const text = item.mail.firstParagraph?.trim();
  return includeText && text ? text : null;
};

export async function proposeMailThread(item: MailForStudio, deps: MailStudioDeps): Promise<MailStudioProposal> {
  const { files, problems } = await readStudioFiles(deps.options.dir);
  const view = buildStudioView(files, deps.options, deps.areas, problems);
  const threads = view.active;
  const listed = threads.map((t) => ({ slug: t.slug, question: oneLine(t.question) }));
  const canIncludeText = Boolean(item.mail.firstParagraph?.trim());
  if (threads.length === 0) return { thread: null, reason: "No thread is active; it goes to the Studio inbox.", threads: listed, canIncludeText };
  const localMail = item.area === null || effectivePolicy([item.area], deps.areas).policy === "local";
  const access = localMail ? deps.options.filer?.local : filerFor(deps.options, threads);
  const { answer, reason } = await askFiler(access, threads, mailLine(item), deps.model ?? captureModel);
  const match = answer?.match && answer.thread ? threads.find((t) => t.slug === answer.thread) : undefined;
  const why = oneLine(reason).replace(/;? ?saved in the Studio inbox\.$/, ".");
  return { thread: match?.slug ?? null, reason: why.slice(0, MAX_MAIL_REASON), threads: listed, canIncludeText };
}

function planMail(ctx: ActContext, item: MailForStudio, input: AddMailInput, id: string): ActPlan | ActRefusal {
  const text = bodyText(item, input.includeText);
  const subject = oneLine(item.mail.subject);
  if (input.thread === null) {
    const front = stringify({ at: localTime(ctx.now), via: "mail" });
    const body = [mailLine(item), ...(text ? ["", ...safeBody(text).map((l) => `> ${l}`)] : [])].join("\n");
    return { writes: [{ path: `inbox/${id}.md`, text: `---\n${front}---\n\n${body}\n` }], removes: [], subject: `File capture ${id} in inbox`, message: `Added “${subject}” to the Studio inbox.` };
  }
  const thread = ctx.view.active.find((t) => t.slug === input.thread);
  if (!thread) return { status: 409, error: "That thread is no longer active; nothing was written." };
  const why = input.reason ? `the filer said: ${oneLine(input.reason).slice(0, MAX_MAIL_REASON)}` : "you chose this thread";
  return captureInThread(ctx, thread, id, [mailLine(item), ...(text ? quoted(text) : [])], `Filed capture ${id} from mail; ${why}`, `Added “${subject}” to “${oneLine(thread.question)}”.`);
}

export async function addMailToStudio(item: MailForStudio, input: AddMailInput, deps: MailStudioDeps): Promise<ActResult> {
  const id = captureId(input.requestId);
  const now = deps.now ?? new Date();
  const features = mailFeatures(deps.db, item.mail);
  const result = await runStudioTransaction({ options: deps.options, areas: deps.areas, requestId: input.requestId, now }, (ctx) => planMail(ctx, item, input, id));
  if (!result.ok || result.replayed) return result;
  const at = now.getTime();
  deps.db.query("INSERT INTO desk_done (attempt_key, action, item_key, title, status, message, created_at, updated_at) VALUES (?, 'studio.capture', ?, ?, 'done', ?, ?, ?) ON CONFLICT(attempt_key) DO NOTHING")
    .run(`studio-capture:${id}`, id, result.message, result.message, at, at);
  logMailDecision(deps.db, features, "studio", "desk", at);
  return result;
}
