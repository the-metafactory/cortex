import { z } from "zod";
import { DAY_MS, startOfDay } from "./time";

export const ASK_KINDS = ["reminder", "note", "task", "goal", "calendar"] as const;
export type AskKind = (typeof ASK_KINDS)[number];

const iso = z.string().refine((s) => Number.isFinite(Date.parse(s)), "not a date");
const text = (max: number) => z.string().trim().min(1).max(max);

export const FIELD_SCHEMAS = {
  reminder: z.object({ text: text(300), due: iso }),
  note: z.object({ text: text(1000) }),
  task: z.object({ title: text(200), details: z.string().max(4000).optional(), map: text(200) }),
  goal: z.object({ wording: text(300) }),
  calendar: z.object({
    title: text(200),
    start: iso,
    end: iso.optional(),
    allDay: z.boolean().optional(),
    location: z.string().max(200).optional(),
    notes: z.string().max(2000).optional(),
  }),
} satisfies Record<AskKind, z.ZodType>;

export type AskFields = { [K in AskKind]: z.infer<(typeof FIELD_SCHEMAS)[K]> };
export type AskCard = { [K in AskKind]: { kind: K; fields: AskFields[K] } }[AskKind];
export type ParseResult = AskCard | { kind: "none"; reason: string };
export type RulesResult = { kind: AskKind; fields: Record<string, unknown> } | { kind: "none"; reason: string };

export const isAskKind = (k: unknown): k is AskKind => ASK_KINDS.includes(k as AskKind);

export function validateCard(kind: unknown, fields: unknown): AskCard | string {
  if (!isAskKind(kind)) return "The Desk does not know that kind of request.";
  const parsed = FIELD_SCHEMAS[kind].safeParse(fields);
  if (!parsed.success) return `The ${KIND_LABEL[kind].toLowerCase()} is missing ${parsed.error.issues.map((i) => i.path.join(".") || "a field").join(", ")}.`;
  return { kind, fields: parsed.data } as AskCard;
}

export const KIND_LABEL: Record<AskKind, string> = {
  reminder: "Reminder",
  note: "Note",
  task: "Agent task",
  goal: "Goal draft",
  calendar: "Calendar entry",
};

export const notSetUp = (kind: AskKind): string => `${KIND_PLURAL[kind]} are not set up on this stack.`;

const KIND_PLURAL: Record<AskKind, string> = {
  reminder: "Reminders",
  note: "Notes",
  task: "Agent tasks",
  goal: "Goal drafts",
  calendar: "Calendar entries",
};

export function taskMapAllowed(card: AskCard, maps: readonly AskMap[]): boolean {
  return card.kind !== "task" || maps.some((m) => m.ref === card.fields.map);
}

export function proposalTime(kind: AskKind, fields: Record<string, unknown>): { at?: number; end?: number } {
  const t = (v: unknown): number | undefined => (typeof v === "string" && Number.isFinite(Date.parse(v)) ? Date.parse(v) : undefined);
  if (kind === "reminder") return { at: t(fields.due) };
  if (kind === "calendar") return { at: t(fields.start), end: t(fields.end) };
  return {};
}

export interface AskMap {
  ref: string;
  label: string;
}

export interface RulesContext {
  now: number;
  maps: AskMap[];
}

const NO_MATCH = "I could not tell what to make of that. Start with \"remind me\", \"note\", \"ask an agent to\", \"new goal\" or \"schedule\".";

const capital = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);
const tidy = (s: string): string => s.replace(/\s+/g, " ").replace(/^[\s,:;-]+|[\s,.;:-]+$/g, "");

export function parseByRules(input: string, ctx: RulesContext): RulesResult {
  const raw = tidy(input);
  for (const rule of RULES) {
    const body = rule.lead.exec(raw)?.groups?.body;
    if (body) return rule.build(body, ctx);
  }
  return { kind: "none", reason: NO_MATCH };
}

const RULES: { lead: RegExp; build: (body: string, ctx: RulesContext) => RulesResult }[] = [
  {
    lead: /^remind me\s+(?:to\s+|that\s+|about\s+)?(?<body>.+)$/i,
    build: (body, ctx) => {
      const when = findWhen(body, ctx.now);
      return { kind: "reminder", fields: { text: capital(tidy(when ? when.rest : body)), ...(when ? { due: new Date(when.at).toISOString() } : {}) } };
    },
  },
  {
    lead: /^(?:note|remember|keep in mind)\b[\s:,-]*(?:that\s+)?(?<body>.+)$/i,
    build: (body) => ({ kind: "note", fields: { text: capital(tidy(body)) } }),
  },
  {
    lead: /^(?:ask an agent to|get an agent to|have an agent|agent task|agent|task)\b[\s:,-]*(?<body>.+)$/i,
    build: (body, ctx) => {
      const map = ctx.maps[0]?.ref;
      return { kind: "task", fields: { title: capital(tidy(body)), ...(map ? { map } : {}) } };
    },
  },
  {
    lead: /^(?:new goal|add a goal|set a goal|goal)\b[\s:,-]*(?:to\s+)?(?<body>.+)$/i,
    build: (body) => ({ kind: "goal", fields: { wording: capital(tidy(body)) } }),
  },
  {
    lead: /^(?:schedule|book|block|calendar|put|add (?:an? )?(?:meeting|event|appointment)(?: for)?)\b[\s:,-]*(?<body>.+)$/i,
    build: (body, ctx) => {
      const when = findWhen(body, ctx.now);
      const title = capital(tidy((when ? when.rest : body).replace(/\b(?:in|on|to|into) (?:my|the) calendar\b/i, "")));
      if (!when) return { kind: "calendar", fields: { title } };
      const timing = when.allDay ? { allDay: true } : { end: new Date(when.end ?? when.at + 3_600_000).toISOString() };
      return { kind: "calendar", fields: { title, start: new Date(when.at).toISOString(), ...timing } };
    },
  },
];

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

interface When {
  at: number;
  end?: number;
  allDay?: boolean;
  rest: string;
}

function hourOf(h: string | undefined, mm: string | undefined, ampm: string | undefined): [number, number] | null {
  if (h === undefined) return null;
  let hour = Number(h);
  const minute = mm ? Number(mm) : 0;
  if (ampm?.toLowerCase() === "pm" && hour < 12) hour += 12;
  if (ampm?.toLowerCase() === "am" && hour === 12) hour = 0;
  return hour <= 23 && minute <= 59 ? [hour, minute] : null;
}

const atTime = (day: number, hm: [number, number]): number => {
  const d = new Date(day);
  d.setHours(hm[0], hm[1], 0, 0);
  return d.getTime();
};

export function findWhen(input: string, now: number): When | null {
  const rel = /\bin (?<n>\d+|an?|half an) (?<unit>minutes?|mins?|hours?|h)\b/i.exec(input);
  if (rel?.groups) {
    const { n = "", unit = "" } = rel.groups;
    const count = /half/i.test(n) ? 0.5 : /^an?$/i.test(n) ? 1 : Number(n);
    return { at: now + count * (/^h/i.test(unit) ? 3_600_000 : 60_000), rest: input.replace(rel[0], " ") };
  }

  const today = startOfDay(now);
  const dm = DAY_PHRASE.exec(input);
  const day = dm?.groups ? dayFrom(dm.groups, now) : null;
  const dayText = dm?.[0] ?? "";
  const rest = dayText ? input.replace(dayText, " ") : input;
  const rollover = (at: number): number => (day === null && at <= now ? at + DAY_MS : at);

  const range = RANGE.exec(rest)?.groups;
  if (range) {
    const a = hourOf(range.h1, range.m1, range.p1 ?? range.p2);
    const b = hourOf(range.h2, range.m2, range.p2);
    if (a && b) {
      const at = atTime(day ?? today, a);
      return { at: rollover(at), end: rollover(at) - at + atTime(day ?? today, b), rest: rest.replace(RANGE, " ") };
    }
  }
  const single = SINGLE.exec(rest)?.groups;
  const hm = single ? hourOf(single.h ?? single.h2, single.m ?? single.m2, single.p) : null;
  if (hm) return { at: rollover(atTime(day ?? today, hm)), rest: rest.replace(SINGLE, " ") };
  if (day === null) return null;
  if (/tonight/i.test(dayText)) return { at: atTime(day, [19, 0]), rest };
  return { at: day, allDay: true, rest };
}

const DAY_PHRASE =
  /\b(?<word>today|tonight|tomorrow|(?:on |next )?(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday))\b|\bon (?<y>\d{4})-(?<mo>\d{2})-(?<d>\d{2})\b|\bon (?<dd>\d{1,2})\.(?<mm>\d{1,2})\.(?<yy>\d{4})?/i;
const RANGE = new RegExp(String.raw`\b(?:from |at )?(?<h1>\d{1,2})(?:[:.](?<m1>\d{2}))?\s*(?<p1>am|pm)?\s*(?:-|–|to|until)\s*(?<h2>\d{1,2})(?:[:.](?<m2>\d{2}))?\s*(?<p2>am|pm)?`, "i");
const SINGLE = /\b(?:at |um )(?<h>\d{1,2})(?:[:.](?<m>\d{2}))?\s*(?<p>am|pm)?\b|\b(?<h2>\d{1,2})[:.](?<m2>\d{2})\b/i;

function dayFrom(g: Record<string, string | undefined>, now: number): number {
  const today = startOfDay(now);
  const word = g.word?.toLowerCase();
  if (word === "today" || word === "tonight") return today;
  if (word === "tomorrow") return startOfDay(today + DAY_MS + DAY_MS / 2);
  if (word) {
    const target = WEEKDAYS.indexOf(word.replace(/^(on|next) /, ""));
    const ahead = (target - new Date(now).getDay() + 7) % 7 || 7;
    return startOfDay(today + ahead * DAY_MS + DAY_MS / 2);
  }
  if (g.y) return new Date(Number(g.y), Number(g.mo) - 1, Number(g.d)).getTime();
  const year = g.yy ? Number(g.yy) : new Date(now).getFullYear();
  const day = new Date(year, Number(g.mm) - 1, Number(g.dd)).getTime();
  return !g.yy && day < today ? new Date(year + 1, Number(g.mm) - 1, Number(g.dd)).getTime() : day;
}

export interface ParserRequest {
  text: string;
  now: string;
  timeZone: string;
  kinds: AskKind[];
  maps: AskMap[];
}

export type ParserRunner = (argv: string[], stdin: string, timeoutMs: number) => Promise<string>;

export async function parseWithCommand(argv: string[], request: ParserRequest, run: ParserRunner, timeoutMs: number): Promise<ParseResult | null> {
  let answer: { kind?: unknown; fields?: unknown; reason?: unknown } | null;
  try {
    answer = JSON.parse(await run(argv, JSON.stringify(request), timeoutMs)) as typeof answer;
  } catch {
    return null;
  }
  if (answer?.kind === "none") return { kind: "none", reason: typeof answer.reason === "string" && answer.reason.trim() ? answer.reason.trim().slice(0, 200) : NO_MATCH };
  if (!answer || !request.kinds.includes(answer.kind as AskKind)) return null;
  const card = validateCard(answer.kind, answer.fields);
  if (typeof card === "string") return null;
  if (!taskMapAllowed(card, request.maps)) return null;
  return card;
}

export interface DeskProposal {
  kind: AskKind;
  label: string;
  fields: Record<string, unknown>;
  at?: number;
  end?: number;
  problem?: string;
  unwritable?: true;
  via: "parser" | "rules";
}

function problemFor(kind: AskKind, fields: Record<string, unknown>, at: number | undefined, writable: ReadonlySet<AskKind>): string | undefined {
  if (!writable.has(kind)) return notSetUp(kind);
  const checked = validateCard(kind, fields);
  if (typeof checked !== "string") return undefined;
  if (kind === "reminder" && at === undefined) return "When should I remind you?";
  if (kind === "calendar" && at === undefined) return "When is it?";
  if (kind === "task" && !fields.map) return "Which map should the task go on? None is set up.";
  return checked;
}

export function toProposal(kind: AskKind, fields: Record<string, unknown>, writable: ReadonlySet<AskKind>, via: DeskProposal["via"]): DeskProposal {
  const { at, end } = proposalTime(kind, fields);
  const problem = problemFor(kind, fields, at, writable);
  return {
    kind,
    label: KIND_LABEL[kind],
    fields,
    ...(at !== undefined ? { at } : {}),
    ...(end !== undefined ? { end } : {}),
    ...(problem ? { problem } : {}),
    ...(writable.has(kind) ? {} : { unwritable: true as const }),
    via,
  };
}
