import { stringify } from "yaml";
import { z } from "zod";
import { clip, plainQuestion } from "./board";
import { appendEntry, appendLog, localTime, oneLine, safeBody, setFront, setNoteStatus, setSection } from "./edit";
import { localDate, YES_ANSWERS } from "./labels";
import { AREA_ID, ISO_DATE, STUDIO_SLUG, THREAD_OUTCOMES, validDate, type IvyNote, type StudioCapture, type ThreadType } from "./format";
import type { StudioFile, StudioFiles, StudioProposalView, StudioThreadView, StudioView } from "./view";

export const MAX_RESPONSE = 4000;
export const MAX_OUTCOME = 2000;

const slug = z.string().regex(STUDIO_SLUG, "is not a thread slug");
const words = (max: number) => z.string().trim().min(1, "is empty").max(max, `is longer than ${max} characters`);

export const StudioActSchema = z.discriminatedUnion("act", [
  z.object({ act: z.literal("respond"), thread: slug, text: words(MAX_RESPONSE) }),
  z.object({ act: z.literal("keep"), thread: slug, note: z.string().min(1).max(64) }),
  z.object({ act: z.literal("dismiss"), thread: slug, note: z.string().min(1).max(64) }),
  z.object({ act: z.literal("park"), thread: slug }),
  z.object({ act: z.literal("unpark"), thread: slug, park: slug.optional() }),
  z.object({ act: z.literal("think"), thread: slug, on: z.boolean() }),
  z.object({
    act: z.literal("close"),
    thread: slug,
    outcome: z.enum(THREAD_OUTCOMES),
    text: words(MAX_OUTCOME),
    expect: z.string().trim().max(500).optional(),
    reviewOn: z.string().regex(ISO_DATE, "must be a date like 2026-12-15").refine(validDate, "is not a real date").optional(),
  }),
  z.object({
    act: z.literal("open"),
    from: z.enum(["proposal", "capture"]),
    id: slug,
    area: z.string().regex(AREA_ID, "is not an area id"),
    park: slug.optional(),
    answers: z.record(z.string().max(200), z.string().trim().min(1).max(300)).optional(),
  }),
]);

export type StudioAct = z.infer<typeof StudioActSchema>;

export interface ActPlan {
  writes: StudioFile[];
  removes: string[];
  subject: string;
  message: string;
}

export interface ActRefusal {
  status: number;
  error: string;
  needsPark?: boolean;
}

export interface ActContext {
  files: StudioFiles;
  view: StudioView;
  now: Date;
}

const refuse = (status: number, error: string, extra: Partial<ActRefusal> = {}): ActRefusal => ({ status, error, ...extra });
const quoted = (q: string): string => `“${clip(plainQuestion(q), 50)}”`;

const allThreads = (view: StudioView): StudioThreadView[] => [...view.active, ...view.parked, ...view.closed];

function chain(text: string | null, ...steps: ((t: string) => string | null)[]): string | null {
  let out = text;
  for (const step of steps) {
    if (out === null) return null;
    out = step(out);
  }
  return out;
}

const NOT_EDITABLE = "has a layout the Studio cannot edit: its front matter must start and end with a --- line";

interface Ctx extends ActContext {
  today: string;
}

function source(ctx: Ctx, path: string): string | undefined {
  return [...ctx.files.threads, ...ctx.files.inbox, ...ctx.files.proposals].find((f) => f.path === path)?.text;
}

interface Found {
  thread: StudioThreadView;
  text: string;
}

function threadOf(ctx: Ctx, name: string): Found | ActRefusal {
  const thread = allThreads(ctx.view).find((t) => t.slug === name);
  const text = thread ? source(ctx, thread.path) : undefined;
  if (!thread || text === undefined) return refuse(404, `No readable thread is called ${name}.`);
  return { thread, text };
}

const isRefusal = (x: object): x is ActRefusal => "error" in x;

function edited(path: string, text: string | null): StudioFile | ActRefusal {
  return text === null ? refuse(409, `${path} ${NOT_EDITABLE}.`) : { path, text };
}

function plan(writes: (StudioFile | ActRefusal)[], subject: string, message: string, removes: string[] = []): ActPlan | ActRefusal {
  const bad = writes.find(isRefusal);
  if (bad) return bad;
  return { writes: writes.filter((w): w is StudioFile => !isRefusal(w)), removes, subject, message };
}

function respond(ctx: Ctx, act: Extract<StudioAct, { act: "respond" }>, { thread, text }: Found): ActPlan | ActRefusal {
  const latest = [...thread.notes].sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0];
  const entry = [`### ${localTime(ctx.now)}`, ...(latest ? [`re: ${latest.at}`] : []), "", ...safeBody(act.text)];
  const out = chain(text, (t) => appendEntry(t, "responses", "Responses", entry), (t) => appendLog(t, ctx.today, "Answered Ivy"));
  return plan([edited(thread.path, out)], `Answer Ivy on ${thread.slug}`, `Your answer is in ${quoted(thread.question)}.`);
}

const GHOST_NAME: Record<IvyNote["kind"], string> = { stand: "stand", idea: "idea", relation: "relation", note: "note" };

function relationName(note: IvyNote): string {
  const r = note.relates;
  return r ? ` to ${r.kind}: ${r.label}` : "";
}

function keepOrDismiss(ctx: Ctx, act: Extract<StudioAct, { act: "keep" | "dismiss" }>, { thread, text }: Found): ActPlan | ActRefusal {
  const note = thread.notes.find((n) => n.at === act.note);
  if (!note) return refuse(404, `${quoted(thread.question)} has no note from ${act.note}.`);
  if (note.kind === "note") return refuse(409, "Only Ivy's proposed stands, ideas and relations can be kept or dismissed.");
  if (note.status !== "open") return refuse(409, `This ${GHOST_NAME[note.kind]} is already ${note.status}.`);
  const keep = act.act === "keep";
  const verb = keep ? "Kept" : "Dismissed";
  const what = `Ivy's ${GHOST_NAME[note.kind]}${note.kind === "relation" ? relationName(note) : ""}`;
  const steps: ((t: string) => string | null)[] = [(t) => setNoteStatus(t, note.at, keep ? "kept" : "dismissed")];
  if (keep && note.kind === "stand") steps.push((t) => setSection(t, "stand", "Where I stand", note.text));
  steps.push((t) => appendLog(t, ctx.today, `${verb} ${what}`));
  const message = keep && note.kind === "stand" ? "Ivy's stand is now yours." : `${verb} ${what}.`;
  return plan([edited(thread.path, chain(text, ...steps))], `${keep ? "Keep" : "Dismiss"} ${what} on ${thread.slug}`, message);
}

function parkStep(ctx: Ctx, park: string | undefined, forWhat: string): { write: StudioFile | ActRefusal; question: string } | ActRefusal | null {
  if (ctx.view.active.length < ctx.view.maxActive) return null;
  if (!park) return refuse(409, `All ${ctx.view.maxActive} places are in use. Choose a thread to park first.`, { needsPark: true });
  const target = ctx.view.active.find((t) => t.slug === park);
  const text = target ? source(ctx, target.path) : undefined;
  if (!target || text === undefined) return refuse(409, `${park} is not an active thread, so it cannot be parked.`, { needsPark: true });
  const out = chain(text, (t) => setFront(t, "state", "parked"), (t) => appendLog(t, ctx.today, `Parked to make room for ${forWhat}`));
  return { write: edited(target.path, out), question: target.question };
}

function park(ctx: Ctx, act: Extract<StudioAct, { act: "park" }>, { thread, text }: Found): ActPlan | ActRefusal {
  if (thread.state !== "active") return refuse(409, `${quoted(thread.question)} is not active.`);
  const out = chain(text, (t) => setFront(t, "state", "parked"), (t) => appendLog(t, ctx.today, "Parked"));
  return plan([edited(thread.path, out)], `Park ${thread.slug}`, `Parked ${quoted(thread.question)}. Its notes stay with it.`);
}

function unpark(ctx: Ctx, act: Extract<StudioAct, { act: "unpark" }>, { thread, text }: Found): ActPlan | ActRefusal {
  if (thread.state !== "parked") return refuse(409, `${quoted(thread.question)} is not parked.`);
  const parked = parkStep(ctx, act.park, quoted(thread.question));
  if (parked && isRefusal(parked)) return parked;
  const out = chain(text, (t) => setFront(t, "state", "active"), (t) => appendLog(t, ctx.today, "Brought back"));
  const message = parked ? `Brought back ${quoted(thread.question)} and parked ${quoted(parked.question)}.` : `Brought back ${quoted(thread.question)}.`;
  return plan([edited(thread.path, out), ...(parked ? [parked.write] : [])], `Bring back ${thread.slug}${parked ? `, park ${act.park ?? ""}` : ""}`, message);
}

function think(ctx: Ctx, act: Extract<StudioAct, { act: "think" }>, { thread, text }: Found): ActPlan | ActRefusal {
  if (thread.thinkTonight === act.on) return refuse(409, act.on ? "This thread is already on Ivy's list for tonight." : "This thread is not on Ivy's list for tonight.");
  const out = chain(text, (t) => setFront(t, "thinkTonight", act.on), (t) => appendLog(t, ctx.today, act.on ? "Asked Ivy to think tonight" : "Took it off Ivy's list for tonight"));
  return plan([edited(thread.path, out)], `Think tonight ${act.on ? "on" : "off"} for ${thread.slug}`, act.on ? "Ivy thinks about it tonight." : "Ivy leaves it alone tonight.");
}

function close(ctx: Ctx, act: Extract<StudioAct, { act: "close" }>, { thread, text }: Found): ActPlan | ActRefusal {
  const decided = act.outcome === "decided";
  if (decided && !act.expect) return refuse(400, "A decision needs what you expect to happen, so the review has something to check.");
  if (decided && !act.reviewOn) return refuse(400, "A decision needs a review date.");
  if (decided && act.reviewOn && act.reviewOn < ctx.today) return refuse(400, "The review date is in the past.");
  const out = chain(
    text,
    (t) => setFront(t, "state", "closed"),
    (t) => setFront(t, "closed", ctx.today),
    (t) => setFront(t, "outcome", act.outcome),
    (t) => setFront(t, "expect", decided ? act.expect : undefined),
    (t) => setFront(t, "reviewOn", decided ? act.reviewOn : undefined),
    (t) => setFront(t, "thinkTonight", thread.thinkTonight ? false : undefined),
    (t) => setSection(t, "outcome", "Outcome", act.text),
    (t) => appendLog(t, ctx.today, `Closed as ${act.outcome}`),
  );
  const message = decided ? `Closed as decided. It is in the decision journal, with a review on ${act.reviewOn ?? ""}.` : `Closed as ${act.outcome}.`;
  return plan([edited(thread.path, out)], `Close ${thread.slug} as ${act.outcome}`, message);
}

export function slugFor(question: string, taken: ReadonlySet<string>): string {
  const base =
    plainQuestion(question)
      .normalize("NFKD")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60)
      .replace(/-+$/, "") || "thread";
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
}

interface OpenSource {
  path: string;
  type: ThreadType;
  areas: string[];
  question: string;
  material: string[];
  log: string;
}

function fromProposal(p: StudioProposalView, area: string): OpenSource {
  const areas = p.areas.includes(area) ? [area, ...p.areas.filter((a) => a !== area)] : [area];
  return { path: p.path, type: p.type, areas, question: p.question, material: [], log: "Opened from Ivy's proposal" };
}

function fromCapture(c: StudioCapture, today: string): OpenSource {
  const question = clip(oneLine(c.text), 200);
  return { path: c.path, type: "question", areas: [], question, material: [`${c.via}: Capture, ${today}: “${clip(oneLine(c.text), 80)}”`], log: `Opened from a capture (${c.via})` };
}

function yesSection(ctx: Ctx, answers: Record<string, string> | undefined): { lines: string[]; summary: string } {
  const asked = ctx.view.yesFilter.questions.filter((q) => answers?.[q] !== undefined);
  if (!answers || asked.length === 0) return { lines: [], summary: "" };
  const counts = YES_ANSWERS.map((a) => [a, asked.filter((q) => answers[q] === a).length] as const).filter(([, n]) => n > 0);
  return {
    lines: ["## Yes-filter", "", ...asked.map((q) => `- ${oneLine(q)} ${oneLine(answers[q] ?? "")}`), ""],
    summary: counts.length ? `. Yes-filter: ${counts.map(([a, n]) => `${n} ${a}`).join(", ")}` : ". Yes-filter answered",
  };
}

function open(ctx: Ctx, act: Extract<StudioAct, { act: "open" }>): ActPlan | ActRefusal {
  if (!ctx.view.areas.some((a) => a.id === act.area)) return refuse(400, `The Desk config lists no area ${act.area}.`);
  const proposal = act.from === "proposal" ? ctx.view.proposals.find((p) => p.id === act.id) : undefined;
  const capture = act.from === "capture" ? ctx.view.inbox.find((c) => c.id === act.id) : undefined;
  const src = proposal ? fromProposal(proposal, act.area) : capture ? fromCapture(capture, ctx.today) : null;
  if (!src) return refuse(404, `No readable ${act.from} is called ${act.id}.`);
  const areas = src.areas.length ? src.areas : [act.area];
  const name = slugFor(src.question, new Set([...allThreads(ctx.view).map((t) => t.slug), ...ctx.files.threads.map((f) => (f.path.split("/").pop() ?? "").replace(/\.md$/, ""))]));
  const parked = parkStep(ctx, act.park, quoted(src.question));
  if (parked && isRefusal(parked)) return parked;
  const yes = yesSection(ctx, act.answers);
  const front = stringify({ type: src.type, areas, state: "active", opened: ctx.today }, { flowCollectionPadding: false }).trimEnd();
  const body = [
    "---",
    front,
    "---",
    "",
    "## Question",
    "",
    ...safeBody(src.question),
    "",
    "## Where I stand",
    "",
    ...(src.material.length ? ["## Material", "", ...src.material.map((m) => `- ${m}`), ""] : []),
    ...yes.lines,
    "## Log",
    "",
    `- ${ctx.today}: ${src.log}${yes.summary}`,
    "",
  ].join("\n");
  const path = `threads/${name}.md`;
  const message = parked ? `Opened ${quoted(src.question)} and parked ${quoted(parked.question)}.` : `Opened ${quoted(src.question)}.`;
  return plan([{ path, text: body }, ...(parked ? [parked.write] : [])], `Open ${name} from ${act.from} ${act.id}${parked ? `, park ${act.park ?? ""}` : ""}`, message, [src.path]);
}

const NEEDS_OPEN_THREAD = new Set<StudioAct["act"]>(["respond", "think", "close"]);

function threadAct(ctx: Ctx, act: Exclude<StudioAct, { act: "open" }>, found: Found): ActPlan | ActRefusal {
  switch (act.act) {
    case "respond":
      return respond(ctx, act, found);
    case "keep":
    case "dismiss":
      return keepOrDismiss(ctx, act, found);
    case "park":
      return park(ctx, act, found);
    case "unpark":
      return unpark(ctx, act, found);
    case "think":
      return think(ctx, act, found);
    case "close":
      return close(ctx, act, found);
  }
}

export function planAct(context: ActContext, act: StudioAct): ActPlan | ActRefusal {
  const ctx: Ctx = { ...context, today: localDate(context.now) };
  if (act.act === "open") return open(ctx, act);
  const found = threadOf(ctx, act.thread);
  if (isRefusal(found)) return found;
  if (NEEDS_OPEN_THREAD.has(act.act) && found.thread.state === "closed") return refuse(409, `${quoted(found.thread.question)} is closed.`);
  return threadAct(ctx, act, found);
}

export { isRefusal };
