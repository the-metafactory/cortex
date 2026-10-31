import { z } from "zod";
import { runCommand } from "../spawn";

/**
 * The Desk source contract (cortex#2772): a source is a command, run without a shell, that prints one
 * JSON object with `events` and/or `items`. Entries that do not match are dropped, not fatal.
 */
/** Links a source may hand to the Desk: web pages, meetings, and Apple Mail messages. */
export const SAFE_LINK = /^(https?:|message:)/i;
const safeLink = z.string().refine((u) => SAFE_LINK.test(u));

export const SourceEventSchema = z.object({
  id: z.string().min(1),
  start: z.string().refine((s) => Number.isFinite(Date.parse(s))),
  end: z.string().refine((s) => Number.isFinite(Date.parse(s))).optional(),
  allDay: z.boolean().optional(),
  title: z.string().min(1),
  location: z.string().optional(),
  online: z.boolean().optional(),
  url: safeLink.optional(),
});

export const SourceMailSchema = z.object({
  kind: z.literal("mail"),
  id: z.string().min(1),
  from: z.object({ name: z.string().optional(), address: z.string().min(3) }),
  subject: z.string(),
  receivedAt: z.string().refine((s) => Number.isFinite(Date.parse(s))),
  unread: z.boolean(),
  firstParagraph: z.string().optional(),
  url: safeLink.optional(),
  account: z.string().optional(),
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
}

/** Parses a source's stdout; keeps each entry that matches the contract and counts the rest. */
export function parseSourceOutput(stdout: string): { events: SourceEvent[]; mail: SourceMail[]; dropped: number } {
  const body = JSON.parse(stdout) as { events?: unknown; items?: unknown };
  let dropped = 0;
  const keep = <T>(list: unknown, schema: z.ZodType<T>): T[] => {
    if (!Array.isArray(list)) return [];
    return list.flatMap((entry) => {
      const parsed = schema.safeParse(entry);
      if (!parsed.success) dropped += 1;
      return parsed.success ? [parsed.data] : [];
    });
  };
  return { events: keep(body.events, SourceEventSchema), mail: keep(body.items, SourceMailSchema), dropped };
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

  constructor(private readonly run: CommandRunner = spawnCommand) {}

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
      .catch((err: unknown) => ({ events: cached?.events ?? [], mail: cached?.mail ?? [], dropped: 0, error: err instanceof Error ? err.message : String(err) }))
      .then((r): SourceReading => {
        const reading = { id: source.id, area: source.area ?? null, readAt: now, ...r };
        this.readings.set(source.id, reading);
        this.running.delete(source.id);
        return reading;
      });
    this.running.set(source.id, next);
    return next;
  }
}
