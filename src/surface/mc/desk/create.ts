import type { Database } from "bun:sqlite";
import { z } from "zod";
import { KIND_LABEL, notSetUp, type AskCard, type AskKind } from "./ask";
import { addNote } from "./notes";
import { oneLine } from "./actions";
import { clock } from "./time";

export const WRITER_KINDS = ["calendar", "task", "goal"] as const;
export type WriterKind = (typeof WRITER_KINDS)[number];
export type DeskWriters = Partial<Record<WriterKind, string[]>>;

export function writableKinds(writers: DeskWriters): Set<AskKind> {
  return new Set<AskKind>(["reminder", "note", ...WRITER_KINDS.filter((k) => (writers[k]?.length ?? 0) > 0)]);
}

export interface WriterResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type WriterRunner = (argv: string[], stdin: string, timeoutMs: number) => Promise<WriterResult>;

const WriterAnswer = z.object({
  id: z.string().min(1),
  url: z.string().regex(/^https?:/i).optional(),
  message: z.string().max(300).optional(),
});

export type Created =
  | { ok: true; message: string; url?: string; event?: { at: number; end?: number; title: string; allDay?: boolean } }
  | { ok: false; error: string; uncertain?: true };

export class WriterTimeout extends Error {}

const MAYBE_CREATED = "It may have been created; check before asking again.";

export interface CreateDeps {
  requestId: string;
  db: Database;
  writers: DeskWriters;
  run: WriterRunner;
  now: number;
  timeoutMs: number;
}

const day = (at: number, now: number): string => {
  const d = new Date(at);
  const sameDay = d.toDateString() === new Date(now).toDateString();
  return sameDay ? "today" : d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
};

export async function createFromCard(card: AskCard, deps: CreateDeps): Promise<Created> {
  if (card.kind === "reminder") {
    const due = Date.parse(card.fields.due);
    addNote(deps.db, "reminder", card.fields.text, due, deps.now);
    return { ok: true, message: `I will remind you ${day(due, deps.now)} at ${clock(due)}.` };
  }
  if (card.kind === "note") {
    addNote(deps.db, "note", card.fields.text, null, deps.now);
    return { ok: true, message: "Noted. It is under Keep in mind." };
  }
  const argv = deps.writers[card.kind];
  if (!argv?.length) return { ok: false, error: notSetUp(card.kind) };
  let result: WriterResult;
  try {
    result = await deps.run(argv, JSON.stringify({ ...card, requestId: deps.requestId }), deps.timeoutMs);
  } catch (err) {
    if (err instanceof WriterTimeout) return { ok: false, error: `The ${KIND_LABEL[card.kind].toLowerCase()} writer ${err.message}. ${MAYBE_CREATED}`, uncertain: true };
    return { ok: false, error: `The ${KIND_LABEL[card.kind].toLowerCase()} writer did not run: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (result.code !== 0) return { ok: false, error: oneLine(result.stderr || result.stdout, `The ${KIND_LABEL[card.kind].toLowerCase()} writer exited with code ${result.code}.`) };
  let answer: z.infer<typeof WriterAnswer>;
  try {
    answer = WriterAnswer.parse(JSON.parse(result.stdout));
  } catch {
    return { ok: false, error: `The ${KIND_LABEL[card.kind].toLowerCase()} writer answered in a form the Desk cannot read. ${MAYBE_CREATED}`, uncertain: true };
  }
  const message = answer.message ?? `Created the ${KIND_LABEL[card.kind].toLowerCase()}.`;
  if (card.kind !== "calendar") return { ok: true, message, ...(answer.url ? { url: answer.url } : {}) };
  const at = Date.parse(card.fields.start);
  const end = card.fields.end ? Date.parse(card.fields.end) : undefined;
  return {
    ok: true,
    message,
    ...(answer.url ? { url: answer.url } : {}),
    event: { at, ...(end !== undefined ? { end } : {}), title: card.fields.title, ...(card.fields.allDay ? { allDay: true } : {}) },
  };
}

export const spawnWithStdin: WriterRunner = async (argv, stdin, timeoutMs) => {
  const proc = Bun.spawn(argv, { stdin: new Blob([stdin]), stdout: "pipe", stderr: "pipe" });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      proc.kill("SIGKILL");
      reject(new WriterTimeout(`timed out after ${Math.round(timeoutMs / 1000)} s`));
    }, timeoutMs);
  });
  const finished = (async () => {
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    return { code, stdout, stderr };
  })();
  try {
    return await Promise.race([finished, timedOut]);
  } finally {
    clearTimeout(timer);
  }
};

export class RecentCalendarWrites {
  private entries: { at: number; end?: number; title: string; allDay?: boolean; createdAt: number }[] = [];

  add(event: NonNullable<Extract<Created, { ok: true }>["event"]>, now: number): void {
    this.entries.push({ ...event, createdAt: now });
  }

  pending(now: number, seen: { title: string; start: number }[]): { at: number; end?: number; title: string; allDay?: boolean }[] {
    this.entries = this.entries.filter((e) => now - e.createdAt < 15 * 60_000 && !seen.some((s) => s.title === e.title && s.start === e.at));
    return this.entries.map(({ createdAt: _, ...e }) => e);
  }
}
