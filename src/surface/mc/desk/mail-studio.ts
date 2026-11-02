import type { Database } from "bun:sqlite";
import { stringify } from "yaml";
import { readClassifications } from "./classify";
import type { ListedMail } from "./mail-actions";
import { logMailDecision, mailFeatures } from "./mail-log";
import type { SourceReading } from "./sources/command";
import { askFiler, captureId, captureMarker, captureModel, filerFor, type CaptureModel } from "./studio/capture";
import { appendEntry, appendLog, localTime, oneLine, safeBody } from "./studio/edit";
import { readStudioFiles } from "./studio/read";
import { buildStudioView, effectivePolicy, type StudioArea, type StudioThreadView } from "./studio/view";
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

export const isLocalMail = (item: MailForStudio, areas: readonly StudioArea[]): boolean =>
  item.area !== null && effectivePolicy([item.area], areas).policy === "local";

export const eligibleThreads = (active: readonly StudioThreadView[], local: boolean): StudioThreadView[] =>
  active.filter((t) => !local || t.policy === "local");

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
  const local = isLocalMail(item, deps.areas);
  const threads = eligibleThreads(view.active, local);
  const listed = threads.map((t) => ({ slug: t.slug, question: oneLine(t.question) }));
  const canIncludeText = Boolean(item.mail.firstParagraph?.trim());
  if (threads.length === 0) return { thread: null, reason: local ? "No local thread is active, and this mail's area keeps it local; it goes to the Studio inbox." : "No thread is active; it goes to the Studio inbox.", threads: listed, canIncludeText };
  const config = filerFor(deps.options, threads, local);
  if (!config && local) return { thread: null, reason: "This mail's area keeps it on a local model, and no local filer is set; choose a thread or the Studio inbox.", threads: listed, canIncludeText };
  const { answer, reason } = await askFiler(config, threads, mailLine(item), deps.model ?? captureModel);
  const match = answer?.match && answer.thread ? threads.find((t) => t.slug === answer.thread) : undefined;
  const why = oneLine(reason).replace(/;? ?saved in the Studio inbox\.$/, ".");
  return { thread: match?.slug ?? null, reason: why.slice(0, MAX_MAIL_REASON), threads: listed, canIncludeText };
}

function planMail(ctx: ActContext, item: MailForStudio, input: AddMailInput, id: string, local: boolean): ActPlan | ActRefusal {
  const text = bodyText(item, input.includeText);
  const subject = oneLine(item.mail.subject);
  if (input.thread === null) {
    const front = stringify({ at: localTime(ctx.now), via: "mail" });
    const body = [mailLine(item), ...(text ? ["", ...safeBody(text).map((l) => `> ${l}`)] : [])].join("\n");
    return { writes: [{ path: `inbox/${id}.md`, text: `---\n${front}---\n\n${body}\n` }], removes: [], subject: `File capture ${id} in inbox`, message: `Added “${subject}” to the Studio inbox.` };
  }
  const thread = ctx.view.active.find((t) => t.slug === input.thread);
  if (!thread) return { status: 409, error: "That thread is no longer active; nothing was written." };
  if (local && thread.policy !== "local") return { status: 409, error: "This mail's area keeps it local, and that thread may use a cloud model; nothing was written." };
  const file = ctx.files.threads.find((f) => f.path === thread.path);
  const entry = [`${captureMarker(id)}${mailLine(item)}`, ...(text ? quoted(text) : [])];
  const material = file ? appendEntry(file.text, "material", "Material", entry) : null;
  const why = input.reason ? `the filer said: ${oneLine(input.reason).slice(0, MAX_MAIL_REASON)}` : "you chose this thread";
  const edited = material ? appendLog(material, localTime(ctx.now), `Filed capture ${id} from mail; ${why}`) : null;
  if (!edited) return { status: 409, error: "That thread cannot be edited; nothing was written." };
  return { writes: [{ path: thread.path, text: edited }], removes: [], subject: `File capture ${id} in ${thread.slug}`, message: `Added “${subject}” to “${oneLine(thread.question)}”.` };
}

export async function addMailToStudio(item: MailForStudio, input: AddMailInput, deps: MailStudioDeps): Promise<ActResult> {
  const id = captureId(input.requestId);
  const local = isLocalMail(item, deps.areas);
  const now = deps.now ?? new Date();
  const features = mailFeatures(deps.db, item.mail);
  const result = await runStudioTransaction({ options: deps.options, areas: deps.areas, requestId: input.requestId, now }, (ctx) => planMail(ctx, item, input, id, local));
  if (!result.ok || result.replayed) return result;
  const at = now.getTime();
  deps.db.query("INSERT INTO desk_done (attempt_key, action, item_key, title, status, message, created_at, updated_at) VALUES (?, 'studio.capture', ?, ?, 'done', ?, ?, ?) ON CONFLICT(attempt_key) DO NOTHING")
    .run(`studio-capture:${id}`, id, result.message, result.message, at, at);
  logMailDecision(deps.db, features, "studio", "desk", at);
  return result;
}
