import { parse as parseYaml } from "yaml";
import { z } from "zod";

export const THREAD_TYPES = ["question", "topic", "making"] as const;
export const THREAD_STATES = ["active", "parked", "closed"] as const;
export const THREAD_OUTCOMES = ["decided", "shipped", "dropped"] as const;
export const NOTE_KINDS = ["note", "stand", "idea", "relation"] as const;
export const NOTE_STATUSES = ["open", "kept", "dismissed"] as const;

export type ThreadType = (typeof THREAD_TYPES)[number];
export type ThreadState = (typeof THREAD_STATES)[number];
export type ThreadOutcome = (typeof THREAD_OUTCOMES)[number];
export type NoteKind = (typeof NOTE_KINDS)[number];
export type NoteStatus = (typeof NOTE_STATUSES)[number];

export const STUDIO_SLUG = /^[a-z0-9][a-z0-9-]{0,79}$/;
export const AREA_ID = /^[\w.-]{1,64}$/;
export const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
export const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/;

export const validDate = (s: string): boolean => !Number.isNaN(Date.parse(s));
const isoDate = z.string().regex(ISO_DATE, "must be a date like 2026-10-31").refine(validDate, "is not a real date");
const isoTime = z.string().regex(ISO_TIME, "must be an ISO time with a zone, like 2026-10-31T03:12:00+01:00").refine(validDate, "is not a real time");
const areaList = z.array(z.string().regex(AREA_ID, "is not an area id")).min(1, "needs at least one area");

const TargetSchema = z
  .object({
    thread: z.string().regex(STUDIO_SLUG, "is not a thread slug").optional(),
    place: z.literal("new").optional(),
    area: z.string().regex(AREA_ID, "is not an area id").optional(),
    reason: z.string().trim().min(1, "needs a reason"),
  })
  .refine((t) => (t.thread === undefined) !== (t.place === undefined), "names either a thread or place: new");

export type StudioTarget = z.infer<typeof TargetSchema>;

const ThreadFrontSchema = z
  .object({
    type: z.enum(THREAD_TYPES),
    areas: areaList,
    state: z.enum(THREAD_STATES),
    opened: isoDate,
    closed: isoDate.optional(),
    thinkTonight: z.boolean().default(false),
    outcome: z.enum(THREAD_OUTCOMES).optional(),
    expect: z.string().optional(),
    reviewOn: isoDate.optional(),
  })
  .refine((f) => f.state !== "closed" || f.outcome !== undefined, "a closed thread needs an outcome");

const InboxFrontSchema = z.object({
  at: isoTime,
  via: z.string().trim().min(1),
  target: TargetSchema.optional(),
});

const ProposalFrontSchema = z.object({
  type: z.enum(THREAD_TYPES),
  areas: areaList,
  proposed: isoTime,
  target: TargetSchema,
});

export interface IvyNote {
  at: string;
  trigger: string;
  model: string;
  kind: NoteKind;
  status: NoteStatus;
  sample: boolean;
  because?: string;
  relates?: MaterialLink;
  text: string;
}

export interface StudioResponse {
  at: string;
  re?: string;
  text: string;
}

export interface MaterialLink {
  kind: string;
  label: string;
  href?: string;
}

export interface LogEntry {
  at?: string;
  text: string;
}

export interface StudioThread {
  slug: string;
  path: string;
  type: ThreadType;
  areas: string[];
  state: ThreadState;
  opened: string;
  closed?: string;
  thinkTonight: boolean;
  outcome?: ThreadOutcome;
  expect?: string;
  reviewOn?: string;
  question: string;
  stand: string;
  notes: IvyNote[];
  responses: StudioResponse[];
  material: MaterialLink[];
  log: LogEntry[];
  outcomeText: string;
}

export interface StudioCapture {
  id: string;
  path: string;
  at: string;
  via: string;
  text: string;
  target?: StudioTarget;
}

export interface StudioProposal {
  id: string;
  path: string;
  type: ThreadType;
  areas: string[];
  proposed: string;
  question: string;
  why: string;
  target: StudioTarget;
}

export type Parsed<T> = { ok: true; value: T } | { ok: false; reason: string };

const failed = (reason: string): { ok: false; reason: string } => ({ ok: false, reason });

const FRONT = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

function splitFrontMatter(text: string): Parsed<{ front: unknown; body: string }> {
  const match = FRONT.exec(text);
  if (!match) return failed("has no YAML front matter between --- lines");
  try {
    return { ok: true, value: { front: parseYaml(match[1] ?? ""), body: text.slice(match[0].length) } };
  } catch (err) {
    return failed(`has front matter that is not YAML: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`);
  }
}

function zodReason(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return "has invalid front matter";
  const field = issue.path.join(".");
  return field ? `front matter ${field} ${issue.message}` : `front matter: ${issue.message}`;
}

function sections(body: string, level: "##" | "###"): { heading: string; text: string }[] {
  const out: { heading: string; text: string }[] = [];
  const marker = `${level} `;
  let current: { heading: string; lines: string[] } | null = null;
  for (const line of body.split(/\r?\n/)) {
    if (line.startsWith(marker)) {
      if (current) out.push({ heading: current.heading, text: current.lines.join("\n").trim() });
      current = { heading: line.slice(marker.length).trim(), lines: [] };
    } else if (current) {
      current.lines.push(line);
    }
  }
  if (current) out.push({ heading: current.heading, text: current.lines.join("\n").trim() });
  return out;
}

const SECTION_KEYS: Record<string, string> = {
  question: "question",
  "where i stand": "stand",
  "ivy's notes": "notes",
  "ivy’s notes": "notes",
  material: "material",
  log: "log",
  outcome: "outcome",
  responses: "responses",
  why: "why",
};

export const sectionKey = (heading: string): string | undefined => SECTION_KEYS[heading.trim().toLowerCase()];

function sectionMap(body: string): Parsed<Map<string, string>> {
  const map = new Map<string, string>();
  for (const { heading, text } of sections(body, "##")) {
    const key = sectionKey(heading);
    if (!key) continue;
    if (map.has(key)) return failed(`has the section "${heading}" twice`);
    map.set(key, text);
  }
  return { ok: true, value: map };
}

export const NOTE_META_KEYS = ["trigger", "model", "kind", "status", "sample", "because", "relates"] as const;
const NOTE_META = new RegExp(`^(${NOTE_META_KEYS.join("|")}):[ \\t]*(.*)$`);

function parseNote(heading: string, text: string): Parsed<IvyNote> {
  if (!ISO_TIME.test(heading) || !validDate(heading)) return failed(`has a note headed "${heading}", which is not an ISO time with a zone`);
  const meta = new Map<string, string>();
  const lines = text.split("\n");
  let i = 0;
  for (; i < lines.length; i++) {
    const m = NOTE_META.exec(lines[i] ?? "");
    if (!m) break;
    meta.set(m[1] ?? "", (m[2] ?? "").trim());
  }
  const trigger = meta.get("trigger") ?? "";
  const model = meta.get("model") ?? "";
  if (!trigger) return failed(`has a note at ${heading} without a trigger: line`);
  if (!model) return failed(`has a note at ${heading} without a model: line`);
  const kind = meta.get("kind") ?? "note";
  if (!(NOTE_KINDS as readonly string[]).includes(kind)) return failed(`has a note at ${heading} with kind "${kind}"; use ${NOTE_KINDS.join(", ")}`);
  const status = meta.get("status") ?? "open";
  if (!(NOTE_STATUSES as readonly string[]).includes(status)) return failed(`has a note at ${heading} with status "${status}"; use ${NOTE_STATUSES.join(", ")}`);
  const because = meta.get("because");
  const relates = meta.get("relates");
  if (kind === "relation" && !relates) return failed(`has a relation note at ${heading} without a relates: line`);
  return {
    ok: true,
    value: {
      at: heading,
      trigger,
      model,
      kind: kind as NoteKind,
      status: status as NoteStatus,
      sample: meta.get("sample") === "true",
      ...(because ? { because } : {}),
      ...(kind === "relation" && relates ? { relates: parseMaterialItem(relates) } : {}),
      text: lines.slice(i).join("\n").trim(),
    },
  };
}

function parseNotes(text: string): Parsed<IvyNote[]> {
  const notes: IvyNote[] = [];
  for (const { heading, text: body } of sections(text, "###")) {
    const note = parseNote(heading, body);
    if (!note.ok) return note;
    notes.push(note.value);
  }
  return { ok: true, value: notes };
}

const bullets = (text: string): string[] =>
  text
    .split("\n")
    .map((l) => /^[-*][ \t]+(.*)$/.exec(l.trim())?.[1]?.trim() ?? "")
    .filter((l) => l !== "");

const LINK = /^\[([^\]]+)\]\(([^)\s]+)\)$/;
const KIND_PREFIX = /^([a-z][a-z-]*):[ \t]+(.+)$/;

export function parseMaterialItem(item: string): MaterialLink {
  const kinded = KIND_PREFIX.exec(item);
  const kind = kinded?.[1] ?? "link";
  const rest = kinded?.[2] ?? item;
  const link = LINK.exec(rest);
  return link ? { kind, label: link[1] ?? rest, href: link[2] ?? "" } : { kind, label: rest };
}

const parseMaterial = (text: string): MaterialLink[] => bullets(text).map(parseMaterialItem);

function parseResponses(text: string): Parsed<StudioResponse[]> {
  const out: StudioResponse[] = [];
  for (const { heading, text: body } of sections(text, "###")) {
    if (!ISO_TIME.test(heading) || !validDate(heading)) return failed(`has a response headed "${heading}", which is not an ISO time with a zone`);
    const lines = body.split("\n");
    const re = /^re:[ \t]*(\S+)[ \t]*$/.exec(lines[0] ?? "")?.[1];
    out.push({ at: heading, ...(re ? { re } : {}), text: lines.slice(re ? 1 : 0).join("\n").trim() });
  }
  return { ok: true, value: out };
}

const LOG_DATE = /^(\d{4}-\d{2}-\d{2}(?:T\S+)?):?[ \t]+(.+)$/;

function parseLog(text: string): LogEntry[] {
  return bullets(text).map((item) => {
    const dated = LOG_DATE.exec(item);
    return dated?.[1] && dated[2] ? { at: dated[1], text: dated[2] } : { text: item };
  });
}

const fileId = (path: string): string => (path.split("/").pop() ?? "").replace(/\.md$/, "");

function checkedId(path: string): Parsed<string> {
  const id = fileId(path);
  return STUDIO_SLUG.test(id) ? { ok: true, value: id } : failed(`has a file name that is not a slug (lowercase letters, digits and hyphens)`);
}

function parseFile<S extends z.ZodType>(path: string, text: string, schema: S): Parsed<{ id: string; front: z.infer<S>; body: string }> {
  const id = checkedId(path);
  if (!id.ok) return id;
  const split = splitFrontMatter(text);
  if (!split.ok) return split;
  const front = schema.safeParse(split.value.front);
  if (!front.success) return failed(zodReason(front.error));
  return { ok: true, value: { id: id.value, front: front.data, body: split.value.body } };
}

function withQuestion(body: string): Parsed<{ map: Map<string, string>; question: string }> {
  const map = sectionMap(body);
  if (!map.ok) return map;
  const question = map.value.get("question") ?? "";
  if (!question) return failed('has no "## Question" section, or it is empty');
  return { ok: true, value: { map: map.value, question } };
}

export function parseThreadFile(path: string, text: string): Parsed<StudioThread> {
  const file = parseFile(path, text, ThreadFrontSchema);
  if (!file.ok) return file;
  const body = withQuestion(file.value.body);
  if (!body.ok) return body;
  const { map, question } = body.value;
  const notes = parseNotes(map.get("notes") ?? "");
  if (!notes.ok) return notes;
  const responses = parseResponses(map.get("responses") ?? "");
  if (!responses.ok) return responses;
  const f = file.value.front;
  return {
    ok: true,
    value: {
      slug: file.value.id,
      path,
      type: f.type,
      areas: f.areas,
      state: f.state,
      opened: f.opened,
      ...(f.closed ? { closed: f.closed } : {}),
      thinkTonight: f.thinkTonight,
      ...(f.outcome ? { outcome: f.outcome } : {}),
      ...(f.expect ? { expect: f.expect } : {}),
      ...(f.reviewOn ? { reviewOn: f.reviewOn } : {}),
      question,
      stand: map.get("stand") ?? "",
      notes: notes.value,
      responses: responses.value,
      material: parseMaterial(map.get("material") ?? ""),
      log: parseLog(map.get("log") ?? ""),
      outcomeText: map.get("outcome") ?? "",
    },
  };
}

export function parseCaptureFile(path: string, text: string): Parsed<StudioCapture> {
  const file = parseFile(path, text, InboxFrontSchema);
  if (!file.ok) return file;
  const body = file.value.body.trim();
  if (!body) return failed("has no capture text below the front matter");
  const { at, via, target } = file.value.front;
  return { ok: true, value: { id: file.value.id, path, at, via, text: body, ...(target ? { target } : {}) } };
}

export function parseProposalFile(path: string, text: string): Parsed<StudioProposal> {
  const file = parseFile(path, text, ProposalFrontSchema);
  if (!file.ok) return file;
  const body = withQuestion(file.value.body);
  if (!body.ok) return body;
  const f = file.value.front;
  return { ok: true, value: { id: file.value.id, path, type: f.type, areas: f.areas, proposed: f.proposed, question: body.value.question, why: body.value.map.get("why") ?? "", target: f.target } };
}
