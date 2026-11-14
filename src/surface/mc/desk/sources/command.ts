import { HOST_NAME_RE } from "../../../../common/host-name";
import { z } from "zod";
import { runCommand } from "../../common/spawn";
import { CalendarCoverageSchema, EventAvailabilitySchema, SourceCapabilitiesSchema, type CalendarCoverage, type SourceCapabilities } from "../calendar-contract";

/**
 * The Desk source contract (cortex#2772): a source is a command, run without a shell, that prints one
 * JSON object with `events` and/or `items`. Entries that do not match are dropped, not fatal, and each
 * dropped entry yields a problem that names the field.
 */
/** Links a source may hand to the Desk: web pages, meetings, and Apple Mail messages. */
export const SAFE_LINK = /^(https?:|message:)/i;
const safeLink = z.string().refine((u) => SAFE_LINK.test(u), "must start with http:, https: or message:");
const isoDate = z.string().refine((s) => Number.isFinite(Date.parse(s)), "must be an ISO 8601 date and time");

export const AUTH_VERDICTS = ["pass", "fail", "softfail", "neutral", "none", "temperror", "permerror", "policy"] as const;

function printable(v: string): string {
  let out = "";
  for (let i = 0; i < v.length; i += 1) {
    const code = v.charCodeAt(i);
    out += code < 32 || code === 127 ? " " : v.charAt(i);
  }
  return out.replace(/\s+/g, " ").trim();
}
const headerText = (max: number) => z.string().transform(printable).pipe(z.string().min(1).max(max)).optional().catch(undefined);
const verdict = z.preprocess((v) => (typeof v === "string" ? v.trim().toLowerCase() : v), z.enum(AUTH_VERDICTS)).optional().catch(undefined);

const lenientList = <T>(item: z.ZodType<T>, keep: number) =>
  z
    .array(z.unknown())
    .transform((list): T[] => list.flatMap((d) => { const p = item.safeParse(d); return p.success ? [p.data] : []; }).slice(0, keep))
    .optional()
    .catch(undefined);

const hostName = z.string().trim().toLowerCase().max(253).regex(HOST_NAME_RE);
const messageId = z.string().trim().transform((v) => v.replace(/^<|>$/g, "")).pipe(z.string().min(1).max(512).regex(/^[^\s<>]+$/));
const MAX_REFERENCES = 20;
const messageIds = lenientList(messageId, MAX_REFERENCES);
const hostList = lenientList(hostName, 10);

function present<T extends object>(record: T): Partial<T> | undefined {
  const kept = Object.fromEntries(Object.entries(record).filter(([, v]) => v !== undefined));
  return Object.keys(kept).length > 0 ? (kept as Partial<T>) : undefined;
}

/** Headers a mail source may report. Untrusted: each field that does not fit is dropped on its own, never the mail. */
export const MailHeadersSchema = z
  .object({
    listId: headerText(300),
    listUnsubscribe: headerText(2000),
    listUnsubscribePost: headerText(200),
    authResults: z.object({ spf: verdict, dkim: verdict, dmarc: verdict, dkimDomains: hostList, spfDomain: hostName.optional().catch(undefined) }).optional().catch(undefined),
    replyTo: headerText(300),
    inReplyTo: headerText(1000),
    references: messageIds,
  })
  .transform((h): MailHeaders | undefined => present({ ...h, authResults: h.authResults && present(h.authResults) }))
  .optional()
  .catch(undefined);

export interface MailHeaders {
  listId?: string;
  listUnsubscribe?: string;
  listUnsubscribePost?: string;
  authResults?: Partial<Record<"spf" | "dkim" | "dmarc", (typeof AUTH_VERDICTS)[number]>> & { dkimDomains?: string[]; spfDomain?: string };
  replyTo?: string;
  inReplyTo?: string;
  references?: string[];
}

const MAX_LINKS = 20;
const MailLinkSchema = z.object({
  text: z.string().transform(printable).pipe(z.string().min(1).max(200)),
  href: z.string().max(2000).refine((u) => /^https?:\/\//i.test(u) && URL.canParse(u)),
});

export interface MailLink {
  text: string;
  href: string;
}

const MailLinksSchema = lenientList<MailLink>(MailLinkSchema, MAX_LINKS);

export const PART_STATS = ["NEEDS-ACTION", "ACCEPTED", "DECLINED", "TENTATIVE", "DELEGATED"] as const;
const inviteText = (max: number) => z.string().transform(printable).pipe(z.string().min(1).max(max));
const inviteAddress = z.string().trim().toLowerCase().pipe(z.string().min(3).max(320).regex(/^[^\s<>@,;:]+@[^\s<>@,;:]+$/));

/** A meeting request a mail carries (iTIP METHOD:REQUEST), as the mail source read it. Untrusted; a bad one is dropped alone. */
export const MailInvitationSchema = z
  .object({
    method: z.literal("REQUEST"),
    uid: z.string().min(1).max(1000).regex(/^[^\r\n]+$/),
    sequence: z.number().int().min(0).max(1_000_000).catch(0),
    summary: inviteText(300).catch("(no title)"),
    start: isoDate,
    end: isoDate.optional().catch(undefined),
    allDay: z.boolean().optional().catch(undefined),
    location: inviteText(300).optional().catch(undefined),
    organizer: z.object({ address: inviteAddress, name: inviteText(200).optional().catch(undefined) }),
    attendee: z.object({ address: inviteAddress, status: z.enum(PART_STATS).catch("NEEDS-ACTION"), rsvp: z.boolean().optional().catch(undefined) }).optional().catch(undefined),
    recurring: z.boolean().optional().catch(undefined),
    attendees: z.number().int().min(0).max(100_000).catch(0),
  })
  .refine((v) => v.end === undefined || Date.parse(v.end) >= Date.parse(v.start))
  .optional()
  .catch(undefined);

export type MailInvitation = NonNullable<z.infer<typeof MailInvitationSchema>>;

export const SourceMailSchema = z.object({
  kind: z.literal("mail"),
  id: z.string().min(1),
  from: z.object({ name: z.string().optional(), address: z.string().min(3) }),
  subject: z.string(),
  receivedAt: isoDate,
  dueAt: isoDate.optional().catch(undefined),
  unread: z.boolean(),
  firstParagraph: z.string().optional(),
  url: safeLink.optional(),
  account: z.string().optional(),
  headers: MailHeadersSchema,
  links: MailLinksSchema,
  invitation: MailInvitationSchema,
});

const MailAddressSchema = z.object({
  name: z.string().transform(printable).pipe(z.string().max(200)).optional().catch(undefined),
  address: z.string().trim().toLowerCase().pipe(z.string().min(3).max(320).regex(/^[^\s<>@,;]+@[^\s<>@,;]+$/)),
});

const MAX_EVENT_ATTENDEES = 500;

type MailAddress = z.infer<typeof MailAddressSchema>;
const absent = (v: unknown): boolean => v === undefined || v === null;

function readAddress(v: unknown): MailAddress | null {
  const p = MailAddressSchema.safeParse(v);
  return p.success ? p.data : null;
}

const readOrganizer = (v: unknown): MailAddress | null | undefined => (absent(v) ? undefined : readAddress(v));

function readAttendees(v: unknown): MailAddress[] | undefined {
  if (absent(v) || (Array.isArray(v) && v.length === 0)) return undefined;
  if (!Array.isArray(v)) return [];
  return v
    .map(readAddress)
    .filter((a): a is MailAddress => a !== null)
    .slice(0, MAX_EVENT_ATTENDEES);
}

/**
 * A calendar event. `organizer` and `attendees` are the meeting's people, read by the `mail.link-meeting` auto-link. Entries whose
 * address does not parse are dropped, but the list still counts as given: an unreadable organizer becomes null, and an attendee
 * value that is not an array, or a nonempty one with no readable entry, becomes empty, so the auto-link refuses every sender rather than none.
 */
export const SourceEventSchema = z.object({
  id: z.string().min(1),
  start: isoDate,
  end: isoDate.optional(),
  allDay: z.boolean().optional(),
  title: z.string().min(1),
  calendar: z.string().trim().min(1).max(200).optional(),
  calendarId: z.string().trim().min(1).max(500).optional(),
  location: z.string().optional(),
  online: z.boolean().optional(),
  url: safeLink.optional(),
  availability: EventAvailabilitySchema.optional(),
  organizer: z.unknown().transform(readOrganizer).optional(),
  attendees: z.unknown().transform(readAttendees).optional(),
});

const MAX_RECIPIENTS = 20;
const MAX_REPLIES = 10;
export const MAX_SENT_TEXT = 1000;

/** A mail the account sent (cortex#2983): its recipients, its thread headers and the replies the source found. */
export const SourceSentSchema = z.object({
  kind: z.literal("sent"),
  id: messageId,
  from: MailAddressSchema,
  to: lenientList(MailAddressSchema, MAX_RECIPIENTS).pipe(z.array(MailAddressSchema).min(1)),
  subject: z.string().transform(printable).pipe(z.string().max(500)),
  sentAt: isoDate,
  text: z.string().transform(printable).transform((t) => t.slice(0, MAX_SENT_TEXT)).optional().catch(undefined),
  url: safeLink.optional().catch(undefined),
  account: z.string().optional(),
  inReplyTo: messageId.optional().catch(undefined),
  references: messageIds,
  replies: lenientList(z.object({ id: messageId, from: MailAddressSchema, at: isoDate }), MAX_REPLIES),
});

export type SourceEvent = z.infer<typeof SourceEventSchema>;
export type SourceMail = z.infer<typeof SourceMailSchema>;
export type SourceSent = z.infer<typeof SourceSentSchema>;

export interface DeskSourceConfig {
  id: string;
  command: string[];
  area?: string;
  everySeconds: number;
  timeoutSeconds: number;
}

export interface SourceReading {
  capabilities?: SourceCapabilities;
  calendarCoverage?: CalendarCoverage;
  id: string;
  area: string | null;
  events: SourceEvent[];
  mail: SourceMail[];
  sent?: SourceSent[];
  readAt: number;
  error: string | null;
  dropped: number;
  problems: string[];
}

export interface ParsedSource {
  capabilities?: SourceCapabilities;
  calendarCoverage?: CalendarCoverage;
  events: SourceEvent[];
  mail: SourceMail[];
  sent: SourceSent[];
  dropped: number;
  problems: string[];
}

const fieldPath = (root: string, path: readonly PropertyKey[]): string =>
  path.reduce<string>((at, key) => (typeof key === "number" ? `${at}[${key}]` : `${at}.${String(key)}`), root);

export function entryProblems(root: string, error: z.ZodError): string[] {
  return error.issues.map((issue) => `${fieldPath(root, issue.path)}: ${issue.message}`);
}

const occurrenceIdentity = (event: SourceEvent): string => JSON.stringify([event.calendarId ?? null, event.id, Date.parse(event.start)]);

function oneEntryPerOccurrence(events: SourceEvent[]): SourceEvent[] {
  const seen = new Set<string>();
  return events.filter(event => {
    const identity = occurrenceIdentity(event);
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });
}

export function parseSourceOutput(stdout: string): ParsedSource {
  let body: unknown;
  try {
    body = JSON.parse(stdout);
  } catch {
    throw new Error("printed no JSON object on stdout");
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw new Error("printed JSON that is not an object with events or items");
  const events = "events" in body ? body.events : undefined;
  const items = "items" in body ? body.items : undefined;
  let dropped = 0;
  const problems: string[] = [];
  const keep = <T>(name: string, list: unknown, schema: z.ZodType<T>): T[] => {
    if (list === undefined) return [];
    if (!Array.isArray(list)) {
      problems.push(`${name}: must be an array`);
      return [];
    }
    return list.flatMap((entry, i) => {
      const parsed = schema.safeParse(entry);
      if (parsed.success) return [parsed.data];
      dropped += 1;
      problems.push(...entryProblems(`${name}[${i}]`, parsed.error));
      return [];
    });
  };
  const metadata = <T>(name: string, schema: z.ZodType<T>): T | undefined => {
    if (!(name in body)) return undefined;
    const parsed = schema.safeParse(Reflect.get(body, name));
    if (parsed.success) return parsed.data;
    problems.push(...entryProblems(name, parsed.error));
    return undefined;
  };
  const capabilities = metadata("capabilities", SourceCapabilitiesSchema);
  const calendarCoverage = metadata("calendarCoverage", CalendarCoverageSchema);
  if (capabilities?.includes("calendar") && !Array.isArray(events)) problems.push("events: a calendar source must provide its event array");
  if (capabilities && !capabilities.includes("calendar") && events !== undefined) problems.push("events: an attention-only source cannot provide calendar output");
  if (calendarCoverage && !capabilities?.includes("calendar")) problems.push("calendarCoverage: requires the calendar capability");
  const isSent = (entry: unknown): boolean => typeof entry === "object" && entry !== null && "kind" in entry && entry.kind === "sent";
  const listed = Array.isArray(items) ? items : undefined;
  const mail = listed ? keep("items", listed.filter((e) => !isSent(e)), SourceMailSchema) : keep("items", items, SourceMailSchema);
  const sent = listed ? keep("sent items", listed.filter(isSent), SourceSentSchema) : [];
  return { events: oneEntryPerOccurrence(keep("events", events, SourceEventSchema)), mail, sent, dropped, problems, ...(capabilities ? { capabilities } : {}), ...(calendarCoverage ? { calendarCoverage } : {}) };
}

export type CommandRunner = (argv: string[], timeoutMs: number) => Promise<string>;

export const spawnCommand: CommandRunner = async (argv, timeoutMs) => {
  const { code, signal, stdout, stderr } = await runCommand(argv, timeoutMs);
  if (signal) throw new Error(`killed by ${signal}`);
  if (code !== 0) throw new Error(`exited ${code}${stderr.trim() ? `: ${stderr.trim().split("\n").pop()}` : ""}`);
  return stdout;
};

/**
 * Runs each source at most once per `everySeconds` and shares one run between concurrent requests.
 * An expired reading is served while the next run happens in the background, so only the very first
 * request for a source waits for it. One cache per Mission Control server keeps stacks apart.
 */
export class SourceCache {
  private readonly readings = new Map<string, SourceReading>();
  private readonly running = new Map<string, Promise<SourceReading>>();

  constructor(
    private readonly run: CommandRunner = spawnCommand,
    private readonly onReading?: (prev: SourceReading | undefined, next: SourceReading) => unknown,
  ) {}

  cached(): SourceReading[] {
    return [...this.readings.values()];
  }

  async read(sources: DeskSourceConfig[], now: number): Promise<SourceReading[]> {
    return Promise.all(sources.map((s) => this.readOne(s, now)));
  }

  private readOne(source: DeskSourceConfig, now: number): Promise<SourceReading> {
    const cached = this.readings.get(source.id);
    if (cached && now - cached.readAt < source.everySeconds * 1000) return Promise.resolve(cached);
    const next = this.running.get(source.id) ?? this.refresh(source, now, cached);
    return cached ? Promise.resolve(cached) : next;
  }

  private refresh(source: DeskSourceConfig, now: number, cached: SourceReading | undefined): Promise<SourceReading> {
    const next = this.run(source.command, source.timeoutSeconds * 1000)
      .then((stdout) => ({ ...parseSourceOutput(stdout), error: null }))
      .catch((err: unknown) => ({ events: cached?.events ?? [], mail: cached?.mail ?? [], sent: cached?.sent ?? [], dropped: 0, problems: [], ...(cached?.capabilities ? { capabilities: cached.capabilities } : {}), error: err instanceof Error ? err.message : String(err) }))
      .then((r): SourceReading => {
        const reading = { id: source.id, area: source.area ?? null, readAt: now, ...r };
        this.readings.set(source.id, reading);
        this.running.delete(source.id);
        this.onReading?.(cached, reading);
        return reading;
      });
    this.running.set(source.id, next);
    return next;
  }
}
