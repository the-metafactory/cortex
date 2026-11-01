import { z } from "zod";
import { runCommand } from "../spawn";

/**
 * The Desk source contract (cortex#2772): a source is a command, run without a shell, that prints one
 * JSON object with `events` and/or `items`. Entries that do not match are dropped, not fatal, and each
 * dropped entry yields a problem that names the field.
 */
/** Links a source may hand to the Desk: web pages, meetings, and Apple Mail messages. */
export const SAFE_LINK = /^(https?:|message:)/i;
const safeLink = z.string().refine((u) => SAFE_LINK.test(u), "must start with http:, https: or message:");
const isoDate = z.string().refine((s) => Number.isFinite(Date.parse(s)), "must be an ISO 8601 date and time");

export const SourceEventSchema = z.object({
  id: z.string().min(1),
  start: isoDate,
  end: isoDate.optional(),
  allDay: z.boolean().optional(),
  title: z.string().min(1),
  calendar: z.string().trim().min(1).max(200).optional(),
  location: z.string().optional(),
  online: z.boolean().optional(),
  url: safeLink.optional(),
});

const HOST_NAME = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
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
    authResults: z.object({ spf: verdict, dkim: verdict, dmarc: verdict, dkimDomains: z.array(z.string().trim().toLowerCase().regex(HOST_NAME).max(253)).max(10).optional().catch(undefined) }).optional().catch(undefined),
    replyTo: headerText(300),
    inReplyTo: headerText(1000),
  })
  .transform((h): MailHeaders | undefined => present({ ...h, authResults: h.authResults && present(h.authResults) }))
  .optional()
  .catch(undefined);

export interface MailHeaders {
  listId?: string;
  listUnsubscribe?: string;
  listUnsubscribePost?: string;
  authResults?: Partial<Record<"spf" | "dkim" | "dmarc", (typeof AUTH_VERDICTS)[number]>> & { dkimDomains?: string[] };
  replyTo?: string;
  inReplyTo?: string;
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

const MailLinksSchema = z
  .array(z.unknown())
  .max(200)
  .transform((list): MailLink[] => list.flatMap((l) => { const p = MailLinkSchema.safeParse(l); return p.success ? [p.data] : []; }).slice(0, MAX_LINKS))
  .optional()
  .catch(undefined);

export const SourceMailSchema = z.object({
  kind: z.literal("mail"),
  id: z.string().min(1),
  from: z.object({ name: z.string().optional(), address: z.string().min(3) }),
  subject: z.string(),
  receivedAt: isoDate,
  dueAt: isoDate.optional(),
  unread: z.boolean(),
  firstParagraph: z.string().optional(),
  url: safeLink.optional(),
  account: z.string().optional(),
  headers: MailHeadersSchema,
  links: MailLinksSchema,
});

export type SourceEvent = z.infer<typeof SourceEventSchema>;
export type SourceMail = z.infer<typeof SourceMailSchema>;

export interface DeskSourceConfig {
  id: string;
  command: string[];
  area?: string;
  everySeconds: number;
  timeoutSeconds: number;
}

export interface SourceReading {
  id: string;
  area: string | null;
  events: SourceEvent[];
  mail: SourceMail[];
  readAt: number;
  error: string | null;
  dropped: number;
  problems: string[];
}

export interface ParsedSource {
  events: SourceEvent[];
  mail: SourceMail[];
  dropped: number;
  problems: string[];
}

const fieldPath = (root: string, path: readonly PropertyKey[]): string =>
  path.reduce<string>((at, key) => (typeof key === "number" ? `${at}[${key}]` : `${at}.${String(key)}`), root);

export function entryProblems(root: string, error: z.ZodError): string[] {
  return error.issues.map((issue) => `${fieldPath(root, issue.path)}: ${issue.message}`);
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
  return { events: keep("events", events, SourceEventSchema), mail: keep("items", items, SourceMailSchema), dropped, problems };
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
      .catch((err: unknown) => ({ events: cached?.events ?? [], mail: cached?.mail ?? [], dropped: 0, problems: [], error: err instanceof Error ? err.message : String(err) }))
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
